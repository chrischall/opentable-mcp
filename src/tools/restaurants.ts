import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

const GRAPHQL_PATH = '/dtp/eatery/graphql';
const BASE_URL = 'https://www.opentable.com';

export interface RawRestaurant {
  id?: string;
  name?: string;
  cuisine?: string;
  neighborhood?: string;
  address?: string | { city?: string };
  rating?: number;
  review_count?: number;
  price_range?: string;
  profile_url?: string;
  description?: string;
  phone?: string;
  hours?: string;
  features?: string[];
  availability?: Array<{ token?: string; time?: string; type?: string }>;
}

export function formatRestaurant(
  raw: RawRestaurant,
  opts: { date?: string; partySize?: number } = {}
) {
  const url = raw.profile_url
    ? `${BASE_URL}${raw.profile_url.startsWith('/') ? raw.profile_url : `/${raw.profile_url}`}`
    : undefined;

  // search results embed a structured address with a city field; the
  // single-restaurant endpoint returns a flat string. Expose each under its
  // own key so Claude never sees a street address promoted into `city`.
  const addressCity =
    typeof raw.address === 'object' ? raw.address?.city ?? undefined : undefined;
  const addressString = typeof raw.address === 'string' ? raw.address : undefined;

  const slots =
    opts.date !== undefined && opts.partySize !== undefined
      ? (raw.availability ?? []).map((a) => ({
          reservation_token: a.token ?? '',
          date: opts.date!,
          time: a.time ?? '',
          party_size: opts.partySize!,
          type: a.type,
        }))
      : undefined;

  return {
    restaurant_id: raw.id,
    name: raw.name,
    cuisine: raw.cuisine,
    neighborhood: raw.neighborhood,
    address_city: addressCity,
    address: addressString,
    phone: raw.phone,
    hours: raw.hours,
    description: raw.description,
    rating: raw.rating,
    review_count: raw.review_count,
    price_range: raw.price_range,
    features: raw.features,
    url,
    slots,
  };
}

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_search_restaurants',
    {
      description:
        'Search OpenTable for restaurants with availability. Returns restaurants plus any bookable reservation_tokens for the requested date + party size.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().optional(),
        location: z.string().describe('City, neighborhood, or address'),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().optional().describe('HH:MM (24h)'),
        party_size: z.number().int().positive(),
        cuisine: z.string().optional(),
        price_range: z.enum(['$', '$$', '$$$', '$$$$']).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, location, date, time, party_size, cuisine, price_range, limit }) => {
      const variables = {
        location,
        date,
        time,
        partySize: party_size,
        query,
        cuisine,
        priceRange: price_range,
        limit: limit ?? 20,
      };
      const data = await client.request<{ restaurants?: RawRestaurant[] }>(
        'POST',
        GRAPHQL_PATH,
        { operation: 'Search', variables }
      );
      const formatted = (data.restaurants ?? []).map((r) =>
        formatRestaurant(r, { date, partySize: party_size })
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_get_restaurant',
    {
      description: 'Get full details for a single OpenTable restaurant by id.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.string(),
      },
    },
    async ({ restaurant_id }) => {
      const data = await client.request<RawRestaurant>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}`
      );
      const formatted = formatRestaurant(data);
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );
}
