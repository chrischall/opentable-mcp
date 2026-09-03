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
const requestMock = vi.fn().mockResolvedValue({ status: 200, body: '', url: '' });

vi.mock('@chrischall/mcp-utils/fetchproxy', () => {
  return {
    createFetchproxyTransport: (opts: unknown) => {
      ctorCalls.push(opts);
      return {
        server: {
          request: requestMock,
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
const { FetchproxyTransport, WRITE_RELAY_TAB_PREFIXES } = await import(
  '../src/transport-fetchproxy.js'
);
const { FetchproxyNoTabError } = await import('@fetchproxy/server');

beforeEach(() => {
  ctorCalls.length = 0;
  graphqlQueryMock.mockClear();
  requestMock.mockReset();
  requestMock.mockResolvedValue({ status: 200, body: '', url: '' });
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

  it("declares exactly the 'fetch' + 'graphql' capabilities + graphqlOps for RestaurantsAvailability", () => {
    // @fetchproxy/server 1.7.0+: routes find_slots through the tab's own
    // Apollo client instead of the isolated-world fetch() path Akamai
    // rejects for this endpoint. AVAILABILITY_GRAPHQL_OP_NAME is the
    // single source of truth reservations.ts also imports, so the two
    // never drift apart.
    //
    // `fetch_in_page` is deliberately ABSENT. 0.18.1 declared it on the
    // theory that OpenTable's edge 403s GraphQL mutations from the isolated
    // world; the live comparison on 2026-09-02 showed the 403 came from the
    // relay TAB (one without `window.__CSRF_TOKEN__`, so no x-csrf-token
    // header), and the same mutation passes from the isolated world through
    // a CSRF-bearing tab. Writes now pin the relay tab instead — see the
    // fetch() tests below — and the MAIN-world routing (which hands page
    // script the request, CSRF header included) is gone.
    new FetchproxyTransport({ version: '1.2.3' });

    // Asserted EXACTLY, not with `arrayContaining`: this is the set the user
    // approves at pair time, and a capability appearing here without someone
    // updating this line is precisely the drift worth failing on.
    expect(ctorCalls[0]).toMatchObject({
      capabilities: ['fetch', 'graphql'],
      graphqlOps: [
        { name: AVAILABILITY_GRAPHQL_OP_NAME, operationName: 'RestaurantsAvailability' },
      ],
    });
  });
});

describe('FetchproxyTransport.fetch — write relay tab', () => {
  // OpenTable's write endpoints (GraphQL mutations AND the REST booking
  // POST) need the `x-csrf-token` header. The extension injects it from the
  // relay tab's `window.__CSRF_TOKEN__`, which only OpenTable's app pages
  // define — the homepage and search pages don't. fetchproxy's default relay
  // is the FIRST tab on the host in Chrome's tab order, so a user whose
  // oldest OpenTable tab is the homepage got every write 403'd (the 0.18.x
  // symptom). Writes therefore name a relay tab explicitly, walking a list
  // of app-page prefixes and falling back to the default only when none is
  // open. GETs (SSR pages) need no CSRF and keep the default relay.
  const relayCalls = () => requestMock.mock.calls.map((c) => (c[2] as { viaTab?: string }).viaTab);

  it('relays a POST through a restaurant-profile tab first', async () => {
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await transport.fetch({ path: '/dapi/fe/gql?opname=X', method: 'POST', body: '{}' });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe('POST');
    expect(requestMock.mock.calls[0][1]).toBe('/dapi/fe/gql?opname=X');
    expect(requestMock.mock.calls[0][2]).toMatchObject({
      subdomain: 'www',
      body: '{}',
      viaTab: 'https://www.opentable.com/r/',
    });
  });

  it('walks the prefix list when no tab matches, then falls back to the default relay', async () => {
    requestMock.mockImplementation(async (_m: string, _p: string, opts: { viaTab?: string }) => {
      if (opts.viaTab !== undefined) throw new FetchproxyNoTabError(`no tab matching ${opts.viaTab}`);
      return { status: 204, body: '', url: 'https://www.opentable.com/dapi/wishlist/add' };
    });
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    const result = await transport.fetch({ path: '/dapi/wishlist/add', method: 'POST', body: '{}' });

    expect(result.status).toBe(204);
    expect(relayCalls()).toEqual([...WRITE_RELAY_TAB_PREFIXES, undefined]);
  });

  it('stops at the first prefix that has a tab', async () => {
    requestMock.mockImplementation(async (_m: string, _p: string, opts: { viaTab?: string }) => {
      if (opts.viaTab === 'https://www.opentable.com/r/') {
        throw new FetchproxyNoTabError('no tab matching https://www.opentable.com/r/');
      }
      return { status: 200, body: '{}', url: 'https://www.opentable.com/x' };
    });
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await transport.fetch({ path: '/x', method: 'DELETE' });

    expect(relayCalls()).toEqual(['https://www.opentable.com/r/', 'https://www.opentable.com/booking/']);
  });

  it('does not swallow other bridge errors while walking the list', async () => {
    requestMock.mockRejectedValue(new Error('extension offline'));
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await expect(transport.fetch({ path: '/x', method: 'POST', body: '{}' })).rejects.toThrow(
      'extension offline'
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('leaves GETs on the default relay tab', async () => {
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await transport.fetch({ path: '/user/dining-dashboard', method: 'GET' });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][2]).not.toHaveProperty('viaTab');
  });

  it('never sets the in-page flag', async () => {
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await transport.fetch({ path: '/dapi/fe/gql?optype=mutation', method: 'POST', body: '{}' });
    expect(requestMock.mock.calls[0][2]).not.toHaveProperty('inPage');
  });

  it('maps the response to the {status, body, url} triple', async () => {
    requestMock.mockResolvedValue({ status: 200, body: '<html>', url: 'https://www.opentable.com/r/x' });
    const transport = new FetchproxyTransport({ version: '1.2.3' });
    await expect(transport.fetch({ path: '/r/x', method: 'GET' })).resolves.toEqual({
      status: 200,
      body: '<html>',
      url: 'https://www.opentable.com/r/x',
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
