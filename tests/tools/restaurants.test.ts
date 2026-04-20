import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
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
    ) as { restaurant_id: number; name: string; availability_token: string };
    expect(parsed.restaurant_id).toBe(42);
    expect(parsed.name).toBe('Testeria');
    expect(parsed.availability_token).toBe('t-x');
  });

  it('accepts numeric restaurant_id', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        restaurantProfile: { restaurant: { restaurantId: 99, name: 'Y' } },
      })
    );
    await harness.callTool('opentable_get_restaurant', { restaurant_id: 99 });
    expect(mockFetchHtml).toHaveBeenCalledWith('/r/99');
  });
});
