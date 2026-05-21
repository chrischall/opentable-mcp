#!/usr/bin/env tsx
// Live probe for Experience-mandatory bookings. Mirrors probe-book-cancel-uk.ts
// but targets an Experience slot and routes through book_preview (required for
// Experience-mandatory restaurants) before calling book.
//
// **This makes a real reservation and immediately cancels it.**
// Target: Cafe Pasqual's Community Table Dining (Experience ID 514735).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_PROBE_EXP_RID ?? 278896); // Cafe Pasquals
const DINING_AREA_ID = Number(process.env.OT_PROBE_EXP_AREA ?? 21881); // Main Dining
const EXPERIENCE_ID = Number(process.env.OT_PROBE_EXP_EXP ?? 514735); // Community Table Dining
const PARTY = Number(process.env.OT_PROBE_EXP_PARTY ?? 2);

// 14 days from now at 18:00 PT
const today = new Date();
const twoWeeksOut = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
const DATE =
  process.env.OT_PROBE_EXP_DATE ??
  `${twoWeeksOut.getFullYear()}-${String(twoWeeksOut.getMonth() + 1).padStart(2, '0')}-${String(twoWeeksOut.getDate()).padStart(2, '0')}`;
const TIME = process.env.OT_PROBE_EXP_TIME ?? '18:00';

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
  experience_ids?: number[];
}>;
if (!slots[0]) {
  console.error('no slots — try a different date/time');
  process.exit(1);
}
const chosen = slots[0];
console.log(
  `  chose ${chosen.date} ${chosen.time} (${chosen.type ?? 'Standard'}), experiences: ${chosen.experience_ids?.join(',') ?? 'none'}`
);

console.log(`── book_preview (required for Experience-mandatory) ──`);
let bookingToken: string | null = null;
let previewBookingType: string | null = null;
let experienceName: string | null = null;
try {
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
    console.error(`[ISERROR=true] ${previewResp.text}`);
  } else {
    const preview = JSON.parse(previewResp.text) as {
      booking_token: string;
      booking_type: string;
      experience?: { name: string };
    };
    bookingToken = preview.booking_token;
    previewBookingType = preview.booking_type;
    experienceName = preview.experience?.name ?? null;
    console.log(`  booking_type=${preview.booking_type}, experience=${experienceName}`);
  }
} catch (e) {
  console.log(`[THREW] ${(e as Error).message}`);
}

if (!bookingToken) {
  console.error('book_preview did not produce a booking_token — cannot proceed');
  process.exit(1);
}

console.log(`── book with booking_token ──`);
let confirmationFromBook: number | null = null;
try {
  const bookResp = await call('opentable_book', {
    restaurant_id: RID,
    date: chosen.date,
    time: chosen.time,
    party_size: PARTY,
    reservation_token: chosen.reservation_token,
    slot_hash: chosen.slot_hash,
    dining_area_id: DINING_AREA_ID,
    booking_token: bookingToken,
    experience_ids: [EXPERIENCE_ID],
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
  console.log(
    `book reported success conf=${confirmationFromBook} but list didn't show it — confirmation number may be parsed differently`
  );
}

await c.close();
console.log('── done ──');
