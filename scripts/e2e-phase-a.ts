#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 't', version: '0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/bundle.js'],
});
await client.connect(transport);

for (const name of ['opentable_list_reservations', 'opentable_get_profile', 'opentable_list_favorites']) {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content[0] as { text: string }).text;
  const parsed = JSON.parse(text);
  const summary = Array.isArray(parsed) ? `${parsed.length} entries` : Object.keys(parsed).join(',');
  console.log(`${name}: ${summary}`);
}
await client.close();
