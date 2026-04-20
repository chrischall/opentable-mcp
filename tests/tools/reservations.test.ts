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
});
