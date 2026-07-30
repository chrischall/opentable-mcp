import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AVAILABILITY_GRAPHQL_OP_NAME } from '../src/client.js';

// Capture the options the adapter passes to mcp-utils' createFetchproxyTransport.
// As of the @chrischall/mcp-utils adoption, FetchproxyServer construction +
// start/close lifecycle is owned by createFetchproxyTransport (and tested
// upstream in mcp-utils). All this repo's adapter has to do is wire its options
// through correctly and keep the opentable-specific fetch() mapping. We mock the
// mcp-utils subpath so we can assert exactly what opentable-mcp hands it.
const ctorCalls: unknown[] = [];
const graphqlQueryMock = vi.fn().mockResolvedValue({ availability: [] });

vi.mock('@chrischall/mcp-utils/fetchproxy', () => {
  return {
    createFetchproxyTransport: (opts: unknown) => {
      ctorCalls.push(opts);
      return {
        server: {
          request: () => Promise.resolve({ status: 200, body: '', url: '' }),
          graphqlQuery: graphqlQueryMock,
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
  graphqlQueryMock.mockClear();
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

  it("declares the 'graphql' capability + graphqlOps for RestaurantsAvailability", () => {
    // @fetchproxy/server 1.7.0+: routes find_slots through the tab's own
    // Apollo client instead of the isolated-world fetch() path Akamai
    // rejects for this endpoint. AVAILABILITY_GRAPHQL_OP_NAME is the
    // single source of truth reservations.ts also imports, so the two
    // never drift apart.
    new FetchproxyTransport({ version: '1.2.3' });

    expect(ctorCalls[0]).toMatchObject({
      capabilities: ['fetch', 'graphql'],
      graphqlOps: [
        { name: AVAILABILITY_GRAPHQL_OP_NAME, operationName: 'RestaurantsAvailability' },
      ],
    });
  });
});

describe('FetchproxyTransport.graphqlQuery', () => {
  it('delegates to the underlying server.graphqlQuery with name + variables', async () => {
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    const result = await transport.graphqlQuery({
      name: AVAILABILITY_GRAPHQL_OP_NAME,
      variables: { restaurantIds: [42], partySize: 2 },
    });

    expect(graphqlQueryMock).toHaveBeenCalledWith({
      name: AVAILABILITY_GRAPHQL_OP_NAME,
      variables: { restaurantIds: [42], partySize: 2 },
    });
    expect(result).toEqual({ availability: [] });
  });
});
