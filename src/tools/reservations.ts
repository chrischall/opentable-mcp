import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export interface RawSlot {
  token?: string;
  time?: string;
  type?: string;
}

export function formatSlot(
  raw: RawSlot,
  date: string,
  partySize: number
): { reservation_token: string; date: string; time: string; party_size: number; type?: string } {
  return {
    reservation_token: raw.token ?? '',
    date,
    time: raw.time ?? '',
    party_size: partySize,
    type: raw.type,
  };
}

function compareHHMM(a: string, b: string): number {
  const parse = (s: string) => {
    const [h, m] = s.split(':').map((n) => Number(n));
    return (h || 0) * 60 + (m || 0);
  };
  return parse(a) - parse(b);
}

export function registerReservationTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_find_slots',
    {
      description:
        'List available reservation slots at a specific restaurant for a date + party size. Tokens expire quickly; book soon after fetching.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        time: z.string().optional().describe('HH:MM (24h)'),
      },
    },
    async ({ restaurant_id, date, party_size, time }) => {
      const params = new URLSearchParams({
        date,
        party_size: String(party_size),
      });
      if (time) params.set('time', time);
      const data = await client.request<{ availability?: RawSlot[] }>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}/availability?${params.toString()}`
      );
      const slots = (data.availability ?? [])
        .map((s) => formatSlot(s, date, party_size))
        .sort((a, b) => compareHHMM(a.time, b.time));
      return { content: [{ type: 'text' as const, text: JSON.stringify(slots, null, 2) }] };
    }
  );

  interface RawReservation {
    id?: string;
    confirmation_number?: string;
    restaurant_name?: string;
    restaurant?: { name?: string };
    date?: string;
    time?: string;
    party_size?: number;
    status?: string;
    special_requests?: string;
  }

  server.registerTool(
    'opentable_list_reservations',
    {
      description:
        'List the user\'s OpenTable reservations. Defaults to upcoming; pass scope="past" or scope="all" to broaden.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z.enum(['upcoming', 'past', 'all']).optional(),
      },
    },
    async ({ scope }) => {
      const scopeParam = scope ?? 'upcoming';
      const data = await client.request<{ reservations?: RawReservation[] }>(
        'GET',
        `/api/v2/users/me/reservations?scope=${encodeURIComponent(scopeParam)}`
      );
      const formatted = (data.reservations ?? []).map((r) => ({
        reservation_id: r.id ?? '',
        confirmation_number: r.confirmation_number,
        restaurant_name: r.restaurant_name ?? r.restaurant?.name ?? 'Unknown',
        date: r.date ?? '',
        time: r.time ?? '',
        party_size: r.party_size ?? 0,
        status: r.status,
        special_requests: r.special_requests,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );
}
