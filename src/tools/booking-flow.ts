// Booking-flow primitives shared between opentable_book / opentable_book_preview
// and opentable_modify / opentable_modify_preview.
//
// Two endpoints, two helpers:
//
//   lockSlot(client, args)
//     POST /dapi/fe/gql?opname=BookDetailsStandardSlotLock (Standard) or
//     POST /dapi/fe/gql?opname=BookDetailsExperienceSlotLock (Experience).
//     Returns the slotLockId. Hides the Standard-vs-Experience input
//     shape + response-wrapping divergence (`lockSlot` vs
//     `lockExperienceSlot`).
//
//   makeReservation(client, args)
//     POST /dapi/booking/make-reservation. Handles four orthogonal
//     concerns in one place: Standard/Experience body shape, optional
//     CC fields, modify vs new-book (isModify + identity triple), and
//     the standard error mapping (3DS bail, SLOT_LOCK_EXPIRED → re-find,
//     errorCode pass-through). Returns the parsed confirmation block.
//
// The persisted-query hashes + endpoint paths live in tools/reservations.ts
// (the file that imports these helpers); we accept them as constructor-ish
// args rather than re-exporting them, so the hashes stay in one place
// where the inline re-capture instructions can see them.

import { randomUUID } from 'node:crypto';
import type { OpenTableClient } from '../client.js';
import type {
  BookingTokenPaymentCard,
  BookingTokenType,
} from '../booking-token.js';

/** OpenTable's hardcoded SCA redirect URL — make-reservation's validator
 *  requires this field when any `creditCard*` field is set, even though
 *  pre-authenticated saved cards never trigger an actual 3DS flow. */
const SCA_REDIRECT_URL = 'https://www.opentable.com/booking/payments-sca';

/** OpenTable's card-tokenization vendor. Saved-card cardIds are already
 *  Spreedly tokens; we don't tokenize anything ourselves. */
const CC_PROVIDER = 'spreedly';

export interface SlotLockArgs {
  restaurantId: number;
  reservationDateTime: string; // `${date}T${time}`
  partySize: number;
  slotHash: string;
  diningAreaId: number;
  reservationToken: string; // slotAvailabilityToken — only sent for the Experience variant
  /** OpenTable's sharded-database region the restaurant lives in. Sent
   *  verbatim on the slot-lock input. North-American venues are `'NA'`;
   *  non-NA (UK/EU/APAC) restaurants live in other shards and slot-lock
   *  against the wrong database — or fail opaquely — when this is wrong.
   *  Defaults to `'NA'` at the tool layer. */
  databaseRegion: string;
  /** When set, routes through `BookDetailsExperienceSlotLock` instead of
   *  `BookDetailsStandardSlotLock`. The `experienceVersion` is an
   *  optimistic-concurrency stamp from the booking-details SSR state. */
  experience?: {
    experienceId: number;
    experienceVersion: number;
  };
  /** Endpoint paths + persisted-query hashes — caller-supplied so they
   *  stay co-located with the inline re-capture instructions in
   *  tools/reservations.ts. */
  endpoints: {
    standardPath: string;
    experiencePath: string;
    standardHash: string;
    experienceHash: string;
  };
}

/**
 * Slot-lock a candidate slot for ~90 seconds. Returns the slotLockId on
 * success. Throws with the verbatim server response on failure.
 */
