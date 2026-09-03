#!/usr/bin/env tsx
/**
 * Live check of the write path — WITHOUT booking.
 *
 * `opentable_book_preview` fetches /booking/details and slot-locks. The
 * slot-lock is the first write of every booking, and the one that 403s when
 * the fetchproxy relay tab carries no CSRF token (see WRITE_RELAY_TAB_PREFIXES
 * in src/transport-fetchproxy.ts). A preview makes NO reservation — the lock
 * expires on its own in ~90s.
 *
 * Usage:  npx tsx scripts/probe-slot-lock.ts [YYYY-MM-DD] [HH:MM]
 * Needs the fetchproxy extension installed and a signed-in restaurant page
 * (/r/…) open — that tab both warms RestaurantsAvailability for find_slots
 * and relays the slot-lock.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RESTAURANT_ID = 985138; // Sophia's Lounge at The Ivey's Hotel, Charlotte
const date = process.argv[2] ?? '2026-09-24';
const time = process.argv[3] ?? '19:00';

const text = (r: unknown): string =>
  ((r as { content?: { text?: string }[] }).content?.[0]?.text ?? '').toString();
const isErr = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const client = new Client({ name: 'probe-inpage', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

console.log(`find_slots ${date} ${time} party 2 …`);
const slots = await client.callTool({
  name: 'opentable_find_slots',
  arguments: { restaurant_id: RESTAURANT_ID, date, time, party_size: 2 },
});
if (isErr(slots)) {
  console.error('find_slots failed:', text(slots));
  process.exit(2);
}
const parsed = JSON.parse(text(slots)) as {
  time: string;
  slot_hash: string;
  reservation_token: string;
}[];
const slot = parsed.find((s) => s.time === time) ?? parsed[0];
if (!slot) {
  console.error('no slots returned; pick another date/time');
  process.exit(2);
}
console.log(`  → using ${slot.time} (slot_hash ${slot.slot_hash})`);

console.log('book_preview (this is the slot-lock mutation) …');
const preview = await client.callTool({
  name: 'opentable_book_preview',
  arguments: {
    restaurant_id: RESTAURANT_ID,
    date,
    time: slot.time,
    party_size: 2,
    reservation_token: slot.reservation_token,
    slot_hash: slot.slot_hash,
  },
});

const body = text(preview);
if (isErr(preview)) {
  console.error('\n❌ slot-lock FAILED');
  console.error(body.slice(0, 400));
  if (body.includes('403')) {
    console.error(
      '\n403 means the relay tab had no x-csrf-token to inject. Every prefix in WRITE_RELAY_TAB_PREFIXES ' +
        '(transport-fetchproxy.ts) matched no tab, or the matched tab predates the current ' +
        'extension build — open https://www.opentable.com/r/<any-restaurant> in a fresh tab and retry.',
    );
  }
  process.exit(1);
}

const preview_ = JSON.parse(body) as {
  booking_token?: string;
  credit_card_required?: boolean;
  cancellation_policy?: unknown;
};
console.log('\n✅ slot-lock SUCCEEDED (write path is good)');
console.log(`   booking_token: ${preview_.booking_token ? 'present' : 'MISSING'}`);
console.log(`   credit_card_required: ${String(preview_.credit_card_required)}`);
console.log('\nNo reservation was made; the lock expires on its own.');
await client.close();
