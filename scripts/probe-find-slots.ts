#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 't', version: '0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] })
);
const r = await client.callTool({
  name: 'opentable_find_slots',
  arguments: { restaurant_id: 54232, date: '2026-05-01', time: '19:00', party_size: 2 },
});
const text = (r.content[0] as { text: string }).text;
console.log('first 600 chars:');
console.log(text.slice(0, 600));
console.log('---');
try {
  const parsed = JSON.parse(text);
  console.log(
    `${parsed.length} slots; first=${JSON.stringify(parsed[0] ?? null)?.slice(0, 200)}`
  );
} catch {
  // already printed
}
await client.close();
