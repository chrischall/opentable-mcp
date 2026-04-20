#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerRestaurantTools } from './tools/restaurants.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerFavoriteTools } from './tools/favorites.js';
import { registerNotifyTools } from './tools/notify.js';

const client = new OpenTableClient();
const server = new McpServer({ name: 'opentable-mcp', version: '0.1.0' });

registerUserTools(server, client);
registerRestaurantTools(server, client);
registerReservationTools(server, client);
registerFavoriteTools(server, client);
registerNotifyTools(server, client);

console.error(
  '[opentable-mcp] This project was developed and is maintained by AI (Claude Opus 4.7). Use at your own discretion.'
);

const transport = new StdioServerTransport();
await server.connect(transport);
