import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { OpenTableClient } from '../../src/client.js';
import { registerReservationTools } from '../../src/tools/reservations.js';
import { createTestHarness } from '../helpers.js';
import { decodeBookingToken, encodeBookingToken } from '../../src/booking-token.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8'));

const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(state: unknown): string {
  return `<!DOCTYPE html><html><head></head><body><script>{"__INITIAL_STATE__":${JSON.stringify(
    state
  )}}</script></body></html>`;
}

describe('reservation tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerReservationTools(server, mockClient)
    );
  });

  describe('opentable_list_reservations', () => {
    it('fetches /user/dining-dashboard and returns upcoming reservations by default', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          diningDashboard: {
            upcomingReservations: [
              {
                confirmationNumber: 999,
                dateTime: '2026-05-01T19:00:00',
                partySize: 2,
                reservationState: 'CONFIRMED',
                reservationType: 'Standard',
                restaurantId: 42,
                restaurantName: 'Testeria',
                securityToken: 't',
              },
            ],
            pastReservations: [],
          },
        })
      );

      const result = await harness.callTool('opentable_list_reservations');

      expect(mockFetchHtml).toHaveBeenCalledWith('/user/dining-dashboard');
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(
        (result.content[0] as { text: string }).text
      ) as Array<{ date: string; time: string; restaurant_name: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        date: '2026-05-01',
        time: '19:00',
        restaurant_name: 'Testeria',
      });
    });

    it('passes scope=past through to the parser', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [
              {
                confirmationNumber: 1,
                dateTime: '2025-11-01T20:00:00',
                partySize: 4,
                reservationState: 'COMPLETED',
                restaurantName: 'Old Spot',
              },
            ],
          },
        })
      );

      const result = await harness.callTool('opentable_list_reservations', {
        scope: 'past',
      });
      const parsed = JSON.parse(
        (result.content[0] as { text: string }).text
      ) as Array<{ status: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0].status).toBe('COMPLETED');
    });

    it('returns an empty array when the dashboard has no reservations', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [],
          },
        })
      );
      const result = await harness.callTool('opentable_list_reservations');
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        []
      );
    });
  });

  describe('opentable_find_slots', () => {
    it('POSTs the persisted-query body and returns formatted slots', async () => {
      mockFetchJson.mockResolvedValue({
        data: {
          availability: [
            {
              restaurantId: 42,
              availabilityDays: [
                {
                  slots: [
                    {
                      isAvailable: true,
                      timeOffsetMinutes: 0,
                      slotAvailabilityToken: 'tok-19',
                      slotHash: 'h-19',
                      type: 'Standard',
                      attributes: ['default'],
                      pointsValue: 100,
                      __typename: 'AvailableSlot',
                    },
                    {
                      isAvailable: true,
                      timeOffsetMinutes: 30,
                      slotAvailabilityToken: 'tok-1930',
                      type: 'Standard',
                      attributes: ['default'],
                      pointsValue: 100,
                      __typename: 'AvailableSlot',
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

      const result = await harness.callTool('opentable_find_slots', {
        restaurant_id: 42,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
      });

      expect(mockFetchJson).toHaveBeenCalledWith(
        '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            operationName: 'RestaurantsAvailability',
            variables: expect.objectContaining({
              restaurantIds: [42],
              date: '2026-05-01',
              time: '19:00',
              partySize: 2,
            }),
            extensions: expect.objectContaining({
              persistedQuery: expect.objectContaining({ sha256Hash: expect.any(String) }),
            }),
          }),
        })
      );
      const parsed = JSON.parse(
        (result.content[0] as { text: string }).text
      ) as Array<{ time: string; reservation_token: string }>;
      expect(parsed).toHaveLength(2);
      expect(parsed[0].time).toBe('19:00');
      expect(parsed[1].time).toBe('19:30');
    });

    it('returns [] when the restaurant has no available slots', async () => {
      mockFetchJson.mockResolvedValue({
        data: {
          availability: [
            {
              restaurantId: 42,
              availabilityDays: [{ slots: [{ isAvailable: false, __typename: 'UnavailableSlot' }] }],
            },
          ],
        },
      });
      const result = await harness.callTool('opentable_find_slots', {
        restaurant_id: 42,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
      });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual([]);
    });
  });

  describe('opentable_book_preview', () => {
    it('fetches /booking/details + slot-lock and returns the CC policy + token', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-cc.json'))
      );
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 902203460 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 5,
        reservation_token: 'rt_xxx',
        slot_hash: '1663920856',
        dining_area_id: 1,
      });

      // Called the SSR page
      expect(mockFetchHtml).toHaveBeenCalledWith(
        expect.stringMatching(/^\/booking\/details\?.*rid=2827/)
      );
      // And the slot-lock mutation
      expect(mockFetchJson).toHaveBeenCalledWith(
        '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock',
        expect.objectContaining({ method: 'POST' })
      );

      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text) as {
        booking_token: string;
        cancellation_policy: { type: string; amount_usd: number; per_person: boolean };
        payment_method: { brand: string; last4: string } | null;
        charges_at_booking: { amount_usd: number; description: string };
      };
      expect(body.cancellation_policy.type).toBe('no_show_fee');
      expect(body.cancellation_policy.amount_usd).toBe(50);
      expect(body.cancellation_policy.per_person).toBe(true);
      expect(body.payment_method).toEqual({ brand: 'Mastercard', last4: '4242' });
      expect(body.charges_at_booking.amount_usd).toBe(0);
      expect(body.charges_at_booking.description).toMatch(/held only/i);
      expect(body.charges_at_booking.description).toContain('4242');

      const decoded = decodeBookingToken(body.booking_token);
      expect(decoded.ccRequired).toBe(true);
      expect(decoded.slotLockId).toBe(902203460);
      expect(decoded.partySize).toBe(5);
      expect(decoded.paymentCard).toEqual({
        id: 'card_REDACTED_DEFAULT',
        last4: '4242',
        // Fixture has expiryMonth: 10, expiryYear: 2028
        expiryMmYy: '1028',
        provider: 'spreedly',
      });
    });

    it('surfaces messages.termsAndConditions in preview output as a top-level `terms` field', async () => {
      const state = {
        ...fixture('booking-details-state-no-cc.json'),
        messages: {
          termsAndConditions: {
            message:
              'Please note that we work with a 24 hour cancellation policy and a £10pp charge should you cancel within this time frame.',
            language: { code: 'en', ietf: 'en-GB', region: 'GB' },
          },
        },
      };
      mockFetchHtml.mockResolvedValue(htmlWith(state));
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 141537,
        date: '2026-05-09',
        time: '19:30',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.terms).toEqual({
        text: expect.stringContaining('£10pp'),
        language: 'en-GB',
      });
    });

    it('returns terms=null when the venue has no custom policy', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-no-cc.json'))
      );
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      });

      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.terms).toBeNull();
    });

    it('on a no-CC slot returns policy.type=none, payment_method=null, still issues a token', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-no-cc.json'))
      );
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.cancellation_policy.type).toBe('none');
      expect(body.payment_method).toBeNull();
      expect(body.cc_required).toBe(false);
      expect(typeof body.booking_token).toBe('string');
      const decoded = decodeBookingToken(body.booking_token);
      expect(decoded.ccRequired).toBe(false);
      expect(decoded.paymentCard).toBeNull();
    });

    it('throws a same-day conflict error before touching slot-lock', async () => {
      const conflictState = {
        ...fixture('booking-details-state-no-cc.json'),
        upcomingReservationConflicts: [
          {
            dateTime: '2026-05-01T20:00',
            confirmationNumber: 2110515622,
            partySize: 5,
            restaurant: { restaurantId: 2827, name: 'Rowes Wharf Sea Grille' },
          },
        ],
      };
      mockFetchHtml.mockResolvedValue(htmlWith(conflictState));
      mockFetchJson.mockRejectedValue(new Error('should not be called'));

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/same day/i);
      expect(text).toContain('Rowes Wharf Sea Grille');
      expect(text).toContain('2110515622');
      expect(text).toMatch(/opentable_cancel/);
      // slot-lock must not have fired — we refused pre-flight.
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('throws when CC-required and no default card on file', async () => {
      const noCardState = {
        ...fixture('booking-details-state-cc.json'),
        wallet: { savedCards: [], selectedPaymentCardId: null },
      };
      mockFetchHtml.mockResolvedValue(htmlWith(noCardState));
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 1 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 5,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/default payment method/i);
      expect(text).toContain('opentable.com/account/payment-methods');
    });
  });

  describe('opentable_book_preview — Experience-mandatory slot', () => {
    it('builds the /booking/details URL with experience query params and calls Experience slot-lock', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-experience.json'))
      );
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
        if (path.includes('opname=BookDetailsExperienceSlotLock')) {
          // Experience slot-lock wraps the result in `lockExperienceSlot`
          // rather than `lockSlot` (Standard's field). Verified live
          // 2026-05-21 — see commits on capture branch.
          return {
            data: {
              lockExperienceSlot: { success: true, slotLock: { slotLockId: 9999 } },
            },
            __observed: init?.body,
          };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        experience_id: 514735,
      });

      // URL contains experience params
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
      const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
      expect(htmlUrl).toContain('selectedExperience=514735');
      expect(htmlUrl).toContain('experienceIds=514735');
      expect(htmlUrl).toContain('st=Experience');

      // SlotLock invoked with Experience op + body
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      const [lockPath, lockInit] = mockFetchJson.mock.calls[0] as [
        string,
        { body?: { operationName?: string; variables?: { input?: Record<string, unknown> } } }
      ];
      expect(lockPath).toBe(
        '/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock'
      );
      expect(lockInit.body?.operationName).toBe('BookDetailsExperienceSlotLock');
      expect(lockInit.body?.variables?.input?.experienceId).toBe(514735);
      // ExperienceSlotLockInput differs from Standard SlotLockInput:
      // bookingType: "Table" (not reservationType: "EXPERIENCE"),
      // experienceVersion from the parsed experience record,
      // slotAvailabilityToken on the input itself, no tableCategory.
      expect(lockInit.body?.variables?.input?.bookingType).toBe('Table');
      expect(lockInit.body?.variables?.input?.experienceVersion).toBe(7);
      expect(lockInit.body?.variables?.input?.slotAvailabilityToken).toBe('tok');
      expect(lockInit.body?.variables?.input?.reservationType).toBeUndefined();
      expect(lockInit.body?.variables?.input?.tableCategory).toBeUndefined();

      // Token + result fields
      expect(result.isError).toBeFalsy();
      const json = JSON.parse((result.content[0] as { text: string }).text);
      expect(json.booking_type).toBe('experience_mandatory');
      expect(json.experience.experience_id).toBe(514735);
      const decoded = decodeBookingToken(json.booking_token);
      expect(decoded.bookingType).toBe('experience');
      expect(decoded.experienceId).toBe(514735);
    });

    it('refuses an Experience slot when experience_id is missing', async () => {
      // The handler should reject before any fetch fires — we trigger
      // Experience-mode by passing experience_ids (the agent passes them
      // through from find_slots) without picking one via experience_id.
      mockFetchHtml.mockRejectedValue(new Error('should not be called'));
      mockFetchJson.mockRejectedValue(new Error('should not be called'));

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        experience_ids: [514735, 627696],
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/experience_id/);
      expect(text).toContain('514735');
      expect(text).toContain('627696');
      expect(mockFetchHtml).not.toHaveBeenCalled();
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('the Standard path still includes booking_type=instant and experience=null', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-no-cc.json'))
      );
      mockFetchJson.mockResolvedValue({
        data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
      });

      const result = await harness.callTool('opentable_book_preview', {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.booking_type).toBe('instant');
      expect(body.experience).toBeNull();
      // The /booking/details URL must NOT include Experience query params.
      const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
      expect(htmlUrl).not.toContain('selectedExperience');
      expect(htmlUrl).not.toContain('experienceIds');
      expect(htmlUrl).not.toContain('st=Experience');
      // And the lock should still be the Standard one.
      const [lockPath, lockInit] = mockFetchJson.mock.calls[0] as [
        string,
        { body?: { operationName?: string; variables?: { input?: Record<string, unknown> } } }
      ];
      expect(lockPath).toBe(
        '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock'
      );
      expect(lockInit.body?.operationName).toBe('BookDetailsStandardSlotLock');
      expect(lockInit.body?.variables?.input?.reservationType).toBe('STANDARD');
      expect(lockInit.body?.variables?.input).not.toHaveProperty('experienceId');
    });
  });

  describe('opentable_book — CC-required gating + booking_token path', () => {
    it('refuses to commit a CC-required slot without a booking_token', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith(fixture('booking-details-state-cc.json'))
      );

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 5,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/credit-card guarantee/i);
      expect(text).toMatch(/opentable_book_preview/);
    });

    it('on a standard slot without a booking_token, refuses with a same-day-conflict error', async () => {
      const conflictState = {
        ...fixture('booking-details-state-no-cc.json'),
        upcomingReservationConflicts: [
          {
            dateTime: '2026-05-01T20:00',
            confirmationNumber: 2110515622,
            partySize: 5,
            restaurant: { restaurantId: 2827, name: 'Rowes Wharf Sea Grille' },
          },
        ],
      };
      mockFetchHtml.mockResolvedValue(htmlWith(conflictState));
      mockFetchJson.mockRejectedValue(new Error('should not be called'));

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/same day/i);
      expect(text).toContain('Rowes Wharf Sea Grille');
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('commits cleanly when called with a valid booking_token (skips re-lock)', async () => {
      const token = encodeBookingToken({
        slotLockId: 12345,
        restaurantId: 2827,
        diningAreaId: 1,
        partySize: 5,
        date: '2026-05-01',
        time: '20:45',
        reservationToken: 'rt',
        slotHash: 'sh',
        paymentCard: { id: 'card_real', last4: '4242', expiryMmYy: '1028', provider: 'spreedly' },
        ccRequired: true,
        issuedAt: '2026-04-21T00:00:00Z',
      });

      // Only the make-reservation JSON call should fire — no slot-lock, no booking-details SSR.
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
        if (path.includes('make-reservation')) {
          const body = init?.body as Record<string, unknown>;
          expect(body.slotLockId).toBe(12345);
          // paymentMethodId MUST NOT appear — OpenTable's validator rejects it.
          expect(body).not.toHaveProperty('paymentMethodId');
          // But the five CC fields SHOULD be present for a CC-required book.
          expect(body.creditCardToken).toBe('card_real');
          expect(body.creditCardLast4).toBe('4242');
          expect(body.creditCardMMYY).toBe('1028');
          expect(body.creditCardProvider).toBe('spreedly');
          expect(body.scaRedirectUrl).toBe('https://www.opentable.com/booking/payments-sca');
          // And correlationId should be a UUID.
          expect(body.correlationId).toMatch(/^[0-9a-f]{8}-/);
          return {
            success: true,
            reservationId: 424242,
            confirmationNumber: 8675309,
            securityToken: 'st_real',
            points: 100,
            partnerScaRequired: false,
          };
        }
        throw new Error(`unexpected fetchJson path: ${path}`);
      });
      // fetchHtml is still called by fetchProfile for PII.
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          header: {
            userProfile: {
              firstName: 'Test',
              lastName: 'User',
              email: 'test@example.com',
              mobilePhoneNumber: { number: '5551234567', countryId: 'US' },
              countryId: 'US',
            },
          },
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [],
          },
        })
      );

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 5,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
        booking_token: token,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.confirmation_number).toBe(8675309);
      expect(body.cc_required).toBe(true);
    });

    it('rejects a booking_token whose fields do not match the call args', async () => {
      const token = encodeBookingToken({
        slotLockId: 12345,
        restaurantId: 2827,
        diningAreaId: 1,
        partySize: 5,
        date: '2026-05-01',
        time: '20:45',
        reservationToken: 'rt',
        slotHash: 'sh',
        paymentCard: { id: 'card_real', last4: '4242', expiryMmYy: '1028', provider: 'spreedly' },
        ccRequired: true,
        issuedAt: '2026-04-21T00:00:00Z',
      });

      // fetchJson / fetchHtml must never fire — rejection must be synchronous.
      mockFetchJson.mockRejectedValue(new Error('should not be called'));
      mockFetchHtml.mockRejectedValue(new Error('should not be called'));

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 4, // changed from 5
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
        booking_token: token,
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/different reservation/i);
      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(mockFetchHtml).not.toHaveBeenCalled();
    });

    it('maps a SLOT_LOCK_EXPIRED failure to an actionable message', async () => {
      const token = encodeBookingToken({
        slotLockId: 12345,
        restaurantId: 2827,
        diningAreaId: 1,
        partySize: 5,
        date: '2026-05-01',
        time: '20:45',
        reservationToken: 'rt',
        slotHash: 'sh',
        paymentCard: { id: 'card_real', last4: '4242', expiryMmYy: '1028', provider: 'spreedly' },
        ccRequired: true,
        issuedAt: '2026-04-21T00:00:00Z',
      });

      mockFetchHtml.mockResolvedValue(
        htmlWith({
          header: {
            userProfile: {
              firstName: 'Test',
              lastName: 'User',
              email: 'test@example.com',
              mobilePhoneNumber: { number: '5551234567', countryId: 'US' },
              countryId: 'US',
            },
          },
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [],
          },
        })
      );
      mockFetchJson.mockResolvedValue({
        success: false,
        errorCode: 'SLOT_LOCK_EXPIRED',
        errorMessage: 'slot lock expired',
      });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 2827,
        date: '2026-05-01',
        time: '20:45',
        party_size: 5,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 1,
        booking_token: token,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/slot lock expired/i);
      expect(text).toMatch(/opentable_find_slots/);
    });
  });

  describe('opentable_book — Experience-mandatory slot', () => {
    it('with a token: skips slot-lock, submits make-reservation with experience fields', async () => {
      const token = encodeBookingToken({
        slotLockId: 9999,
        restaurantId: 278896,
        diningAreaId: 21881,
        partySize: 5,
        date: '2026-06-25',
        time: '18:00',
        reservationToken: 'tok',
        slotHash: '431673495',
        paymentCard: null,
        ccRequired: false,
        issuedAt: new Date().toISOString(),
        bookingType: 'experience',
        experienceId: 514735,
      });

      // fetchProfile reads dining-dashboard via fetchHtml — wire that up.
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          header: {
            userProfile: {
              firstName: 'A',
              lastName: 'B',
              email: 'a@b.c',
              mobilePhoneNumber: { number: '5550000', countryId: 'US' },
              countryId: 'US',
            },
          },
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [],
          },
        })
      );

      let makeBody: Record<string, unknown> | undefined;
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
        if (path === '/dapi/booking/make-reservation') {
          makeBody = init?.body as Record<string, unknown>;
          return {
            confirmationNumber: 8675309,
            reservationId: 1,
            securityToken: 'sec',
            success: true,
          };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        booking_token: token,
      });

      expect(result.isError).toBeFalsy();
      expect(makeBody).toBeDefined();
      expect(makeBody!.experienceId).toBe(514735);
      expect(makeBody!.reservationType).toBe('Experience');
      // tableCategory belongs on the slot-lock body, not on make-reservation
      // — the REST endpoint 400s with "tableCategory is not allowed" if
      // included. Verified live 2026-05-21.
      expect(makeBody!.tableCategory).toBeUndefined();
      // experienceVersion threads through from the token (book_preview reads
      // it from the parsed booking-details-state).
      expect(makeBody!.experienceVersion).toBeDefined();
      // Slot-lock must NOT have fired — token path skips re-lock.
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      const json = JSON.parse((result.content[0] as { text: string }).text);
      expect(json.confirmation_number).toBe(8675309);
      expect(json.booking_type).toBe('experience_mandatory');
    });

    it('without a token: refuses Experience slots (preview-first gating)', async () => {
      // The handler should reject before any fetch fires.
      mockFetchHtml.mockRejectedValue(new Error('should not be called'));
      mockFetchJson.mockRejectedValue(new Error('should not be called'));

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        experience_ids: [514735], // signals Experience without a token
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/book_preview/);
      expect(mockFetchHtml).not.toHaveBeenCalled();
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('refuses an Experience token when caller-provided experience_id mismatches the token', async () => {
      mockFetchHtml.mockRejectedValue(new Error('should not be called'));
      mockFetchJson.mockRejectedValue(new Error('should not be called'));

      const token = encodeBookingToken({
        slotLockId: 9999,
        restaurantId: 278896,
        diningAreaId: 21881,
        partySize: 5,
        date: '2026-06-25',
        time: '18:00',
        reservationToken: 'tok',
        slotHash: '431673495',
        paymentCard: null,
        ccRequired: false,
        issuedAt: new Date().toISOString(),
        bookingType: 'experience',
        experienceId: 514735,
      });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        booking_token: token,
        experience_id: 627696, // ← drifted from the token's 514735
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/booking_token was issued for a different reservation/);
      expect(text).toMatch(/experience_id/);
      expect(mockFetchHtml).not.toHaveBeenCalled();
      expect(mockFetchJson).not.toHaveBeenCalled();
    });
  });

  describe('opentable_modify_preview', () => {
    // Splice the modifyReservation block onto the existing Experience
    // fixture rather than maintaining a third near-duplicate fixture file.
    const modifyState = {
      ...(fixture('booking-details-state-experience.json') as object),
      modifyReservation: fixture('modify-reservation-block.json'),
    };

    describe("Experience-mandatory slot (Pasqual's style)", () => {
      it('builds the /booking/details URL with confirmationNumber + securityToken + isModify=true + Experience params, slot-locks, returns modify_token', async () => {
        mockFetchHtml.mockResolvedValue(htmlWith(modifyState));
        mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
          if (path.includes('opname=BookDetailsExperienceSlotLock')) {
            return {
              data: { lockExperienceSlot: { success: true, slotLock: { slotLockId: 8888 } } },
              __observed: init?.body,
            };
          }
          throw new Error(`unexpected POST: ${path}`);
        });

        const result = await harness.callTool('opentable_modify_preview', {
          restaurant_id: 278896,
          confirmation_number: 29541,
          security_token: '01abc',
          date: '2026-06-25',
          time: '19:15',
          party_size: 5,
          reservation_token: 'tok',
          slot_hash: '4444',
          dining_area_id: 21881,
          experience_id: 514735,
        });

        // URL contains all three modify markers + Experience params
        const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
        expect(htmlUrl).toContain('confirmationNumber=29541');
        expect(htmlUrl).toContain('securityToken=01abc');
        expect(htmlUrl).toContain('isModify=true');
        expect(htmlUrl).toContain('selectedExperience=514735');
        expect(htmlUrl).toContain('st=Experience');

        // Result shape
        expect(result.isError).toBeFalsy();
        const json = JSON.parse((result.content[0] as { text: string }).text);
        expect(json.booking_type).toBe('experience_mandatory');
        expect(json.existing_reservation).toEqual({
          confirmation_number: 29541,
          restaurant_id: 278896,
          // Enriched from modifyReservation block in the SSR state — lets
          // the agent phrase "moving your booking from June 25 18:00 → 19:15".
          date: '2026-06-25',
          time: '18:00',
          party_size: 5,
          dining_area_id: 21881,
        });
        expect(json.reservation).toMatchObject({
          date: '2026-06-25',
          time: '19:15',
          party_size: 5,
        });

        // Token carries existing-reservation identity + new slot routing info
        const decoded = decodeBookingToken(json.modify_token);
        expect(decoded.existingReservationId).toBeGreaterThan(0);
        expect(decoded.existingConfirmationNumber).toBe(29541);
        expect(decoded.existingSecurityToken).toBe('01abc');
        expect(decoded.bookingType).toBe('experience');
        expect(decoded.experienceId).toBe(514735);
      });
    });

    describe('Standard slot', () => {
      it('builds the /booking/details URL with modify markers, slot-locks via Standard op, returns modify_token', async () => {
        mockFetchHtml.mockResolvedValue(htmlWith(fixture('booking-details-state-no-cc.json')));
        mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
          if (path.includes('opname=BookDetailsStandardSlotLock')) {
            return {
              data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
              __observed: init?.body,
            };
          }
          throw new Error(`unexpected POST: ${path}`);
        });

        const result = await harness.callTool('opentable_modify_preview', {
          restaurant_id: 1272781,
          confirmation_number: 11111,
          security_token: '02xyz',
          date: '2026-05-05',
          time: '20:00',
          party_size: 2,
          reservation_token: 'tok',
          slot_hash: 'h',
          dining_area_id: 1,
        });

        const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
        expect(htmlUrl).toContain('confirmationNumber=11111');
        expect(htmlUrl).toContain('securityToken=02xyz');
        expect(htmlUrl).toContain('isModify=true');
        expect(htmlUrl).not.toContain('st=Experience');

        const json = JSON.parse((result.content[0] as { text: string }).text);
        expect(json.booking_type).toBe('instant');
        expect(json.existing_reservation.confirmation_number).toBe(11111);
        const decoded = decodeBookingToken(json.modify_token);
        expect(decoded.bookingType).toBe('standard');
        expect(decoded.existingConfirmationNumber).toBe(11111);
      });
    });

    describe('same-day move (existing reservation excluded from conflict check)', () => {
      it('does not throw when the only conflict on new_date is the existing reservation being moved', async () => {
        const stateWithSelfConflict = {
          ...(fixture('booking-details-state-no-cc.json') as object),
          upcomingReservationConflicts: [
            {
              dateTime: '2026-05-05T18:00',
              confirmationNumber: 11111, // ← same as the existing one
              partySize: 2,
              restaurant: { restaurantId: 1272781, name: 'X' },
            },
          ],
        };
        mockFetchHtml.mockResolvedValue(htmlWith(stateWithSelfConflict));
        mockFetchJson.mockImplementation(async (path: string) => {
          if (path.includes('opname=BookDetailsStandardSlotLock')) {
            return { data: { lockSlot: { success: true, slotLock: { slotLockId: 1 } } } };
          }
          throw new Error(`unexpected POST: ${path}`);
        });

        const result = await harness.callTool('opentable_modify_preview', {
          restaurant_id: 1272781,
          confirmation_number: 11111,
          security_token: '02xyz',
          date: '2026-05-05',
          time: '20:00',
          party_size: 2,
          reservation_token: 'tok',
          slot_hash: 'h',
          dining_area_id: 1,
        });

        expect(result.isError).toBeFalsy();
      });

      it('still throws if a DIFFERENT same-day reservation exists', async () => {
        const stateWithOtherConflict = {
          ...(fixture('booking-details-state-no-cc.json') as object),
          upcomingReservationConflicts: [
            {
              dateTime: '2026-05-05T13:00',
              confirmationNumber: 99999, // ← different reservation
              partySize: 4,
              restaurant: { restaurantId: 5, name: 'Brunch Spot' },
            },
          ],
        };
        mockFetchHtml.mockResolvedValue(htmlWith(stateWithOtherConflict));

        const result = await harness.callTool('opentable_modify_preview', {
          restaurant_id: 1272781,
          confirmation_number: 11111,
          security_token: '02xyz',
          date: '2026-05-05',
          time: '20:00',
          party_size: 2,
          reservation_token: 'tok',
          slot_hash: 'h',
          dining_area_id: 1,
        });

        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toMatch(/two reservations on the same day/i);
      });
    });
  });

  describe('opentable_modify', () => {
    it('with a modify token: submits make-reservation with isModify: true and the existing reservationId', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          header: {
            userProfile: {
              firstName: 'A',
              lastName: 'B',
              email: 'a@b.c',
              mobilePhoneNumber: { number: '5550000', countryId: 'US' },
              countryId: 'US',
            },
          },
          diningDashboard: {
            upcomingReservations: [],
            pastReservations: [],
          },
        })
      );
      let makeBody: Record<string, unknown> | null = null;
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: Record<string, unknown> }) => {
        if (path === '/dapi/booking/make-reservation') {
          makeBody = init?.body ?? null;
          return { confirmationNumber: 29541, reservationId: 2082218742, securityToken: 'sec2', success: true };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const token = encodeBookingToken({
        slotLockId: 8888, restaurantId: 278896, diningAreaId: 21881,
        partySize: 5, date: '2026-06-25', time: '19:15',
        reservationToken: 'tok', slotHash: '4444',
        paymentCard: { id: 'card-1', last4: '2630', expiryMmYy: '1028', provider: 'spreedly' },
        ccRequired: true,
        issuedAt: new Date().toISOString(),
        bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
        existingReservationId: 170008082287,
        existingConfirmationNumber: 29541,
        existingSecurityToken: '01abc',
      });

      const result = await harness.callTool('opentable_modify', {
        restaurant_id: 278896,
        confirmation_number: 29541,
        security_token: '01abc',
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '4444',
        dining_area_id: 21881,
        modify_token: token,
        experience_id: 514735,
      });

      expect(result.isError).toBeFalsy();
      expect(makeBody!.isModify).toBe(true);
      // make-reservation modify identity = isModify + securityToken + confnumber.
      // reservationId is explicitly NOT allowed (live: 400 "reservationId
      // is not allowed"). gpid stays in the token for tamper-check purposes
      // but never goes on the wire.
      expect(makeBody!.reservationId).toBeUndefined();
      expect(makeBody!.securityToken).toBe('01abc');
      expect(makeBody!.confnumber).toBe(29541);
      expect(makeBody!.experienceId).toBe(514735);
      expect(makeBody!.experienceVersion).toBe(7);
      expect(makeBody!.reservationType).toBe('Experience');
      const json = JSON.parse((result.content[0] as { text: string }).text);
      expect(json.confirmation_number).toBe(29541);
      expect(json.was_modified).toBe(true);
      expect(json.booking_type).toBe('experience_mandatory');
    });

    it('refuses without a modify_token', async () => {
      const result = await harness.callTool('opentable_modify', {
        restaurant_id: 278896,
        confirmation_number: 29541,
        security_token: '01abc',
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '4444',
        dining_area_id: 21881,
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/modify_preview/);
    });

    it('refuses a book_preview token (no existingReservationId)', async () => {
      const bookToken = encodeBookingToken({
        slotLockId: 9999, restaurantId: 278896, diningAreaId: 21881,
        partySize: 5, date: '2026-06-25', time: '19:15',
        reservationToken: 'tok', slotHash: '4444',
        paymentCard: null, ccRequired: false,
        issuedAt: new Date().toISOString(),
        bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
      });

      const result = await harness.callTool('opentable_modify', {
        restaurant_id: 278896,
        confirmation_number: 29541,
        security_token: '01abc',
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '4444',
        dining_area_id: 21881,
        modify_token: bookToken,
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/book_preview.*not.*opentable_modify_preview/i);
    });

    it('refuses when caller confirmation_number diverges from the token', async () => {
      const token = encodeBookingToken({
        slotLockId: 8888, restaurantId: 278896, diningAreaId: 21881,
        partySize: 5, date: '2026-06-25', time: '19:15',
        reservationToken: 'tok', slotHash: '4444',
        paymentCard: null, ccRequired: false,
        issuedAt: new Date().toISOString(),
        bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
        existingReservationId: 170008082287,
        existingConfirmationNumber: 29541,
        existingSecurityToken: '01abc',
      });

      const result = await harness.callTool('opentable_modify', {
        restaurant_id: 278896,
        confirmation_number: 99999, // ← drifted
        security_token: '01abc',
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '4444',
        dining_area_id: 21881,
        modify_token: token,
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/different reservation/);
    });
  });
});
