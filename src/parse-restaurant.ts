/**
 * Parse a single restaurant's details from the /r/{slug} SSR page.
 *
 * Details live under `state.restaurantProfile.restaurant`. Availability
 * slots are *not* SSR'd — they are loaded client-side after hydration
 * and must be fetched separately (see `parse-slots.ts` / `find_slots`).
 */
import { extractInitialState, ParseError } from './initial-state.js';

const BASE_URL = 'https://www.opentable.com';

interface RawReview {
  __typename?: string;
  rating?: number;
  ratingText?: string;
  content?: string;
  createdDate?: string;
}

interface RawRestaurant {
  restaurantId?: number;
  name?: string;
  /** "GuestCenter" = bookable via OpenTable; "Listing" = info-only,
   *  no booking flow available. */
  type?: string;
  primaryCuisine?: { name?: string };
  cuisines?: Array<{ name?: string }>;
  priceBand?: { name?: string; currencySymbol?: string; priceBandId?: number };
  neighborhood?: { name?: string };
  metro?: { displayName?: string };
  diningStyle?: string;
  dressCode?: string;
  description?: string;
  executiveChef?: string;
  hoursOfOperation?: string;
  parkingDetails?: string;
  publicTransit?: string;
  crossStreet?: string;
  website?: string;
  paymentOptions?: string[];
  additionalDetails?: string[];
  maxAdvanceDays?: number;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postCode?: string;
    country?: string;
  };
  contactInformation?: { phoneNumber?: string; formattedPhoneNumber?: string };
  coordinates?: { latitude?: number; longitude?: number; mapUrl?: string };
  timeZone?: { offsetInMinutes?: number };
  features?: {
    bar?: boolean;
    counter?: boolean;
    highTop?: boolean;
    outdoor?: boolean;
    reservationMaxPartySize?: number;
    waitlistV2Enabled?: boolean;
  };
  statistics?: {
    recentReservationCount?: number;
    reviews?: {
      allTimeTextReviewCount?: number;
      ratings?: { overall?: { rating?: number } };
    };
  };
  mostRecentReview?: { reviews?: RawReview[] };
  photos?: { profile?: { url?: string; __typename?: string } };
  /** Private-dining concierge contact block. For Listing-type
   *  restaurants (where contactInformation.phoneNumber is empty),
   *  `privateDining.formattedPhone` is the only phone OpenTable's SSR
   *  surfaces — it's the OT concierge line rather than the restaurant's
   *  direct number, but better than nothing for agents trying to point
   *  the user somewhere. */
  privateDining?: { formattedPhone?: string };
}

export type RestaurantListingType = 'GuestCenter' | 'Listing' | 'Unknown';

export interface FormattedRestaurant {
  restaurant_id: number | null;
  name: string;
  primary_cuisine: string;
  cuisines: string[];
  price_band: string;
  neighborhood: string;
  metro: string;
  dining_style: string;
  dress_code: string;
  description: string;
  executive_chef: string;
  hours_of_operation: string;
  parking_details: string;
  public_transit: string;
  cross_street: string;
  website: string;
  payment_options: string[];
  additional_details: string[];
  max_advance_days: number | null;
  address: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string;
  latitude: number | null;
  longitude: number | null;
  map_url: string;
  time_zone_offset_minutes: number | null;
  has_bar: boolean;
  has_counter: boolean;
  has_outdoor: boolean;
  max_party_size: number | null;
  waitlist_enabled: boolean;
  rating: number | null;
  review_count: number | null;
  recent_reservation_count: number;
  latest_review: string;
  photo_url: string;
  availability_token: string;
  url: string;
  /** True when OpenTable accepts reservations for this restaurant.
   *  False for Listing-type restaurants (info-only). */
  bookable: boolean;
  /** Verbatim OpenTable classification: "GuestCenter" for bookable
   *  restaurants, "Listing" for info-only. "Unknown" when the field
   *  is missing from the SSR state (defensive default). */
  listing_type: RestaurantListingType;
}

function joinAddress(a: RawRestaurant['address']): string {
  if (!a) return '';
  const parts = [a.line1, a.line2, a.city, a.state, a.postCode, a.country].filter(
    (p) => typeof p === 'string' && p.length > 0
  );
  return parts.join(', ');
}

