import { describe, it, expect } from 'vitest';
import { parseRestaurant } from '../src/parse-restaurant.js';
import { ParseError } from '../src/initial-state.js';

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

describe('parseRestaurant', () => {
  it('maps a fully-populated restaurantProfile.restaurant', () => {
    const html = htmlWith({
      restaurantProfile: {
        availabilityToken: 'tok-avail-1',
        restaurant: {
          restaurantId: 42,
          name: 'Gran Morsi',
          primaryCuisine: { name: 'Italian' },
          cuisines: [{ name: 'Italian' }, { name: 'Pizza' }, { name: 'Seafood' }],
          priceBand: { name: '$31 to $50', priceBandId: 2, currencySymbol: '$' },
          neighborhood: { name: 'Tribeca' },
          metro: { displayName: 'New York' },
          diningStyle: 'Casual Elegant',
          dressCode: 'Business Casual',
          description: 'Italian family style.',
          executiveChef: 'Chef Smith',
          hoursOfOperation: 'Mon-Fri 5-10pm; Sat-Sun 11am-10pm',
          parkingDetails: 'Street parking',
          publicTransit: '1 train to Canal',
          crossStreet: 'White St',
          website: 'https://example.com',
          paymentOptions: ['AMEX', 'Mastercard', 'Visa', 'Discover'],
          additionalDetails: ['Beer', 'Wine', 'Outdoor'],
          maxAdvanceDays: 30,
          address: {
            line1: '22 Warren St',
            line2: '',
            city: 'New York',
            state: 'NY',
            postCode: '10007',
            country: 'US',
          },
          contactInformation: {
            formattedPhoneNumber: '(212) 253-7555',
            phoneNumber: '+12122537555',
          },
          coordinates: {
            latitude: 40.714,
            longitude: -74.009,
            mapUrl: 'https://maps/...',
          },
          timeZone: { offsetInMinutes: -300 },
          features: {
            bar: true,
            counter: false,
            outdoor: true,
            reservationMaxPartySize: 8,
            waitlistV2Enabled: true,
          },
          statistics: {
            recentReservationCount: 50,
            reviews: {
              allTimeTextReviewCount: 500,
              ratings: { overall: { rating: 4.5 } },
            },
          },
          mostRecentReview: {
            reviews: [{ content: 'Loved it.' }],
          },
          photos: { profile: { url: 'https://cdn/r.jpg' } },
        },
      },
    });
    const r = parseRestaurant(html);
    expect(r).toMatchObject({
      restaurant_id: 42,
      name: 'Gran Morsi',
      primary_cuisine: 'Italian',
      cuisines: ['Italian', 'Pizza', 'Seafood'],
      price_band: '$31 to $50',
      neighborhood: 'Tribeca',
      metro: 'New York',
      dining_style: 'Casual Elegant',
      dress_code: 'Business Casual',
      description: 'Italian family style.',
      executive_chef: 'Chef Smith',
      payment_options: ['AMEX', 'Mastercard', 'Visa', 'Discover'],
      address: '22 Warren St, New York, NY, 10007, US',
      city: 'New York',
      phone: '(212) 253-7555',
      latitude: 40.714,
      has_bar: true,
      has_outdoor: true,
      max_party_size: 8,
      waitlist_enabled: true,
      rating: 4.5,
      review_count: 500,
      recent_reservation_count: 50,
      latest_review: 'Loved it.',
      availability_token: 'tok-avail-1',
      photo_url: 'https://cdn/r.jpg',
      url: 'https://www.opentable.com/r/42',
    });
  });

  it('fills missing fields with sensible defaults', () => {
    const html = htmlWith({
      restaurantProfile: {
        restaurant: { restaurantId: 1, name: 'X' },
      },
    });
    const r = parseRestaurant(html);
    expect(r.name).toBe('X');
    expect(r.primary_cuisine).toBe('');
    expect(r.cuisines).toEqual([]);
    expect(r.payment_options).toEqual([]);
    expect(r.rating).toBeNull();
    expect(r.has_bar).toBe(false);
    expect(r.max_party_size).toBeNull();
    expect(r.availability_token).toBe('');
  });

  it('throws ParseError when restaurantProfile.restaurant is absent', () => {
    expect(() => parseRestaurant(htmlWith({ restaurantProfile: {} }))).toThrow(ParseError);
    expect(() => parseRestaurant(htmlWith({}))).toThrow(ParseError);
  });

  it('falls back to raw phoneNumber when formattedPhoneNumber is missing', () => {
    const html = htmlWith({
      restaurantProfile: {
        restaurant: {
          restaurantId: 1,
          name: 'X',
          contactInformation: { phoneNumber: '+12125550000' },
        },
      },
    });
    expect(parseRestaurant(html).phone).toBe('+12125550000');
  });
});
