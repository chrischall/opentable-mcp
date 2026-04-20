import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseFavorites } from '../parse-favorites.js';

const FAVORITES_PATH = '/user/favorites';
const WISHLIST_ADD_PATH = '/dapi/wishlist/add';
const WISHLIST_REMOVE_PATH = '/dapi/wishlist/remove';
const WISHLIST_NAME = 'Favorites';

export function registerFavoriteTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_favorites',
    {
      description:
        "List the user's saved restaurants from OpenTable (Saved Restaurants list). Returns each entry's id, name, cuisine, neighborhood, price band, rating, and OpenTable URL.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const html = await client.fetchHtml(FAVORITES_PATH);
      const favorites = parseFavorites(html);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(favorites, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_add_favorite',
    {
      description:
        "Add a restaurant to the user's Saved Restaurants list.",
      inputSchema: {
        restaurant_id: z.number().int().positive(),
      },
    },
    async ({ restaurant_id }) => {
      await client.fetchJson<null>(WISHLIST_ADD_PATH, {
        method: 'POST',
        body: { restaurantId: restaurant_id, wishListName: WISHLIST_NAME },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ favorited: true, restaurant_id }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_remove_favorite',
    {
      description:
        "Remove a restaurant from the user's Saved Restaurants list.",
      inputSchema: {
        restaurant_id: z.number().int().positive(),
      },
    },
    async ({ restaurant_id }) => {
      await client.fetchJson<null>(WISHLIST_REMOVE_PATH, {
        method: 'POST',
        body: { restaurantId: restaurant_id, wishListName: WISHLIST_NAME },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ removed: true, restaurant_id }, null, 2),
          },
        ],
      };
    }
  );
}
