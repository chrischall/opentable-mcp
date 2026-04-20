import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export function registerNotifyTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_notify',
    {
      description: 'List the user\'s OpenTable notify-me subscriptions.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request<Record<string, unknown>>(
        'GET',
        '/api/v2/users/me/notifications'
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_add_notify',
    {
      description:
        'Subscribe to notify-me for a restaurant + date + party size. Optional time_window narrows the alert (e.g. "19:00-21:00").',
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        time_window: z.string().optional().describe('HH:MM-HH:MM'),
      },
    },
    async ({ restaurant_id, date, party_size, time_window }) => {
      const payload: Record<string, unknown> = { restaurant_id, date, party_size };
      if (time_window !== undefined) payload.time_window = time_window;
      const data = await client.request<Record<string, unknown>>(
        'POST',
        '/api/v2/notifications',
        payload
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_remove_notify',
    {
      description: 'Cancel a notify-me subscription by notify_id.',
      inputSchema: { notify_id: z.string() },
    },
    async ({ notify_id }) => {
      await client.request<unknown>('DELETE', `/api/v2/notifications/${notify_id}`);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ removed: true, notify_id }, null, 2) },
        ],
      };
    }
  );
}
