#!/usr/bin/env tsx
// Spin up the fetchproxy WS bridge in isolation (no MCP server, no tools)
// so you can observe extension ⇆ server connectivity behavior.
// The fetchproxy server doesn't expose raw frames, but it logs lifecycle
// events you can watch via the connect/close behavior.
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

const port = Number(process.env.OT_WS_PORT ?? 37149);
const transport = new FetchproxyTransport({ port, version: '0.9.1' });

await transport.start();
console.log(`[serve-only] fetchproxy server listening on 127.0.0.1:${port}`);
console.log('[serve-only] waiting for extension connection… (Ctrl-C to stop)');

process.on('SIGINT', async () => {
  console.log('\n[serve-only] shutting down');
  await transport.close();
  process.exit(0);
});
