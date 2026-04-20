import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerNotifyTools } from '../../src/tools/notify.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('notify tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerNotifyTools(server, mockClient)
    );
  });

  it('list_notify: GET /api/v2/users/me/notifications', async () => {
    mockRequest.mockResolvedValue({ notifications: [] });
    await harness.callTool('opentable_list_notify');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me/notifications');
  });

  it('add_notify: POSTs payload and returns identifier', async () => {
    mockRequest.mockResolvedValue({
      notify_id: 'n-1',
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
    });
    const result = await harness.callTool('opentable_add_notify', {
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
      time_window: '19:00-21:00',
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/api/v2/notifications', {
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
      time_window: '19:00-21:00',
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.notify_id).toBe('n-1');
  });

  it('remove_notify: DELETEs by notify_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_remove_notify', {
      notify_id: 'n-1',
    });
    expect(mockRequest).toHaveBeenCalledWith('DELETE', '/api/v2/notifications/n-1');
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ removed: true, notify_id: 'n-1' });
  });
});
