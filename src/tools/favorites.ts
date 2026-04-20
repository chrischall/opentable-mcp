import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export function registerFavoriteTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_favorites',
    {
      description: 'List the user\'s favorited OpenTable restaurants ("saved restaurants").',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request<Record<string, unknown>>(
        'GET',
        '/api/v2/users/me/favorites'
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_add_favorite',
    {
      description: 'Add a restaurant to the user\'s favorites by restaurant_id.',
      inputSchema: { restaurant_id: z.string() },
    },
    async ({ restaurant_id }) => {
      await client.request<unknown>('POST', '/api/v2/users/me/favorites', { restaurant_id });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ favorited: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_remove_favorite',
    {
      description: 'Remove a restaurant from the user\'s favorites by restaurant_id.',
      inputSchema: { restaurant_id: z.string() },
    },
    async ({ restaurant_id }) => {
      await client.request<unknown>('DELETE', `/api/v2/users/me/favorites/${restaurant_id}`);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ removed: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );
}
