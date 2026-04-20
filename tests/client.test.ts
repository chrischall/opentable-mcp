import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { OpenTableClient } from '../src/client.js';

const PORT = 37300 + Math.floor(Math.random() * 500);

let client: OpenTableClient;
let ws: WebSocket | null = null;

beforeEach(async () => {
  client = new OpenTableClient({ port: PORT });
  await client.start();
});
afterEach(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  await client.close();
});

async function connectFakeExtension(): Promise<WebSocket> {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((r, j) => {
    sock.once('open', () => r());
    sock.once('error', j);
  });
  sock.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
  sock.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
  return sock;
}

describe('OpenTableClient', () => {
  it('fetchHtml returns the body when the extension replies 200', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: '<html>dashboard</html>',
            url: 'https://www.opentable.com/user/dining-dashboard',
          })
        );
      }
    });

    const html = await client.fetchHtml('/user/dining-dashboard');
    expect(html).toBe('<html>dashboard</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError if the response looks like a sign-in page', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body:
              '<html><body><form action="/authenticate/start">' +
              '<button>Sign in</button></form></body></html>',
            url: 'https://www.opentable.com/authenticate/start',
          })
        );
      }
    });
    await expect(client.fetchHtml('/user/dining-dashboard')).rejects.toThrow(
      /sign in/i
    );
  });

  it('fetchHtml throws for non-2xx status', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 500,
            body: 'oops',
            url: 'https://www.opentable.com/x',
          })
        );
      }
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        const body = JSON.parse(f.init.body);
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: JSON.stringify({ echoed: body }),
            url: 'https://www.opentable.com/thing',
          })
        );
      }
    });
    const result = await client.fetchJson<{ echoed: { n: number } }>(
      '/thing',
      { method: 'POST', body: { n: 42 } }
    );
    expect(result.echoed.n).toBe(42);
  });

  it('fetchJson throws if the reply is not valid JSON', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: 'not-json',
            url: 'https://www.opentable.com/thing',
          })
        );
      }
    });
    await expect(
      client.fetchJson('/thing', { method: 'POST', body: {} })
    ).rejects.toThrow(/json/i);
  });
});
