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
      expect(decoded.paymentMethodId).toBe('card_REDACTED_DEFAULT');
    });
  });
});
