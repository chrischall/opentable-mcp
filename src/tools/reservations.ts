// Reservation tools: list, find-slots, book (two-step lock + make), cancel.
//
// All the GraphQL tools here use Apollo persisted queries — instead of
// sending the full query text, we reference a sha256Hash pre-registered
// on OpenTable's CDN. The hashes are pinned below; if OpenTable
// redeploys we'll see `PersistedQueryNotFound` and need to re-capture
// them via the extension's XHR logger.
//
// Book flow:
//   1. BookDetailsStandardSlotLock — locks the slot for ~90s, returns slotLockId.
//   2. /dapi/booking/make-reservation — consumes slotLockId + user PII + slot tokens.
// Cancel is a single mutation keyed on (restaurantId, confirmationNumber, securityToken).
//
// User PII (name/email/phone) is read from the dining-dashboard SSR
// on every book call — cheaper than a dedicated profile endpoint, and
// the data we need is always there for authenticated users.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseDiningDashboard } from '../parse-dining-dashboard.js';
import { parseAvailabilityResponse } from '../parse-slots.js';
import { parseUserProfile } from '../parse-user-profile.js';
import { parseBookingDetailsState, sameDayConflicts } from '../parse-booking-details-state.js';
import { extractInitialState } from '../initial-state.js';
import { encodeBookingToken, decodeBookingToken } from '../booking-token.js';

const DINING_DASHBOARD_PATH = '/user/dining-dashboard';

/**
 * URL for the SSR /booking/details page. OpenTable shows this page right
 * before the user clicks "Complete Reservation" and it ships the
 * cancellation policy + saved cards + CC-required flag in its
 * __INITIAL_STATE__. See parse-booking-details-state.ts for what we
 * pull out.
 */
function bookingDetailsPath(input: {
  restaurant_id: number;
  date: string;
  time: string;
  party_size: number;
  slot_hash: string;
  reservation_token: string;
  dining_area_id: number;
}): string {
  const params = new URLSearchParams({
    rid: String(input.restaurant_id),
    datetime: `${input.date}T${input.time}`,
    covers: String(input.party_size),
    partySize: String(input.party_size),
    seating: 'default',
    slotHash: input.slot_hash,
    slotAvailabilityToken: input.reservation_token,
    diningAreaId: String(input.dining_area_id),
  });
  return `/booking/details?${params.toString()}`;
}

// Apollo persisted-query hashes captured from opentable.com on 2026-04-20.
// If OpenTable re-deploys and invalidates these, the server returns
// `PersistedQueryNotFound` and we'll need to re-capture via the
// extension's XHR logger.
const RESTAURANTS_AVAILABILITY_HASH =
  'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e';
const BOOK_SLOT_LOCK_HASH =
  '1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa';
const CANCEL_RESERVATION_HASH =
  '4ee53a006030f602bdeb1d751fa90ddc4240d9e17d015fb7976f8efcb80a026e';

const AVAILABILITY_PATH = '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability';
const SLOT_LOCK_PATH = '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock';
const MAKE_RESERVATION_PATH = '/dapi/booking/make-reservation';
const CANCEL_RESERVATION_PATH = '/dapi/fe/gql?optype=mutation&opname=CancelReservation';

/** OpenTable uses Spreedly for card tokenization. Saved-card `cardId`s
 *  are already Spreedly tokens; we don't run any tokenization ourselves. */
const CC_PROVIDER = 'spreedly';

/** Hardcoded in OpenTable's FE — URL the user would be redirected to if
 *  the card's bank triggers a 3D-Secure (SCA) challenge. We never hit it
 *  for pre-authenticated saved cards, but the make-reservation validator
 *  requires the field when creditCard* fields are set. */
const SCA_REDIRECT_URL = 'https://www.opentable.com/booking/payments-sca';

/** Format `month` + `year` as `"MMYY"` — OpenTable's make-reservation
 *  expects `creditCardMMYY` in that form. e.g. (10, 2028) → "1028". */
function expiryMmYy(month: number | null, year: number | null): string {
  if (month == null || year == null) return '';
  const mm = String(month).padStart(2, '0');
  const yy = String(year % 100).padStart(2, '0');
  return `${mm}${yy}`;
}

/** Build a human-readable error when OpenTable would reject the booking
 *  as a same-day conflict. Called pre-flight from book/book_preview
 *  whenever the /booking/details page reports overlapping reservations
 *  — avoids the opaque HTTP 409 that the server would otherwise return
 *  from make-reservation. */
