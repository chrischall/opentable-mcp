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
});
