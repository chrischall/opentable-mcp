#!/usr/bin/env tsx
// Quick check: list upcoming reservations. Use this to spot any
// dangling reservations left over from probe runs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

const r = await c.callTool({
  name: 'opentable_list_reservations',
  arguments: { scope: 'upcoming' },
});
const text = (r.content[0] as { text: string }).text;
console.log(text);

await c.close();
