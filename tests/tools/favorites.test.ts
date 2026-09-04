import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerFavoriteTools } from '../../src/tools/favorites.js';
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

describe('favorite tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerFavoriteTools(server, mockClient)
    );
  });

  it('list_favorites fetches /user/favorites and returns a formatted list', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        userProfile: {
          favorites: {
            loading: false,
            restaurants: [
              {
                id: 42,
                name: 'Testeria',
                primaryCuisine: 'Italian',
                urlSlug: 'testeria',
              },
            ],
          },
        },
      })
    );

    const result = await harness.callTool('opentable_list_favorites');

    expect(mockFetchHtml).toHaveBeenCalledWith('/user/favorites');
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Array<{ restaurant_id: string; name: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].restaurant_id).toBe('42');
    expect(parsed[0].name).toBe('Testeria');
  });

  describe('view', () => {
    function oneFavorite(): unknown {
      return htmlWith({
        userProfile: {
          favorites: {
            loading: false,
            restaurants: [
              { id: 42, name: 'Testeria', primaryCuisine: 'Italian', urlSlug: 'testeria' },
            ],
          },
        },
      });
    }

    // This tool's projection carries no media, so compact and full agree on the
    // CONTENT — and that is exactly the point worth pinning. Compact is
    // subtractive: it removes media and nothing else, so a payload with no media
    // must come back whole. A projection that had guessed at a field list would
    // quietly shrink this one too.
    it('returns the same records on both rungs — there is no media here to drop', async () => {
      const seen: Array<Array<Record<string, unknown>>> = [];
      for (const args of [{}, { view: 'compact' }, { view: 'full' }]) {
        mockFetchHtml.mockResolvedValue(oneFavorite());
        const result = await harness.callTool('opentable_list_favorites', args);
        expect(result.isError).toBeFalsy();
        seen.push(JSON.parse((result.content[0] as { text: string }).text));
      }
      expect(seen[0]).toEqual(seen[2]);
      expect(seen[1]).toEqual(seen[2]);
      expect(seen[2][0]).toMatchObject({ restaurant_id: '42', name: 'Testeria' });
    });

    // …and the wiring is still observable, because `viewResponse` minifies where
    // the `textResult` this tool used to return pretty-printed. Reverting the
    // wiring fails here even though every content assertion above still passes.
    it('emits one line of JSON', async () => {
      mockFetchHtml.mockResolvedValue(oneFavorite());
      const result = await harness.callTool('opentable_list_favorites');
      expect((result.content[0] as { text: string }).text).not.toMatch(/\n/);
    });

    // A rung this server does not honour is rejected by the schema before the
    // handler runs — the tool advertises compact|full only.
    it('rejects a rung it does not honour', async () => {
      mockFetchHtml.mockResolvedValue(oneFavorite());
      const result = await harness.callTool('opentable_list_favorites', { view: 'raw' });
      expect(result.isError).toBe(true);
    });
  });
});
