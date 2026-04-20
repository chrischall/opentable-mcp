import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { OpenTableWsServer } from '../src/ws-server.js';

let server: OpenTableWsServer;
const PORT = 37190 + Math.floor(Math.random() * 500);

beforeEach(() => {
  server = new OpenTableWsServer({ port: PORT });
});
afterEach(async () => {
  await server.close();
});

async function openClient(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  return ws;
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(String(raw))))
  );
}

describe('OpenTableWsServer', () => {
  it('starts listening after start()', async () => {
    await server.start();
    const ws = await openClient();
    ws.close();
  });

  it('accepts a hello + ready handshake, then serves a request', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 42, url: 'https://www.opentable.com/' }));

    // Kick off a fetch from server side
    const pending = server.fetch({ path: '/foo', method: 'GET' });
    const req = (await nextMessage(ws)) as {
      type: string;
      id: number;
      op: string;
      init: { path: string; method: string };
    };
    expect(req.type).toBe('request');
    expect(req.op).toBe('fetch');
    expect(req.init.path).toBe('/foo');

    ws.send(
      JSON.stringify({
        type: 'response',
        id: req.id,
        ok: true,
        status: 200,
        body: '<html>ok</html>',
        url: 'https://www.opentable.com/foo',
      })
    );

    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body).toBe('<html>ok</html>');
  });

  it('rejects a fetch() when no extension is connected', async () => {
    await server.start();
    // No client. Expect queue timeout to kick in.
    server.setConnectTimeoutMs(50);
    await expect(server.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /extension offline/i
    );
  });

  it('times out per-request when the extension does not reply', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
    server.setRequestTimeoutMs(100);
    await expect(server.fetch({ path: '/slow', method: 'GET' })).rejects.toThrow(
      /timed out/i
    );
  });

  it('keeps the first connection and closes a second one', async () => {
    await server.start();
    const first = await openClient();
    first.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    first.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));

    const second = await openClient();
    await new Promise<void>((r) => second.once('close', () => r()));
    // first still usable
    expect(first.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects pending requests when the extension disconnects', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
    const pending = server.fetch({ path: '/x', method: 'GET' });
    ws.close();
    await expect(pending).rejects.toThrow(/disconnect/i);
  });
});
