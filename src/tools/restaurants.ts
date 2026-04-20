import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseRestaurant } from '../parse-restaurant.js';

/**
 * `restaurant_id` can be either a numeric ID (e.g. 42) or a URL slug
 * (e.g. "gran-morsi-new-york"). Both forms work against /r/{...}.
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
          .describe('Numeric restaurant id or URL slug (e.g. "gran-morsi-new-york")'),
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
