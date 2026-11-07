import { XMLParser } from 'fast-xml-parser';
import {
  findTorrentByStreamKey,
  getStreamCandidates,
  streamKeyFromItem,
} from '../../packages/torrent-stream.plugin/src/lib/jackett.api';
import type { JackettItem } from '../../packages/torrent-stream.plugin/src/lib/jackett.api';

const REPORTED_TITLE =
  'Менталист / The Mentalist (2008-2015) WEB-DL (S1-7E1-151 of 151) ТВ3';

function item(
  partial: Partial<JackettItem> & {
    attrs?: { '@_name': string; '@_value': string }[];
  },
): JackettItem {
  return {
    title: partial.title ?? '',
    guid: partial.guid ?? 'fixture-guid',
    jackettindexer: 'fixture',
    type: 'tv',
    comments: '',
    pubDate: '',
    size: partial.size ?? 1024,
    files: partial.files ?? 1,
    description: partial.title ?? '',
    link: 'fixture://not-a-download',
    category: [],
    enclosure: {
      url: 'fixture://not-a-download',
      length: 0,
      type: 'application/x-bittorrent',
    },
    'torznab:attr': partial.attrs ?? partial['torznab:attr'] ?? [],
  };
}

describe('torrent stream key identity', () => {
  const titles = [
    REPORTED_TITLE,
    'slash/name',
    '100% real',
    'a%20b',
    'what?',
    'hash#tag',
    'paren (2008)',
    'mix/%?#(字)',
  ];

  it('uses infohash when the indexer provides one', () => {
    const torrent = item({
      title: REPORTED_TITLE,
      attrs: [{ '@_name': 'infohash', '@_value': 'abcdef0123456789' }],
    });

    expect(streamKeyFromItem(torrent)).toBe('abcdef0123456789');
    expect(getStreamCandidates([torrent])[0].key).toBe('abcdef0123456789');
    expect(findTorrentByStreamKey([torrent], 'abcdef0123456789')).toBe(torrent);
    expect(findTorrentByStreamKey([torrent], REPORTED_TITLE)).toBeUndefined();
  });

  it('falls back to the title, then guid, and finds that same key', () => {
    for (const title of titles) {
      const torrent = item({ title, guid: 'guid-for-' + title });
      expect(streamKeyFromItem(torrent)).toBe(title);
      expect(getStreamCandidates([torrent])[0].key).toBe(title);
      expect(findTorrentByStreamKey([torrent], title)).toBe(torrent);
    }

    const guidOnly = item({ title: '', guid: 'only-guid' });
    expect(streamKeyFromItem(guidOnly)).toBe('only-guid');
    expect(findTorrentByStreamKey([guidOnly], 'only-guid')).toBe(guidOnly);
  });

  it('parses a synthetic indexer item without an infohash', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
  <title>${REPORTED_TITLE}</title>
  <guid>fixture-guid-1</guid>
  <size>2048</size>
  <link>fixture://not-a-download</link>
  <torznab:attr name="seeders" value="3" />
  <torznab:attr name="peers" value="1" />
</item></channel></rss>`;
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const raw = parsed?.rss?.channel?.item;
    const items = (Array.isArray(raw) ? raw : [raw]) as JackettItem[];

    expect(streamKeyFromItem(items[0])).toBe(REPORTED_TITLE);
    expect(getStreamCandidates(items)[0].key).toBe(REPORTED_TITLE);
    expect(findTorrentByStreamKey(items, REPORTED_TITLE)?.guid).toBe(
      'fixture-guid-1',
    );
  });
});
