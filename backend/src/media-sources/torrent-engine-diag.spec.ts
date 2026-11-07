import { EventEmitter } from 'events';
import { watchTorrentEngine } from '../../packages/torrent-stream.plugin/src/lib/torrent-manager';

function engine() {
  const emitter = new EventEmitter();
  const swarm = {
    wires: [] as object[],
    connections: [] as object[],
    downloaded: 0,
    queued: 0,
    _destroyed: false,
  };
  let destroyed = false;
  return Object.assign(emitter, {
    swarm,
    destroy(cb?: () => void) {
      destroyed = true;
      swarm._destroyed = true;
      if (cb) cb();
    },
    wasDestroyed: () => destroyed,
  });
}

function logsOf(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(' '));
  };
  try {
    run();
  } finally {
    console.info = original;
  }
  return lines;
}

describe('torrent engine diagnostics', () => {
  it('counts existing events and marks missing DHT, tracker, and speed', async () => {
    const target = engine();
    const lines: string[] = [];
    const original = console.info;
    console.info = (...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(' '));
    };
    let clock = 0;
    const watched = watchTorrentEngine(target, {
      intervalMs: 20,
      maxMs: 50,
      now: () => clock,
    });
    target.emit('ready');
    target.emit('peer', '203.0.113.8:6881');
    target.emit('blocked-peer', '203.0.113.9:6881');
    target.swarm.wires.push({});
    target.swarm.connections.push({});
    target.swarm.downloaded = 116;
    await new Promise((resolve) => setTimeout(resolve, 30));
    clock = 50;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setTimeout(resolve, 30));
    console.info = original;
    watched.stop();
    const text = lines.join('\n');
    expect(text).toContain('peerEvents=1');
    expect(text).toContain('blockedPeerEvents=1');
    expect(text).toContain('wires=1');
    expect(text).toContain('connections=1');
    expect(text).toContain('downloaded=116');
    expect(text).toContain('ready=yes');
    expect(text).toContain('active=yes');
    expect(text).toContain('speed=unavailable');
    expect(text).toContain('dht=unavailable');
    expect(text).toContain('tracker=unavailable');
    expect(text).toContain('reason=limit');
    expect(text).not.toContain('203.0.113');
    expect(
      lines.filter((line) => line.includes('reason=interval')).length,
    ).toBe(1);
  });

  it('stops the timer on destroy and does not log raw errors', () => {
    const target = engine();
    const lines = logsOf(() => {
      watchTorrentEngine(target, { intervalMs: 10_000, maxMs: 120_000 });
      target.emit(
        'error',
        Object.assign(new Error('http://tracker.example/secret'), {
          code: 'ECONNRESET',
        }),
      );
      target.emit('peer', '198.51.100.4:6881');
    });
    const text = lines.join('\n');
    expect(text).toContain('reason=error code=ECONNRESET');
    expect(text).not.toContain('http://');
    expect(text).not.toContain('198.51.100');
    expect(text).not.toContain('secret');
    expect(target.wasDestroyed()).toBe(false);
  });

  it('unrefs the interval and still calls the original destroy', () => {
    const target = engine();
    const timers: NodeJS.Timeout[] = [];
    const original = global.setInterval;
    global.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = original(...args) as NodeJS.Timeout;
      timers.push(timer);
      return timer;
    }) as typeof setInterval;
    try {
      watchTorrentEngine(target, { intervalMs: 60_000, maxMs: 120_000 });
      expect(timers).toHaveLength(1);
      expect(timers[0].hasRef()).toBe(false);
      target.destroy();
      expect(target.wasDestroyed()).toBe(true);
    } finally {
      global.setInterval = original;
      timers.forEach((timer) => clearInterval(timer));
    }
  });
});
