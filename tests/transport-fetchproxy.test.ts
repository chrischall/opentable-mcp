import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture the options the adapter passes to FetchproxyServer's constructor.
// We don't exercise the real WebSocket here — the FetchproxyServer surface
// itself is owned (and tested) upstream in @fetchproxy/server. All we care
// about is that the adapter wires its options through correctly.
const ctorCalls: unknown[] = [];

vi.mock('@fetchproxy/server', () => {
  class FakeFetchproxyServer {
    constructor(opts: unknown) {
      ctorCalls.push(opts);
    }
    listen() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    request() {
      return Promise.resolve({ status: 200, body: '', url: '' });
    }
  }
  return { FetchproxyServer: FakeFetchproxyServer };
});

// Import AFTER vi.mock so the adapter picks up the fake.
const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');

beforeEach(() => {
  ctorCalls.length = 0;
});

describe('FetchproxyTransport constructor', () => {
  it('opts into proactive keep-alive by passing keepAliveIntervalMs: 25_000', () => {
    // fetchproxy#71 / opentable-mcp#56 — round-3 #67 evidence shows the
    // reactive lazy-revive in 0.8.0 loses the race against Chrome's ~30s
    // SW eviction during real human-paced sessions. 0.9.0 added a
    // proactive ping (off by default for back-compat); this assertion
    // pins the opentable-mcp opt-in so a future refactor can't silently
    // drop it.
    new FetchproxyTransport({ version: '9.9.9' });

    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]).toMatchObject({ keepAliveIntervalMs: 25_000 });
  });

  it('wires through serverName, version, and the opentable domain', () => {
    new FetchproxyTransport({ version: '1.2.3' });

    expect(ctorCalls[0]).toMatchObject({
      serverName: 'opentable-mcp',
      version: '1.2.3',
      domains: ['opentable.com'],
      port: 37149,
    });
  });

  it('honors an explicit port and server name override', () => {
    new FetchproxyTransport({ version: '1.2.3', port: 40000, server: 'custom' });

    expect(ctorCalls[0]).toMatchObject({
      serverName: 'custom',
      port: 40000,
    });
  });
});
