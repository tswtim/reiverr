import * as fs from 'fs';
import * as path from 'path';
import * as torrentStream from 'torrent-stream';
import { TorrentInputError } from './torrent-id';

function cacheFilePath(): string {
  const override = process.env.TORRENT_STREAM_CACHE_FILE;
  if (override && override.trim()) return path.resolve(override);
  return path.join(__dirname, '..', '..', 'stream-cache.json');
}

/** Classify a persisted id without putting the value into a log line. */
export function persistedTorrentKind(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'empty';
  const text = value.trim();
  if (/^magnet:\?/i.test(text)) return 'magnet';
  if (/^[a-f0-9]{40}$/i.test(text) || /^[a-z2-7]{32}$/i.test(text))
    return 'hash';
  if (/^https?:\/\//i.test(text)) return 'http';
  return 'other';
}

export function safeTorrentErrorCode(error: unknown): string {
  if (error instanceof TorrentInputError) {
    return /^[a-z0-9-]{1,40}$/.test(error.reason)
      ? error.reason
      : 'torrent-input';
  }
  if (
    error instanceof Error &&
    error.message === 'Invalid torrent identifier'
  ) {
    return 'invalid-identifier';
  }
  const code = (error as { code?: string } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  return 'engine-error';
}

function asEngineError(error: unknown): Error {
  if (error instanceof TorrentInputError) return error;
  if (
    error instanceof Error &&
    error.message === 'Invalid torrent identifier'
  ) {
    return new TorrentInputError(
      'The release link is not a magnet, info hash, or torrent file.',
      'invalid-identifier',
    );
  }
  if (error instanceof Error) return error;
  return new Error('engine-error');
}

class FileCache<T> {
  private cache: T;
  private writable = true;

  constructor(
    private cacheFile: string,
    private defaultValue: T,
  ) {
    this.cache = this.readStreamCache();
  }

  private writeStreamCache(cache: T) {
    this.cache = cache;
    fs.writeFileSync(this.cacheFile, JSON.stringify(cache));
  }

  private readStreamCache(): T {
    try {
      if (!fs.existsSync(this.cacheFile)) return this.defaultValue;
      const data = fs.readFileSync(this.cacheFile, 'utf8');
      if (!data) return this.defaultValue;
      return JSON.parse(data) ?? this.defaultValue;
    } catch (error) {
      this.writable = false;
      console.error('torrent cache unreadable', safeTorrentErrorCode(error));
      return this.defaultValue;
    }
  }

  update(fn: (value: T) => T): T {
    if (!this.writable) {
      console.error('torrent cache not rewritten', 'unreadable');
      return this.get();
    }
    const n = fn(this.get());
    this.cache = n;
    this.writeStreamCache(n);
    return n;
  }

  get(): T {
    return this.cache ?? this.defaultValue;
  }
}

type TorrentMetadata = {
  userId: string;
  infoHash: string;
  lastAccessed: number;
};

class EngineCache {
  // maxFileCacheSize = 5 * 1024 * 1024 * 1024;
  maxActiveTorrentsPerUser = 1;
  maxTorrentKeepAlive = 1000 * 60 * 60 * 24 * 3;

  private userTorrentMetadata = new FileCache<{
    [userId: string]: TorrentMetadata;
  }>(cacheFilePath(), {});
  private engineCache: {
    [infoHash: string]: Promise<TorrentStream.TorrentEngine>;
  } = {};

  constructor() {
    let entries: TorrentMetadata[] = [];
    try {
      const stored = this.userTorrentMetadata.get();
      entries =
        stored && typeof stored === 'object' ? Object.values(stored) : [];
    } catch (error) {
      console.error('torrent cache unreadable', safeTorrentErrorCode(error));
      return;
    }
    for (const metadata of entries) {
      this.restorePersisted(metadata);
    }
  }

  private restorePersisted(metadata: TorrentMetadata) {
    const kind = persistedTorrentKind(metadata?.infoHash);
    const recent =
      typeof metadata?.lastAccessed === 'number' &&
      metadata.lastAccessed > Date.now() - this.maxTorrentKeepAlive;
    if ((kind === 'magnet' || kind === 'hash') && !recent) {
      console.log('discarding old torrent', kind);
      this.userTorrentMetadata.update((stored) => {
        delete stored[metadata.userId];
        return stored;
      });
      return;
    }
    if (kind !== 'magnet' && kind !== 'hash') {
      // Leave the saved record untouched. Opening it rejects instead of
      // killing the process, and a later successful play can replace it.
      console.error('skipped persisted torrent', kind);
    } else {
      console.log('initializing old torrent', kind);
    }
    if (typeof metadata?.infoHash !== 'string' || !metadata.infoHash.trim()) {
      return;
    }
    try {
      void this.getTorrent(metadata.infoHash);
    } catch (error) {
      console.error(
        'skipped persisted torrent',
        kind,
        safeTorrentErrorCode(error),
      );
    }
  }

  private async destroyEngine(infoHash: string) {
    const pending = this.engineCache[infoHash];
    if (!pending) return;
    let engine: TorrentStream.TorrentEngine | undefined;
    try {
      engine = await pending;
    } catch {
      // A saved http link never became an engine. Drop only the in-memory
      // rejection; the cache file is updated later only if a new id opens.
      delete this.engineCache[infoHash];
      console.error(
        'skipped persisted torrent',
        persistedTorrentKind(infoHash),
        'invalid-identifier',
      );
      return;
    }

    await new Promise((res) => {
      engine?.remove
        ? engine?.remove(false, () => {
            res(undefined);
          })
        : res(undefined);
    });

    await new Promise((res) => {
      engine?.destroy ? engine?.destroy(() => res(undefined)) : res(undefined);
    });

    this.userTorrentMetadata.update((metadata) => {
      const toDelete = Object.values(metadata).find(
        (m) => (m.infoHash = infoHash),
      );
      if (toDelete) delete metadata[toDelete.userId];
      return metadata;
    });
    delete this.engineCache[infoHash];
    console.log('destroyed', persistedTorrentKind(infoHash));
  }

  private getTorrent(magnetLink: string): Promise<TorrentStream.TorrentEngine> {
    if (typeof magnetLink !== 'string' || !magnetLink.trim()) {
      return Promise.reject(
        new TorrentInputError('The release did not include a torrent link.'),
      );
    }
    if (magnetLink in this.engineCache) {
      return this.engineCache[magnetLink];
    }

    const kind = persistedTorrentKind(magnetLink);
    const promise = new Promise<TorrentStream.TorrentEngine>((res, rej) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        rej(asEngineError(error));
      };
      const succeed = (engine: TorrentStream.TorrentEngine) => {
        if (settled) return;
        settled = true;
        res(engine);
      };
      try {
        const engine = torrentStream(magnetLink, {
          tmp: process.env.TORRENT_STREAM_DOWNLOADS?.startsWith('/')
            ? process.env.TORRENT_STREAM_DOWNLOADS
            : path.join(
                __dirname,
                '..',
                '..',
                process.env.TORRENT_STREAM_DOWNLOADS ??
                  'torrent-stream-downloads',
              ),
        });
        engine.on('ready', () => succeed(engine));
        engine.on('error', (error: unknown) => fail(error));
        engine.on('download', () => console.info('onDownload', kind));
        engine.on('upload', () => console.info('onUpload', kind));
      } catch (error) {
        fail(error);
      }
    });
    // Constructor does not await. A rejection still rejects for getFiles,
    // and this handler keeps it from terminating the process.
    promise.catch((error) => {
      console.error('torrent engine failed', kind, safeTorrentErrorCode(error));
    });
    this.engineCache[magnetLink] = promise;
    return promise;
  }

  private getUserActiveTorrent(userId: string): TorrentMetadata | undefined {
    return this.userTorrentMetadata.get()[userId];
  }

  private async setUserActiveTorrent(userId: string, magnetLink: string) {
    const activeTorrent = this.getUserActiveTorrent(userId);

    if (activeTorrent && activeTorrent.infoHash !== magnetLink) {
      console.log(
        'destroying old torrent',
        persistedTorrentKind(activeTorrent.infoHash),
        persistedTorrentKind(magnetLink),
      );
      await this.destroyEngine(activeTorrent.infoHash);
    }

    this.userTorrentMetadata.update((metadata) => {
      metadata[userId] = {
        userId,
        infoHash: magnetLink,
        lastAccessed: Date.now(),
      };
      return metadata;
    });
  }

  async getFiles(userId: string, magnetLink: string) {
    const engine = await this.getTorrent(magnetLink);
    await this.setUserActiveTorrent(userId, magnetLink);
    return engine.files;
  }
}

const engineCache = new EngineCache();

export function getFiles(
  userId: string,
  magnetLink: string,
): Promise<TorrentStream.TorrentFile[]> {
  return engineCache.getFiles(userId, magnetLink);
}
