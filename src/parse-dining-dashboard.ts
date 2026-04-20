/**
 * Parse an OpenTable Dining Dashboard HTML page.
 *
 * OpenTable is a Next.js/React SSR application: page state is embedded in
 * the HTML as `window.__INITIAL_STATE__ = {...}`. The client-side app
 * hydrates from that blob rather than calling a public JSON API. Our tools
 * therefore fetch the user-facing page and extract the state blob, rather
 * than hitting a REST endpoint.
 *
 * This module handles only the parsing layer. Fetching the HTML requires
 * bypassing Akamai Bot Manager, which is tracked separately — see README.
 */

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

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Extract `window.__INITIAL_STATE__` from an HTML string.
 *
 * OpenTable renders the state as a JSON literal inside a <script> tag. We
 * locate the assignment and then walk the JSON to find its matching closing
 * brace (can't use regex because the state contains nested objects and
 * escaped strings).
 */
export function extractInitialState(html: string): Record<string, unknown> {
  const marker = 'window.__INITIAL_STATE__';
  const idx = html.indexOf(marker);
  if (idx < 0) {
    throw new ParseError('window.__INITIAL_STATE__ not found in HTML');
  }

  // Find the first '{' after the marker (skip whitespace and `=`).
  let start = idx + marker.length;
  while (start < html.length && html[start] !== '{') start++;
  if (start >= html.length) {
    throw new ParseError('Could not locate start of __INITIAL_STATE__ JSON');
  }

  // Walk forward, counting braces while respecting strings, to find the match.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    throw new ParseError('Unmatched braces in __INITIAL_STATE__');
  }

  const json = html.slice(start, end);
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `Failed to parse __INITIAL_STATE__ JSON: ${(err as Error).message}`
    );
  }
}

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
