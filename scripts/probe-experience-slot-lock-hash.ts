// Usage:
//   npm run build && npx tsx scripts/probe-experience-slot-lock-hash.ts
//
// Drives Pasqual's (rid 278896) Experience-mandatory booking flow up to
// the slot-lock step and dumps the SlotLock GraphQL POST body so we can
// pin `BookDetailsExperienceSlotLock`'s persisted-query sha256Hash.
//
// Prereqs: companion Chrome extension loaded; opentable.com signed-in
// tab open. Does NOT submit a booking — stops after slot-lock.
import { OpenTableWsServer } from '../src/ws-server.js';
import { OpenTableClient } from '../src/client.js';

const PASQUAL_RID = 278896;
const PASQUAL_SLUG = 'cafe-pasquals-santa-fe';
// Two weeks out is a safe slot window — Pasqual's runs Experience
// flows daily; adjust if their schedule changes.
const DATE = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
const TIME = '18:00';
const PARTY = 2;

async function main(): Promise<void> {
  const server = new OpenTableWsServer({ port: 37149 });
  await server.start();
  const client = new OpenTableClient(server);
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
      'Then click the first available time slot, "Select" on a seating area, "Select" on the Experience.'
    );
    console.error(
      'In DevTools → Network, find the POST to /dapi/fe/gql?opname=BookDetailsExperienceSlotLock.'
    );
    console.error(
      'Copy its `extensions.persistedQuery.sha256Hash` into src/tools/reservations.ts (Task 5).'
    );
    console.error(
      'Also copy `window.__INITIAL_STATE__` from the /booking/details page into'
    );
    console.error('  tests/fixtures/booking-details-state-experience.json');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('probe-experience-slot-lock-hash failed:', err);
  process.exit(1);
});
