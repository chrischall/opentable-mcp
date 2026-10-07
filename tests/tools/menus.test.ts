import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UpstreamHttpError } from '@chrischall/mcp-utils';
import type { OpenTableClient } from '../../src/client.js';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness } from '../helpers.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/restaurant-menus-state.json', import.meta.url), 'utf8'));
const html = `<script>${JSON.stringify({ windowVariables: { __INITIAL_STATE__: fixture } })}</script>`;
const mockFetchHtml = vi.fn();
const client = { fetchHtml: mockFetchHtml } as unknown as OpenTableClient;
let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });
const parse = (result: Awaited<ReturnType<typeof harness.callTool>>) => JSON.parse((result.content[0] as { text: string }).text);

describe('menu tool', () => {
  it('registers a read-only menu tool', async () => {
    harness = await createTestHarness(server => registerRestaurantTools(server, client));
    const { tools } = await harness.client.listTools();
    expect(tools.find(t => t.name === 'opentable_get_menu')?.annotations?.readOnlyHint).toBe(true);
  });

  it.each([42, '42'])('uses the numeric profile route for %s', async (restaurant_id) => {
    mockFetchHtml.mockResolvedValue(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id });
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml).toHaveBeenCalledExactlyOnceWith('/restaurant/profile/42');
    expect(parse(result)).toMatchObject({ url: 'https://www.opentable.com/restaurant/profile/42', available_menus: ['Breakfast', 'Dinner'] });
  });

  it('uses the exact URL path and filters the requested menu', async () => {
    mockFetchHtml.mockResolvedValue(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'https://www.opentable.com/r/fixture-cafe', menu_name: ' dinner ' });
    expect(mockFetchHtml).toHaveBeenCalledExactlyOnceWith('/r/fixture-cafe');
    expect(parse(result).menus).toHaveLength(1);
    expect(parse(result).menus[0].title).toBe('Dinner');
  });

  it('falls back to a legacy root slug only after a 404', async () => {
    mockFetchHtml.mockRejectedValueOnce(new UpstreamHttpError(404, 'not found')).mockResolvedValueOnce(html);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'fixture-cafe' });
    expect(mockFetchHtml.mock.calls).toEqual([['/r/fixture-cafe'], ['/fixture-cafe']]);
    expect(parse(result).url).toBe('https://www.opentable.com/fixture-cafe');
  });

  it('honors compact/full views without removing prices, descriptions, or menu links', async () => {
    mockFetchHtml.mockResolvedValue(html);
    for (const view of [undefined, 'full']) {
      const result = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42, menu_name: 'Dinner', ...(view ? { view } : {}) }));
      expect(result.menu_url).toBe('https://example.com/menu');
      expect(result.menus[0].sections).toEqual(fixture.restaurantProfile.menus.menuData[1].sections);
      expect(result.menus[0].description).toBe(fixture.restaurantProfile.menus.menuData[1].description);
      if (view === 'full') expect(result.menus[0].provider.image.url).toBe('https://example.com/provider.png');
      else expect(result.menus[0].provider.image?.url).toBeUndefined();
    }
  });

  it.each([new UpstreamHttpError(403, 'blocked'), new Error('session_not_ready')])('surfaces bridge/HTTP errors without retrying', async error => {
    mockFetchHtml.mockRejectedValue(error);
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 'fixture-cafe' });
    expect(result.isError).toBe(true);
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });

  it('surfaces parsing failures without returning a successful empty menu', async () => {
    mockFetchHtml.mockResolvedValue('<html>Verify you are human</html>');
    const result = await harness.callTool('opentable_get_menu', { restaurant_id: 42 });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('__INITIAL_STATE__');
  });

  it('never fetches an external menu URL', async () => {
    const state = { restaurantProfile: { restaurant: {}, menus: { menuInfo: { url: 'https://example.com/menu.pdf' } } } };
    mockFetchHtml.mockResolvedValue(`<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`);
    const result = parse(await harness.callTool('opentable_get_menu', { restaurant_id: 42 }));
    expect(result.status).toBe('external_only');
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
  });
});