export async function lockSlot(
  client: OpenTableClient,
  args: SlotLockArgs
): Promise<number> {
  const isExperience = args.experience !== undefined;
  const path = isExperience ? args.endpoints.experiencePath : args.endpoints.standardPath;
  const operationName = isExperience
    ? 'BookDetailsExperienceSlotLock'
    : 'BookDetailsStandardSlotLock';
  const sha256Hash = isExperience ? args.endpoints.experienceHash : args.endpoints.standardHash;

  // ExperienceSlotLockInput and (Standard) SlotLockInput are different GraphQL
  // input types — they don't share field sets. Verified live 2026-05-21.
  const input = isExperience
    ? {
        restaurantId: args.restaurantId,
        seatingOption: 'DEFAULT',
        reservationDateTime: args.reservationDateTime,
        partySize: args.partySize,
        databaseRegion: args.databaseRegion,
        slotHash: args.slotHash,
        experienceId: args.experience!.experienceId,
        experienceVersion: args.experience!.experienceVersion,
        diningAreaId: args.diningAreaId,
        bookingType: 'Table',
        slotAvailabilityToken: args.reservationToken,
      }
    : {
        restaurantId: args.restaurantId,
        seatingOption: 'DEFAULT',
        reservationDateTime: args.reservationDateTime,
        partySize: args.partySize,
        databaseRegion: args.databaseRegion,
        slotHash: args.slotHash,
        reservationType: 'STANDARD',
        diningAreaId: args.diningAreaId,
      };

  const response = await client.fetchJson<{
    data?: {
      // Standard wraps under `lockSlot`; Experience under `lockExperienceSlot`.
      // Same inner shape.
      lockSlot?: {
        success?: boolean;
        slotLock?: { slotLockId?: number };
        slotLockErrors?: unknown;
      };
      lockExperienceSlot?: {
        success?: boolean;
        slotLock?: { slotLockId?: number };
        slotLockErrors?: unknown;
      };
    };
  }>(path, {
    method: 'POST',
    headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
    body: {
      operationName,
      variables: { input },
      extensions: { persistedQuery: { version: 1, sha256Hash } },
    },
  });

  const lockResult = isExperience
    ? response?.data?.lockExperienceSlot
    : response?.data?.lockSlot;
  const slotLockId = lockResult?.slotLock?.slotLockId;
  if (!slotLockId || lockResult?.success !== true) {
    throw new Error(
      `OpenTable failed to lock slot: ${JSON.stringify(lockResult ?? response)}`
    );
  }
  return slotLockId;
}

/** PII fields make-reservation needs. Caller fetches this from the
 *  dining-dashboard SSR (see fetchProfile in tools/reservations.ts). */
export interface BookProfile {
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone_number: string;
  country_id: string;
}

export interface MakeReservationArgs {
  restaurantId: number;
  reservationDateTime: string;
  partySize: number;
  slotHash: string;
  reservationToken: string;
  slotLockId: number;
  diningAreaId: number;
  profile: BookProfile;
  bookingType: BookingTokenType;
  experienceId?: number;
  experienceVersion?: number;
  paymentCard: BookingTokenPaymentCard | null;
  /** When set, sends the modify identity triple (isModify + securityToken
   *  + confnumber) instead of a fresh booking. */
  modify?: {
    confirmationNumber: number;
    securityToken: string;
  };
  /** Endpoint path — caller-supplied so it stays co-located with the
   *  rest of the path constants in tools/reservations.ts. */
  endpoint: string;
}

export interface MakeReservationResult {
  confirmationNumber: number;
  reservationId: number | null;
  securityToken: string;
  points: number;
}

/** Format MM/YY-ish: month + year → "MMYY" (e.g. 10, 2028 → "1028"). */
function expiryMmYy(month: number | null, year: number | null): string {
  if (month == null || year == null) return '';
  const mm = String(month).padStart(2, '0');
  const yy = String(year % 100).padStart(2, '0');
  return `${mm}${yy}`;
}

/**
 * POST /dapi/booking/make-reservation with the right body shape for the
 * (Standard|Experience) × (book|modify) × (CC|no-CC) combination. Throws
 * actionable errors for the known failure modes (3DS bail,
 * SLOT_LOCK_EXPIRED, generic errorCode pass-through). Returns
 * confirmation_number + the identity tokens.
 */
