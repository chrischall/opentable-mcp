import { z } from 'zod';
import { textResult, PositiveInt } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { HttpError } from '../client.js';
import { parseRestaurant } from '../parse-restaurant.js';

const BASE_URL = 'https://www.opentable.com';

/**
 * Turn a `restaurant_id` input into the ordered list of detail-page paths to
 * try.
 *
 * OpenTable serves restaurant detail pages at two URL shapes: most at
 * `/r/{slug}`, but a subset of (legacy) listings at the root `/{slug}`. The
 * canonical `url` returned by `opentable_search_restaurants` already encodes
 * which one a venue uses, so:
 *
 *  - A full URL or an absolute path is used **verbatim** (single candidate) —
 *    no guessing. Pass the search result's `url` here for a guaranteed hit.
 *  - A bare slug is ambiguous, so we try `/r/{slug}` first (the common case)
 *    and fall back to `/{slug}` on a 404.
 *
 * Numeric ids 404 on both shapes and can't be resolved to a slug from here,
 * so they're rejected up front with an actionable message rather than letting
 * a raw 404 HTML page surface.
 */
function resolveCandidatePaths(restaurant_id: string): string[] {
  let input = restaurant_id.trim();

  // Full URL → take its pathname (+ query, harmless) and use verbatim.
  if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input);
      input = `${u.pathname}${u.search}`;
    } catch {
      // Fall through and treat the raw string as a path/slug below.
    }
  }

  // Absolute path → caller already knows the exact shape; use verbatim.
  if (input.startsWith('/')) return [input];

  // Bare slug → try the common /r/{slug} form, fall back to legacy root.
  return [`/r/${input}`, `/${input}`];
}

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_get_restaurant',
    {
      description:
        'Get full details for a single OpenTable restaurant: cuisine, price band, description, address, hours, phone, payment options, features, rating/review count, and availability_token (used internally when booking). Accepts the slug, path, or full URL from opentable_search_restaurants — passing the search result\'s "url" verbatim always resolves, including legacy venues served at /{slug} instead of /r/{slug}.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z
          .union([z.string(), PositiveInt])
          .describe(
            'Slug ("state-of-confusion-charlotte"), path, or full URL from opentable_search_restaurants. Prefer passing the search result\'s "url" verbatim — it resolves both /r/{slug} and legacy /{slug} venues. Numeric ids are not supported (they 404); use the slug/url instead.'
          ),
      },
    },
    async ({ restaurant_id }) => {
      if (typeof restaurant_id !== 'string') {
        throw new Error(
          `Numeric restaurant ids aren't supported — OpenTable's detail page 404s on /r/${restaurant_id}. Pass the slug or url from opentable_search_restaurants instead (e.g. "state-of-confusion-charlotte" or "https://www.opentable.com/r/state-of-confusion-charlotte").`
        );
      }

      const candidates = resolveCandidatePaths(restaurant_id);
      let lastNotFound: HttpError | undefined;
      for (const path of candidates) {
        try {
          const html = await client.fetchHtml(path);
          // Thread the exact URL we fetched through so the output `url` reflects
          // the form OpenTable actually serves (/r/{slug} vs legacy /{slug}).
          const restaurant = parseRestaurant(html, `${BASE_URL}${path}`);
          return textResult(restaurant);
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) {
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
