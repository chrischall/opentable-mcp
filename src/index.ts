#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';

const client = new OpenTableClient();
const server = new McpServer({ name: 'opentable-mcp', version: '0.2.0-alpha.1' });

registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);

console.error(
  '[opentable-mcp] v0.2.0-alpha.1 — Next.js SSR architecture. ' +
    'Requires session cookies exported from a real browser; see README. ' +
    'Developed and maintained by AI (Claude Opus 4.7). Use at your own discretion.'
);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
