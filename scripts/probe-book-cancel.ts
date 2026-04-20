#!/usr/bin/env tsx
// Live probe: find_slots → book → cancel round-trip.
// **This makes a real reservation and immediately cancels it.**
// Pick a restaurant that's not going to care about a ~3-second booking.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RESTAURANT_ID = Number(process.env.OT_PROBE_RID ?? 1272781); // State of Confusion
const DINING_AREA_ID = Number(process.env.OT_PROBE_AREA ?? 48750); // Main Dining Room
const DATE = process.env.OT_PROBE_DATE ?? '2026-05-01';
const TIME = process.env.OT_PROBE_TIME ?? '19:00';

const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content[0] as { text: string }).text;
  return { isError: !!r.isError, text };
}

console.log(`── find_slots restaurant=${RESTAURANT_ID} date=${DATE} time=${TIME} ──`);
const slotsRaw = await call('opentable_find_slots', {
  restaurant_id: RESTAURANT_ID,
  date: DATE,
  time: TIME,
  party_size: 2,
});
if (slotsRaw.isError) {
  console.error('find_slots failed:', slotsRaw.text);
  process.exit(1);
}
const slots = JSON.parse(slotsRaw.text) as Array<{
  restaurant_id: number;
  reservation_token: string;
  slot_hash: string;
  date: string;
  time: string;
}>;
console.log(`  got ${slots.length} slots; first=${slots[0]?.time}`);
if (!slots[0]) {
  console.error('no slots available — pick a different day/time');
  process.exit(1);
}
const chosen = slots[0];

console.log(`── book slot ${chosen.date} ${chosen.time} ──`);
const bookResp = await call('opentable_book', {
  restaurant_id: chosen.restaurant_id,
  date: chosen.date,
  time: chosen.time,
  party_size: 2,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: DINING_AREA_ID,
});
if (bookResp.isError) {
  console.error('book failed:', bookResp.text);
  process.exit(1);
}
console.log(bookResp.text);
const booking = JSON.parse(bookResp.text) as {
  confirmation_number: number;
  security_token: string;
  restaurant_id: number;
};

console.log(`── cancel confirmation=${booking.confirmation_number} ──`);
const cancelResp = await call('opentable_cancel', {
  restaurant_id: booking.restaurant_id,
  confirmation_number: booking.confirmation_number,
  security_token: booking.security_token,
});
console.log(cancelResp.text);

await c.close();
