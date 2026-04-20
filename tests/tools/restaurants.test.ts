import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('restaurant tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerRestaurantTools(server, mockClient)
    );
  });

  describe('opentable_search_restaurants', () => {
    it('posts the search query and formats the results', async () => {
      mockRequest.mockResolvedValue({
        restaurants: [
          {
            id: 'ristorante-milano-sf',
            name: 'Ristorante Milano',
            cuisine: 'Italian',
            neighborhood: 'Hayes Valley',
            address: { city: 'San Francisco' },
            rating: 4.7,
            review_count: 1200,
            price_range: '$$$',
            profile_url: '/restaurant/ristorante-milano-sf',
            availability: [
              { token: 'tok-1', time: '19:00' },
              { token: 'tok-2', time: '19:30' },
            ],
          },
        ],
      });

      const result = await harness.callTool('opentable_search_restaurants', {
        location: 'San Francisco',
        date: '2026-05-01',
        party_size: 2,
        time: '19:00',
      });

      expect(result.isError).toBeFalsy();
      expect(mockRequest).toHaveBeenCalledWith(
        'POST',
        '/dtp/eatery/graphql',
        expect.objectContaining({
          operation: 'Search',
          variables: expect.objectContaining({
            location: 'San Francisco',
            date: '2026-05-01',
            partySize: 2,
            time: '19:00',
          }),
        })
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"restaurant_id": "ristorante-milano-sf"');
      expect(text).toContain('"name": "Ristorante Milano"');
      expect(text).toContain('"url": "https://www.opentable.com/restaurant/ristorante-milano-sf"');
      expect(text).toContain('"reservation_token": "tok-1"');
    });

    it('rejects missing location via zod', async () => {
      const result = await harness.callTool('opentable_search_restaurants', {
        date: '2026-05-01',
        party_size: 2,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('opentable_get_restaurant', () => {
    it('calls GET /api/v2/restaurants/{id} and formats the response', async () => {
      mockRequest.mockResolvedValue({
        id: 'ristorante-milano-sf',
        name: 'Ristorante Milano',
        description: 'Northern Italian in Hayes Valley.',
        cuisine: 'Italian',
        address: '123 Market St, San Francisco, CA',
        phone: '+14155551234',
        hours: 'Daily 5–10pm',
        rating: 4.7,
        review_count: 1200,
        price_range: '$$$',
        features: ['Outdoor seating', 'Wheelchair accessible'],
        profile_url: '/restaurant/ristorante-milano-sf',
      });

      const result = await harness.callTool('opentable_get_restaurant', {
        restaurant_id: 'ristorante-milano-sf',
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/restaurants/ristorante-milano-sf'
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"restaurant_id": "ristorante-milano-sf"');
      expect(text).toContain('"phone": "+14155551234"');
      expect(text).toContain('"features"');
      expect(text).toContain('"url": "https://www.opentable.com/restaurant/ristorante-milano-sf"');

      // String-address shape emits `address`, NOT `address_city` — the full
      // street address should never be promoted into the city slot.
      expect(text).toContain('"address": "123 Market St, San Francisco, CA"');
      expect(text).not.toMatch(/"address_city":\s*"123 Market St/);
    });
  });
});
