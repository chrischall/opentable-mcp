import { describe, it, expect } from 'vitest';
import {
  extractInitialState,
  parseDiningDashboard,
  ParseError,
} from '../src/parse-dining-dashboard.js';

/**
 * Synthetic fixture matching the shape observed in a real authenticated
 * OpenTable /user/dining-dashboard page (2026-04-20). No real PII. Shape
 * verified in-browser before being hand-crafted into this fixture.
 */
const syntheticState = {
  authentication: { loggedIn: true },
  diningDashboard: {
    email: 'sample@example.com',
    points: 150,
    countryId: 1,
    isUserActive: true,
    hasError: false,
    upcomingReservations: [
      {
        __typename: 'Reservation',
        confirmationNumber: 1234567890,
        confirmationId: null,
        dateTime: '2026-05-01T19:00:00',
        dinerFirstName: 'Sample',
        dinerLastName: 'Diner',
        isForPrimaryDiner: true,
        isPrivateDining: false,
        isUpcoming: true,
        partySize: 2,
        points: 100,
        reservationState: 'CONFIRMED',
        reservationType: 'Standard',
        restaurantId: 42,
        restaurantName: 'Example Trattoria',
        securityToken: 'tok-abc-123',
        restaurant: {
          __typename: 'Restaurant',
          photos: {
            __typename: 'RestaurantProfile',
            profile: {
              __typename: 'RestaurantProfilePhotos',
              small: { __typename: 'Thumbnail', url: 'https://example.com/small.jpg' },
              wideLarge: { __typename: 'Thumbnail', url: 'https://example.com/wl.jpg' },
            },
          },
        },
      },
    ],
    pastReservations: [
      {
        __typename: 'Reservation',
        confirmationNumber: 1234567000,
        dateTime: '2025-12-15T20:30:00',
        partySize: 4,
        reservationState: 'COMPLETED',
        reservationType: 'Standard',
        restaurantId: 99,
        restaurantName: 'Bygone Bistro',
        securityToken: 'tok-old-789',
        isUpcoming: false,
        isForPrimaryDiner: true,
        isPrivateDining: false,
        points: 50,
        transactionType: 'Standard',
      },
    ],
  },
  otherState: { foo: 'bar' },
};

function buildHtml(stateOverride?: unknown): string {
  const payload = stateOverride === undefined ? syntheticState : stateOverride;
  return `<!DOCTYPE html>
<html>
<head><title>Sample</title></head>
<body>
<script nonce="abc">
window.__PAGE_INFO__ = {};
window.__INITIAL_STATE__ = ${JSON.stringify(payload)};
window.__CSRF_TOKEN__ = "not-a-real-token";
</script>
</body>
</html>`;
}

describe('extractInitialState', () => {
  it('parses a straightforward __INITIAL_STATE__ assignment', () => {
    const state = extractInitialState(buildHtml());
    expect((state as { otherState: { foo: string } }).otherState.foo).toBe('bar');
  });

  it('handles nested braces inside string values', () => {
    const html = `<script>window.__INITIAL_STATE__ = {"note":"has { and } in it","n":1};</script>`;
    const state = extractInitialState(html);
    expect(state).toEqual({ note: 'has { and } in it', n: 1 });
  });

  it('handles escaped quotes inside string values', () => {
    const html = `<script>window.__INITIAL_STATE__ = {"note":"She said \\"hi\\" today","n":1};</script>`;
    const state = extractInitialState(html);
    expect(state).toEqual({ note: 'She said "hi" today', n: 1 });
  });

  it('throws ParseError when the marker is absent', () => {
    expect(() => extractInitialState('<html></html>')).toThrow(ParseError);
  });

  it('parses the SSR JSON-key form ("__INITIAL_STATE__":{...})', () => {
    // OpenTable embeds the state as a JSON key inside a larger blob rather
    // than as a JS assignment. Same extractor should handle both.
    const html = `<script>{"apolloState":{},"__INITIAL_STATE__":{"foo":1,"nested":{"bar":2}}}</script>`;
    const state = extractInitialState(html);
    expect(state).toEqual({ foo: 1, nested: { bar: 2 } });
  });

  it('throws ParseError when braces are unmatched', () => {
    expect(() =>
      extractInitialState(`<script>window.__INITIAL_STATE__ = {"a":1</script>`)
    ).toThrow(ParseError);
  });

  it('throws ParseError when JSON is malformed', () => {
    expect(() =>
      extractInitialState(`<script>window.__INITIAL_STATE__ = {"a":undefined};</script>`)
    ).toThrow(ParseError);
  });
});

describe('parseDiningDashboard', () => {
  it('defaults to upcoming reservations, formatted correctly', () => {
    const result = parseDiningDashboard(buildHtml());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      reservation_id: '1234567890',
      confirmation_number: 1234567890,
      restaurant_id: 42,
      restaurant_name: 'Example Trattoria',
      date: '2026-05-01',
      time: '19:00',
      party_size: 2,
      status: 'CONFIRMED',
      reservation_type: 'Standard',
      is_private_dining: false,
      is_primary_diner: true,
      points: 100,
      security_token: 'tok-abc-123',
    });
  });

  it('returns past reservations when scope=past', () => {
    const result = parseDiningDashboard(buildHtml(), 'past');
    expect(result).toHaveLength(1);
    expect(result[0].reservation_id).toBe('1234567000');
    expect(result[0].date).toBe('2025-12-15');
    expect(result[0].time).toBe('20:30');
    expect(result[0].status).toBe('COMPLETED');
  });

  it('merges upcoming + past when scope=all', () => {
    const result = parseDiningDashboard(buildHtml(), 'all');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.reservation_id)).toEqual(['1234567890', '1234567000']);
  });

  it('handles empty reservation arrays gracefully', () => {
    const empty = {
      ...syntheticState,
      diningDashboard: {
        ...syntheticState.diningDashboard,
        upcomingReservations: [],
        pastReservations: [],
      },
    };
    expect(parseDiningDashboard(buildHtml(empty), 'all')).toEqual([]);
  });

  it('throws ParseError when diningDashboard is missing', () => {
    expect(() => parseDiningDashboard(buildHtml({ otherThing: 1 }))).toThrow(ParseError);
  });

  it('preserves reservations with missing optional fields', () => {
    const minimal = {
      diningDashboard: {
        upcomingReservations: [{ confirmationNumber: 1, dateTime: '2026-05-01T19:00:00' }],
        pastReservations: [],
      },
    };
    const result = parseDiningDashboard(buildHtml(minimal));
    expect(result[0].restaurant_name).toBe('Unknown');
    expect(result[0].party_size).toBe(0);
    expect(result[0].security_token).toBe('');
  });

  it('splits date/time without round-tripping through Date (no TZ drift)', () => {
    const tzCase = {
      diningDashboard: {
        upcomingReservations: [
          { confirmationNumber: 1, dateTime: '2026-05-01T19:00:00' },
        ],
        pastReservations: [],
      },
    };
    const result = parseDiningDashboard(buildHtml(tzCase));
    // Restaurant-local 19:00 must appear as 19:00 regardless of test machine TZ.
    expect(result[0].date).toBe('2026-05-01');
    expect(result[0].time).toBe('19:00');
  });
});
