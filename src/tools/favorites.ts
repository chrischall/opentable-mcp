import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseFavorites } from '../parse-favorites.js';

const FAVORITES_PATH = '/user/favorites';

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
}
