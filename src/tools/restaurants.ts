import { z } from 'zod';
import { textResult, PositiveInt, UpstreamHttpError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseRestaurant } from '../parse-restaurant.js';
import { restaurantCandidatePaths, OPENTABLE_BASE_URL } from '../urls.js';

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_get_restaurant',
    {
      description:
        'Get full details for a single OpenTable restaurant: cuisine, price band, description, address, hours, phone, payment options, features, rating/review count, and availability_token (used internally when booking). Accepts the numeric restaurant_id, a slug, a path, or the full URL from opentable_search_restaurants — passing the search result\'s "url" verbatim always resolves, including legacy venues served at /{slug} instead of /r/{slug}.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z
          .union([z.string(), PositiveInt])
          .describe(
            'Numeric restaurant_id (as returned by opentable_list_reservations / opentable_list_favorites), slug ("state-of-confusion-charlotte"), path, or full URL from opentable_search_restaurants. Passing the search result\'s "url" verbatim resolves both /r/{slug} and legacy /{slug} venues; a numeric id resolves via /restaurant/profile/{id}.'
          ),
      },
    },
    async ({ restaurant_id }) => {
      const candidates = restaurantCandidatePaths(restaurant_id);
      let lastNotFound: UpstreamHttpError | undefined;
      for (const path of candidates) {
        try {
          const html = await client.fetchHtml(path);
          // Thread the exact URL we fetched through so the output `url` reflects
          // the form OpenTable actually serves (/r/{slug} vs legacy /{slug}).
          const restaurant = parseRestaurant(html, `${OPENTABLE_BASE_URL}${path}`);
          return textResult(restaurant);
        } catch (e) {
          if (e instanceof UpstreamHttpError && e.status === 404) {
            lastNotFound = e;
            continue;
          }
          throw e;
        }
      }
      throw new Error(
        `No OpenTable restaurant detail page found for "${restaurant_id}" (tried ${candidates.join(
          ', '
        )}). Pass the exact "url" from opentable_search_restaurants. Underlying error: ${lastNotFound?.message ?? 'not found'}`
      );
    }
  );
}
