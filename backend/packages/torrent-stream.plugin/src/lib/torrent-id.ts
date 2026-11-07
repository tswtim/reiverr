import axios from 'axios';
import { lookup as dnsLookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { getTorrentAttribute, JackettItem } from './jackett.api';

// parse-torrent is the CJS contract torrent-stream 1.2.1 actually calls.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parseTorrent = require('parse-torrent') as (id: string | Buffer) => {
  infoHash?: string;
  announce?: string[];
};

/**
 * parse-torrent (the copy torrent-stream 1.2.1 calls) accepts a magnet URI,
 * a 32/40 character info hash, a torrent-file Buffer, or an already parsed
 * object. An http(s) Jackett download link is none of those and throws
 * "Invalid torrent identifier" before any bytes are written.
 */
export class TorrentInputError extends Error {
  readonly reason: string;

  constructor(message: string, reason = 'torrent-input') {
    super(message);
    this.name = 'TorrentInputError';
    this.reason = reason;
  }
}

const MAX_TORRENT_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
blockedAddresses.addSubnet('192.0.2.0', 24, 'ipv4');
blockedAddresses.addSubnet('198.51.100.0', 24, 'ipv4');
blockedAddresses.addSubnet('203.0.113.0', 24, 'ipv4');
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
blockedAddresses.addAddress('255.255.255.255', 'ipv4');
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');

export type HostLookup = (hostname: string) => Promise<string[]>;

export type TorrentHttpResponse = {
  status: number;
  headers: { location?: string | string[] };
  body?: Uint8Array;
};

export type TorrentHttpRequest = (url: string) => Promise<TorrentHttpResponse>;

export type ResolveOptions = {
  jackettBaseUrl?: string;
  lookup?: HostLookup;
  request?: TorrentHttpRequest;
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isMagnet(value: string): boolean {
  return /^magnet:\?/i.test(value);
}

function isInfoHash(value: string): boolean {
  return /^[a-fA-F0-9]{40}$/.test(value) || /^[A-Z2-7]{32}$/i.test(value);
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  const family = isIP(normalized);
  if (family === 0) return true;
  return blockedAddresses.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

function jackettHostname(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
}

export async function assertTorrentUrlAllowed(
  url: URL,
  options: ResolveOptions = {},
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TorrentInputError(
      'The torrent download was rejected.',
      'download-rejected',
    );
  }
  if (url.username || url.password) {
    throw new TorrentInputError(
      'The torrent download was rejected.',
      'download-rejected',
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new TorrentInputError(
      'The torrent download was rejected.',
      'download-rejected',
    );
  }
  if (hostname === jackettHostname(options.jackettBaseUrl)) return;

  const lookup = options.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await lookup(hostname);
  } catch {
    throw new TorrentInputError(
      'The torrent download was rejected.',
      'download-rejected',
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => isBlockedAddress(address))
  ) {
    throw new TorrentInputError(
      'The torrent download was rejected.',
      'download-rejected',
    );
  }
}

function stripKeyOnHostChange(next: URL, previousHost: string) {
  if (next.host === previousHost) return;
  next.searchParams.delete('apikey');
  next.searchParams.delete('jackett_apikey');
}

function magnetFromParsed(parsed: {
  infoHash?: string;
  announce?: string[];
}): string {
  const infoHash = clean(parsed.infoHash).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    throw new TorrentInputError(
      'The downloaded file is not a torrent.',
      'not-torrent',
    );
  }
  const trackers = (parsed.announce ?? []).filter(
    (tracker) =>
      typeof tracker === 'string' &&
      /^https?:\/\//i.test(tracker) &&
      !/api[_-]?key/i.test(tracker),
  );
  let magnet = `magnet:?xt=urn:btih:${infoHash}`;
  for (const tracker of trackers) {
    magnet += `&tr=${encodeURIComponent(tracker)}`;
  }
  return magnet;
}

function asInputError(error: unknown): TorrentInputError {
  if (error instanceof TorrentInputError) return error;
  const code = (error as { code?: string } | undefined)?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new TorrentInputError(
      'The torrent download timed out.',
      'download-timeout',
    );
  }
  return new TorrentInputError(
    'The torrent download was rejected.',
    'download-rejected',
  );
}

async function defaultRequest(url: string): Promise<TorrentHttpResponse> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_TORRENT_BYTES,
      maxBodyLength: MAX_TORRENT_BYTES,
      validateStatus: () => true,
      headers: {
        Accept: 'application/x-bittorrent, application/octet-stream, */*',
      },
    });
    return {
      status: response.status,
      headers: { location: response.headers.location },
      body: Buffer.from(response.data ?? new ArrayBuffer(0)),
    };
  } catch (error) {
    throw asInputError(error);
  }
}

async function downloadTorrent(
  start: URL,
  options: ResolveOptions,
): Promise<Buffer> {
  const request = options.request ?? defaultRequest;
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertTorrentUrlAllowed(current, options);
    let response: TorrentHttpResponse;
    try {
      response = await request(current.toString());
    } catch (error) {
      throw asInputError(error);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location;
      if (!location || hop === MAX_REDIRECTS) {
        throw new TorrentInputError(
          'The torrent download was rejected.',
          'download-rejected',
        );
      }
      const next = new URL(location, current);
      stripKeyOnHostChange(next, current.host);
      current = next;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      throw new TorrentInputError(
        'The torrent download was rejected.',
        'download-rejected',
      );
    }
    const body = Buffer.from(response.body);
    if (body.length === 0 || body.length > MAX_TORRENT_BYTES) {
      throw new TorrentInputError(
        'The torrent download was rejected.',
        'download-rejected',
      );
    }
    return body;
  }
  throw new TorrentInputError(
    'The torrent download was rejected.',
    'download-rejected',
  );
}