function sameDayConflictError(
  conflicts: ReturnType<typeof sameDayConflicts>,
  date: string
): Error {
  const lines = conflicts.map((c) => {
    const time = c.date_time.length >= 16 ? c.date_time.slice(11, 16) : '?';
    const party = c.party_size ? ` party ${c.party_size}` : '';
    return `  • ${time} at ${c.restaurant_name} (confirmation ${c.confirmation_number}${party})`;
  });
  return new Error(
    `OpenTable won't let you book two reservations on the same day. You already have ${conflicts.length === 1 ? 'one reservation' : `${conflicts.length} reservations`} on ${date}:\n${lines.join('\n')}\n` +
      'Cancel or modify the existing reservation first (opentable_cancel), then retry.'
  );
}

/** Minimum viable `variables` for the RestaurantsAvailability query. */
function buildAvailabilityVariables(input: {
  restaurant_ids: number[];
  date: string;
  time: string;
  party_size: number;
}): Record<string, unknown> {
  return {
    onlyPop: false,
    forwardDays: 0,
    requireTimes: false,
    requireTypes: [],
    useCBR: false,
    privilegedAccess: [
      'UberOneDiningProgram',
      'VisaDiningProgram',
      'VisaEventsProgram',
      'ChaseDiningProgram',
    ],
    restaurantIds: input.restaurant_ids,
    restaurantAvailabilityTokens: input.restaurant_ids.map(
      () => 'eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ'
    ),
    date: input.date,
    time: input.time,
    partySize: input.party_size,
    databaseRegion: 'NA',
  };
}

