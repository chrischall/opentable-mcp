import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerSearchTools } from '../../src/tools/search.js';
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

describe('search tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  it('fetches /s?term=…&covers=…&dateTime=… and returns formatted results', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        multiSearch: {
          originalTerm: 'italian charlotte',
          restaurants: [
            {
              restaurantId: 99,
              name: 'Mamma Mia',
              primaryCuisine: { name: 'Italian' },
              urls: { profileLink: { link: '/r/mamma-mia' } },
            },
          ],
          totalRestaurantCount: 1,
        },
      })
    );

    const result = await harness.callTool('opentable_search_restaurants', {
      term: 'italian',
      location: 'Charlotte',
      date: '2026-05-01',
      time: '19:00',
      party_size: 2,
    });

    const fetchedPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(fetchedPath).toContain('/s?');
    expect(fetchedPath).toContain('term=italian+Charlotte');
    expect(fetchedPath).toContain('covers=2');
    expect(fetchedPath).toContain('dateTime=2026-05-01T19%3A00');
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as { meta: { term: string }; restaurants: Array<{ name: string }> };
    expect(parsed.meta.term).toBe('italian charlotte');
    expect(parsed.restaurants[0].name).toBe('Mamma Mia');
  });

  it('defaults time to 19:00 when date is given without time', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ multiSearch: { restaurants: [] } })
    );
    await harness.callTool('opentable_search_restaurants', {
      term: 'sushi',
      date: '2026-06-15',
      party_size: 4,
    });
    const fetchedPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(fetchedPath).toContain('dateTime=2026-06-15T19%3A00');
  });

  it('omits dateTime when date is not provided', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ multiSearch: { restaurants: [] } })
    );
    await harness.callTool('opentable_search_restaurants', { term: 'tapas' });
    const fetchedPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(fetchedPath).not.toContain('dateTime');
    expect(fetchedPath).toContain('term=tapas');
  });

  it('passes lat/lng through when provided', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({ multiSearch: { restaurants: [] } })
    );
    await harness.callTool('opentable_search_restaurants', {
      term: 'sushi',
      latitude: 37.7749,
      longitude: -122.4194,
    });
    const fetchedPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(fetchedPath).toContain('latitude=37.7749');
    expect(fetchedPath).toContain('longitude=-122.4194');
  });
});
