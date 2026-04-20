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
  restaurant_id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  price_range: string;
  rating: number | null;
  review_count: number | null;
  url: string;
}

const BASE_URL = 'https://www.opentable.com';

function firstOf<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function restaurantUrl(slug: string | undefined, profileUrl: string | undefined): string {
  if (profileUrl) {
    return profileUrl.startsWith('http')
      ? profileUrl
      : `${BASE_URL}${profileUrl.startsWith('/') ? profileUrl : `/${profileUrl}`}`;
  }
  if (slug) return `${BASE_URL}/r/${slug}`;
  return '';
}

export function formatFavorite(raw: RawFavoriteRestaurant): FormattedFavorite {
  const id = firstOf(raw.id, raw.restaurantId);
  return {
    restaurant_id: id !== undefined ? String(id) : '',
    name: firstOf(raw.name, raw.restaurantName) ?? 'Unknown',
    cuisine: firstOf(raw.cuisine, raw.primaryCuisine) ?? '',
    neighborhood: firstOf(raw.neighborhoodName, raw.neighborhood) ?? '',
    price_range: firstOf(raw.priceBand, raw.priceRange, raw.price) ?? '',
    rating: firstOf(raw.overallRating, raw.averageRating) ?? null,
    review_count: firstOf(raw.reviewCount, raw.totalReviewCount) ?? null,
    url: restaurantUrl(firstOf(raw.urlSlug, raw.slug), raw.profileUrl),
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
