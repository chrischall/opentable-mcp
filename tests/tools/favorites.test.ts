import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerFavoriteTools } from '../../src/tools/favorites.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('favorite tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerFavoriteTools(server, mockClient)
    );
  });

  it('list_favorites: GET /api/v2/users/me/favorites and passes through', async () => {
    mockRequest.mockResolvedValue({ favorites: [{ id: 'r1', name: 'Milano' }] });
    const result = await harness.callTool('opentable_list_favorites');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me/favorites');
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Milano');
  });

  it('add_favorite: POSTs restaurant_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_add_favorite', {
      restaurant_id: 'r1',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'POST',
      '/api/v2/users/me/favorites',
      { restaurant_id: 'r1' }
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ favorited: true, restaurant_id: 'r1' });
  });

  it('remove_favorite: DELETEs by restaurant_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_remove_favorite', {
      restaurant_id: 'r1',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'DELETE',
      '/api/v2/users/me/favorites/r1'
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ removed: true, restaurant_id: 'r1' });
  });
});
