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

  server.registerTool(
    'opentable_cancel',
    {
      description:
        'Cancel an OpenTable reservation by its reservation_id (from opentable_book or opentable_list_reservations).',
      inputSchema: { reservation_id: z.string() },
    },
    async ({ reservation_id }) => {
      const data = await client.request<Record<string, unknown>>(
        'POST',
        `/api/v2/reservations/${reservation_id}/cancel`
      );
      const status = typeof data.status === 'string' ? data.status.toLowerCase() : undefined;
      const hasErrorField = 'error' in data || 'error_message' in data;
      const explicitSuccess =
        (status !== undefined && /cancel/.test(status)) || data.ok === true;
      const explicitFailure =
        data.ok === false ||
        (status !== undefined && /fail|error|denied/.test(status)) ||
        hasErrorField;
      const cancelled = explicitSuccess || !explicitFailure;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ cancelled, raw: data }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_book',
    {
      description:
        'Book an OpenTable reservation. Composite: internally runs find-slots → book. Pass desired_time (HH:MM, 24-hour) to target a specific slot; otherwise the first available slot is used. Closest-time fallback if desired_time is not an exact match.',
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        desired_time: z.string().optional().describe('HH:MM (24h)'),
        special_requests: z.string().optional(),
      },
    },
    async ({ restaurant_id, date, party_size, desired_time, special_requests }) => {
      // 1. find fresh slots
      const findParams = new URLSearchParams({
        date,
        party_size: String(party_size),
      });
      const findData = await client.request<{ availability?: RawSlot[] }>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}/availability?${findParams.toString()}`
      );
      const slots = (findData.availability ?? [])
        .map((s) => formatSlot(s, date, party_size))
        .sort((a, b) => compareHHMM(a.time, b.time));
      if (slots.length === 0) {
        throw new Error(
          'No available slots for this restaurant/date/party size. The restaurant may be fully booked.'
        );
      }

      // 2. pick slot — exact, else closest, else first
      let chosen = slots[0];
      if (desired_time) {
        const exact = slots.find((s) => s.time === desired_time);
        if (exact) {
          chosen = exact;
        } else {
          const toMin = (t: string) => {
            const [h, m] = t.split(':').map((n) => Number(n));
            return (h || 0) * 60 + (m || 0);
          };
          const desired = toMin(desired_time);
          chosen = slots.reduce((best, s) =>
            Math.abs(toMin(s.time) - desired) < Math.abs(toMin(best.time) - desired) ? s : best
          );
        }
      }

      // 3. book
      const bookPayload = {
        reservation_token: chosen.reservation_token,
        party_size,
        date,
        time: chosen.time,
        ...(special_requests !== undefined ? { special_requests } : {}),
      };
      interface BookResponse {
        reservation_id?: string;
        confirmation_number?: string;
        restaurant_name?: string;
        restaurant?: { name?: string };
        profile_url?: string;
        date?: string;
        time?: string;
        party_size?: number;
        status?: string;
      }
      const booked = await client.request<BookResponse>(
        'POST',
        `/api/v2/restaurants/${restaurant_id}/reservations`,
        bookPayload
      );

      const restaurantUrl = booked.profile_url
        ? `https://www.opentable.com${
            booked.profile_url.startsWith('/') ? booked.profile_url : `/${booked.profile_url}`
          }`
        : undefined;

      const result = {
        reservation_id: booked.reservation_id,
        confirmation_number: booked.confirmation_number,
        restaurant_name: booked.restaurant_name ?? booked.restaurant?.name ?? 'Unknown',
        restaurant_url: restaurantUrl,
        date: booked.date ?? date,
        time: booked.time ?? chosen.time,
        party_size: booked.party_size ?? party_size,
        status: booked.status,
        special_requests,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
