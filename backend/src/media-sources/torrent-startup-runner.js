/**
 * Production-shaped startup: ts-node loads torrent-manager.ts, which builds
 * EngineCache at import time. torrent-stream is replaced with a double that
 * still calls the real parse-torrent, so an http id throws the real
 * "Invalid torrent identifier" and no peer connection is opened.
 */
require('ts-node/register');

const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const parseTorrent = require('parse-torrent');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'torrent-stream') {
    return function torrentStream(link) {
      const parsed = parseTorrent(link);
      const engine = new EventEmitter();
      engine.files = [{ name: 'fixture.mkv' }];
      engine.remove = (_keep, cb) => cb && cb();
      engine.destroy = (cb) => cb && cb();
      if (parsed.infoHash === process.env.ASYNC_FAIL_HASH) {
        process.nextTick(() => {
          const error = new Error('engine failed');
          error.code = 'EFAKE';
          engine.emit('error', error);
        });
        return engine;
      }
      process.nextTick(() => engine.emit('ready'));
      return engine;
    };
  }
  return originalRequire.apply(this, arguments);
};

const cacheFile = process.env.TORRENT_STREAM_CACHE_FILE;
const before = fs.readFileSync(cacheFile);
const manager = require(process.env.TORRENT_MANAGER_PATH);

setTimeout(async () => {
  const afterStartup = fs.readFileSync(cacheFile);
  let badName = '';
  try {
    await manager.getFiles('startup-check-bad', process.env.BAD_LINK);
    badName = 'resolved';
  } catch (error) {
    badName = error && error.name ? error.name : 'error';
  }
  const afterBad = fs.readFileSync(cacheFile);
  let goodCount = -1;
  try {
    const files = await manager.getFiles(
      'startup-check-good',
      process.env.GOOD_LINK,
    );
    goodCount = Array.isArray(files) ? files.length : -1;
  } catch {
    goodCount = -2;
  }
  const afterGood = fs.readFileSync(cacheFile);
  const saved = afterGood.toString('utf8');
  fs.writeFileSync(
    process.env.TORRENT_STARTUP_RESULT,
    JSON.stringify({
      startupSame: before.equals(afterStartup),
      badRequestSame: before.equals(afterBad),
      badName,
      goodCount,
      badRecordRemains: saved.includes(process.env.BAD_MARKER),
    }),
  );
  process.exit(0);
}, 50);
