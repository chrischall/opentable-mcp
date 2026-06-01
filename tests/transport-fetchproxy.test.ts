import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture the options the adapter passes to mcp-utils' createFetchproxyTransport.
// As of the @chrischall/mcp-utils adoption, FetchproxyServer construction +
// start/close lifecycle is owned by createFetchproxyTransport (and tested
// upstream in mcp-utils). All this repo's adapter has to do is wire its options
// through correctly and keep the opentable-specific fetch() mapping. We mock the
// mcp-utils subpath so we can assert exactly what opentable-mcp hands it.
const ctorCalls: unknown[] = [];

vi.mock('@chrischall/mcp-utils/fetchproxy', () => {
  return {
    createFetchproxyTransport: (opts: unknown) => {
      ctorCalls.push(opts);
      return {
        server: {
          request: () => Promise.resolve({ status: 200, body: '', url: '' }),
        },
        start: () => Promise.resolve(),
        close: () => Promise.resolve(),
        status: () => ({}),
        role: null,
      };
    },
  };
});

// Import AFTER vi.mock so the adapter picks up the fake.
const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');

beforeEach(() => {
  ctorCalls.length = 0;
});

describe('FetchproxyTransport constructor', () => {
  it('does NOT pass keepAliveIntervalMs (relies on the 0.10.0 server default of 25_000)', () => {
    // fetchproxy#71 / opentable-mcp#56 — round-3 #67 evidence showed the
    // reactive lazy-revive in 0.8.0 loses the race against Chrome's ~30s
    // SW eviction during real human-paced sessions. 0.9.0 added a
    // proactive ping (off by default for back-compat) which we opted into.
    // 0.10.0 makes 25_000 the server default (fetchproxy#72), so the
    // explicit opt-in is dropped — this assertion pins that we leave it to
    // the server rather than re-passing a redundant value.
    new FetchproxyTransport({ version: '9.9.9' });

    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]).not.toHaveProperty('keepAliveIntervalMs');
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
