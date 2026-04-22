#!/usr/bin/env node
// opentable-mcp entrypoint.
//
// Boot sequence:
//   1. OpenTableClient.start() — opens the WebSocket listener on
//      127.0.0.1:37149. The companion Chrome extension connects here.
//   2. Register tool handlers against the MCP server.
//   3. Connect the MCP server to stdio for the host client.
//
// The WS listener outlives the MCP session. On SIGINT/SIGTERM we close
// it so ports don't leak between client restarts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';
import { registerSearchTools } from './tools/search.js';
import { registerRestaurantTools } from './tools/restaurants.js';

const client = new OpenTableClient();
await client.start();

const server = new McpServer({ name: 'opentable-mcp', version: '0.7.0' });

registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);
registerSearchTools(server, client);
registerRestaurantTools(server, client);

console.error(
  '[opentable-mcp] v0.7.0 — WebSocket bridge to Chrome extension on 127.0.0.1:37149. ' +
    'Load the extension from ./extension/ and sign in at opentable.com.'
);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
