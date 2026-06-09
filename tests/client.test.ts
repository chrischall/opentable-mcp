// OpenTableClient unit tests — exercise the client's error mapping
// (non-2xx, sign-in interstitial, empty 204) against a stub transport.
// The WS layer itself now lives in @fetchproxy/server; its protocol is
// tested upstream in the fetchproxy repo.
import { describe, it, expect, vi } from 'vitest';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';
import { OpenTableClient, HttpError } from '../src/client.js';
import type { FetchInit, FetchResult, OpenTableTransport } from '../src/transport.js';

function stubTransport(handler: (init: FetchInit) => Promise<FetchResult>): OpenTableTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
  };
}

describe('OpenTableClient', () => {
  it('fetchHtml returns the body when the transport replies 200', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>dashboard</html>',
        url: 'https://www.opentable.com/user/dining-dashboard',
      })),
    });
    const html = await client.fetchHtml('/user/dining-dashboard');
    expect(html).toBe('<html>dashboard</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError when the response is the sign-in page', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 200,
        body:
          '<html><body><form action="/authenticate/start">' +
          '<button>Sign in</button></form></body></html>',
        url: 'https://www.opentable.com/authenticate/start',
      })),
    });
    await expect(client.fetchHtml('/user/dining-dashboard')).rejects.toThrow(/sign in/i);
  });

  it('sign-in error is the canonical @chrischall/mcp-utils SessionNotAuthenticatedError', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 200,
        body:
          '<html><body><form action="/authenticate/start">' +
          '<button>Sign in</button></form></body></html>',
        url: 'https://www.opentable.com/authenticate/start',
      })),
    });
    const rejection = expect(client.fetchHtml('/user/dining-dashboard')).rejects;
    await rejection.toBeInstanceOf(SessionNotAuthenticatedError);
    // Canonical message: names the service and points at opentable.com.
    await expect(client.fetchHtml('/user/dining-dashboard')).rejects.toThrow(
      /Not signed in to OpenTable\. Open opentable\.com in your browser/
    );
  });

  it('fetchHtml throws for non-2xx status', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 500,
        body: 'oops',
        url: 'https://www.opentable.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchHtml throws an HttpError carrying the status code', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 404,
        body: '<html>not found</html>',
        url: 'https://www.opentable.com/r/missing',
      })),
    });
    await expect(client.fetchHtml('/r/missing')).rejects.toMatchObject({
      name: 'HttpError',
      status: 404,
    });
    await expect(client.fetchHtml('/r/missing')).rejects.toBeInstanceOf(HttpError);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async (init) => {
        expect(init.method).toBe('POST');
        expect(init.headers?.['Content-Type']).toBe('application/json');
        const body = JSON.parse(String(init.body));
        return {
          status: 200,
          body: JSON.stringify({ echoed: body }),
          url: 'https://www.opentable.com/thing',
        };
      }),
    });
    const result = await client.fetchJson<{ echoed: { n: number } }>(
      '/thing',
      { method: 'POST', body: { n: 42 } }
    );
    expect(result.echoed.n).toBe(42);
  });

  it('fetchJson throws if the reply is not valid JSON', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: 'not-json',
        url: 'https://www.opentable.com/thing',
      })),
    });
    await expect(
      client.fetchJson('/thing', { method: 'POST', body: {} })
    ).rejects.toThrow(/json/i);
  });

  it('fetchJson returns null for 204 No Content', async () => {
    const client = new OpenTableClient({
      transport: stubTransport(async () => ({
        status: 204,
        body: '',
        url: 'https://www.opentable.com/thing',
      })),
    });
    const result = await client.fetchJson('/thing', { method: 'POST', body: {} });
    expect(result).toBeNull();
  });
});
