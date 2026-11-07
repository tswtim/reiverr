/**
 * Same ts-node load as production. torrent-stream is replaced after the real
 * parse-torrent call, so peers are never opened, but an http id still throws
 * the real "Invalid torrent identifier".
 */
require('ts-node/register');

const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const parseTorrent = require('parse-torrent');

const seen = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'torrent-stream') {
    return function torrentStream(link) {
      let parsed;
      try {
        parsed = parseTorrent(link);
      } catch (error) {
        if (error && error.message === 'Invalid torrent identifier') {
          seen.push('invalid-identifier');
        } else {
          seen.push('parse-error');
        }
        throw error;
      }
      seen.push(parsed && parsed.infoHash ? 'accepted' : 'no-hash');
      const engine = new EventEmitter();
      engine.files = [{ name: 'fixture.mkv' }];
      engine.infoHash = parsed.infoHash;
      engine.remove = (_keep, cb) => cb && cb();
      engine.destroy = (cb) => cb && cb();
      process.nextTick(() => engine.emit('ready'));
      return engine;
    };
  }
  return originalRequire.apply(this, arguments);
};

const cacheFile = process.env.TORRENT_STREAM_CACHE_FILE;
const before = fs.readFileSync(cacheFile);
const manager = require(process.env.TORRENT_MANAGER_PATH);
const { filesForRelease } = require(process.env.TORRENT_ID_PATH);
const item = JSON.parse(fs.readFileSync(process.env.ITEM_PATH, 'utf8'));
const torrentBytes = fs.readFileSync(process.env.TORRENT_BYTES_PATH);

setTimeout(async () => {
  const afterStartup = fs.readFileSync(cacheFile);
  let reason = '';
  let played = false;
  try {
    await filesForRelease(
      item,
      {
        jackettBaseUrl: process.env.JACKETT_BASE,
        request: async () => ({ status: 200, headers: {}, body: torrentBytes }),
      },
      (id) => manager.getFiles(process.env.USER_ID, id),
    );
    played = true;
  } catch (error) {
    reason = error && error.reason ? error.reason : error && error.name;
  }
  const afterPlay = fs.readFileSync(cacheFile);
  fs.writeFileSync(
    process.env.TORRENT_STARTUP_RESULT,
    JSON.stringify({
      startupSame: before.equals(afterStartup),
      played,
      reason,
      seen,
      secretAfterStartup: afterStartup
        .toString('utf8')
        .includes(process.env.SECRET_MARKER),
      secretAfterPlay: afterPlay
        .toString('utf8')
        .includes(process.env.SECRET_MARKER),
    }),
  );
  process.exit(0);
}, 50);
