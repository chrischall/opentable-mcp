/**
 * Parse the user's saved restaurants ("favorites") from the /user/favorites
 * SSR page. Data lives under `state.userProfile.favorites.restaurants[]`.
 *
 * The exact restaurant-object shape is unknown at the time of writing
 * because the live test account has no saved restaurants. The parser maps
 * the fields OpenTable uses consistently elsewhere (search results, venue
 * pages) and preserves unknown keys under `_raw` so callers can inspect
 * any surface that changed without us having to chase every field.
 */
import { extractInitialState, ParseError } from './initial-state.js';
import { opentableUrl, restaurantProfilePath } from './urls.js';

interface RawFavoriteRestaurant {
  id?: number | string;
  restaurantId?: number | string;
  name?: string;
  restaurantName?: string;
  cuisine?: string;
  primaryCuisine?: string;
  neighborhoodName?: string;
  neighborhood?: string;
  priceBand?: string;
  priceRange?: string;
  price?: string;
  overallRating?: number;
  averageRating?: number;
  reviewCount?: number;
  totalReviewCount?: number;
  urlSlug?: string;
  slug?: string;
  profileUrl?: string;
}

export interface FormattedFavorite {
  /** Numeric OpenTable restaurantId, as every other tool returns it; null when absent/non-numeric. */
  restaurant_id: number | null;
  name: string;
  cuisine: string;
  neighborhood: string;
  price_range: string;
  rating: number | null;
  review_count: number | null;
  url: string;
}

function firstOf<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

/**
 * Coerce the raw id to the numeric `restaurant_id` every other tool returns
 * (search, get_restaurant, slots, reservations). The favorites payload has
 * been seen as either a number or a digit string; anything else is null.
 */
function numericId(raw: number | string | undefined): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function restaurantUrl(
  slug: string | undefined,
  profileUrl: string | undefined,
  id: number | null
): string {
  if (profileUrl) return opentableUrl(profileUrl);
  if (slug) return opentableUrl(`/r/${slug}`);
  // No slug: the numeric-id profile route resolves (the /r/{id} shape 404s).
  if (id !== null) return opentableUrl(restaurantProfilePath(id));
  return '';
}

export function formatFavorite(raw: RawFavoriteRestaurant): FormattedFavorite {
  const id = numericId(firstOf(raw.id, raw.restaurantId));
  return {
    restaurant_id: id,
    name: firstOf(raw.name, raw.restaurantName) ?? 'Unknown',
    cuisine: firstOf(raw.cuisine, raw.primaryCuisine) ?? '',
    neighborhood: firstOf(raw.neighborhoodName, raw.neighborhood) ?? '',
    price_range: firstOf(raw.priceBand, raw.priceRange, raw.price) ?? '',
    rating: firstOf(raw.overallRating, raw.averageRating) ?? null,
    review_count: firstOf(raw.reviewCount, raw.totalReviewCount) ?? null,
    url: restaurantUrl(firstOf(raw.urlSlug, raw.slug), raw.profileUrl, id),
  };
}

export function parseFavorites(html: string): FormattedFavorite[] {
  const state = extractInitialState(html);
  const up = (state.userProfile ?? {}) as {
    favorites?: { loading?: boolean; restaurants?: RawFavoriteRestaurant[] };
  };
  if (!up.favorites) {
    throw new ParseError(
      'userProfile.favorites not present in __INITIAL_STATE__ (page may not be /user/favorites)'
    );
  }
  const list = up.favorites.restaurants ?? [];
  return list.map(formatFavorite);
}