/**
 * Magnet URL, info hash, or Jackett http(s) .torrent link -> an identifier
 * parse-torrent accepts. The result never includes a Jackett API key.
 */
export async function resolveTorrentEngineId(
  locator: string,
  options: ResolveOptions = {},
): Promise<string> {
  const value = clean(locator);
  if (!value) {
    throw new TorrentInputError(
      'The release did not include a torrent link.',
      'empty',
    );
  }
  if (isMagnet(value) || isInfoHash(value)) {
    try {
      parseTorrent(value);
    } catch {
      throw new TorrentInputError(
        'The release link is not a magnet, info hash, or torrent file.',
        isMagnet(value) ? 'magnet-parse' : 'hash-parse',
      );
    }
    return isInfoHash(value) ? value.toLowerCase() : value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TorrentInputError(
      'The release link is not a magnet, info hash, or torrent file.',
      'url-parse',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TorrentInputError(
      'The release link is not a magnet, info hash, or torrent file.',
      'url-scheme',
    );
  }
  const body = await downloadTorrent(url, options);
  try {
    return magnetFromParsed(parseTorrent(body));
  } catch (error) {
    if (error instanceof TorrentInputError) throw error;
    throw new TorrentInputError(
      'The downloaded file is not a torrent.',
      'not-torrent',
    );
  }
}

export function locatorKind(value: unknown): string {
  if (typeof value !== 'string') {
    if (value == null) return 'missing';
    return Array.isArray(value) ? 'array' : 'nonstring';
  }
  const text = value.trim();
  if (!text) return 'empty';
  if (/^magnet:\?/i.test(text)) return 'magnet';
  if (/^[a-f0-9]{40}$/i.test(text) || /^[a-z2-7]{32}$/i.test(text))
    return 'hash';
  if (/^https?:\/\//i.test(text)) return 'http';
  return 'other';
}

function safeAttrName(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value)
    ? value.toLowerCase()
    : '';
}

/** Presence only. Values, hosts, queries, titles, and hashes are omitted. */
export function describeReleaseItem(item: JackettItem): {
  link: string;
  enclosure: string;
  magnetAttr: boolean;
  infohashAttr: boolean;
  attrShape: 'missing' | 'array' | 'object' | 'other';
  attrNames: string[];
} {
  const attr = item?.['torznab:attr'] as unknown;
  let attrShape: 'missing' | 'array' | 'object' | 'other' = 'missing';
  const attrNames: string[] = [];
  let magnetAttr = false;
  let infohashAttr = false;
  const take = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const name = safeAttrName(record['@_name']);
    const present =
      record['@_value'] != null && `${record['@_value']}`.trim() !== '';
    if (name) attrNames.push(name);
    if (name === 'magneturl' && present) magnetAttr = true;
    if (name === 'infohash' && present) infohashAttr = true;
  };
  if (Array.isArray(attr)) {
    attrShape = 'array';
    attr.forEach(take);
  } else if (attr && typeof attr === 'object') {
    attrShape = 'object';
    take(attr);
  } else if (attr != null) {
    attrShape = 'other';
  }
  const enclosure = item?.enclosure as
    | { url?: unknown; '@_url'?: unknown }
    | undefined;
  const enclosureValue =
    typeof enclosure?.url === 'string' ? enclosure.url : enclosure?.['@_url'];
  return {
    link: locatorKind(item?.link),
    enclosure: locatorKind(enclosureValue),
    magnetAttr,
    infohashAttr,
    attrShape,
    attrNames: attrNames.slice(0, 20),
  };
}

export function formatTorrentReject(item: JackettItem, reason: string): string {
  return `torrent-reject ${JSON.stringify({ reason, ...describeReleaseItem(item) })}`;
}

export function selectTorrentLocator(item: JackettItem): string {
  const magnet = clean(getTorrentAttribute(item, 'magneturl'));
  const infohash = clean(getTorrentAttribute(item, 'infohash'));
  const link = clean(item.link);
  const enclosure = clean(item.enclosure?.url);
  if (isMagnet(magnet)) return magnet;
  if (isInfoHash(infohash)) return infohash;
  if (isMagnet(link) || isInfoHash(link)) return link;
  if (isMagnet(enclosure) || isInfoHash(enclosure)) return enclosure;
  if (/^https?:\/\//i.test(link)) return link;
  if (/^https?:\/\//i.test(enclosure)) return enclosure;
  return '';
}

export async function filesForRelease<T>(
  item: JackettItem,
  options: ResolveOptions,
  loadFiles: (engineId: string) => Promise<T>,
): Promise<{ engineId: string; files: T }> {
  try {
    const engineId = await resolveTorrentEngineId(
      selectTorrentLocator(item),
      options,
    );
    return { engineId, files: await loadFiles(engineId) };
  } catch (error) {
    const reason =
      error instanceof TorrentInputError ? error.reason : 'exception';
    try {
      console.error(formatTorrentReject(item, reason));
    } catch {
      console.error('torrent-reject', JSON.stringify({ reason }));
    }
    throw error;
  }
}
