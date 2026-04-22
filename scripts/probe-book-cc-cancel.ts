#!/usr/bin/env tsx
// Live probe: CC-required find_slots → book_preview → book → cancel.
//
// ⚠️ RISK ⚠️
// This makes a REAL CC-guarantee reservation and immediately cancels it.
// If the cancel step fails or is skipped, you are on the hook for whatever
// no-show fee the cancellation policy specifies. Read the probe output
// carefully — if anything looks wrong, cancel manually at opentable.com.
//
// Inputs (all via env):
//   OT_PROBE_CC_RID     — restaurant id known to require a CC guarantee
//   OT_PROBE_CC_AREA    — dining area id from opentable_get_restaurant
//   OT_PROBE_CC_DATE    — YYYY-MM-DD, prime-time booking where the
//                         guarantee is actually in force
//   OT_PROBE_CC_TIME    — HH:MM, same
//   OT_PROBE_CC_PARTY   — optional, default 2
//
// Exits non-zero if the slot turns out NOT to require a CC — we'd
// rather halt than silently exercise the non-guarantee path.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_PROBE_CC_RID ?? '');
const AREA = Number(process.env.OT_PROBE_CC_AREA ?? '');
const DATE = process.env.OT_PROBE_CC_DATE ?? '';
const TIME = process.env.OT_PROBE_CC_TIME ?? '';
const PARTY = Number(process.env.OT_PROBE_CC_PARTY ?? 2);

if (!RID || !AREA || !DATE || !TIME) {
  console.error(
    'Set OT_PROBE_CC_RID, OT_PROBE_CC_AREA, OT_PROBE_CC_DATE (YYYY-MM-DD), OT_PROBE_CC_TIME (HH:MM).\n' +
      '(OT_PROBE_CC_PARTY optional, default 2.)'
  );
  process.exit(2);
}

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
}>;
if (!slots[0]) {
  console.error('no slots');
  process.exit(1);
}
const chosen = slots[0];
console.log(`  chose ${chosen.date} ${chosen.time}`);

console.log(`── book_preview ──`);
const preview = await call('opentable_book_preview', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: PARTY,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: AREA,
});
if (preview.isError) {
  console.error('book_preview failed:', preview.text);
  process.exit(1);
}
const previewBody = JSON.parse(preview.text) as {
  booking_token: string;
  cancellation_policy: { type: string; description: string; amount_usd: number | null };
  payment_method: { brand: string; last4: string } | null;
  cc_required: boolean;
};
console.log(
  `  policy=${previewBody.cancellation_policy.type} amount=$${previewBody.cancellation_policy.amount_usd ?? '?'} card=${previewBody.payment_method?.brand ?? 'none'} ${previewBody.payment_method?.last4 ?? ''}`
);
if (!previewBody.cc_required) {
  console.error(
    'ABORT: chosen slot is not CC-required. Pick a higher-demand time/day or a different restaurant.'
  );
  process.exit(3);
}

console.log(`── book (commits a real reservation) ──`);
const bookResp = await call('opentable_book', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: PARTY,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: AREA,
  booking_token: previewBody.booking_token,
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
  cc_required: boolean;
};

console.log(`── cancel ${booking.confirmation_number} ──`);
const cancelResp = await call('opentable_cancel', {
  restaurant_id: booking.restaurant_id,
  confirmation_number: booking.confirmation_number,
  security_token: booking.security_token,
});
console.log(cancelResp.text);
const cancel = JSON.parse(cancelResp.text) as { cancelled: boolean };
if (!cancel.cancelled) {
  console.error('‼️ CANCEL FAILED — go cancel at opentable.com NOW');
  process.exit(1);
}

await c.close();
console.log('✅ CC-required round-trip clean');
