/**
 * Parse user-profile data out of an OpenTable page's `__INITIAL_STATE__`.
 *
 * Profile lives under `state.header.userProfile` and is present on every
 * authenticated user-facing page (including /user/dining-dashboard that
 * we already fetch for reservations).
 */
import { extractInitialState, ParseError } from './initial-state.js';

interface RawPhoneNumber {
  number?: string;
  countryId?: string;
  __typename?: string;
}

interface RawMetro {
  displayName?: string;
  name?: string;
  __typename?: string;
}

interface RawUserProfile {
  gpid?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailHash?: string;
  homePhoneNumber?: RawPhoneNumber;
  mobilePhoneNumber?: RawPhoneNumber;
  points?: number;
  eligibleToEarnPoints?: boolean;
  metro?: RawMetro;
  metroId?: number;
  countryId?: string;
  createDate?: string;
  isConcierge?: boolean;
  isVip?: boolean;
  userType?: number;
}

export interface FormattedProfile {
  gpid: number | null;
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  home_phone: string | null;
  points: number;
  eligible_to_earn_points: boolean;
  metro: string;
  country_id: string;
  member_since: string;
  is_vip: boolean;
  is_concierge: boolean;
}

function phoneString(p: RawPhoneNumber | undefined): string | null {
  if (!p || !p.number) return null;
  return p.countryId ? `+${p.countryId} ${p.number}` : p.number;
}

export function parseUserProfile(html: string): FormattedProfile {
  const state = extractInitialState(html);
  const header = (state.header ?? {}) as { userProfile?: RawUserProfile };
  const up = header.userProfile;
  if (!up) {
    throw new ParseError('header.userProfile not present in __INITIAL_STATE__');
  }
  return {
    gpid: typeof up.gpid === 'number' ? up.gpid : null,
    first_name: up.firstName ?? '',
    last_name: up.lastName ?? '',
    email: up.email ?? '',
    mobile_phone: phoneString(up.mobilePhoneNumber),
    home_phone: phoneString(up.homePhoneNumber),
    points: up.points ?? 0,
    eligible_to_earn_points: up.eligibleToEarnPoints ?? false,
    metro: up.metro?.displayName ?? up.metro?.name ?? '',
    country_id: up.countryId ?? '',
    member_since: up.createDate ?? '',
    is_vip: up.isVip ?? false,
    is_concierge: up.isConcierge ?? false,
  };
}