/**
 * Parse the restaurant SSR state into the tool-facing shape.
 *
 * @param html  Raw HTML from `/r/{slug}`.
 * @param slug  The slug used in the URL the HTML was fetched from. Threaded
 *              through so the `url` field can be built as `/r/{slug}` —
 *              OpenTable 404s on `/r/{numeric-id}`. Optional for callers
 *              that don't have it (e.g., unit tests or numeric-id inputs
 *              to `opentable_get_restaurant`); url falls back to the
 *              numeric id form in that case.
 */
export function parseRestaurant(html: string, slug?: string): FormattedRestaurant {
  const state = extractInitialState(html);
  const rp = state.restaurantProfile as
    | { restaurant?: RawRestaurant; availabilityToken?: string }
    | undefined;
  if (!rp?.restaurant) {
    throw new ParseError(
      'restaurantProfile.restaurant not present in __INITIAL_STATE__ (page may not be /r/{slug})'
    );
  }
  const r = rp.restaurant;
  const reviews = r.statistics?.reviews;
  const latest = r.mostRecentReview?.reviews?.[0];

  const rawType = (r.type ?? '').trim();
  const listingType: RestaurantListingType =
    rawType === 'GuestCenter' ? 'GuestCenter'
    : rawType === 'Listing' ? 'Listing'
    : 'Unknown';
  const bookable = listingType === 'GuestCenter';

  return {
    restaurant_id: r.restaurantId ?? null,
    name: r.name ?? 'Unknown',
    primary_cuisine: r.primaryCuisine?.name ?? '',
    cuisines: (r.cuisines ?? []).map((c) => c.name ?? '').filter((s) => s.length > 0),
    price_band: r.priceBand?.name ?? '',
    neighborhood: r.neighborhood?.name ?? '',
    metro: r.metro?.displayName ?? '',
    dining_style: r.diningStyle ?? '',
    dress_code: r.dressCode ?? '',
    description: r.description ?? '',
    executive_chef: r.executiveChef ?? '',
    hours_of_operation: r.hoursOfOperation ?? '',
    parking_details: r.parkingDetails ?? '',
    public_transit: r.publicTransit ?? '',
    cross_street: r.crossStreet ?? '',
    website: r.website ?? '',
    payment_options: r.paymentOptions ?? [],
    additional_details: r.additionalDetails ?? [],
    max_advance_days: r.maxAdvanceDays ?? null,
    address: joinAddress(r.address),
    city: r.address?.city ?? '',
    state: r.address?.state ?? '',
    postal_code: r.address?.postCode ?? '',
    country: r.address?.country ?? '',
    // Phone: prefer the restaurant's direct line, fall back to OpenTable's
    // private-dining concierge line for Listing-type restaurants (which
    // leave contactInformation empty). Empty string only if both are missing.
    phone:
      r.contactInformation?.formattedPhoneNumber ||
      r.contactInformation?.phoneNumber ||
      r.privateDining?.formattedPhone ||
      '',
    latitude: r.coordinates?.latitude ?? null,
    longitude: r.coordinates?.longitude ?? null,
    map_url: r.coordinates?.mapUrl ?? '',
    time_zone_offset_minutes: r.timeZone?.offsetInMinutes ?? null,
    has_bar: r.features?.bar ?? false,
    has_counter: r.features?.counter ?? false,
    has_outdoor: r.features?.outdoor ?? false,
    max_party_size: r.features?.reservationMaxPartySize ?? null,
    waitlist_enabled: r.features?.waitlistV2Enabled ?? false,
    rating: reviews?.ratings?.overall?.rating ?? null,
    review_count: reviews?.allTimeTextReviewCount ?? null,
    recent_reservation_count: r.statistics?.recentReservationCount ?? 0,
    latest_review: latest?.content ?? '',
    photo_url: r.photos?.profile?.url ?? '',
    availability_token: rp.availabilityToken ?? '',
    // URL: /r/{slug} when we have it (the only form opentable.com serves);
    // fall back to /r/{numeric-id} so the field at least leads to the right
    // restaurant in the API/CDN sense even if the public-facing URL 404s.
    url: slug
      ? `${BASE_URL}/r/${slug}`
      : r.restaurantId !== undefined
        ? `${BASE_URL}/r/${r.restaurantId}`
        : '',
    bookable,
    listing_type: listingType,
  };
}
