import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as parseTorrent from 'parse-torrent';

const HASH = 'ab'.repeat(20);
const ASYNC_FAIL_HASH = 'cd'.repeat(20);
const GOOD_LINK = `magnet:?xt=urn:btih:${HASH}`;
const ASYNC_LINK = `magnet:?xt=urn:btih:${ASYNC_FAIL_HASH}`;
const BAD_LINK =
  'http://jackett.local/dl/fixture?jackett_apikey=SECRET-FIXTURE';
const SECRET = /SECRET-FIXTURE|jackett_apikey|magnet:\?|http:\/\//i;

const managerPath = path.join(
  __dirname,
  '../../packages/torrent-stream.plugin/src/lib/torrent-manager.ts',
);
const runnerPath = path.join(__dirname, 'torrent-startup-runner.js');

function mixedCache() {
  const now = Date.now();
  return {
    'user-http': {
      userId: 'user-http',
      infoHash: BAD_LINK,
      lastAccessed: now,
    },
    'user-empty': { userId: 'user-empty', infoHash: '', lastAccessed: now },
    'user-other': {
      userId: 'user-other',
      infoHash: 'not a torrent id',
      lastAccessed: now,
    },
    'user-magnet': {
      userId: 'user-magnet',
      infoHash: GOOD_LINK,
      lastAccessed: now,
    },
    'user-hash': { userId: 'user-hash', infoHash: HASH, lastAccessed: now },
    'user-async': {
      userId: 'user-async',
      infoHash: ASYNC_LINK,
      lastAccessed: now,
    },
  };
}

function runStartup(cacheBody: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reiverr-torrent-cache-'));
  const cacheFile = path.join(dir, 'stream-cache.json');
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(cacheFile, cacheBody);
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 8000,
    env: {
      ...process.env,
      TORRENT_STREAM_CACHE_FILE: cacheFile,
      TORRENT_STARTUP_RESULT: reportFile,
      TORRENT_MANAGER_PATH: managerPath,
      BAD_LINK,
      BAD_MARKER: 'SECRET-FIXTURE',
      GOOD_LINK,
      ASYNC_FAIL_HASH,
    },
  });
  const report = fs.existsSync(reportFile)
    ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    : undefined;
  return { ...result, cacheFile, dir, report };
}

describe('persisted torrent startup', () => {
  jest.setTimeout(20000);

  function crashWith(source: string) {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reiverr-torrent-crash-'),
    );
    const script = path.join(dir, 'crash.js');
    fs.writeFileSync(script, source);
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        BAD_LINK,
        NODE_PATH: path.join(__dirname, '../../node_modules'),
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  it('crashes the process when an http id is restored as a floating promise', () => {
    const direct = crashWith(`require('parse-torrent')(process.env.BAD_LINK);`);
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toContain('Invalid torrent identifier');
    expect(direct.stderr).not.toMatch(SECRET);

    const floating = crashWith(
      `new Promise(() => { require('parse-torrent')(process.env.BAD_LINK); });`,
    );
    expect(floating.status).not.toBe(0);
    expect(floating.stderr).toContain('Invalid torrent identifier');
    expect(floating.stderr).not.toMatch(SECRET);
  });

  it('loads mixed persisted state through ts-node without writing or exiting', () => {
    expect(parseTorrent(GOOD_LINK).infoHash).toBe(HASH);
    const started = runStartup(JSON.stringify(mixedCache()));
    expect(started.status).toBe(0);
    expect(`${started.stderr}\n${started.stdout}`).not.toMatch(SECRET);
    const report = started.report;
    expect(report).toEqual({
      startupSame: true,
      badRequestSame: true,
      badName: 'TorrentInputError',
      goodCount: 1,
      badRecordRemains: true,
    });
    const logs = `${started.stderr}\n${started.stdout}`;
    expect(logs).toContain('skipped persisted torrent http');
    expect(logs).toContain('skipped persisted torrent empty');
    expect(logs).toContain('initializing old torrent magnet');
    expect(logs).toContain('initializing old torrent hash');
    expect(logs).toContain('torrent engine failed magnet EFAKE');
    fs.rmSync(started.dir, { recursive: true, force: true });
  });

  it('does not rewrite an unreadable cache file', () => {
    const started = runStartup('{');
    expect(started.status).toBe(0);
    expect(`${started.stderr}\n${started.stdout}`).toContain(
      'torrent cache unreadable',
    );
    expect(`${started.stderr}\n${started.stdout}`).not.toMatch(SECRET);
    const report = started.report;
    expect(report.startupSame).toBe(true);
    expect(report.badRequestSame).toBe(true);
    expect(report.badName).toBe('TorrentInputError');
    expect(report.goodCount).toBe(1);
    expect(fs.readFileSync(started.cacheFile, 'utf8')).toBe('{');
    fs.rmSync(started.dir, { recursive: true, force: true });
  });
});
