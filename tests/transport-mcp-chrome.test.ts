import { describe, expect, it, vi } from 'vitest';
import {
  McpChromeTransport,
  type MinimalMcpClient,
} from '../src/transport-mcp-chrome.js';

type CallToolArgs = { name: string; arguments?: Record<string, unknown> };
type MockedClient = MinimalMcpClient & {
  readonly lastCall: CallToolArgs | null;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly callTool: ReturnType<typeof vi.fn>;
};

/** Build a mock that returns a fixed RPC payload. Captures the last
 *  callTool args via closure so tests can assert on them. */
function mockClient(rpc: unknown): MockedClient {
  let lastCall: CallToolArgs | null = null;
  const callTool = vi.fn(async (args: CallToolArgs) => {
    lastCall = args;
    return rpc;
  });
  const connect = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return {
    connect,
    close,
    callTool,
    get lastCall() {
      return lastCall;
    },
  };
}

/** Wrap the network-helper.js shape that mcp-chrome's network-request
 *  tool returns. The MCP-side `chrome_network_request` packages this
 *  inner JSON as the text of a `content[0]` entry. */
function rpcOk(inner: {
  status?: number;
  body?: string;
  url?: string;
  success?: boolean;
  error?: string;
}) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ success: true, ...inner }) }],
  };
}

describe('McpChromeTransport', () => {
  it('translates fetchHtml-style GET into chrome_network_request with tabUrl pinning', async () => {
    const client = mockClient(
      rpcOk({ status: 200, body: '<html>ok</html>', url: 'https://www.opentable.com/user/x' })
    );
    const t = new McpChromeTransport({ client });
    await t.start();

    const result = await t.fetch({ path: '/user/dining-dashboard', method: 'GET' });

    expect(result.status).toBe(200);
    expect(result.body).toBe('<html>ok</html>');
    expect(client.lastCall?.name).toBe('chrome_network_request');
    expect(client.lastCall?.arguments).toEqual({
      url: 'https://www.opentable.com/user/dining-dashboard',
      method: 'GET',
      tabUrl: 'https://www.opentable.com/',
      background: true,
    });
    // No body, no headers — should not appear in the call.
    expect(client.lastCall?.arguments).not.toHaveProperty('body');
    expect(client.lastCall?.arguments).not.toHaveProperty('headers');
  });

  it('passes through method, headers, and body for POSTs', async () => {
    const client = mockClient(rpcOk({ status: 200, body: '{"ok":true}', url: 'https://www.opentable.com/dapi' }));
    const t = new McpChromeTransport({ client });
    await t.start();

    await t.fetch({
      path: '/dapi/fe/gql?opname=X',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'tok' },
      body: '{"x":1}',
    });

    expect(client.lastCall?.arguments).toMatchObject({
      url: 'https://www.opentable.com/dapi/fe/gql?opname=X',
      method: 'POST',
      tabUrl: 'https://www.opentable.com/',
      background: true,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'tok' },
      body: '{"x":1}',
    });
  });

  it('respects an absolute URL in init.path (passes through unchanged)', async () => {
    const client = mockClient(rpcOk({ status: 200, body: 'ok', url: 'https://example.com/' }));
    const t = new McpChromeTransport({ client });
    await t.start();

    await t.fetch({ path: 'https://example.com/probe', method: 'GET' });

    expect(client.lastCall?.arguments?.url).toBe('https://example.com/probe');
  });

  it('honors a custom tabUrl', async () => {
    const client = mockClient(rpcOk({ status: 200, body: 'ok', url: 'https://x.test/' }));
    const t = new McpChromeTransport({ client, tabUrl: 'https://x.test/' });
    await t.start();

    await t.fetch({ path: '/foo', method: 'GET' });

    expect(client.lastCall?.arguments?.tabUrl).toBe('https://x.test/');
  });

  it('returns the parsed status/body/url for happy-path responses', async () => {
    const client = mockClient(
      rpcOk({ status: 204, body: '', url: 'https://www.opentable.com/dapi/wishlist/add' })
    );
    const t = new McpChromeTransport({ client });
    await t.start();

    const r = await t.fetch({ path: '/dapi/wishlist/add', method: 'POST', body: '{}' });

    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    expect(r.url).toBe('https://www.opentable.com/dapi/wishlist/add');
  });

  it('maps tool-level mcp-chrome errors (isError:true) to a 599 with the error text', async () => {
    const client = mockClient({
      isError: true,
      content: [{ type: 'text', text: 'No active tab found' }],
    });
    const t = new McpChromeTransport({ client });
    await t.start();

    const r = await t.fetch({ path: '/user/dining-dashboard', method: 'GET' });

    expect(r.status).toBe(599);
    expect(r.body).toContain('No active tab found');
    expect(r.body).toContain('chrome_network_request');
  });

  it('maps inner success:false from network-helper to 599 with the helper error message', async () => {
    const client = mockClient({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: 'Failed to fetch (CORS)' }),
        },
      ],
    });
    const t = new McpChromeTransport({ client });
    await t.start();

    const r = await t.fetch({ path: '/dapi/x', method: 'GET' });

    expect(r.status).toBe(599);
    expect(r.body).toBe('Failed to fetch (CORS)');
  });

  it('maps non-JSON tool output to 599 with a body preview', async () => {
    const client = mockClient({
      isError: false,
      content: [{ type: 'text', text: 'not json at all' }],
    });
    const t = new McpChromeTransport({ client });
    await t.start();

    const r = await t.fetch({ path: '/x', method: 'GET' });

    expect(r.status).toBe(599);
    expect(r.body).toContain('non-JSON');
    expect(r.body).toContain('not json at all');
  });

  it('connect/close are idempotent and only fire on the owned-client path', async () => {
    const client = mockClient(rpcOk({ status: 200, body: 'ok' }));
    const t = new McpChromeTransport({ client });

    await t.start();
    await t.start(); // second start is a no-op
    await t.close();
    await t.close(); // second close is a no-op

    // Mock client owned by the test — transport should NOT call connect/close on it.
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});
