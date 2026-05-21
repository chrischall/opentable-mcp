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
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseDiningDashboard } from '../parse-dining-dashboard.js';
import { parseAvailabilityResponse } from '../parse-slots.js';
import { parseUserProfile } from '../parse-user-profile.js';
import { parseBookingDetailsState, sameDayConflicts } from '../parse-booking-details-state.js';
import { extractInitialState } from '../initial-state.js';
import { encodeBookingToken, decodeBookingToken } from '../booking-token.js';
import {
  lockSlot,
  makeReservation,
  expiryMmYy,
  CC_PROVIDER,
  type BookProfile,
} from './booking-flow.js';

const DINING_DASHBOARD_PATH = '/user/dining-dashboard';

/**
 * URL for the SSR /booking/details page. OpenTable shows this page right
 * before the user clicks "Complete Reservation" and it ships the
 * cancellation policy + saved cards + CC-required flag in its
 * __INITIAL_STATE__. See parse-booking-details-state.ts for what we
 * pull out.
 *
 * For Experience-mandatory slots, pass `experience_id` to add the
 * `experienceIds`, `selectedExperience`, `tableCategory`, and
 * `st=Experience` query params — these are what the seating-options
 * and specials intermediate pages would otherwise append for us when
 * the user clicks through them in the browser.
 */
