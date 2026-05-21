// Usage:
//   npm run build && npx tsx scripts/probe-experience-slot-lock-hash.ts
//
// Drives Pasqual's (rid 278896) Experience-mandatory booking flow up to
// the slot-lock step and dumps the SlotLock GraphQL POST body so we can
// pin `BookDetailsExperienceSlotLock`'s persisted-query sha256Hash.
//
// Prereqs: fetchproxy extension installed (github.com/chrischall/fetchproxy);
// opentable.com signed-in tab open. Does NOT submit a booking — stops
// after slot-lock.
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';
import { OpenTableClient } from '../src/client.js';

const PASQUAL_RID = 278896;
const PASQUAL_SLUG = 'cafe-pasquals-santa-fe';
// Two weeks out is a safe slot window — Pasqual's runs Experience
// flows daily; adjust if their schedule changes.
const DATE = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
const TIME = '18:00';
const PARTY = 2;

async function main(): Promise<void> {
  const transport = new FetchproxyTransport({ port: 37149, version: '0.9.1' });
  await transport.start();
  const client = new OpenTableClient({ transport });
  try {
    const availability = await client.fetchJson<unknown>(
      '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
      {
        method: 'POST',
        headers: { 'ot-page-type': 'home', 'ot-page-group': 'seo-landing-home' },
        body: {
          operationName: 'RestaurantsAvailability',
          variables: {
            onlyPop: false,
            forwardDays: 0,
            requireTimes: false,
            requireTypes: [],
            useCBR: false,
            privilegedAccess: [],
            restaurantIds: [PASQUAL_RID],
            restaurantAvailabilityTokens: [
              'eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ',
            ],
            date: DATE,
            time: TIME,
            partySize: PARTY,
            databaseRegion: 'NA',
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash:
                'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e',
            },
          },
        },
      }
    );
    console.log(JSON.stringify(availability, null, 2));
    console.error('');
    console.error('=== availability dumped to stdout ===');
    console.error('');
    console.error(
      'NEXT: open the bridged Chrome tab and navigate to:'
    );
    console.error(
      `  https://www.opentable.com/r/${PASQUAL_SLUG}?covers=${PARTY}&dateTime=${DATE}T${TIME}`
    );
    console.error(
      'Click an available time slot, "Select" on a seating area, "Select" on the Experience.'
    );
    console.error(
      'You should land on /booking/details. After the page settles, open DevTools → Console and run:'
    );
    console.error('');
    console.error(
      '  window.__APOLLO_CLIENT__.queryManager.mutationStore[\'1\'].mutation.documentId'
    );
    console.error('');
    console.error(
      'The returned 64-char hex string IS the BookDetailsExperienceSlotLock'
    );
    console.error(
      "persisted-query sha256Hash — paste it into BOOK_EXPERIENCE_SLOT_LOCK_HASH in src/tools/reservations.ts."
    );
    console.error(
      '(Apollo\'s `documentId` field == the persisted-query hash. The same trick'
    );
    console.error(
      'works for any other persisted-query op that fires on the page — iterate'
    );
    console.error(
      'queryManager.queries via .forEach to read each query\'s documentId.)'
    );
    console.error('');
    console.error(
      'If you also want to refresh tests/fixtures/booking-details-state-experience.json:'
    );
    console.error(
      '  copy(JSON.stringify(window.__INITIAL_STATE__, null, 2))'
    );
    console.error(
      'then paste into the fixture file and re-run `npx prettier --write` on it.'
    );
  } finally {
    await transport.close();
  }
}

main().catch((err) => {
  console.error('probe-experience-slot-lock-hash failed:', err);
  process.exit(1);
});
