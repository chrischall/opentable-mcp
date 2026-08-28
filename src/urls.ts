// Canonical OpenTable URL construction.
//
// Every opentable.com path the tools reach for used to be built inline at
// its call site, which let two provably-wrong shapes survive:
//
//   1. `/r/{numeric-id}` as the restaurant-detail fallback. It 404s — the
//      old comment on it said so out loud ("better than empty") and shipped
//      it anyway, so `opentable_get_restaurant` handed callers a dead link.
//   2. Protocol-relative photo URLs (`//resizer.otstatic.com/...`) passed
//      through verbatim from the SSR state. Those resolve in a browser and
//      nowhere else, so an agent or an HTTP client fetching one fails.
//
// Both are fixed here rather than at the call sites so the shapes have one
// definition and one place to regression-test. This module deliberately
// holds only URL/path *construction* — no fetching, no parsing — so it can
// be unit-tested with no transport and no fixtures.

/** Origin every relative path in this server is resolved against. */
export const OPENTABLE_BASE_URL = 'https://www.opentable.com';

/**
 * Detail-page path for a numeric OpenTable `restaurantId`.
 *
 * VERIFIED LIVE 2026-08-27 against the bridged session, on two real venues:
 * `/r/{id}` returns OpenTable's 404 page, while `/restaurant/profile/{id}`
 * returns the full `restaurantProfile` SSR state — the same parsed result as
 * the venue's own slug page. So numeric ids ARE addressable; only the route
 * the repo previously assumed was wrong. (The venue ids used for that check
 * are deliberately not recorded here: they came from a signed-in session's
 * own reservations, and naming them would tie a person to those venues.)
 *
 * This matters because `restaurant_id` is the ONLY venue handle that
 * `opentable_list_reservations` and `opentable_list_favorites` return — no
 * slug, no url. Without this route, a numeric id from either tool could not
 * be resolved to a detail page at all.
 */
export function restaurantProfilePath(restaurantId: number | string): string {
  return `/restaurant/profile/${encodeURIComponent(String(restaurantId))}`;
}

/**
 * Turn a `restaurant_id` input into the ordered list of detail-page paths to
 * try. The first one that isn't a 404 wins.
 *
 * OpenTable serves restaurant detail pages at three shapes:
 *   - `/r/{slug}`                  — the common case
 *   - `/{slug}`                    — a subset of legacy listings
 *   - `/restaurant/profile/{id}`   — the numeric-id route (see above)
 *
 * The canonical `url` returned by `opentable_search_restaurants` already
 * encodes which of the two slug shapes a venue uses, so:
 *
 *  - A full URL or an absolute path is used **verbatim** (single candidate) —
 *    no guessing. Pass the search result's `url` here for a guaranteed hit.
 *  - A numeric id resolves to the profile route (single candidate) — the slug
 *    shapes are known-404 for numeric input, so trying them only costs a
 *    round-trip.
 *  - A bare slug is ambiguous, so we try `/r/{slug}` first (the common case)
 *    and fall back to `/{slug}`.
 */
export function restaurantCandidatePaths(restaurantId: string | number): string[] {
  if (typeof restaurantId === 'number') return [restaurantProfilePath(restaurantId)];

  let input = restaurantId.trim();

  // Full URL → take its pathname (+ query, harmless) and use verbatim. The
  // origin is dropped rather than honoured: the transport pins opentable.com,
  // so a foreign host in the input would be silently retargeted at
  // opentable.com anyway. Dropping it makes that explicit instead of implied.
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

  // An all-digits string is a numeric id that arrived as text (JSON, a shell
  // arg, a `String(id)` round-trip). Same route as the number branch — the
  // slug shapes 404 for it just the same.
  if (/^\d+$/.test(input)) return [restaurantProfilePath(input)];

  // Bare slug → try the common /r/{slug} form, fall back to legacy root.
  return [`/r/${encodeURIComponent(input)}`, `/${encodeURIComponent(input)}`];
}

/**
 * Absolutise a URL taken from OpenTable's SSR state.
 *
 * OpenTable's `photos.*.url` fields are protocol-relative
 * (`//resizer.otstatic.com/v3/photos/80193677-2`). That form only resolves
 * against a page's own scheme, so it is not a usable URL once it leaves the
 * browser — `new URL()` rejects it and an HTTP client cannot fetch it. We
 * emit `https:` for it.
 *
 * Already-absolute values pass through untouched; empty/missing becomes ''.
 * A root-relative value (`/foo`) is resolved against the opentable.com origin.
 */
export function absoluteAssetUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${OPENTABLE_BASE_URL}${value}`;
  return value;
}

/**
 * Join an opentable.com path onto the canonical origin.
 *
 * Tolerates a missing leading slash so a caller that builds a path by
 * concatenation can't produce `https://www.opentable.comuser/...`.
 * Already-absolute URLs pass through so callers can hand this either shape.
 */
export function opentableUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${OPENTABLE_BASE_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}
