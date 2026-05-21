#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));
for (const date of ['2026-06-04', '2026-06-05', '2026-06-10', '2026-06-15', '2026-06-20']) {
  const r = await c.callTool({
    name: 'opentable_find_slots',
    arguments: { restaurant_id: 278896, date, time: '18:00', party_size: 2 },
  });
  const slots = JSON.parse((r.content[0] as { text: string }).text) as Array<{ time: string; experience_ids?: number[] }>;
  const bookable = slots.filter((s) => s.experience_ids?.includes(514735));
  console.log(`  ${date}: bookable@CommunityTable = ${bookable.map((s) => s.time).join(', ') || '(none)'}`);
}
await c.close();
