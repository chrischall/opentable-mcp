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

  describe('view', () => {
    // A search hit whose only media is `photo_url`. OpenTable serves those from
    // resizer.otstatic.com with a real image extension, which is what the fleet's
    // media rule keys off — so this is the shape compact actually shrinks.
    function oneHit(): unknown {
      return htmlWith({
        multiSearch: {
          restaurants: [
            {
              restaurantId: 99,
              name: 'Mamma Mia',
              urls: { profileLink: { link: '/r/mamma-mia' } },
              photos: {
                profileV3: { url: 'https://resizer.otstatic.com/v2/profiles/legacy/99.jpg' },
              },
            },
          ],
          totalRestaurantCount: 1,
        },
      });
    }

    // The rollout's whole claim, at the wiring level: a caller who passes no
    // `view` gets the projected answer. Search is the highest-volume read here
    // (a page of hits, each with a photo), so a default that silently reverted to
    // `full` would cost the most and show up nowhere.
    it('strips photo_url by default, with no view argument passed', async () => {
      mockFetchHtml.mockResolvedValue(oneHit());
      const result = await harness.callTool('opentable_search_restaurants', { term: 'italian' });
      const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
        restaurants: Array<Record<string, unknown>>;
      };
      expect(parsed.restaurants[0].name).toBe('Mamma Mia');
      expect(parsed.restaurants[0]).not.toHaveProperty('photo_url');
    });

    it('returns photo_url under view: "full"', async () => {
      mockFetchHtml.mockResolvedValue(oneHit());
      const result = await harness.callTool('opentable_search_restaurants', {
        term: 'italian',
        view: 'full',
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
        restaurants: Array<{ photo_url: string }>;
      };
      expect(parsed.restaurants[0].photo_url).toBe(
        'https://resizer.otstatic.com/v2/profiles/legacy/99.jpg'
      );
    });

    // `view` is OURS — a response-shape knob — and must never reach OpenTable.
    // This tool is the one that builds a URL out of its whole input object, so it
    // is where a leak would land: sending `view=compact` up to /s? is at best
    // noise in a signature and at worst a search that returns something different
    // from the one a caller without the parameter would get. The handler
    // destructures `view` off before `buildSearchUrl` ever sees the rest.
    it('never puts view on the upstream search URL', async () => {
      mockFetchHtml.mockResolvedValue(htmlWith({ multiSearch: { restaurants: [] } }));
      for (const view of ['compact', 'full']) {
        mockFetchHtml.mockClear();
        await harness.callTool('opentable_search_restaurants', { term: 'tapas', view });
        const fetchedPath = mockFetchHtml.mock.calls[0][0] as string;
        expect(fetchedPath).not.toContain('view');
        expect(fetchedPath).not.toContain(view);
        expect(fetchedPath).toBe('/s?term=tapas');
      }
    });

    // Minification is the other half of the change; `textResult` (what this tool
    // used to return) pretty-prints, so a single-line result is what distinguishes
    // the two. Asserted on the raw text because both parse identically.
    it('emits one line of JSON', async () => {
      mockFetchHtml.mockResolvedValue(oneHit());
      const result = await harness.callTool('opentable_search_restaurants', { term: 'italian' });
      expect((result.content[0] as { text: string }).text).not.toMatch(/\n/);
    });
  });
});
