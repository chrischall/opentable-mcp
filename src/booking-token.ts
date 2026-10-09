// Opaque, stateless token passed between opentable_book_preview and
// opentable_book (and modify_preview → modify). Format:
//
//   base64url(JSON({ p: payload, exp })) "." base64url(HMAC-SHA256)
//
// The HMAC key never leaves this server (derived from the fleet confirm key:
// MCP_CONFIRM_SECRET when set, else a per-process random key — the server
// outlives preview → book), so an agent can neither forge a token to skip
// the preview nor edit one (ccRequired, paymentCard, tcAccepted, slot
// tokens…). `exp` bounds how long a token is accepted. The receiving tool
// still tamper-checks the payload against the caller's own call arguments.
// See docs/superpowers/specs/2026-04-21-cc-required-booking-design.md.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { confirmKeyFromEnv } from '@chrischall/mcp-utils';

/** Card details the `make-reservation` payload needs for a CC-required
 *  booking. The four fields are OpenTable's payload keys; we stash them
 *  here so opentable_book doesn't have to re-fetch the booking-details
 *  page just to assemble the POST. */
export interface BookingTokenPaymentCard {
  /** `creditCardToken` in the POST. Matches `wallet.savedCards[].cardId`. */
  id: string;
  /** `creditCardLast4` in the POST. */
  last4: string;
  /** `creditCardMMYY` in the POST — e.g. `"1028"` for October 2028. */
  expiryMmYy: string;
  /** `creditCardProvider` in the POST. `"spreedly"` for OpenTable's
   *  tokenization vendor; kept as a field so we can re-tool if they
   *  switch. */
  provider: string;
}

/** Human-readable context captured by the preview tool so the confirm gate
 *  on opentable_book / opentable_modify can show the user WHAT they are
 *  approving (venue, card, policy) without another network call. Display
 *  only — never sent on the make-reservation wire. */
export interface BookingTokenDisplay {
  restaurantName?: string;
  /** Brand of the card that will be held (e.g. "Mastercard"). The last4
   *  lives in paymentCard. */
  cardBrand?: string;
  /** Cancellation / no-show policy text from the booking-details page. */
  policy?: string;
  /** Name of the Experience being booked, for Experience tokens. */
  experienceName?: string;
  /** Modify tokens only: the reservation's current slot, from the
   *  booking-details page's modifyReservation block. */
  existingDate?: string;
  existingTime?: string;
  existingPartySize?: number;
}

export type BookingTokenType = 'standard' | 'experience';

export interface BookingTokenPayload {
  slotLockId: number;
  restaurantId: number;
  diningAreaId: number;
  partySize: number;
  date: string;
  time: string;
  reservationToken: string;
  slotHash: string;
  /** Full card reference for CC-required bookings. `null` otherwise. */
  paymentCard: BookingTokenPaymentCard | null;
  ccRequired: boolean;
  issuedAt: string; // ISO-8601
  /** Routes opentable_book to the right slot-lock + make-reservation
   *  payload. Tokens minted before this field was added decode as
   *  "standard" for backward compatibility. */
  bookingType: BookingTokenType;
  /** Required when bookingType === "experience"; absent otherwise. */
  experienceId?: number;
  /** Optimistic-concurrency version of the Experience config that the
   *  slot-lock + make-reservation calls have to echo back. Sourced from
   *  __INITIAL_STATE__.experiences.experiences[].version on the
   *  /booking/details page. Required for Experience bookings (the REST
   *  /dapi/booking/make-reservation endpoint 400s without it). */
  experienceVersion?: number;
  /** Set by preview when the booking-details page carried restaurant
   *  terms (`terms` in the preview output). Makes opentable_book /
   *  opentable_modify send `tcAccepted: true` on make-reservation, the
   *  way the page does when its "I agree" checkbox exists. Absent
   *  otherwise (old tokens decode with it absent, too). */
  tcAccepted?: boolean;
  /** Existing reservation's confirmation_number, populated when this
   *  token is a modify token (minted by opentable_modify_preview).
   *  Presence of this field is the modify-vs-book discriminator. Goes
   *  on the make-reservation wire as `confnumber` (OpenTable's quirky
   *  shorthand). Absent on tokens minted by opentable_book_preview. */
  existingConfirmationNumber?: number;
  /** Existing reservation's security_token. Goes on the make-reservation
   *  wire as `securityToken`. Required together with
   *  existingConfirmationNumber; partial-modify tokens fail decode. */
  existingSecurityToken?: string;
  /** The slot's loyalty points from the booking-details page, echoed on
   *  make-reservation. Absent on tokens minted before they were carried
   *  (make-reservation then falls back to Standard / 100). */
  pointsType?: string;
  pointsValue?: number;
  /** Confirm-prompt context (venue name, card brand, policy). Absent on
   *  tokens minted before it was added. */
  display?: BookingTokenDisplay;
}

