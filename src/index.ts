#!/usr/bin/env node
// opentable-mcp entrypoint.
//
// Boot sequence:
//   1. Pick a transport based on $OT_BRIDGE (default: 'websocket').
//      - websocket: open the embedded WebSocket listener on 127.0.0.1:37149.
//        The companion Chrome extension under ./extension/ connects here.
//      - mcp-chrome: open an MCP-over-HTTP connection to hangwin/mcp-chrome
//        at http://127.0.0.1:12306/mcp. Requires mcp-chrome's
//        `chrome_network_request` tool to support tabUrl pinning (PR
//        hangwin/mcp-chrome#348). Pre-PR versions are active-tab-only and
//        will misbehave for cross-origin fetches.
//   2. OpenTableClient.start() — brings the chosen transport up.
//   3. Register tool handlers against the MCP server.
//   4. Connect the MCP server to stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM we close it
// so ports/connections don't leak between client restarts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { McpChromeTransport } from './transport-mcp-chrome.js';
import { OpenTableWsServer } from './ws-server.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';
import { registerSearchTools } from './tools/search.js';
import { registerRestaurantTools } from './tools/restaurants.js';

type BridgeKind = 'websocket' | 'mcp-chrome';

const bridgeKindRaw = (process.env.OT_BRIDGE ?? 'websocket').toLowerCase();
const bridgeKind: BridgeKind =
  bridgeKindRaw === 'mcp-chrome' ? 'mcp-chrome' : 'websocket';

const transport =
  bridgeKind === 'mcp-chrome'
    ? new McpChromeTransport({ url: process.env.OT_MCP_CHROME_URL })
    : new OpenTableWsServer({ port: process.env.OT_WS_PORT ? Number(process.env.OT_WS_PORT) : undefined });

const client = new OpenTableClient({ transport });
await client.start();

const server = new McpServer({ name: 'opentable-mcp', version: '0.9.1' });

registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);
registerSearchTools(server, client);
registerRestaurantTools(server, client);

if (bridgeKind === 'mcp-chrome') {
  console.error(
    '[opentable-mcp] v0.9.0 — bridging via hangwin/mcp-chrome at ' +
      (process.env.OT_MCP_CHROME_URL ?? 'http://127.0.0.1:12306/mcp') +
      '. Requires mcp-chrome ≥ the release containing PR #348 (tabUrl support).'
  );
} else {
  console.error(
    '[opentable-mcp] v0.9.0 — WebSocket bridge to Chrome extension on 127.0.0.1:37149. ' +
      'Load the extension from ./extension/ and sign in at opentable.com. ' +
      '(To use hangwin/mcp-chrome as the bridge instead, set OT_BRIDGE=mcp-chrome.)'
  );
}

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const stdio = new StdioServerTransport();
await server.connect(stdio);
