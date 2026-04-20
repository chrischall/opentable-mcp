/**
 * Parse OpenTable search results from the /s?... SSR page.
 *
 * Results live under `state.multiSearch.restaurants[]`. Slot-level
 * availability is loaded client-side *after* hydration, so it is not
 * present in the server-rendered state — callers who need booking slots
 * should use `opentable_find_slots` for a specific venue.
 */
import { extractInitialState, ParseError } from './initial-state.js';

const BASE_URL = 'https://www.opentable.com';

interface RawRestaurant {
  restaurantId?: number;
  name?: string;
  primaryCuisine?: { name?: string };
  neighborhood?: { name?: string };
  priceBand?: { name?: string; currencySymbol?: string; priceBandId?: number };
  diningStyle?: string;
  description?: string;
  isInstantBookable?: boolean;
  address?: {
    city?: string;
    line1?: string;
    line2?: string;
    postCode?: string;
    state?: string;
  };
  contactInformation?: { phoneNumber?: string; formattedPhoneNumber?: string };
  coordinates?: { latitude?: number; longitude?: number };
  statistics?: {
    recentReservationCount?: number;
    reviews?: {
      allTimeTextReviewCount?: number;
      ratings?: { overall?: { rating?: number } };
    };
  };
  topReview?: { highlightedText?: string };
  urls?: { profileLink?: { link?: string } };
  photos?: { profileV3?: { url?: string; legacy?: { url?: string } } };
}

export interface FormattedSearchResult {
  restaurant_id: number | null;
  name: string;
  cuisine: string;
  neighborhood: string;
  price_band: string;
  price_band_id: number | null;
  dining_style: string;
  description: string;
  rating: number | null;
  review_count: number | null;
  recent_reservations: number;
  instant_bookable: boolean;
  address: string;
  city: string;
  state: string;
  postal_code: string;
  phone: string;
  latitude: number | null;
  longitude: number | null;
  top_review: string;
  url: string;
  photo_url: string;
}

export interface SearchMeta {
  term: string;
  metro: string;
  metro_id: number | null;
  total_count: number;
  returned_count: number;
}

export interface SearchResult {
  meta: SearchMeta;
  restaurants: FormattedSearchResult[];
}

function joinAddress(a: RawRestaurant['address']): string {
  if (!a) return '';
  const parts = [a.line1, a.line2, a.city, a.state, a.postCode].filter(
    (p) => typeof p === 'string' && p.length > 0
  );
  return parts.join(', ');
}

function restaurantUrl(profileLink: string | undefined): string {
  if (!profileLink) return '';
  if (profileLink.startsWith('http')) return profileLink;
  return `${BASE_URL}${profileLink.startsWith('/') ? profileLink : `/${profileLink}`}`;
}

export function formatSearchResult(raw: RawRestaurant): FormattedSearchResult {
  const reviews = raw.statistics?.reviews;
  return {
    restaurant_id: raw.restaurantId ?? null,
    name: raw.name ?? 'Unknown',
    cuisine: raw.primaryCuisine?.name ?? '',
    neighborhood: raw.neighborhood?.name ?? '',
    price_band: raw.priceBand?.name ?? '',
    price_band_id: raw.priceBand?.priceBandId ?? null,
    dining_style: raw.diningStyle ?? '',
    description: raw.description ?? '',
    rating: reviews?.ratings?.overall?.rating ?? null,
    review_count: reviews?.allTimeTextReviewCount ?? null,
    recent_reservations: raw.statistics?.recentReservationCount ?? 0,
    instant_bookable: raw.isInstantBookable ?? false,
    address: joinAddress(raw.address),
    city: raw.address?.city ?? '',
    state: raw.address?.state ?? '',
    postal_code: raw.address?.postCode ?? '',
    phone: raw.contactInformation?.formattedPhoneNumber ?? raw.contactInformation?.phoneNumber ?? '',
    latitude: raw.coordinates?.latitude ?? null,
    longitude: raw.coordinates?.longitude ?? null,
    top_review: raw.topReview?.highlightedText ?? '',
    url: restaurantUrl(raw.urls?.profileLink?.link),
    photo_url: raw.photos?.profileV3?.url ?? raw.photos?.profileV3?.legacy?.url ?? '',
  };
}

export function parseSearch(html: string): SearchResult {
  const state = extractInitialState(html);
  const ms = (state.multiSearch ?? {}) as {
    restaurants?: RawRestaurant[];
    totalRestaurantCount?: number;
    originalTerm?: string;
    freetextTerm?: string;
    metroId?: number;
    metro?: { name?: string };
  };
  if (!ms.restaurants) {
    throw new ParseError(
      'multiSearch.restaurants not present in __INITIAL_STATE__ (page may not be /s?...)'
    );
  }
  const restaurants = ms.restaurants.map(formatSearchResult);
  return {
    meta: {
      term: ms.originalTerm ?? ms.freetextTerm ?? '',
      metro: ms.metro?.name ?? '',
      metro_id: ms.metroId ?? null,
      total_count: ms.totalRestaurantCount ?? restaurants.length,
      returned_count: restaurants.length,
    },
    restaurants,
  };
}
