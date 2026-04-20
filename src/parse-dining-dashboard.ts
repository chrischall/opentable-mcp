/**
 * Parse an OpenTable Dining Dashboard HTML page (/user/dining-dashboard).
 *
 * The page is server-rendered by Next.js and embeds `__INITIAL_STATE__` in
 * the HTML. We locate that blob (via `extractInitialState`) and shape the
 * `diningDashboard` subtree into tool-friendly objects.
 */
import { extractInitialState } from './initial-state.js';

interface RawReservation {
  __typename?: string;
  confirmationNumber?: number;
  confirmationId?: unknown;
  dateTime?: string;
  dinerFirstName?: string;
  dinerLastName?: string;
  isForPrimaryDiner?: boolean;
  isPrivateDining?: boolean;
  isUpcoming?: boolean;
  partySize?: number;
  points?: number;
  reservationState?: string;
  reservationType?: string;
  restaurantId?: number;
  restaurantName?: string;
  securityToken?: string;
}

export interface FormattedReservation {
  reservation_id: string;
  confirmation_number: number | null;
  restaurant_id: number | null;
  restaurant_name: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  reservation_type: string;
  is_private_dining: boolean;
  is_primary_diner: boolean;
  points: number;
  security_token: string;
}

// ParseError and extractInitialState are re-exported from ./initial-state
// for backward compatibility with tests that imported them here.
export { ParseError, extractInitialState } from './initial-state.js';
import { ParseError } from './initial-state.js';

/**
 * Split an ISO-ish datetime ("2026-04-26T19:00:00") into date + HH:MM.
 * Parses by string split rather than Date() to avoid timezone drift —
 * OpenTable emits the local restaurant time in this field.
 */
function splitDateTime(dt: string | undefined): { date: string; time: string } {
  if (!dt) return { date: '', time: '' };
  const tIdx = dt.indexOf('T');
  if (tIdx < 0) return { date: dt, time: '' };
  const date = dt.slice(0, tIdx);
  const rest = dt.slice(tIdx + 1);
  const hhmm = rest.match(/^(\d{2}):(\d{2})/);
  return { date, time: hhmm ? `${hhmm[1]}:${hhmm[2]}` : '' };
}

function formatReservation(raw: RawReservation): FormattedReservation {
  const { date, time } = splitDateTime(raw.dateTime);
  return {
    reservation_id: raw.confirmationNumber !== undefined ? String(raw.confirmationNumber) : '',
    confirmation_number: raw.confirmationNumber ?? null,
    restaurant_id: raw.restaurantId ?? null,
    restaurant_name: raw.restaurantName ?? 'Unknown',
    date,
    time,
    party_size: raw.partySize ?? 0,
    status: raw.reservationState ?? '',
    reservation_type: raw.reservationType ?? '',
    is_private_dining: raw.isPrivateDining ?? false,
    is_primary_diner: raw.isForPrimaryDiner ?? false,
    points: raw.points ?? 0,
    security_token: raw.securityToken ?? '',
  };
}

export type ReservationScope = 'upcoming' | 'past' | 'all';

export function parseDiningDashboard(
  html: string,
  scope: ReservationScope = 'upcoming'
): FormattedReservation[] {
  const state = extractInitialState(html);
  const dd = state.diningDashboard as
    | { upcomingReservations?: RawReservation[]; pastReservations?: RawReservation[] }
    | undefined;
  if (!dd) {
    throw new ParseError('diningDashboard not present in __INITIAL_STATE__');
  }

  const upcoming = dd.upcomingReservations ?? [];
  const past = dd.pastReservations ?? [];

  const source =
    scope === 'upcoming' ? upcoming : scope === 'past' ? past : [...upcoming, ...past];

  return source.map(formatReservation);
}