const REQUIRED_KEYS: Array<keyof BookingTokenPayload> = [
  'slotLockId',
  'restaurantId',
  'diningAreaId',
  'partySize',
  'date',
  'time',
  'reservationToken',
  'slotHash',
  'ccRequired',
  'issuedAt',
  // bookingType intentionally omitted — added below with a default
  //   so old tokens still decode.
  // paymentCard intentionally omitted — can legitimately be null.
  // experienceId intentionally omitted — only set on experience tokens.
];

/** How long a minted token is accepted. The slot lock it carries lasts
 *  only ~90s (make-reservation then answers SLOT_LOCK_EXPIRED), but the
 *  two-step confirm flow can wait on the user, so this matches the confirm
 *  token's default lifetime rather than the lock's. */
export const BOOKING_TOKEN_TTL_MS = 10 * 60_000;

const NOT_OURS =
  'booking_token was not issued by this server or was altered — call opentable_book_preview (or opentable_modify_preview) again and pass its token unchanged.';

/** Token-specific subkey of the fleet confirm key, so a signature here can
 *  never double as a confirm-token signature (or vice versa). */
function signingKey(): Buffer {
  return createHmac('sha256', confirmKeyFromEnv())
    .update('opentable-mcp/booking-token/v1')
    .digest();
}

function sign(body: string): string {
  return createHmac('sha256', signingKey()).update(body, 'utf8').digest('base64url');
}

export function encodeBookingToken(
  payload: BookingTokenPayload,
  opts: { now?: number } = {}
): string {
  const exp = (opts.now ?? Date.now()) + BOOKING_TOKEN_TTL_MS;
  const body = Buffer.from(JSON.stringify({ p: payload, exp }), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeBookingToken(
  token: string,
  opts: { now?: number } = {}
): BookingTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error(NOT_OURS);
  const [body, sig] = parts;
  const want = Buffer.from(sign(body), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error(NOT_OURS);

  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('booking_token does not contain valid JSON — was it issued by opentable_book_preview?');
  }
  const { p: parsed, exp } = (envelope ?? {}) as { p?: unknown; exp?: unknown };
  if (typeof exp !== 'number' || (opts.now ?? Date.now()) > exp) {
    throw new Error(
      'booking_token has expired — call opentable_find_slots for a fresh slot, then preview again.'
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('booking_token payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      throw new Error(`booking_token is missing required field: ${key}`);
    }
  }
  if (!('paymentCard' in obj)) {
    (obj as { paymentCard: BookingTokenPaymentCard | null }).paymentCard = null;
  }
  if (!('bookingType' in obj)) {
    (obj as { bookingType: BookingTokenType }).bookingType = 'standard';
  } else if (obj.bookingType !== 'standard' && obj.bookingType !== 'experience') {
    throw new Error(
      `booking_token has unknown bookingType: ${JSON.stringify(obj.bookingType)}`
    );
  }
  // experienceId stays optional — leave it untouched if absent.
  // Modify-token integrity: existingConfirmationNumber + existingSecurityToken
  // must be present together (or both absent). The pair forms the
  // modify identity that make-reservation needs on the wire. Partial-
  // modify tokens (only one field set) fail decode here rather than
  // surfacing as an opaque server-side error.
  const hasConfNum = 'existingConfirmationNumber' in obj;
  const hasSecTok = 'existingSecurityToken' in obj;
  if (hasConfNum || hasSecTok) {
    if (
      typeof (obj as { existingConfirmationNumber?: unknown }).existingConfirmationNumber !== 'number' ||
      typeof (obj as { existingSecurityToken?: unknown }).existingSecurityToken !== 'string'
    ) {
      throw new Error(
        'modify token must include both existingConfirmationNumber (number) and existingSecurityToken (string) — partial-modify tokens are rejected.'
      );
    }
  }
  return obj as unknown as BookingTokenPayload;
}
