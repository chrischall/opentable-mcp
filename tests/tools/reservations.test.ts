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
});
