import { describe, it, expect } from 'vitest';
import { parseSearch, formatSearchResult } from '../src/parse-search.js';
import { ParseError } from '../src/initial-state.js';

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

const sampleRaw = {
  restaurantId: 42,
  name: 'Testeria',
  primaryCuisine: { name: 'Italian' },
  neighborhood: { name: 'Hayes Valley' },
  priceBand: { name: '$31 to $50', currencySymbol: '$', priceBandId: 2 },
  diningStyle: 'Casual Dining',
  description: 'Northern Italian in a cozy setting.',
  isInstantBookable: true,
  address: {
    line1: '123 Market St',
    line2: null,
    city: 'San Francisco',
    state: 'CA',
    postCode: '94102',
  },
  contactInformation: {
    phoneNumber: '+14155551234',
    formattedPhoneNumber: '(415) 555-1234',
  },
  coordinates: { latitude: 37.7749, longitude: -122.4194 },
  statistics: {
    recentReservationCount: 33,
    reviews: {
      allTimeTextReviewCount: 1200,
      ratings: { overall: { rating: 4.7 } },
    },
  },
  topReview: { highlightedText: 'The pappardelle was perfect.' },
  urls: { profileLink: { link: '/r/testeria-sf' } },
  photos: { profileV3: { url: 'https://cdn.example/hero.jpg' } },
};

describe('parseSearch', () => {
  it('extracts meta + restaurants from multiSearch state', () => {
    const html = htmlWith({
      multiSearch: {
        originalTerm: 'italian',
        metroId: 8,
        metro: { name: 'San Francisco Bay Area' },
        totalRestaurantCount: 250,
        restaurants: [sampleRaw],
      },
    });
    const result = parseSearch(html);
    expect(result.meta).toEqual({
      term: 'italian',
      metro: 'San Francisco Bay Area',
      metro_id: 8,
      total_count: 250,
      returned_count: 1,
    });
    expect(result.restaurants).toHaveLength(1);
    expect(result.restaurants[0]).toMatchObject({
      restaurant_id: 42,
      name: 'Testeria',
      cuisine: 'Italian',
      neighborhood: 'Hayes Valley',
      price_band: '$31 to $50',
      dining_style: 'Casual Dining',
      rating: 4.7,
      review_count: 1200,
      instant_bookable: true,
      address: '123 Market St, San Francisco, CA, 94102',
      city: 'San Francisco',
      latitude: 37.7749,
      phone: '(415) 555-1234',
      url: 'https://www.opentable.com/r/testeria-sf',
    });
  });

  it('returns empty meta values when upstream fields are missing', () => {
    const html = htmlWith({
      multiSearch: { restaurants: [] },
    });
    const result = parseSearch(html);
    expect(result.meta).toEqual({
      term: '',
      metro: '',
      metro_id: null,
      total_count: 0,
      returned_count: 0,
    });
    expect(result.restaurants).toEqual([]);
  });

  it('throws ParseError when multiSearch is absent', () => {
    expect(() => parseSearch(htmlWith({}))).toThrow(ParseError);
  });

  it('defaults gracefully for a minimal restaurant', () => {
    const r = formatSearchResult({ restaurantId: 1, name: 'X' });
    expect(r).toMatchObject({
      restaurant_id: 1,
      name: 'X',
      cuisine: '',
      rating: null,
      review_count: null,
      address: '',
      phone: '',
      url: '',
      photo_url: '',
    });
  });

  it('falls back to raw phoneNumber when formattedPhoneNumber is absent', () => {
    const r = formatSearchResult({
      restaurantId: 1,
      name: 'X',
      contactInformation: { phoneNumber: '+14155550000' },
    });
    expect(r.phone).toBe('+14155550000');
  });

  it('uses legacy photo URL when profileV3.url is missing', () => {
    const r = formatSearchResult({
      restaurantId: 1,
      name: 'X',
      photos: { profileV3: { legacy: { url: 'https://cdn/legacy.jpg' } } },
    });
    expect(r.photo_url).toBe('https://cdn/legacy.jpg');
  });
});
