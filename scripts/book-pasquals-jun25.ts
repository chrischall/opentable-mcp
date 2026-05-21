#!/usr/bin/env tsx
// One-shot: book dinner for 5 at Cafe Pasqual's, 2026-06-25 18:00.
// Walks find_slots → book_preview → book. Does NOT cancel.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = 278896;
const DINING_AREA_ID = 21881; // Community Table
const EXPERIENCE_ID = 514735; // Community Table Dining
const DATE = '2026-06-25';
const TIME = '18:00';
const PARTY = 5;

const c = new Client({ name: 'book-pasquals', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content[0] as { text: string }).text;
  return { isError: !!r.isError, text };
}

console.log(`── find_slots rid=${RID} ${DATE} ${TIME} party=${PARTY} ──`);
const slotsRaw = await call('opentable_find_slots', {
  restaurant_id: RID,
  date: DATE,
  time: TIME,
  party_size: PARTY,
});
if (slotsRaw.isError) {
  console.error('find_slots failed:', slotsRaw.text);
  process.exit(1);
}
const slots = JSON.parse(slotsRaw.text) as Array<{
  reservation_token: string;
  slot_hash: string;
  date: string;
  time: string;
  type?: string;
  experience_ids?: number[];
  booking_type?: string;
}>;

// Want the exact 18:00 slot, not whatever else find_slots returned
const chosen = slots.find((s) => s.date === DATE && s.time === TIME);
if (!chosen) {
  console.error(`no exact slot for ${DATE} ${TIME} — got:`, slots.map((s) => `${s.date} ${s.time}`));
  process.exit(1);
}
console.log(
  `  chose ${chosen.date} ${chosen.time} (${chosen.type}, ${chosen.booking_type})`
);

console.log(`── book_preview ──`);
const previewResp = await call('opentable_book_preview', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: PARTY,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: DINING_AREA_ID,
  experience_id: EXPERIENCE_ID,
});
if (previewResp.isError) {
  console.error('book_preview failed:', previewResp.text);
  process.exit(1);
}
const preview = JSON.parse(previewResp.text);
console.log(JSON.stringify(preview, null, 2));

console.log(`── book ──`);
const bookResp = await call('opentable_book', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: PARTY,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: DINING_AREA_ID,
  booking_token: preview.booking_token,
  experience_id: EXPERIENCE_ID,
});
console.log(bookResp.isError ? `[ISERROR=true] ${bookResp.text}` : bookResp.text);

await c.close();
console.log('── done ──');
