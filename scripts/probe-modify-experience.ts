#!/usr/bin/env tsx
// Live probe for modify. Books → modifies (moves time) → cancels.
// All actions on real OpenTable; the modify probe is the truth-check
// the unit tests can't be.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_MODIFY_RID ?? 278896);
const DINING_AREA_ID = Number(process.env.OT_MODIFY_AREA ?? 21881);
const EXPERIENCE_ID = Number(process.env.OT_MODIFY_EXP ?? 514735);
const PARTY = Number(process.env.OT_MODIFY_PARTY ?? 2);

const today = new Date();
const twoWeeksOut = new Date(today.getTime() + 14 * 86400_000);
const DATE =
  process.env.OT_MODIFY_DATE ??
  `${twoWeeksOut.getFullYear()}-${String(twoWeeksOut.getMonth() + 1).padStart(2, '0')}-${String(twoWeeksOut.getDate()).padStart(2, '0')}`;
const ORIG_TIME = process.env.OT_MODIFY_TIME ?? '18:00';
const NEW_TIME = process.env.OT_MODIFY_NEW_TIME ?? '19:15';

const c = new Client({ name: 'probe-modify', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: (r.content[0] as { text: string }).text };
}

async function findSlot(time: string) {
  const r = await call('opentable_find_slots', {
    restaurant_id: RID,
    date: DATE,
    time,
    party_size: PARTY,
  });
  if (r.isError) {
    console.error(`find_slots(${time}) failed:`, r.text);
    process.exit(1);
  }
  const slots = JSON.parse(r.text) as Array<{
    reservation_token: string;
    slot_hash: string;
    time: string;
    experience_ids?: number[];
  }>;
  const exact = slots.find((s) => s.time === time);
  if (!exact) {
    console.error(
      `no slot at ${time} — got ${slots.map((s) => s.time).join(',')}`
    );
    process.exit(1);
  }
  return exact;
}

console.log(`── 1) book at ${DATE} ${ORIG_TIME} ──`);
const origSlot = await findSlot(ORIG_TIME);
const previewResp = await call('opentable_book_preview', {
  restaurant_id: RID,
  date: DATE,
  time: ORIG_TIME,
  party_size: PARTY,
  reservation_token: origSlot.reservation_token,
  slot_hash: origSlot.slot_hash,
  dining_area_id: DINING_AREA_ID,
  experience_id: EXPERIENCE_ID,
});
if (previewResp.isError) {
  console.error('book_preview failed:', previewResp.text);
  process.exit(1);
}
const bookPreview = JSON.parse(previewResp.text);
const bookResp = await call('opentable_book', {
  restaurant_id: RID,
  date: DATE,
  time: ORIG_TIME,
  party_size: PARTY,
  reservation_token: origSlot.reservation_token,
  slot_hash: origSlot.slot_hash,
  dining_area_id: DINING_AREA_ID,
  booking_token: bookPreview.booking_token,
  experience_id: EXPERIENCE_ID,
});
if (bookResp.isError) {
  console.error('book failed:', bookResp.text);
  process.exit(1);
}
const booked = JSON.parse(bookResp.text);
console.log(
  `booked conf=${booked.confirmation_number} security=${booked.security_token}`
);

console.log(`── 2) modify to ${NEW_TIME} ──`);
const newSlot = await findSlot(NEW_TIME);
const modifyPreviewResp = await call('opentable_modify_preview', {
  restaurant_id: RID,
  confirmation_number: booked.confirmation_number,
  security_token: booked.security_token,
  date: DATE,
  time: NEW_TIME,
  party_size: PARTY,
  reservation_token: newSlot.reservation_token,
  slot_hash: newSlot.slot_hash,
  dining_area_id: DINING_AREA_ID,
  experience_id: EXPERIENCE_ID,
});
let modified: { confirmation_number?: number; security_token?: string } = booked;
if (modifyPreviewResp.isError) {
  console.error('modify_preview failed:', modifyPreviewResp.text);
  // fall through to cancel
} else {
  const modifyPreview = JSON.parse(modifyPreviewResp.text);
  console.log(`modify preview ok; new policy: ${modifyPreview.cancellation_policy?.type}`);
  const modifyResp = await call('opentable_modify', {
    restaurant_id: RID,
    confirmation_number: booked.confirmation_number,
    security_token: booked.security_token,
    date: DATE,
    time: NEW_TIME,
    party_size: PARTY,
    reservation_token: newSlot.reservation_token,
    slot_hash: newSlot.slot_hash,
    dining_area_id: DINING_AREA_ID,
    modify_token: modifyPreview.modify_token,
    experience_id: EXPERIENCE_ID,
  });
  console.log(modifyResp.isError ? `[ISERROR=true] ${modifyResp.text}` : modifyResp.text);
  if (!modifyResp.isError) modified = JSON.parse(modifyResp.text);
}

console.log(`── 3) verify via list_reservations ──`);
const list = await call('opentable_list_reservations', { scope: 'upcoming' });
const reservations = JSON.parse(list.text) as Array<{
  confirmation_number: number;
  date: string;
  time: string;
  security_token: string;
  restaurant_id: number;
}>;
const found = reservations.find(
  (r) => r.confirmation_number === booked.confirmation_number
);
if (found) console.log(`  found conf=${found.confirmation_number} at ${found.date} ${found.time}`);
else console.log('  reservation not visible in upcoming list');

console.log(`── 4) cancel ──`);
const cancelResp = await call('opentable_cancel', {
  restaurant_id: RID,
  confirmation_number: modified.confirmation_number ?? booked.confirmation_number,
  security_token: modified.security_token ?? booked.security_token,
});
console.log(cancelResp.isError ? `[ISERROR=true] ${cancelResp.text}` : cancelResp.text);

await c.close();
console.log('── done ──');
