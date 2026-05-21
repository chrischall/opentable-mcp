// Opaque, stateless token passed between opentable_book_preview and
// opentable_book. Base64-encoded JSON — no signing (we have no shared
// secret with the MCP client) — so the tamper check on the receiving
// end is purely against the caller's own call arguments. See
// docs/superpowers/specs/2026-04-21-cc-required-booking-design.md for
// the rationale.

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

export function encodeBookingToken(payload: BookingTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodeBookingToken(token: string): BookingTokenPayload {
  const json = Buffer.from(token, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('booking_token does not contain valid JSON — was it issued by opentable_book_preview?');
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
