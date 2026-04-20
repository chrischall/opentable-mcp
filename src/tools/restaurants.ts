import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseRestaurant } from '../parse-restaurant.js';

/**
 * OpenTable's `/r/{...}` route expects a URL slug (e.g.
 * "state-of-confusion-charlotte"). Numeric ids 404 on this route — pass
 * the slug from a search result or the `restaurantUrl` field of another
 * tool's response.
 */
function restaurantPath(id: string | number): string {
  return `/r/${id}`;
}

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_get_restaurant',
    {
      description:
        'Get full details for a single OpenTable restaurant: cuisine, price band, description, address, hours, phone, payment options, features, rating/review count, and availability_token (used internally when booking).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z
          .union([z.string(), z.number().int().positive()])
          .describe(
            'URL slug (e.g. "state-of-confusion-charlotte"). Numeric ids 404 on /r/{...} — grab the slug from opentable_search_restaurants.'
          ),
      },
    },
    async ({ restaurant_id }) => {
      const html = await client.fetchHtml(restaurantPath(restaurant_id));
      const restaurant = parseRestaurant(html);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(restaurant, null, 2) },
        ],
      };
    }
  );
}
