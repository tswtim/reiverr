import * as fs from 'fs';
import * as path from 'path';
import * as bencode from 'bncode';
import * as parseTorrent from 'parse-torrent';
import { findTorrentByStreamKey } from '../../packages/torrent-stream.plugin/src/lib/jackett.api';
import type { JackettItem } from '../../packages/torrent-stream.plugin/src/lib/jackett.api';
import {
  filesForRelease,
  isBlockedAddress,
  resolveTorrentEngineId,
  TorrentHttpRequest,
  TorrentInputError,
} from '../../packages/torrent-stream.plugin/src/lib/torrent-id';

const REPORTED_TITLE =
  'Менталист / The Mentalist (2008-2015) WEB-DL (S1-7E1-151 of 151) ТВ3';
const HASH = 'ab'.repeat(20);

function torrentFile(): Buffer {
  return bencode.encode({
    announce: 'http://tracker.fixture/announce',
    info: {
      name: 'fixture-file',
      'piece length': 16384,
      pieces: Buffer.alloc(20, 1),
      length: 4,
    },
  });
}

function item(partial: Partial<JackettItem>): JackettItem {
  return {
    title: partial.title ?? '',
    guid: partial.guid ?? 'fixture-guid',
    jackettindexer: 'fixture',
    type: 'movie',
    comments: '',
    pubDate: '',
    size: 1024,
    files: 1,
    description: '',
    link: partial.link ?? '',
    category: [],
    enclosure: partial.enclosure ?? {
      url: '',
      length: 0,
      type: 'application/x-bittorrent',
    },
    'torznab:attr': partial['torznab:attr'] ?? [],
  };
}

