#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));
const r = await c.callTool({ name: 'opentable_list_reservations', arguments: { scope: 'upcoming' } });
const items = JSON.parse((r.content[0] as { text: string }).text) as Array<{
  restaurant_id: number; confirmation_number: number; security_token: string;
  date: string; time: string;
}>;
console.log('upcoming:', items.map((i) => `${i.confirmation_number} ${i.date} ${i.time}`));
// Cancel all probe orphans at Pasqual's on June 4 (probe target)
for (const r of items) {
  if (r.restaurant_id === 278896 && r.date === '2026-06-04') {
    console.log(`canceling ${r.confirmation_number}`);
    const c2 = await c.callTool({ name: 'opentable_cancel', arguments: {
      restaurant_id: r.restaurant_id, confirmation_number: r.confirmation_number, security_token: r.security_token,
    }});
    console.log((c2.content[0] as { text: string }).text);
  }
}
await c.close();