export async function makeReservation(
  client: OpenTableClient,
  args: MakeReservationArgs
): Promise<MakeReservationResult> {
  // Experience-flavored body bits — present iff bookingType === 'experience'.
  // tableCategory belongs on the slot-lock body only; make-reservation
  // 400s "tableCategory is not allowed" if we include it here.
  const experienceFields =
    args.bookingType === 'experience' && typeof args.experienceId === 'number'
      ? {
          experienceId: args.experienceId,
          experienceVersion: args.experienceVersion ?? 1,
          reservationType: 'Experience',
        }
      : { reservationType: 'Standard' };

  // CC-required body bits — present iff paymentCard is non-null. The
  // saved card's last4 + expiry + provider come straight from the
  // booking-token's paymentCard reference.
  const ccFields = args.paymentCard
    ? {
        creditCardToken: args.paymentCard.id,
        creditCardLast4: args.paymentCard.last4,
        creditCardMMYY: args.paymentCard.expiryMmYy,
        creditCardProvider: args.paymentCard.provider,
        scaRedirectUrl: SCA_REDIRECT_URL,
      }
    : {};

  // Modify identity triple — make-reservation's isModify path keys off
  // confnumber + securityToken. reservationId is explicitly NOT allowed
  // here (400 "reservationId is not allowed") even though the SSR's
  // modifyReservation.gpid looks like it should be the identifier.
  // `confnumber` (lowercase, no underscore) is OpenTable's quirky shorthand.
  const modifyFields = args.modify
    ? {
        isModify: true,
        securityToken: args.modify.securityToken,
        confnumber: args.modify.confirmationNumber,
      }
    : { isModify: false };

  const response = await client.fetchJson<{
    success?: boolean;
    reservationId?: number;
    confirmationNumber?: number;
    securityToken?: string;
    points?: number;
    errorCode?: string;
    errorMessage?: string;
    partnerScaRequired?: boolean;
    partnerScaRedirectUrl?: string | null;
  }>(args.endpoint, {
    method: 'POST',
    body: {
      restaurantId: args.restaurantId,
      reservationDateTime: args.reservationDateTime,
      partySize: args.partySize,
      slotHash: args.slotHash,
      slotAvailabilityToken: args.reservationToken,
      slotLockId: args.slotLockId,
      diningAreaId: args.diningAreaId,
      firstName: args.profile.first_name,
      lastName: args.profile.last_name,
      email: args.profile.email,
      phoneNumber: args.profile.mobile_phone_number,
      phoneNumberCountryId: args.profile.country_id || 'US',
      country: args.profile.country_id || 'US',
      reservationAttribute: 'default',
      pointsType: 'Standard',
      points: 100,
      tipAmount: 0,
      tipPercent: 0,
      confirmPoints: true,
      optInEmailRestaurant: false,
      additionalServiceFees: [],
      nonBookableExperiences: [],
      katakanaFirstName: '',
      katakanaLastName: '',
      correlationId: randomUUID(),
      ...modifyFields,
      ...experienceFields,
      ...ccFields,
    },
  });

  // 3DS challenge — rare for pre-authenticated saved cards, can't be
  // completed outside the browser. Surface the redirect URL and bail.
  if (response?.partnerScaRequired === true) {
    throw new Error(
      `This card requires 3-D Secure authentication (SCA), which can't be completed from the MCP. Complete the booking in your browser: ${
        response.partnerScaRedirectUrl ?? 'https://www.opentable.com/booking'
      }`
    );
  }

  if (response?.errorCode || response?.success === false) {
    const raw = `${response.errorCode ?? 'unknown'}${
      response.errorMessage ? ` — ${response.errorMessage}` : ''
    }`;
    if (/slot.?lock.?expired/i.test(raw) || /SLOT_LOCK_EXPIRED/i.test(raw)) {
      throw new Error(
        'Slot lock expired. Call opentable_find_slots for a fresh slot, then re-preview.'
      );
    }
    throw new Error(`OpenTable ${args.modify ? 'modify' : 'book'} failed: ${raw}`);
  }

  if (!response?.confirmationNumber) {
    throw new Error(
      `OpenTable ${args.modify ? 'modify' : 'book'} response missing confirmationNumber: ${JSON.stringify(response)}`
    );
  }

  return {
    confirmationNumber: response.confirmationNumber,
    reservationId: response.reservationId ?? null,
    securityToken: response.securityToken ?? '',
    points: response.points ?? 0,
  };
}

/** Re-exports so callers don't double-import. */
export { expiryMmYy, CC_PROVIDER };