describe('torrent engine id', () => {
  const parsedFile = parseTorrent(torrentFile());

  it('accepts a magnet and an info hash without a download', async () => {
    const calls: string[] = [];
    const request: TorrentHttpRequest = async (url) => {
      calls.push(url);
      throw new Error('fetch should not run');
    };
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(REPORTED_TITLE)}`;
    await expect(resolveTorrentEngineId(magnet, { request })).resolves.toBe(
      magnet,
    );
    await expect(resolveTorrentEngineId(HASH, { request })).resolves.toBe(HASH);
    expect(parseTorrent(magnet).infoHash).toBe(HASH);
    expect(parseTorrent(HASH).infoHash).toBe(HASH);
    expect(calls).toEqual([]);
  });

  it('turns an http torrent link into a magnet and drops the API key', async () => {
    const secretUrl =
      'http://jackett.local:9117/dl/fixture?jackett_apikey=SECRET&file=a.torrent';
    const engineId = await resolveTorrentEngineId(secretUrl, {
      jackettBaseUrl: 'http://jackett.local:9117',
      request: async (url) => {
        expect(url).toBe(secretUrl);
        return { status: 200, headers: {}, body: torrentFile() };
      },
    });

    expect(engineId.startsWith('magnet:?xt=urn:btih:')).toBe(true);
    expect(engineId).not.toContain('SECRET');
    expect(engineId).not.toContain('apikey');
    expect(engineId).not.toContain('jackett.local');
    expect(parseTorrent(engineId).infoHash).toBe(parsedFile.infoHash);
    expect(parseTorrent(engineId).announce).toEqual([
      'http://tracker.fixture/announce',
    ]);
  });

  it('resolves a slash title through the same engine id a movie and an episode would load', async () => {
    const release = item({
      title: REPORTED_TITLE,
      link: 'http://jackett.local:9117/dl/fixture?jackett_apikey=SECRET',
    });
    expect(findTorrentByStreamKey([release], REPORTED_TITLE)).toBe(release);

    const seen: string[] = [];
    const loaded = await filesForRelease(
      release,
      {
        jackettBaseUrl: 'http://jackett.local:9117',
        request: async () => ({
          status: 200,
          headers: {},
          body: torrentFile(),
        }),
      },
      async (engineId) => {
        seen.push(engineId);
        return [{ name: 'episode.mkv' }];
      },
    );

    expect(seen).toEqual([loaded.engineId]);
    expect(loaded.engineId.startsWith('magnet:?')).toBe(true);
    expect(loaded.engineId).not.toContain('SECRET');
    expect(loaded.files).toEqual([{ name: 'episode.mkv' }]);
    expect(parseTorrent(loaded.engineId).infoHash).toBe(parsedFile.infoHash);
  });

  it('prefers a magnet attribute over an http link that carries a key', async () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}`;
    const release = item({
      link: 'http://jackett.local:9117/dl/fixture?jackett_apikey=SECRET',
      'torznab:attr': [{ '@_name': 'magneturl', '@_value': magnet }],
    });
    const seen: string[] = [];
    await filesForRelease(
      release,
      {
        request: async () => {
          throw new Error('fetch should not run');
        },
      },
      async (engineId) => {
        seen.push(engineId);
        return [];
      },
    );
    expect(seen).toEqual([magnet]);
  });

  it('rejects missing, invalid, non-torrent, timeout, and private redirect targets', async () => {
    await expect(resolveTorrentEngineId('')).rejects.toBeInstanceOf(
      TorrentInputError,
    );
    await expect(resolveTorrentEngineId(REPORTED_TITLE)).rejects.toMatchObject({
      name: 'TorrentInputError',
      message: 'The release link is not a magnet, info hash, or torrent file.',
    });

    await expect(
      resolveTorrentEngineId('http://jackett.local/dl/file', {
        jackettBaseUrl: 'http://jackett.local',
        request: async () => ({
          status: 200,
          headers: {},
          body: Buffer.from('not-a-torrent'),
        }),
      }),
    ).rejects.toMatchObject({
      message: 'The downloaded file is not a torrent.',
    });

    const timeout = new Error('timeout');
    (timeout as { code?: string }).code = 'ECONNABORTED';
    await expect(
      resolveTorrentEngineId('http://jackett.local/dl/file', {
        jackettBaseUrl: 'http://jackett.local',
        request: async () => {
          throw timeout;
        },
      }),
    ).rejects.toMatchObject({ message: 'The torrent download timed out.' });

    let calls = 0;
    await expect(
      resolveTorrentEngineId(
        'http://jackett.local/dl/file?jackett_apikey=SECRET',
        {
          jackettBaseUrl: 'http://jackett.local',
          request: async () => {
            calls += 1;
            return {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest' },
              body: Buffer.alloc(0),
            };
          },
        },
      ),
    ).rejects.toBeInstanceOf(TorrentInputError);
    expect(calls).toBe(1);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);

    const publicDownload = await resolveTorrentEngineId(
      'http://downloads.fixture/a.torrent',
      {
        lookup: async () => ['93.184.216.34'],
        request: async (url) => {
          expect(url).toBe('http://downloads.fixture/a.torrent');
          return { status: 200, headers: {}, body: torrentFile() };
        },
      },
    );
    expect(parseTorrent(publicDownload).infoHash).toBe(parsedFile.infoHash);
    await expect(
      resolveTorrentEngineId('http://downloads.fixture/a.torrent', {
        lookup: async () => ['10.1.2.3'],
        request: async () => {
          throw new Error('private address must not be fetched');
        },
      }),
    ).rejects.toBeInstanceOf(TorrentInputError);

    await expect(
      resolveTorrentEngineId('http://169.254.169.254/latest', {
        request: async () => {
          throw new Error('metadata fetch must not run');
        },
      }),
    ).rejects.toBeInstanceOf(TorrentInputError);
  });

  it('keeps both playback paths on the resolved engine id', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../packages/torrent-stream.plugin/src/index.ts'),
      'utf8',
    );
    expect(source.includes('getFiles(context.userId, torrent.link)')).toBe(
      false,
    );
    expect(source.match(/filesForRelease\(/g)).toHaveLength(2);
  });
});
