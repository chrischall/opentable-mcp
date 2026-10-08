import { describe, it, expect } from 'vitest';
import { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport } from '../src/transport.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { createTestHarness } from './helpers.js';

describe('healthcheck capability scope', () => {
  it.each(['User-agent: *\nDisallow: /user/', '<!doctype html><html>Human verification</html>'])('does not infer business capability success from %s', async body => {
    const bridge = { role: 'host', port: 37149, extension_connected: true };
    const transport = {
      start: async () => {}, close: async () => {},
      fetch: async () => ({ status: 200, body, url: 'https://www.opentable.com/robots.txt' }),
      graphqlQuery: async () => { throw new Error('Response not successful: Received status code 409'); },
      bridgeStatus: () => bridge,
      runProbe: async (fetchFn: (path: string) => Promise<unknown>, path: string) => {
        try { await fetchFn(path); return { ok: true, elapsed_ms: 1, bridge }; }
        catch (error) { return { ok: false, elapsed_ms: 1, bridge, error: { kind: 'other', message: String(error) } }; }
      },
    } as unknown as OpenTableTransport;
    const client = new OpenTableClient({ transport });
    await expect(client.graphqlQuery('availability', {})).rejects.toThrow('409');
    const harness = await createTestHarness(server => registerHealthcheckTools(server, client, transport));
    try {
      const reply = await harness.callTool('opentable_healthcheck', {});
      const result = JSON.parse((reply.content[0] as { text: string }).text);
      expect(result.ok).toBe(!body.startsWith('<'));
      expect(result.scope).toBe('bridge_transport_only');
      expect(result.capabilities.availability).toMatchObject({ state: 'failed', code: 'http_409' });
      expect(result.capabilities.menus.state).toBe('not_probed');
      expect(result.capabilities.booking.state).toBe('not_probed');
    } finally { await harness.close(); }
  });
});
