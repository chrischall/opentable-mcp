#!/usr/bin/env tsx
// One-off live probe targeting a UK restaurant — used to flush out the
// spurious-failure-after-success bug for international bookings. Tries
// to book the earliest available slot for $TONIGHT, then immediately
// cancels regardless of what our tool reports. Cleans up no matter
// what — even if our tool throws after a successful book, the cancel
// uses list_reservations to find the booking and cancel by confirmation
// number.
//
// ⚠️ Books a real reservation. Reads the FULL error/response from our
// tool so we can pin down what's different about the UK path.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_PROBE_UK_RID ?? 141537); // Grafton Arms
const AREA = Number(process.env.OT_PROBE_UK_AREA ?? 1);
const PARTY = Number(process.env.OT_PROBE_UK_PARTY ?? 2);
const today = new Date();
const DATE =
  process.env.OT_PROBE_UK_DATE ??
  `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const TIME = process.env.OT_PROBE_UK_TIME ?? '21:00';

const c = new Client({ name: 't', version: '0' });
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
}>;
if (!slots[0]) {
  console.error('no slots — try a different time tonight');
  process.exit(1);
}
const chosen = slots[0];
console.log(`  chose ${chosen.date} ${chosen.time} (${chosen.type ?? 'Standard'})`);

console.log(`── book ──`);
let confirmationFromBook: number | null = null;
try {
  const bookResp = await call('opentable_book', {
    restaurant_id: RID,
    date: chosen.date,
    time: chosen.time,
    party_size: PARTY,
    reservation_token: chosen.reservation_token,
    slot_hash: chosen.slot_hash,
    dining_area_id: AREA,
  });
  console.log(bookResp.isError ? `[ISERROR=true] ${bookResp.text}` : bookResp.text);
  if (!bookResp.isError) {
    const body = JSON.parse(bookResp.text) as { confirmation_number: number };
    confirmationFromBook = body.confirmation_number;
  }
} catch (e) {
  console.log(`[THREW] ${(e as Error).message}`);
}

console.log(`── list_reservations (find any orphan we might need to cancel) ──`);
const list = await call('opentable_list_reservations', { scope: 'upcoming' });
console.log(list.text);
const reservations = JSON.parse(list.text) as Array<{
  restaurant_id: number;
  confirmation_number: number;
  date: string;
  time: string;
  security_token: string;
}>;

// Find any reservation matching this date/time/restaurant — that's our
// probe booking, even if our tool reported failure.
const orphan = reservations.find(
  (r) => r.restaurant_id === RID && r.date === chosen.date && r.time === chosen.time
);

if (orphan) {
  console.log(`── cancel found reservation conf=${orphan.confirmation_number} ──`);
  const cancelResp = await call('opentable_cancel', {
    restaurant_id: orphan.restaurant_id,
    confirmation_number: orphan.confirmation_number,
    security_token: orphan.security_token,
  });
  console.log(cancelResp.isError ? `[ISERROR=true] ${cancelResp.text}` : cancelResp.text);
} else {
  console.log('no matching reservation found — book may have failed cleanly without persisting');
}

if (confirmationFromBook && !orphan) {
  console.log(`book reported success conf=${confirmationFromBook} but list didn't show it — confirmation number may be parsed differently`);
}

await c.close();
console.log('── done ──');
