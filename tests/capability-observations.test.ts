import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UpstreamHttpError } from '@chrischall/mcp-utils';
import {
  OpenTableClient,
  CAPABILITY_FRESH_MS,
  capabilityFailureCode,
} from '../src/client.js';
import { ParseError } from '../src/initial-state.js';
import type { OpenTableTransport } from '../src/transport.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerReservationTools } from '../src/tools/reservations.js';
import { withCapabilities } from '../src/tools/healthcheck.js';
import { createTestHarness } from './helpers.js';

const menuFixture = JSON.parse(readFileSync(new URL('./fixtures/restaurant-menus-state.json', import.meta.url), 'utf8'));
const menuHtml = `<script>${JSON.stringify({ windowVariables: { __INITIAL_STATE__: menuFixture } })}</script>`;

// The client's own fetchHtml throws UpstreamHttpError on a non-2xx, so a stub
// that returns a status exercises the real error path.
function clientWith(opts: { status?: number; body?: string; graphql?: () => Promise<unknown> }) {
  const transport = {
    start: async () => {}, close: async () => {},
    fetch: async () => ({ status: opts.status ?? 200, body: opts.body ?? '', url: '' }),
    graphqlQuery: opts.graphql ?? (async () => ({})),
  } as unknown as OpenTableTransport;
  return new OpenTableClient({ transport });
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('capabilityFailureCode', () => {
  it('reads an HTTP status from structure before wording', () => {
    expect(capabilityFailureCode(new UpstreamHttpError(503, 'x'), 'read_error')).toBe('http_503');
    expect(capabilityFailureCode(Object.assign(new Error('opaque'), { statusCode: 429 }), 'graphql_error')).toBe('http_429');
  });

  it("reads any status from Apollo's ServerError wording, not just 403/409", () => {
    expect(capabilityFailureCode(new Error('Response not successful: Received status code 409'), 'graphql_error')).toBe('http_409');
    expect(capabilityFailureCode(new Error('Response not successful: Received status code 500'), 'graphql_error')).toBe('http_500');
  });

  it('names parse failures and falls back only for genuinely unclassified errors', () => {
    expect(capabilityFailureCode(new ParseError('no state'), 'read_error')).toBe('parse_error');
    expect(capabilityFailureCode(new Error('socket closed'), 'graphql_error')).toBe('graphql_error');
  });
});

describe('capability freshness', () => {
  it('goes stale after CAPABILITY_FRESH_MS', () => {
    vi.useFakeTimers();
    try {
      const client = clientWith({});
      client.recordCapability('search', 'passed');
      vi.advanceTimersByTime(CAPABILITY_FRESH_MS - 1);
      expect(client.capabilityStatus().search.fresh).toBe(true);
      vi.advanceTimersByTime(1);
      expect(client.capabilityStatus().search.fresh).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('availability is recorded only once the response parses', () => {
  const slotsArgs = { restaurant_id: 42, date: '2026-10-10', time: '19:00', party_size: 2 };

  it('a transport success alone is not a pass', async () => {
    const client = clientWith({ graphql: async () => ({}) });
    await client.graphqlQuery('availability', {});
    expect(client.capabilityStatus().availability.state).toBe('not_probed');
  });

  it('records parse_error when find_slots cannot parse the response', async () => {
    const client = clientWith({ graphql: async () => ({ availability: 'garbage' }) });
    harness = await createTestHarness(server => registerReservationTools(server, client));
    const reply = await harness.callTool('opentable_find_slots', slotsArgs);
    expect(reply.isError).toBe(true);
    expect(client.capabilityStatus().availability).toMatchObject({ state: 'failed', code: 'parse_error' });
  });

  it('records a pass when find_slots parses the response', async () => {
    const client = clientWith({ graphql: async () => ({ availability: [] }) });
    harness = await createTestHarness(server => registerReservationTools(server, client));
    const reply = await harness.callTool('opentable_find_slots', slotsArgs);
    expect(reply.isError).toBeFalsy();
    expect(client.capabilityStatus().availability.state).toBe('passed');
  });
});

describe('search and menus classify what failed', () => {
  it('search: an upstream HTTP failure is http_<status>, not read_or_parse_error', async () => {
    const client = clientWith({ status: 503 });
    harness = await createTestHarness(server => registerSearchTools(server, client));
    await harness.callTool('opentable_search_restaurants', { term: 'sushi' });
    expect(client.capabilityStatus().search).toMatchObject({ state: 'failed', code: 'http_503' });
  });

  it('search: an unparseable page is parse_error', async () => {
    const client = clientWith({ body: '<html>no state here</html>' });
    harness = await createTestHarness(server => registerSearchTools(server, client));
    await harness.callTool('opentable_search_restaurants', { term: 'sushi' });
    expect(client.capabilityStatus().search).toMatchObject({ state: 'failed', code: 'parse_error' });
  });

  it('menus: a restaurant id that matches no page is bad input, not a capability failure', async () => {
    const client = clientWith({ status: 404 });
    harness = await createTestHarness(server => registerRestaurantTools(server, client));
    const reply = await harness.callTool('opentable_get_menu', { restaurant_id: 'no-such-place' });
    expect(reply.isError).toBe(true);
    expect(client.capabilityStatus().menus.state).toBe('not_probed');
  });

  it('menus: records a pass on a parsed menu and http_<status> on a blocked read', async () => {
    let status = 200;
    const transport = {
      start: async () => {}, close: async () => {},
      fetch: async () => ({ status, body: menuHtml, url: '' }),
      graphqlQuery: async () => ({}),
    } as unknown as OpenTableTransport;
    const client = new OpenTableClient({ transport });
    harness = await createTestHarness(server => registerRestaurantTools(server, client));
    await harness.callTool('opentable_get_menu', { restaurant_id: 42 });
    expect(client.capabilityStatus().menus.state).toBe('passed');
    status = 403;
    await harness.callTool('opentable_get_menu', { restaurant_id: 42 });
    expect(client.capabilityStatus().menus).toMatchObject({ state: 'failed', code: 'http_403' });
  });
});

describe('withCapabilities', () => {
  const extra = { scope: 'bridge_transport_only', capabilities: { booking: { state: 'not_probed' } } };

  it('merges into a single JSON text block', () => {
    const out = withCapabilities({ content: [{ type: 'text', text: '{"ok":true}' }] }, extra);
    expect(JSON.parse((out.content[0] as { text: string }).text)).toMatchObject({ ok: true, ...extra });
  });

  it.each([
    ['non-JSON text', { content: [{ type: 'text', text: 'bridge down' }] }],
    ['a JSON array', { content: [{ type: 'text', text: '[1]' }] }],
    ['no content', { content: [] }],
    ['a non-text first block', { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }],
  ])('keeps the original reply and appends the capabilities when given %s', (_label, response) => {
    const out = withCapabilities(response as never, extra);
    expect(out.content.slice(0, response.content.length)).toEqual(response.content);
    const appended = out.content[out.content.length - 1] as { type: string; text: string };
    expect(JSON.parse(appended.text)).toEqual(extra);
  });
});
