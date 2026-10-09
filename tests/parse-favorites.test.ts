import { describe, it, expect } from 'vitest';
import { parseFavorites, formatFavorite } from '../src/parse-favorites.js';
import { ParseError } from '../src/initial-state.js';

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

describe('parseFavorites', () => {
  it('returns an empty list when the user has no favorites', () => {
    const html = htmlWith({
      userProfile: { favorites: { loading: false, restaurants: [] } },
    });
    expect(parseFavorites(html)).toEqual([]);
  });

  it('formats a canonical restaurant entry', () => {
    const html = htmlWith({
      userProfile: {
        favorites: {
          loading: false,
          restaurants: [
            {
              id: 42,
              name: 'Testeria',
              primaryCuisine: 'Italian',
              neighborhoodName: 'Hayes Valley',
              priceBand: '$$$',
              overallRating: 4.7,
              reviewCount: 1200,
              urlSlug: 'testeria-sf',
            },
          ],
        },
      },
    });
    expect(parseFavorites(html)).toEqual([
      {
        restaurant_id: 42,
        name: 'Testeria',
        cuisine: 'Italian',
        neighborhood: 'Hayes Valley',
        price_range: '$$$',
        rating: 4.7,
        review_count: 1200,
        url: 'https://www.opentable.com/r/testeria-sf',
      },
    ]);
  });

  it('tolerates alternate field names (restaurantId, restaurantName, neighborhood, etc.)', () => {
    const r = formatFavorite({
      restaurantId: '99',
      restaurantName: 'Alt Shape',
      cuisine: 'Japanese',
      neighborhood: 'Mission',
      priceRange: '$$',
      averageRating: 4.2,
      totalReviewCount: 50,
      slug: 'alt-shape',
    });
    expect(r).toMatchObject({
      restaurant_id: 99,
      name: 'Alt Shape',
      cuisine: 'Japanese',
      neighborhood: 'Mission',
      price_range: '$$',
      rating: 4.2,
      review_count: 50,
      url: 'https://www.opentable.com/r/alt-shape',
    });
  });

  it('uses profileUrl verbatim when provided, including absolute URLs', () => {
    expect(formatFavorite({ id: 1, name: 'X', profileUrl: '/restaurant/x' }).url).toBe(
      'https://www.opentable.com/restaurant/x'
    );
    expect(
      formatFavorite({ id: 1, name: 'X', profileUrl: 'https://www.opentable.com/r/x' }).url
    ).toBe('https://www.opentable.com/r/x');
  });

  it('tolerates a profileUrl without a leading slash', () => {
    expect(formatFavorite({ id: 1, name: 'X', profileUrl: 'restaurant/x' }).url).toBe(
      'https://www.opentable.com/restaurant/x'
    );
  });

  it('falls back to the numeric-id profile route when neither slug nor profileUrl is present', () => {
    // /r/{numeric-id} 404s; /restaurant/profile/{id} resolves (see urls.ts).
    expect(formatFavorite({ id: 1, name: 'X' }).url).toBe(
      'https://www.opentable.com/restaurant/profile/1'
    );
    expect(formatFavorite({ restaurantId: '77', name: 'X' }).url).toBe(
      'https://www.opentable.com/restaurant/profile/77'
    );
  });

  it('returns empty string url when there is no slug, profileUrl or id', () => {
    expect(formatFavorite({ name: 'X' }).url).toBe('');
  });

  it('returns restaurant_id as a number, like every other tool', () => {
    expect(formatFavorite({ id: 42, name: 'X' }).restaurant_id).toBe(42);
    expect(formatFavorite({ restaurantId: '99', name: 'X' }).restaurant_id).toBe(99);
  });

  it('returns null restaurant_id when the id is missing or not numeric', () => {
    expect(formatFavorite({ name: 'X' }).restaurant_id).toBeNull();
    expect(formatFavorite({ id: 'abc', name: 'X' }).restaurant_id).toBeNull();
    // A non-numeric id has no profile route, so no url either.
    expect(formatFavorite({ id: 'abc', name: 'X' }).url).toBe('');
    // Non-positive / unsafe ids are not addressable OpenTable ids.
    expect(formatFavorite({ id: 0, name: 'X' }).restaurant_id).toBeNull();
    expect(formatFavorite({ id: 1.5, name: 'X' }).restaurant_id).toBeNull();
    expect(formatFavorite({ id: '0', name: 'X' }).restaurant_id).toBeNull();
    expect(formatFavorite({ id: '99999999999999999999', name: 'X' }).restaurant_id).toBeNull();
  });

  it('throws ParseError when userProfile.favorites is missing', () => {
    expect(() =>
      parseFavorites(htmlWith({ userProfile: {} }))
    ).toThrow(ParseError);
  });

  it('defaults rating/review_count to null when absent', () => {
    const r = formatFavorite({ id: 1, name: 'X' });
    expect(r.rating).toBeNull();
    expect(r.review_count).toBeNull();
  });
});
