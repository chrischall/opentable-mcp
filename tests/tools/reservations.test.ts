import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerReservationTools } from '../../src/tools/reservations.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('reservation tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerReservationTools(server, mockClient)
    );
  });

  describe('opentable_find_slots', () => {
    it('returns slots sorted by time ascending', async () => {
      mockRequest.mockResolvedValue({
        availability: [
          { token: 't-2', time: '19:30' },
          { token: 't-1', time: '18:00' },
          { token: 't-3', time: '20:00' },
        ],
      });

      const result = await harness.callTool('opentable_find_slots', {
        restaurant_id: 'r1',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/api/v2/restaurants/r1/availability')
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text) as Array<{
        time: string;
      }>;
      expect(parsed.map((s) => s.time)).toEqual(['18:00', '19:30', '20:00']);
    });
  });

  describe('opentable_list_reservations', () => {
    it('defaults to scope=upcoming and formats each entry', async () => {
      mockRequest.mockResolvedValue({
        reservations: [
          {
            id: 'res-1',
            confirmation_number: 'ABC123',
            restaurant_name: 'Milano',
            date: '2026-05-01',
            time: '19:00',
            party_size: 2,
            status: 'confirmed',
          },
        ],
      });

      const result = await harness.callTool('opentable_list_reservations');

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/users/me/reservations?scope=upcoming'
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"reservation_id": "res-1"');
      expect(text).toContain('"confirmation_number": "ABC123"');
    });

    it('passes scope=past through', async () => {
      mockRequest.mockResolvedValue({ reservations: [] });
      await harness.callTool('opentable_list_reservations', { scope: 'past' });
      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/users/me/reservations?scope=past'
      );
    });
  });

  describe('opentable_cancel', () => {
    it('POSTs cancel and reports cancelled=true on positive signal', async () => {
      mockRequest.mockResolvedValue({ status: 'cancelled' });

      const result = await harness.callTool('opentable_cancel', {
        reservation_id: 'res-1',
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'POST',
        '/api/v2/reservations/res-1/cancel'
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(true);
      expect(parsed.raw).toEqual({ status: 'cancelled' });
    });

    it('reports cancelled=false on explicit error field', async () => {
      mockRequest.mockResolvedValue({ error: 'already cancelled' });
      const result = await harness.callTool('opentable_cancel', {
        reservation_id: 'res-1',
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(false);
    });
  });

  describe('opentable_book', () => {
    it('books the closest-time slot when desired_time is not an exact match', async () => {
      mockRequest
        // 1. find
        .mockResolvedValueOnce({
          availability: [
            { token: 't-7pm', time: '19:00' },
            { token: 't-8pm', time: '20:00' },
          ],
        })
        // 2. book
        .mockResolvedValueOnce({
          reservation_id: 'res-1',
          confirmation_number: 'ABC123',
          restaurant_name: 'Milano',
          profile_url: '/restaurant/milano-sf',
          date: '2026-05-01',
          time: '19:00',
          party_size: 2,
          status: 'confirmed',
        });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        desired_time: '19:10',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.reservation_id).toBe('res-1');
      expect(parsed.confirmation_number).toBe('ABC123');
      expect(parsed.restaurant_url).toBe('https://www.opentable.com/restaurant/milano-sf');
      expect(parsed.time).toBe('19:00');

      // Verify book call carries the chosen token
      const bookCall = mockRequest.mock.calls[1];
      expect(bookCall[0]).toBe('POST');
      expect(bookCall[1]).toBe('/api/v2/restaurants/milano-sf/reservations');
      expect(bookCall[2]).toMatchObject({ reservation_token: 't-7pm', party_size: 2 });
    });

    it('books the exact match if desired_time hits one', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [
            { token: 't-7pm', time: '19:00' },
            { token: 't-730', time: '19:30' },
          ],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-2',
          restaurant_name: 'Milano',
          time: '19:30',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        desired_time: '19:30',
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({ reservation_token: 't-730' });
    });

    it('falls back to first slot when desired_time is omitted', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [
            { token: 't-first', time: '17:00' },
            { token: 't-second', time: '19:00' },
          ],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-3',
          restaurant_name: 'Milano',
          time: '17:00',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({ reservation_token: 't-first' });
    });

    it('throws when no slots are available', async () => {
      mockRequest.mockResolvedValueOnce({ availability: [] });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/No available slots/i);
    });

    it('forwards special_requests in the book payload', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [{ token: 't', time: '19:00' }],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-4',
          restaurant_name: 'Milano',
          time: '19:00',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        special_requests: 'Window seat please',
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({
        special_requests: 'Window seat please',
      });
    });
  });
});
