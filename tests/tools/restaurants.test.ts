import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { UpstreamHttpError } from '@chrischall/mcp-utils';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

function restaurantState(id: number, name: string): unknown {
  return { restaurantProfile: { restaurant: { restaurantId: id, name } } };
}

describe('restaurant tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerRestaurantTools(server, mockClient)
    );
  });

  it('fetches /r/{slug} and returns formatted restaurant details', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        restaurantProfile: {
          availabilityToken: 't-x',
          restaurant: {
            restaurantId: 42,
            name: 'Testeria',
            primaryCuisine: { name: 'Italian' },
          },
        },
      })
    );

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'testeria-sf',
    });

    expect(mockFetchHtml).toHaveBeenCalledWith('/r/testeria-sf');
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as { restaurant_id: number; name: string; availability_token: string; url: string };
    expect(parsed.restaurant_id).toBe(42);
    expect(parsed.name).toBe('Testeria');
    expect(parsed.availability_token).toBe('t-x');
    expect(parsed.url).toBe('https://www.opentable.com/r/testeria-sf');
  });

  it('falls back to root /{slug} when /r/{slug} 404s (legacy URL venues)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path === '/r/the-cellar-at-duckworths') {
        throw new UpstreamHttpError(404, 'OpenTable API error: 404 for GET /r/the-cellar-at-duckworths');
      }
      return htmlWith(restaurantState(188233, "The Cellar at Duckworth's"));
    });

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'the-cellar-at-duckworths',
    });

    expect(mockFetchHtml).toHaveBeenNthCalledWith(1, '/r/the-cellar-at-duckworths');
    expect(mockFetchHtml).toHaveBeenNthCalledWith(2, '/the-cellar-at-duckworths');
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      restaurant_id: number;
      url: string;
    };
    expect(parsed.restaurant_id).toBe(188233);
    expect(parsed.url).toBe('https://www.opentable.com/the-cellar-at-duckworths');
  });

  it('accepts a full canonical URL and fetches its path verbatim (no /r/ guessing)', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith(restaurantState(188233, "The Cellar at Duckworth's"))
    );

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'https://www.opentable.com/the-cellar-at-duckworths',
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockFetchHtml).toHaveBeenCalledWith('/the-cellar-at-duckworths');
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      url: string;
    };
    expect(parsed.url).toBe('https://www.opentable.com/the-cellar-at-duckworths');
  });

  it('accepts a full /r/ URL and fetches its path verbatim', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(restaurantState(42, 'Testeria')));

    await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'https://www.opentable.com/r/testeria-sf',
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockFetchHtml).toHaveBeenCalledWith('/r/testeria-sf');
  });

  it('accepts a bare path and fetches it verbatim', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith(restaurantState(188233, "The Cellar at Duckworth's"))
    );

    await harness.callTool('opentable_get_restaurant', {
      restaurant_id: '/the-cellar-at-duckworths',
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockFetchHtml).toHaveBeenCalledWith('/the-cellar-at-duckworths');
  });

  // Was "rejects numeric restaurant_id": the tool used to throw, on the
  // premise that numeric ids 404. That premise was wrong — /r/{id} 404s but
  // /restaurant/profile/{id} resolves (verified live 2026-08-27 on two real
  // venues; ids not recorded, see src/urls.ts). Numeric ids matter because
  // they are the only venue handle list_reservations / list_favorites return.
  it('resolves a numeric restaurant_id via the profile route', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(restaurantState(99, 'Numeric Venue')));

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 99,
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockFetchHtml).toHaveBeenCalledWith('/restaurant/profile/99');
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text).url).toBe(
      'https://www.opentable.com/restaurant/profile/99'
    );
  });

  it('never tries the known-404 /r/{numeric-id} shape', async () => {
    mockFetchHtml.mockResolvedValue(htmlWith(restaurantState(99, 'Numeric Venue')));

    await harness.callTool('opentable_get_restaurant', { restaurant_id: 99 });

    expect(mockFetchHtml).not.toHaveBeenCalledWith('/r/99');
  });

  it('surfaces a clear error when both /r/{slug} and /{slug} 404', async () => {
    mockFetchHtml.mockRejectedValue(
      new UpstreamHttpError(404, 'OpenTable API error: 404 for GET /r/ghost')
    );

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'ghost',
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/ghost/);
  });

  it('does not fall back on non-404 errors', async () => {
    mockFetchHtml.mockRejectedValue(
      new UpstreamHttpError(500, 'OpenTable API error: 500 for GET /r/boom')
    );

    const result = await harness.callTool('opentable_get_restaurant', {
      restaurant_id: 'boom',
    });

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/500/);
  });
});
