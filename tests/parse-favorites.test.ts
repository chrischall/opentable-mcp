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
        restaurant_id: '42',
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
      restaurant_id: '99',
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

  it('returns empty string url when neither slug nor profileUrl is present', () => {
    expect(formatFavorite({ id: 1, name: 'X' }).url).toBe('');
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
