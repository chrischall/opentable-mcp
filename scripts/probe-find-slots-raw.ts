#!/usr/bin/env tsx
// Raw RestaurantsAvailability dump — bypasses parse-slots to see the full
// response shape, including any fields we currently drop (e.g. CC-required
// flags). One-off debugging script; not wired into any workflow.
//
// Routes through fetchproxy's `graphql` capability (client.graphqlQuery),
// same as opentable_find_slots — a raw fetchJson POST to this endpoint is
// rejected by OpenTable's Akamai Bot Manager at the edge (403/409); the
// bot-detection sensor telemetry lives inside the page's own Apollo link
// chain, not on window.fetch. No persisted-query hash needed here — the
// extension reuses the live DocumentNode the tab's Apollo client already
// observed for RestaurantsAvailability.
//
// Prereqs: fetchproxy extension installed; opentable.com signed-in tab
// open, with at least one restaurant page loaded this session (so the
// tab's Apollo client has observed a RestaurantsAvailability call — if
// not, this errors with "operation ... not yet observed on this tab").
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';
import { OpenTableClient, AVAILABILITY_GRAPHQL_OP_NAME } from '../src/client.js';

const RID = Number(process.env.OT_PROBE_RID ?? 2827);
const DATE = process.env.OT_PROBE_DATE ?? '2026-05-01';
const TIME = process.env.OT_PROBE_TIME ?? '20:45';
const PARTY = Number(process.env.OT_PROBE_PARTY ?? 5);

const transport = new FetchproxyTransport({ port: 37149, version: '0.9.1' });
await transport.start();
const client = new OpenTableClient({ transport });

try {
  const resp = await client.graphqlQuery(AVAILABILITY_GRAPHQL_OP_NAME, {
    onlyPop: false,
    forwardDays: 0,
    requireTimes: false,
    requireTypes: [],
    useCBR: false,
    privilegedAccess: ['UberOneDiningProgram', 'VisaDiningProgram', 'VisaEventsProgram', 'ChaseDiningProgram'],
    restaurantIds: [RID],
    restaurantAvailabilityTokens: ['eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ'],
    date: DATE,
    time: TIME,
    partySize: PARTY,
    databaseRegion: 'NA',
  });
  console.log(JSON.stringify(resp, null, 2));
} finally {
  await transport.close();
}
process.exit(0);
