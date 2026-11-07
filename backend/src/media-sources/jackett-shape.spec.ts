import { XMLParser } from 'fast-xml-parser';
import {
  describeReleaseItem,
  filesForRelease,
  formatTorrentReject,
  resolveTorrentEngineId,
  selectTorrentLocator,
  TorrentInputError,
} from '../../packages/torrent-stream.plugin/src/lib/torrent-id';
import type { JackettItem } from '../../packages/torrent-stream.plugin/src/lib/jackett.api';

const parser = new XMLParser({ ignoreAttributes: false });
const SECRET =
  /SECRET|jackett_apikey|magnet:\?|http:\/\/|Fixture Name|aaaaaaaa/i;

function itemFrom(xml: string): JackettItem {
  const parsed = parser.parse(xml);
  const item = parsed?.rss?.channel?.item;
  return (Array.isArray(item) ? item[0] : item) as JackettItem;
}

const nnm = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel><item>
<title>Fixture Name</title>
<guid>http://tracker.fixture/viewtopic.php?t=1</guid>
<jackettindexer id="noname-club">NoNaMeClub (Public)</jackettindexer>
<link>http://host.docker.internal:9117/dl/noname-club/?jackett_apikey=SECRET&amp;path=abc&amp;file=Fixture%20Name.torrent</link>
<enclosure url="http://host.docker.internal:9117/dl/noname-club/?jackett_apikey=SECRET&amp;path=abc&amp;file=Fixture%20Name.torrent" length="10" type="application/x-bittorrent"/>
<torznab:attr name="seeders" value="2"/>
<torznab:attr name="peers" value="1"/>
<torznab:attr name="downloadvolumefactor" value="0"/>
</item></channel></rss>`;

const localhostLink = nnm.replace(/host\.docker\.internal/g, '127.0.0.1');

const withHash = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
<title>Fixture Name</title>
<link>http://host.docker.internal:9117/dl/x?jackett_apikey=SECRET</link>
<torznab:attr name="infohash" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/>
<torznab:attr name="magneturl" value="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/>
<torznab:attr name="seeders" value="1"/>
</item></channel></rss>`;

const relative = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
<title>Fixture Name</title>
<link>download.php?id=15</link>
<enclosure url="download.php?id=15" type="application/x-bittorrent"/>
<torznab:attr name="seeders" value="1"/>
<torznab:attr name="peers" value="0"/>
</item></channel></rss>`;

const oneAttr = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
<title>Fixture Name</title>
<link>http://host.docker.internal:9117/dl/x?jackett_apikey=SECRET</link>
<torznab:attr name="seeders" value="1"/>
</item></channel></rss>`;

const base =
  'http://host.docker.internal:9117/api/v2.0/indexers/all/results/torznab/';

async function outcome(
  item: JackettItem,
  lookup?: (host: string) => Promise<string[]>,
) {
  let fetched = false;
  try {
    await resolveTorrentEngineId(selectTorrentLocator(item), {
      jackettBaseUrl: base,
      lookup,
      request: async () => {
        fetched = true;
        return { status: 200, headers: {}, body: Buffer.from('not-a-torrent') };
      },
    });
    return { fetched, reason: 'ok', message: '' };
  } catch (error) {
    return {
      fetched,
      reason:
        error instanceof TorrentInputError
          ? error.reason
          : (error as Error).name,
      message: error instanceof Error ? error.message : '',
    };
  }
}

describe('Jackett torznab item contract', () => {
  it('fetches an encoded NoNaMeClub download link and does not use the observed pre-fetch message', async () => {
    const item = itemFrom(nnm);
    const result = await outcome(item);
    expect(result.fetched).toBe(true);
    expect(result.reason).toBe('not-torrent');
    expect(result.message).toBe('The downloaded file is not a torrent.');
    const described = JSON.stringify(describeReleaseItem(item));
    expect(described).not.toMatch(SECRET);
    expect(described).toContain('"link":"http"');
    expect(described).toContain('"enclosure":"http"');
    expect(described).toContain('"magnetAttr":false');
    expect(described).toContain('"infohashAttr":false');
  });

  it('rejects a download host that is not the configured Jackett host before fetching', async () => {
    const result = await outcome(itemFrom(localhostLink), async () => [
      '127.0.0.1',
    ]);
    expect(result.fetched).toBe(false);
    expect(result.reason).toBe('download-rejected');
    expect(result.message).toBe('The torrent download was rejected.');
  });

  it('uses magneturl and does not fetch when infohash and magnet are present', async () => {
    const result = await outcome(itemFrom(withHash));
    expect(result).toEqual({ fetched: false, reason: 'ok', message: '' });
  });

  it('does not treat a relative download.php link as an http locator', async () => {
    const result = await outcome(itemFrom(relative));
    expect(result.fetched).toBe(false);
    expect(result.reason).toBe('empty');
    expect(result.message).toBe('The release did not include a torrent link.');
  });

  it('logs only a reason code when a single torznab attr is not an array', async () => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    let thrown: Error | undefined;
    try {
      await filesForRelease(
        itemFrom(oneAttr),
        { jackettBaseUrl: base },
        async () => [],
      );
    } catch (error) {
      thrown = error as Error;
    } finally {
      console.error = original;
    }
    expect(thrown?.name).toBe('TypeError');
    const line = logs.find((entry) => entry.startsWith('torrent-reject'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(SECRET);
    expect(line).toContain('"reason":"exception"');
    expect(line).toContain('"attrShape":"object"');
    expect(formatTorrentReject(itemFrom(nnm), 'not-torrent')).not.toMatch(
      SECRET,
    );
  });
});
