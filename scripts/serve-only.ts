#!/usr/bin/env tsx
// Raw WS listener on 37149 that logs every frame from the extension.
// Used to debug extension ⇆ server connectivity without an MCP client.
import { WebSocketServer } from 'ws';

const port = Number(process.env.OT_WS_PORT ?? 37149);
const wss = new WebSocketServer({ host: '127.0.0.1', port });

wss.on('listening', () => {
  console.log(`[serve-only] listening on 127.0.0.1:${port}`);
  console.log('[serve-only] waiting for extension connection…');
});

wss.on('connection', (ws, req) => {
  console.log(`[serve-only] connection from ${req.socket.remoteAddress}`);
  ws.on('message', (raw) => {
    const s = String(raw);
    const head = s.length > 200 ? s.slice(0, 200) + '…' : s;
    console.log(`[serve-only] ← ${head}`);
  });
  ws.on('close', (code, reason) => {
    console.log(`[serve-only] close code=${code} reason=${String(reason)}`);
  });
  ws.on('error', (e) => {
    console.log(`[serve-only] error ${e.message}`);
  });
});

process.on('SIGINT', () => {
  console.log('\n[serve-only] shutting down');
  wss.close();
  process.exit(0);
});
