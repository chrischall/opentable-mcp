import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('user tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerUserTools(server, mockClient));
  });

  describe('opentable_get_profile', () => {
    it('calls GET /api/v2/users/me and returns a sanitised profile', async () => {
      mockRequest.mockResolvedValue({
        first_name: 'Chris',
        last_name: 'Chall',
        email: 'chris@example.com',
        phone: '+15551234567',
        loyalty: { tier: 'Gold', points: 1234 },
        member_since: '2020-01-15',
        payment_methods: [{ id: 99, brand: 'visa' }], // should be stripped
      });

      const result = await harness.callTool('opentable_get_profile');

      expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me');
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"first_name": "Chris"');
      expect(text).toContain('"email": "chris@example.com"');
      expect(text).toContain('"phone": "+15551234567"');
      expect(text).toContain('"loyalty_tier": "Gold"');
      expect(text).toContain('"points_balance": 1234');
      expect(text).not.toContain('payment_methods');
    });
  });
});
