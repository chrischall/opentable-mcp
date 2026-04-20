import { describe, it, expect } from 'vitest';
import { parseUserProfile } from '../src/parse-user-profile.js';
import { ParseError } from '../src/initial-state.js';

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

describe('parseUserProfile', () => {
  it('formats a full userProfile from header', () => {
    const html = htmlWith({
      header: {
        userProfile: {
          gpid: 123456789012,
          firstName: 'Sam',
          lastName: 'Example',
          email: 'sam@example.com',
          mobilePhoneNumber: { number: '5551234567', countryId: '1' },
          homePhoneNumber: { number: '', countryId: '1' },
          points: 250,
          eligibleToEarnPoints: true,
          metro: { displayName: 'San Francisco', name: 'SF' },
          countryId: 'US',
          createDate: '2020-06-15T00:00:00',
          isVip: false,
          isConcierge: false,
        },
      },
    });
    expect(parseUserProfile(html)).toEqual({
      gpid: 123456789012,
      first_name: 'Sam',
      last_name: 'Example',
      email: 'sam@example.com',
      mobile_phone: '+1 5551234567',
      home_phone: null,
      points: 250,
      eligible_to_earn_points: true,
      metro: 'San Francisco',
      country_id: 'US',
      member_since: '2020-06-15T00:00:00',
      is_vip: false,
      is_concierge: false,
    });
  });

  it('falls back gracefully when fields are missing', () => {
    const html = htmlWith({ header: { userProfile: { firstName: 'A' } } });
    const p = parseUserProfile(html);
    expect(p.first_name).toBe('A');
    expect(p.last_name).toBe('');
    expect(p.mobile_phone).toBeNull();
    expect(p.home_phone).toBeNull();
    expect(p.points).toBe(0);
    expect(p.is_vip).toBe(false);
  });

  it('omits country code when phone object lacks countryId', () => {
    const html = htmlWith({
      header: {
        userProfile: {
          firstName: 'A',
          lastName: 'B',
          mobilePhoneNumber: { number: '5551234567' },
        },
      },
    });
    expect(parseUserProfile(html).mobile_phone).toBe('5551234567');
  });

  it('throws ParseError when header.userProfile is absent', () => {
    expect(() =>
      parseUserProfile(htmlWith({ header: {} }))
    ).toThrow(ParseError);
  });

  it('prefers metro.displayName over metro.name', () => {
    const html = htmlWith({
      header: {
        userProfile: {
          firstName: 'A',
          lastName: 'B',
          metro: { displayName: 'New York', name: 'NYC' },
        },
      },
    });
    expect(parseUserProfile(html).metro).toBe('New York');
  });
});