function bookingDetailsPath(input: {
  restaurant_id: number;
  date: string;
  time: string;
  party_size: number;
  slot_hash: string;
  reservation_token: string;
  dining_area_id: number;
  experience_id?: number;
  /** When set together with `security_token`, marks this URL as a modify
   *  of an existing reservation. OpenTable's /booking/details SSR loads
   *  the modify state (existing CC hold, current slot details, the
   *  modifyReservation block) when both are in the query string + isModify=true.
   *  Required by opentable_modify_preview. */
  confirmation_number?: number;
  /** Required together with `confirmation_number` for the modify flow. */
  security_token?: string;
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
  if (typeof input.experience_id === 'number') {
    params.set('experienceIds', String(input.experience_id));
    params.set('selectedExperience', String(input.experience_id));
    params.set('tableCategory', 'default');
    params.set('st', 'Experience');
    params.set('isMandatory', 'true');
  }
  if (typeof input.confirmation_number === 'number' && typeof input.security_token === 'string') {
    params.set('confirmationNumber', String(input.confirmation_number));
    params.set('securityToken', input.security_token);
    params.set('isModify', 'true');
  }
  return `/booking/details?${params.toString()}`;
}

// Apollo persisted-query hashes captured from opentable.com.
// If OpenTable re-deploys and invalidates these, the server returns
// `PersistedQueryNotFound` and we'll need to re-capture them. The
// fastest re-capture path: on a /booking/details page in the bridged
// Chrome tab, run
//   window.__APOLLO_CLIENT__.queryManager.mutationStore['1'].mutation.documentId
// after the page's slot-lock has fired. Apollo's `documentId` IS the
// persisted-query sha256Hash. Same trick works for query documents via
// `queryManager.queries` (a Map iterated with .forEach).
const RESTAURANTS_AVAILABILITY_HASH =
  'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e';
const BOOK_SLOT_LOCK_HASH =
  '1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa';
// Captured 2026-05-21 from a live Pasqual's Experience slot-lock via the
// __APOLLO_CLIENT__.queryManager.mutationStore inspection technique above.
const BOOK_EXPERIENCE_SLOT_LOCK_HASH =
  '363af9e3bd17efa82ad71c5808c5272603b5f1abe13b535d3beed1e6258ce504';
const CANCEL_RESERVATION_HASH =
  '4ee53a006030f602bdeb1d751fa90ddc4240d9e17d015fb7976f8efcb80a026e';

const AVAILABILITY_PATH = '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability';
const SLOT_LOCK_PATH = '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock';
const EXPERIENCE_SLOT_LOCK_PATH =
  '/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock';
const MAKE_RESERVATION_PATH = '/dapi/booking/make-reservation';
const CANCEL_RESERVATION_PATH = '/dapi/fe/gql?optype=mutation&opname=CancelReservation';

/** Endpoint paths + persisted-query hashes the slot-lock helper consumes.
 *  Bundled here (rather than in booking-flow.ts) so the inline
 *  re-capture instructions on the hash constants stay co-located with
 *  the constants themselves. */
const SLOT_LOCK_ENDPOINTS = {
  standardPath: SLOT_LOCK_PATH,
  experiencePath: EXPERIENCE_SLOT_LOCK_PATH,
  standardHash: BOOK_SLOT_LOCK_HASH,
  experienceHash: BOOK_EXPERIENCE_SLOT_LOCK_HASH,
} as const;

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
        "Preview an OpenTable booking BEFORE committing. Fetches the /booking/details SSR page and the slot-lock to surface: the cancellation policy (including any credit-card no-show fee), the saved payment card that would be charged/held, and a short-lived `booking_token` that opentable_book consumes. REQUIRED for CC-required slots — opentable_book refuses to commit without the token. Safe to call for standard slots too (the token skips a redundant re-lock in book). Holds the slot for ~60-90s; preview → book should happen within a minute. For Listing-type restaurants (Le Bernardin, etc.) this tool can't fetch a slot at all — callers should check `opentable_get_restaurant.bookable` first and surface the restaurant's phone/URL instead. For Experience-mandatory slots (find_slots returned booking_type=experience_mandatory), pass `experience_id` from the slot's `experience_ids` to route through the Experience slot-lock.",
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
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'For Experience-mandatory slots: which experience to book (from slot.experience_ids). Required when find_slots returned an Experience slot.'
          ),
        experience_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            'Pass-through from find_slots.experience_ids. When non-empty, experience_id must also be set.'
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
      experience_id,
      experience_ids,
    }) => {
      const reservationDateTime = `${date}T${time}`;

      // Detect Experience-mandatory: caller passed experience_ids (from
      // find_slots) and/or picked an experience_id. The ambiguous case
      // — experience_ids present but no experience_id — errors out so
      // the agent surfaces the options to the user.
      const isExperience =
        (Array.isArray(experience_ids) && experience_ids.length > 0) ||
        typeof experience_id === 'number';
      if (isExperience && typeof experience_id !== 'number') {
        throw new Error(
          'This slot requires picking an Experience. Options: ' +
            JSON.stringify(experience_ids) +
            '. Re-call opentable_book_preview with experience_id set to one of them.'
        );
      }

      // Step 1 — fetch the /booking/details SSR page (CC flag + policy + cards).
      // For Experience-mandatory slots we add the experience query params so
      // we land on the same page the browser would after the user clicks
      // through the seating-options/specials intermediate pages.
      const detailsHtml = await client.fetchHtml(
        bookingDetailsPath({
          restaurant_id,
          date,
          time,
          party_size,
          slot_hash,
          reservation_token,
          dining_area_id,
          experience_id,
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

      // Step 3 — slot-lock (reserves the slot for ~90s).
      const slotLockId = await lockSlot(client, {
        restaurantId: restaurant_id,
        reservationDateTime,
        partySize: party_size,
        slotHash: slot_hash,
        diningAreaId: dining_area_id,
        reservationToken: reservation_token,
        experience: isExperience
          ? {
              experienceId: experience_id!,
              experienceVersion: summary.experience?.version ?? 1,
            }
          : undefined,
        endpoints: SLOT_LOCK_ENDPOINTS,
      });

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
        bookingType: isExperience ? 'experience' : 'standard',
        ...(isExperience
          ? {
              experienceId: experience_id,
              experienceVersion: summary.experience?.version ?? 1,
            }
          : {}),
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
                // `instant` for standard slots, `experience_mandatory` when
                // the slot required picking an Experience. Out-of-band signal
                // for the agent so it can present the right confirmation
                // copy before calling opentable_book.
                booking_type: isExperience ? 'experience_mandatory' : 'instant',
                // Populated only for Experience-mandatory bookings. Carries
                // the bookable experience surfaced from the booking-details
                // page's __INITIAL_STATE__ (name, type, description, price).
                experience: summary.experience,
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
                // Restaurant-supplied custom terms (common at UK venues).
                // When non-null, surface to the user before they tell
                // opentable_book to commit.
                terms: summary.terms,
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
    'opentable_modify_preview',
    {
      description:
        "Preview a MODIFICATION to an existing OpenTable reservation. Takes the existing reservation's identity (restaurant_id + confirmation_number + security_token from opentable_list_reservations or the original opentable_book result) plus the NEW slot args (from a fresh opentable_find_slots call) and returns the new cancellation_policy, CC re-hold details, and a `modify_token` that opentable_modify consumes. Mirrors opentable_book_preview, but the /booking/details URL includes confirmationNumber + securityToken + isModify=true so OpenTable's SSR returns the modify state. REQUIRED before opentable_modify — no shortcut path. For Listing-type restaurants the modify can't proceed (no slot picker); check opentable_get_restaurant.bookable first.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
        date: z.string().describe('YYYY-MM-DD (the NEW date)'),
        time: z.string().describe('HH:MM (24h) — the NEW time'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots for the NEW slot'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots for the NEW slot'),
        dining_area_id: z.number().int(),
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('For Experience-mandatory slots; required when the new slot has experience_ids.'),
        experience_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe('Pass-through from find_slots.experience_ids. When non-empty, experience_id must also be set.'),
      },
    },
    async ({
      restaurant_id,
      confirmation_number,
      security_token,
      date,
      time,
      party_size,
      reservation_token,
      slot_hash,
      dining_area_id,
      experience_id,
      experience_ids,
    }) => {
      const reservationDateTime = `${date}T${time}`;

      const isExperience =
        (Array.isArray(experience_ids) && experience_ids.length > 0) ||
        typeof experience_id === 'number';
      if (isExperience && typeof experience_id !== 'number') {
        throw new Error(
          'This slot requires picking an Experience. Options: ' +
            JSON.stringify(experience_ids) +
            '. Re-call opentable_modify_preview with experience_id set to one of them.'
        );
      }

      // 1) /booking/details SSR with modify markers (confirmationNumber + securityToken + isModify=true).
      const detailsHtml = await client.fetchHtml(
        bookingDetailsPath({
          restaurant_id,
          date,
          time,
          party_size,
          slot_hash,
          reservation_token,
          dining_area_id,
          experience_id,
          confirmation_number,
          security_token,
        })
      );
      const state = extractInitialState(detailsHtml);
      const summary = parseBookingDetailsState(state);

      // 2) Same-day conflicts — exclude the reservation being moved.
      const conflicts = sameDayConflicts(summary.conflicts, date, confirmation_number);
      if (conflicts.length > 0) {
        throw sameDayConflictError(conflicts, date);
      }

      if (summary.cc_required && !summary.default_card) {
        throw new Error(
          'No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again.'
        );
      }

      // 3) Slot-lock — same hashes/ops as book_preview.
      const slotLockId = await lockSlot(client, {
        restaurantId: restaurant_id,
        reservationDateTime,
        partySize: party_size,
        slotHash: slot_hash,
        diningAreaId: dining_area_id,
        reservationToken: reservation_token,
        experience: isExperience
          ? {
              experienceId: experience_id!,
              experienceVersion: summary.experience?.version ?? 1,
            }
          : undefined,
        endpoints: SLOT_LOCK_ENDPOINTS,
      });

      // 4) Existing-reservation details — read from `modifyReservation` in
      //    the SSR state to power the existing_reservation echo in the
      //    response. Lets the agent phrase "moving your booking from
      //    A → B". Each field is best-effort: if SSR doesn't surface the
      //    block (e.g. fixtures that don't include modifyReservation),
      //    the echo just omits that detail.
      const modifyRecord = (state as {
        modifyReservation?: {
          localDateTime?: string;
          partySize?: number;
          diningArea?: { diningAreaId?: number };
        };
      }).modifyReservation;
      const existingDate = modifyRecord?.localDateTime?.slice(0, 10) ?? null;
      const existingTime =
        modifyRecord?.localDateTime && modifyRecord.localDateTime.length >= 16
          ? modifyRecord.localDateTime.slice(11, 16)
          : null;
      const existingPartySize = modifyRecord?.partySize ?? null;
      const existingDiningAreaId = modifyRecord?.diningArea?.diningAreaId ?? null;

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

      const modify_token = encodeBookingToken({
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
        bookingType: isExperience ? 'experience' : 'standard',
        ...(isExperience
          ? {
              experienceId: experience_id,
              experienceVersion: summary.experience?.version ?? 1,
            }
          : {}),
        existingConfirmationNumber: confirmation_number,
        existingSecurityToken: security_token,
      });

      const chargesDescription = summary.cc_required
        ? `Nothing charged now — ${summary.default_card!.brand} •••• ${summary.default_card!.last4} re-held only. ${summary.policy.description}`
        : 'Nothing charged now — no card required.';

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                modify_token,
                booking_type: isExperience ? 'experience_mandatory' : 'instant',
                experience: summary.experience,
                existing_reservation: {
                  confirmation_number,
                  restaurant_id,
                  date: existingDate,
                  time: existingTime,
                  party_size: existingPartySize,
                  dining_area_id: existingDiningAreaId,
                },
                reservation: { date, time, party_size, restaurant_id, dining_area_id },
                cancellation_policy: summary.policy,
                payment_method:
                  summary.cc_required && summary.default_card
                    ? { brand: summary.default_card.brand, last4: summary.default_card.last4 }
                    : null,
                charges_at_booking: { amount_usd: 0, description: chargesDescription },
                cc_required: summary.cc_required,
                policy_type: summary.policy_type,
                terms: summary.terms,
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
        "Book an OpenTable reservation. Requires a fresh slot_hash + reservation_token from opentable_find_slots (tokens expire within minutes — call find_slots just before book) AND the dining_area_id for the room you want (from opentable_get_restaurant → diningAreas[]). For CC-required slots (prime-time at busy restaurants), opentable_book refuses without a `booking_token` from opentable_book_preview — the preview step surfaces the cancellation policy and the saved card that would be held. Auto-fetches the user's profile (name/email/phone) from /user/dining-dashboard. Returns confirmation_number + security_token; save both — they're required to cancel. For Listing-type restaurants there's no slot to lock — callers should check `opentable_get_restaurant.bookable` first and surface the restaurant's phone/URL instead.",
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
        experience_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            'Pass-through from find_slots.experience_ids. When non-empty, book refuses without a booking_token from opentable_book_preview.'
          ),
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Tamper-check signal for Experience tokens. When set, must match the experienceId baked into the booking_token by preview — agents that re-state the experience choice here get refused if it drifted from preview.'
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
      experience_ids,
      experience_id: callerExperienceId,
    }) => {
      const reservationDateTime = `${date}T${time}`;
      const diningAreaId = dining_area_id;

      let slotLockId: number;
      let paymentCard: { id: string; last4: string; expiryMmYy: string; provider: string } | null = null;
      let ccRequired = false;
      let bookingType: 'standard' | 'experience' = 'standard';
      let experienceId: number | undefined;
      let experienceVersion: number | undefined;

      // Caller-declared Experience: signal via experience_ids when there's no token yet.
      const callerDeclaredExperience =
        Array.isArray(experience_ids) && experience_ids.length > 0;

      if (booking_token) {
        // Token path — preview did the heavy lifting; we trust the payload
        // subject to a tamper check against the caller's own args. The
        // experienceId tamper check is conditional: a caller that passed an
        // explicit experience_id arg should get refused if it doesn't match
        // the token's experienceId. (The Experience-slot find_slots path
        // currently doesn't echo experience_id as a tool arg, so callers
        // who didn't pass it skip the experience tamper check — the token's
        // own bookingType=experience + experienceId still drive routing.)
        const payload = decodeBookingToken(booking_token);
        if (
          payload.restaurantId !== restaurant_id ||
          payload.date !== date ||
          payload.time !== time ||
          payload.partySize !== party_size ||
          payload.diningAreaId !== dining_area_id ||
          (typeof callerExperienceId === 'number' &&
            payload.experienceId !== callerExperienceId)
        ) {
          throw new Error(
            'booking_token was issued for a different reservation (some field has changed since opentable_book_preview — party_size, date/time, restaurant, dining area, or experience_id). Call opentable_book_preview again with the current args.'
          );
        }
        slotLockId = payload.slotLockId;
        paymentCard = payload.paymentCard;
        ccRequired = payload.ccRequired;
        bookingType = payload.bookingType;
        experienceId = payload.experienceId;
        experienceVersion = payload.experienceVersion;
      } else {
        if (callerDeclaredExperience) {
          throw new Error(
            'This is an Experience-mandatory slot. Call opentable_book_preview first to review the policy + choose an experience_id, then pass the returned booking_token back to opentable_book.'
          );
        }

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
        slotLockId = await lockSlot(client, {
          restaurantId: restaurant_id,
          reservationDateTime,
          partySize: party_size,
          slotHash: slot_hash,
          diningAreaId,
          reservationToken: reservation_token,
          endpoints: SLOT_LOCK_ENDPOINTS,
        });
      }

      const profile = await fetchProfile(client);

      const result = await makeReservation(client, {
        restaurantId: restaurant_id,
        reservationDateTime,
        partySize: party_size,
        slotHash: slot_hash,
        reservationToken: reservation_token,
        slotLockId,
        diningAreaId,
        profile,
        bookingType,
        experienceId,
        experienceVersion,
        paymentCard,
        endpoint: MAKE_RESERVATION_PATH,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                confirmation_number: result.confirmationNumber,
                reservation_id: result.reservationId,
                security_token: result.securityToken,
                restaurant_id,
                date,
                time,
                party_size,
                points: result.points,
                status: 'Pending',
                cc_required: ccRequired,
                booking_type: bookingType === 'experience' ? 'experience_mandatory' : 'instant',
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
    'opentable_modify',
    {
      description:
        "Modify an existing OpenTable reservation in place. Requires the existing reservation's identity (restaurant_id + confirmation_number + security_token) plus a fresh modify_token from opentable_modify_preview — preview is mandatory because the new slot's cancellation policy / CC re-hold can differ from the original. Submits /dapi/booking/make-reservation with isModify: true + the existing confirmation_number + security_token; OpenTable preserves confirmation_number across modifies but may regenerate reservation_id and security_token. Returns the same shape as opentable_book plus was_modified: true so the agent can phrase the user confirmation accurately. For Listing-type restaurants there's no slot to lock — agents should check opentable_get_restaurant.bookable first.",
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
        date: z.string().describe('YYYY-MM-DD (the NEW date)'),
        time: z.string().describe('HH:MM (24h) — the NEW time'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots for the NEW slot'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots for the NEW slot'),
        dining_area_id: z.number().int(),
        modify_token: z
          .string()
          .optional()
          .describe('REQUIRED. From opentable_modify_preview. No no-token path — the new slot\'s policy + CC re-hold can differ from the original.'),
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional tamper-check signal. When set, must match the experienceId baked into modify_token.'),
      },
    },
    async ({
      restaurant_id,
      confirmation_number,
      security_token,
      date,
      time,
      party_size,
      reservation_token,
      slot_hash,
      dining_area_id,
      modify_token,
      experience_id: callerExperienceId,
    }) => {
      const reservationDateTime = `${date}T${time}`;
      const diningAreaId = dining_area_id;

      if (!modify_token) {
        throw new Error(
          'opentable_modify requires a modify_token from opentable_modify_preview. The new slot\'s policy and CC re-hold details can differ from the original — preview is mandatory.'
        );
      }

      const payload = decodeBookingToken(modify_token);

      if (typeof payload.existingConfirmationNumber !== 'number') {
        throw new Error(
          'This token was issued by opentable_book_preview (a new-booking token), not opentable_modify_preview. Use opentable_book to commit, or call opentable_modify_preview if you meant to edit an existing reservation.'
        );
      }

      if (
        payload.restaurantId !== restaurant_id ||
        payload.date !== date ||
        payload.time !== time ||
        payload.partySize !== party_size ||
        payload.diningAreaId !== dining_area_id ||
        payload.existingConfirmationNumber !== confirmation_number ||
        payload.existingSecurityToken !== security_token ||
        (typeof callerExperienceId === 'number' && payload.experienceId !== callerExperienceId)
      ) {
        throw new Error(
          'modify_token was issued for a different reservation (party_size, date/time, dining area, experience_id, or the existing reservation identifier has changed since opentable_modify_preview). Call opentable_modify_preview again with the current args.'
        );
      }

      const slotLockId = payload.slotLockId;
      const paymentCard = payload.paymentCard;
      const ccRequired = payload.ccRequired;
      const bookingType = payload.bookingType;
      const experienceId = payload.experienceId;
      const experienceVersion = payload.experienceVersion;

      const profile = await fetchProfile(client);

      const result = await makeReservation(client, {
        restaurantId: restaurant_id,
        reservationDateTime,
        partySize: party_size,
        slotHash: slot_hash,
        reservationToken: reservation_token,
        slotLockId,
        diningAreaId,
        profile,
        bookingType,
        experienceId,
        experienceVersion,
        paymentCard,
        modify: {
          confirmationNumber: payload.existingConfirmationNumber!,
          securityToken: payload.existingSecurityToken!,
        },
        endpoint: MAKE_RESERVATION_PATH,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                confirmation_number: result.confirmationNumber,
                reservation_id: result.reservationId,
                security_token: result.securityToken,
                restaurant_id,
                date,
                time,
                party_size,
                points: result.points,
                status: 'Pending',
                cc_required: ccRequired,
                booking_type: bookingType === 'experience' ? 'experience_mandatory' : 'instant',
                was_modified: true,
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

