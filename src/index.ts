#!/usr/bin/env node
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

const server = new McpServer({ name: 'opentable-mcp', version: '0.3.0-alpha.2' });

registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);
registerSearchTools(server, client);
registerRestaurantTools(server, client);

console.error(
  '[opentable-mcp] v0.3.0-alpha.2 — WebSocket bridge to Chrome extension on 127.0.0.1:37149. ' +
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