export function registerReservationTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_reservations',
    {
      description:
        'List the authenticated user\'s OpenTable reservations. Defaults to upcoming; pass scope="past" or scope="all" to broaden. Each entry includes the security_token needed to cancel or modify.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z.enum(['upcoming', 'past', 'all']).optional(),
      },
    },
    async ({ scope }) => {
      const html = await client.fetchHtml(DINING_DASHBOARD_PATH);
      const reservations = parseDiningDashboard(html, scope ?? 'upcoming');
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(reservations, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_find_slots',
    {
      description:
        "List available reservation slots at a specific OpenTable restaurant for a date + party size. Returns each slot's reservation_token (use it with opentable_book — tokens expire quickly, book promptly). Slots may be attributes=['default'|'bar'|'highTop'|'outdoor'] and type=Standard|Experience|POP.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().describe('HH:MM (24h) — anchor time; slots come back relative to this'),
        party_size: z.number().int().positive(),
      },
    },
    async ({ restaurant_id, date, time, party_size }) => {
      const body = {
        operationName: 'RestaurantsAvailability',
        variables: buildAvailabilityVariables({
          restaurant_ids: [restaurant_id],
          date,
          time,
          party_size,
        }),
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: RESTAURANTS_AVAILABILITY_HASH,
          },
        },
      };
      const response = await client.fetchJson<unknown>(AVAILABILITY_PATH, {
        method: 'POST',
        headers: { 'ot-page-type': 'home', 'ot-page-group': 'seo-landing-home' },
        body,
      });
      const slots = parseAvailabilityResponse(response, date, time, party_size);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(slots, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_book_preview',
    {
      description:
        "Preview an OpenTable booking BEFORE committing. Fetches the /booking/details SSR page and the slot-lock to surface: the cancellation policy (including any credit-card no-show fee), the saved payment card that would be charged/held, and a short-lived `booking_token` that opentable_book consumes. REQUIRED for CC-required slots — opentable_book refuses to commit without the token. Safe to call for standard slots too (the token skips a redundant re-lock in book). Holds the slot for ~60-90s; preview → book should happen within a minute.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().describe('HH:MM (24h) — must match a slot returned by find_slots'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots'),
        dining_area_id: z
          .number()
          .int()
          .describe('Dining area id (from opentable_get_restaurant → diningAreas[])'),
      },
    },
    async ({ restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id }) => {
      const reservationDateTime = `${date}T${time}`;

      // Step 1 — fetch the /booking/details SSR page (CC flag + policy + cards).
      const detailsHtml = await client.fetchHtml(
        bookingDetailsPath({
          restaurant_id,
          date,
          time,
          party_size,
          slot_hash,
          reservation_token,
          dining_area_id,
        })
      );
      const state = extractInitialState(detailsHtml);
      const summary = parseBookingDetailsState(state);

      // Step 2a — same-day conflict (OpenTable's "double trouble" check).
      // Fail early with a clear error rather than letting make-reservation
      // come back with an opaque 409.
      const conflicts = sameDayConflicts(summary.conflicts, date);
      if (conflicts.length > 0) {
        throw sameDayConflictError(conflicts, date);
      }

      // Step 2b — CC-required: we must have a default saved card.
      if (summary.cc_required && !summary.default_card) {
        throw new Error(
          'No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again.'
        );
      }

      // Step 3 — slot-lock (reserves the slot for ~90s; returns slotLockId).
      const lockResponse = await client.fetchJson<{
        data?: {
          lockSlot?: {
            success?: boolean;
            slotLock?: { slotLockId?: number };
            slotLockErrors?: unknown;
          };
        };
      }>(SLOT_LOCK_PATH, {
        method: 'POST',
        headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
        body: {
          operationName: 'BookDetailsStandardSlotLock',
          variables: {
            input: {
              restaurantId: restaurant_id,
              seatingOption: 'DEFAULT',
              reservationDateTime,
              partySize: party_size,
              databaseRegion: 'NA',
              slotHash: slot_hash,
              reservationType: 'STANDARD',
              diningAreaId: dining_area_id,
            },
          },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: BOOK_SLOT_LOCK_HASH },
          },
        },
      });
      const slotLockId = lockResponse?.data?.lockSlot?.slotLock?.slotLockId;
      if (!slotLockId || lockResponse?.data?.lockSlot?.success !== true) {
        throw new Error(
          `OpenTable failed to lock slot for preview: ${JSON.stringify(
            lockResponse?.data?.lockSlot ?? lockResponse
          )}`
        );
      }

      // Step 4 — mint the booking_token. paymentCard carries everything
      // make-reservation needs for a CC-required POST (id, last4, expiry,
      // provider). For no-CC slots we leave it null.
      const paymentCard =
        summary.cc_required && summary.default_card
          ? {
              id: summary.default_card.id,
              last4: summary.default_card.last4,
              expiryMmYy: expiryMmYy(
                summary.default_card.expiry_month,
                summary.default_card.expiry_year
              ),
              provider: CC_PROVIDER,
            }
          : null;
      const booking_token = encodeBookingToken({
        slotLockId,
        restaurantId: restaurant_id,
        diningAreaId: dining_area_id,
        partySize: party_size,
        date,
        time,
        reservationToken: reservation_token,
        slotHash: slot_hash,
        paymentCard,
        ccRequired: summary.cc_required,
        issuedAt: new Date().toISOString(),
      });

      const chargesDescription = summary.cc_required
        ? `Nothing charged now — ${summary.default_card!.brand} •••• ${summary.default_card!.last4} held only. ${summary.policy.description}`
        : 'Nothing charged now — no card required.';

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                booking_token,
                reservation: { date, time, party_size, restaurant_id, dining_area_id },
                cancellation_policy: summary.policy,
                payment_method:
                  summary.cc_required && summary.default_card
                    ? { brand: summary.default_card.brand, last4: summary.default_card.last4 }
                    : null,
                charges_at_booking: {
                  amount_usd: 0,
                  description: chargesDescription,
                },
                cc_required: summary.cc_required,
                policy_type: summary.policy_type,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_book',
    {
      description:
        "Book an OpenTable reservation. Requires a fresh slot_hash + reservation_token from opentable_find_slots (tokens expire within minutes — call find_slots just before book) AND the dining_area_id for the room you want (from opentable_get_restaurant → diningAreas[]). For CC-required slots (prime-time at busy restaurants), opentable_book refuses without a `booking_token` from opentable_book_preview — the preview step surfaces the cancellation policy and the saved card that would be held. Auto-fetches the user's profile (name/email/phone) from /user/dining-dashboard. Returns confirmation_number + security_token; save both — they're required to cancel.",
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().describe('HH:MM (24h) — must match the slot returned by find_slots'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots'),
        dining_area_id: z
          .number()
          .int()
          .describe("Dining area id (from opentable_get_restaurant → diningAreas[]). Required — OpenTable's numeric-id restaurant URLs 404, so we can't auto-resolve."),
        booking_token: z
          .string()
          .optional()
          .describe(
            'Opaque token from opentable_book_preview. REQUIRED for CC-required slots (book will refuse otherwise). Optional for standard slots — when present, skips a redundant re-lock.'
          ),
      },
    },
    async ({
      restaurant_id,
      date,
      time,
      party_size,
      reservation_token,
      slot_hash,
      dining_area_id,
      booking_token,
    }) => {
      const reservationDateTime = `${date}T${time}`;
      const diningAreaId = dining_area_id;

      let slotLockId: number;
      let paymentCard: { id: string; last4: string; expiryMmYy: string; provider: string } | null = null;
      let ccRequired = false;

      if (booking_token) {
        // Token path — preview did the heavy lifting; we trust the payload
        // subject to a tamper check against the caller's own args.
        const payload = decodeBookingToken(booking_token);
        if (
          payload.restaurantId !== restaurant_id ||
          payload.date !== date ||
          payload.time !== time ||
          payload.partySize !== party_size ||
          payload.diningAreaId !== dining_area_id
        ) {
          throw new Error(
            'booking_token was issued for a different reservation (some field has changed since opentable_book_preview — party_size, date/time, restaurant, or dining area). Call opentable_book_preview again with the current args.'
          );
        }
        slotLockId = payload.slotLockId;
        paymentCard = payload.paymentCard;
        ccRequired = payload.ccRequired;
      } else {
        // No token — run the SSR-page CC-required check first, so we
        // can refuse before locking the slot for nothing.
        const detailsHtml = await client.fetchHtml(
          bookingDetailsPath({
            restaurant_id,
            date,
            time,
            party_size,
            slot_hash,
            reservation_token,
            dining_area_id,
          })
        );
        const summary = parseBookingDetailsState(extractInitialState(detailsHtml));

        // Same-day conflict — fail early with a clear message instead
        // of letting make-reservation 409 below.
        const conflicts = sameDayConflicts(summary.conflicts, date);
        if (conflicts.length > 0) {
          throw sameDayConflictError(conflicts, date);
        }

        if (summary.cc_required) {
          throw new Error(
            'This slot requires a credit-card guarantee. Call opentable_book_preview first to review the cancellation policy, then pass the returned booking_token back to opentable_book.'
          );
        }

        // Standard-no-guarantee path: lock the slot ourselves.
        const lockResponse = await client.fetchJson<{
          data?: {
            lockSlot?: {
              success?: boolean;
              slotLock?: { slotLockId?: number };
              slotLockErrors?: unknown;
            };
          };
        }>(SLOT_LOCK_PATH, {
          method: 'POST',
          headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
          body: {
            operationName: 'BookDetailsStandardSlotLock',
            variables: {
              input: {
                restaurantId: restaurant_id,
                seatingOption: 'DEFAULT',
                reservationDateTime,
                partySize: party_size,
                databaseRegion: 'NA',
                slotHash: slot_hash,
                reservationType: 'STANDARD',
                diningAreaId,
              },
            },
            extensions: {
              persistedQuery: { version: 1, sha256Hash: BOOK_SLOT_LOCK_HASH },
            },
          },
        });
        const lockedId = lockResponse?.data?.lockSlot?.slotLock?.slotLockId;
        if (!lockedId || lockResponse?.data?.lockSlot?.success !== true) {
          throw new Error(
            `OpenTable failed to lock slot for booking: ${JSON.stringify(
              lockResponse?.data?.lockSlot ?? lockResponse
            )}`
          );
        }
        slotLockId = lockedId;
      }

      const profile = await fetchProfile(client);

      // CC-required bookings need five extra fields (all derived from the
      // saved card's metadata, which the preview already stashed in the
      // booking_token). OpenTable's validator rejects `paymentMethodId`
      // outright; the actual Spreedly token is `creditCardToken` and the
      // card's last4 + expiry are separate flat fields.
      const ccFields = paymentCard
        ? {
            creditCardToken: paymentCard.id,
            creditCardLast4: paymentCard.last4,
            creditCardMMYY: paymentCard.expiryMmYy,
            creditCardProvider: paymentCard.provider,
            scaRedirectUrl: SCA_REDIRECT_URL,
          }
        : {};

      const reservation = await client.fetchJson<{
        success?: boolean;
        reservationId?: number;
        confirmationNumber?: number;
        securityToken?: string;
        points?: number;
        reservationDateTime?: string;
        partySize?: number;
        reservationStateId?: number;
        errorCode?: string;
        errorMessage?: string;
        partnerScaRequired?: boolean;
        partnerScaRedirectUrl?: string | null;
      }>(MAKE_RESERVATION_PATH, {
        method: 'POST',
        body: {
          restaurantId: restaurant_id,
          reservationDateTime,
          partySize: party_size,
          slotHash: slot_hash,
          slotAvailabilityToken: reservation_token,
          slotLockId,
          diningAreaId,
          firstName: profile.first_name,
          lastName: profile.last_name,
          email: profile.email,
          phoneNumber: profile.mobile_phone_number,
          phoneNumberCountryId: profile.country_id || 'US',
          country: profile.country_id || 'US',
          reservationType: 'Standard',
          reservationAttribute: 'default',
          pointsType: 'Standard',
          points: 100,
          tipAmount: 0,
          tipPercent: 0,
          confirmPoints: true,
          optInEmailRestaurant: false,
          isModify: false,
          additionalServiceFees: [],
          nonBookableExperiences: [],
          katakanaFirstName: '',
          katakanaLastName: '',
          correlationId: randomUUID(),
          ...ccFields,
        },
      });

      // 3-D Secure challenge — only fires for cards that haven't been
      // pre-authenticated by the issuer. Our default saved cards on
      // opentable.com are almost always pre-authenticated, so this is
      // rare. When it does fire we can't complete the challenge from
      // outside the browser; surface the redirect URL and bail.
      if (reservation?.partnerScaRequired === true) {
        throw new Error(
          `This card requires 3-D Secure authentication (SCA), which can't be completed from the MCP. Complete the booking in your browser: ${
            reservation.partnerScaRedirectUrl ?? 'https://www.opentable.com/booking'
          }`
        );
      }

      if (reservation?.errorCode || reservation?.success === false) {
        const raw = `${reservation.errorCode ?? 'unknown'}${
          reservation.errorMessage ? ` — ${reservation.errorMessage}` : ''
        }`;
        if (/slot.?lock.?expired/i.test(raw) || /SLOT_LOCK_EXPIRED/i.test(raw)) {
          throw new Error(
            'Slot lock expired. Call opentable_find_slots for a fresh slot, then re-preview with opentable_book_preview.'
          );
        }
        throw new Error(`OpenTable book failed: ${raw}`);
      }
      if (!reservation?.confirmationNumber) {
        throw new Error(
          `OpenTable book response missing confirmationNumber: ${JSON.stringify(reservation)}`
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                confirmation_number: reservation.confirmationNumber,
                reservation_id: reservation.reservationId ?? null,
                security_token: reservation.securityToken ?? '',
                restaurant_id,
                date,
                time,
                party_size,
                points: reservation.points ?? 0,
                status: 'Pending',
                cc_required: ccRequired,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_cancel',
    {
      description:
        'Cancel an OpenTable reservation. Requires restaurant_id, confirmation_number, and security_token — all three come from opentable_list_reservations or opentable_book.',
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
      },
    },
    async ({ restaurant_id, confirmation_number, security_token }) => {
      const response = await client.fetchJson<{
        data?: {
          cancelReservation?: {
            statusCode?: number;
            errors?: unknown;
            data?: { reservationState?: string };
          };
        };
      }>(CANCEL_RESERVATION_PATH, {
        method: 'POST',
        headers: { 'ot-page-type': 'network_confirmation', 'ot-page-group': 'booking' },
        body: {
          operationName: 'CancelReservation',
          variables: {
            input: {
              restaurantId: restaurant_id,
              confirmationNumber: confirmation_number,
              securityToken: security_token,
              databaseRegion: 'NA',
              reservationSource: 'Online',
            },
          },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: CANCEL_RESERVATION_HASH },
          },
        },
      });
      const result = response?.data?.cancelReservation;
      const state = result?.data?.reservationState ?? '';
      const cancelled = result?.statusCode === 200 && /cancel/i.test(state) && !result?.errors;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ cancelled, state, raw: response }, null, 2),
          },
        ],
      };
    }
  );
}

// ─── helpers (module-private) ─────────────────────────────────────

interface BookProfile {
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone_number: string;
  country_id: string;
}

async function fetchProfile(client: OpenTableClient): Promise<BookProfile> {
  const html = await client.fetchHtml(DINING_DASHBOARD_PATH);
  const profile = parseUserProfile(html);
  if (!profile.first_name || !profile.email) {
    throw new Error(
      'Could not resolve the signed-in user from the dining dashboard. Re-sign in and retry.'
    );
  }
  // The profile's `mobile_phone` is pre-formatted with country code. We want
  // the raw number for the booking payload; go back to the underlying state.
  const mobile = profile.mobile_phone?.replace(/^\+\d+\s*/, '') ?? '';
  return {
    first_name: profile.first_name,
    last_name: profile.last_name,
    email: profile.email,
    mobile_phone_number: mobile,
    country_id: profile.country_id || 'US',
  };
}

