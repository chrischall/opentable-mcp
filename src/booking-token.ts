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
  // paymentCard intentionally omitted — can legitimately be null.
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
  return obj as unknown as BookingTokenPayload;
}
