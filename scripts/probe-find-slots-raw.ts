#!/usr/bin/env tsx
// Raw RestaurantsAvailability dump — bypasses parse-slots to see the full
// response shape, including any fields we currently drop (e.g. CC-required
// flags). One-off debugging script; not wired into any workflow.
import { OpenTableClient } from '../src/client.js';

const RESTAURANTS_AVAILABILITY_HASH =
  'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e';

const RID = Number(process.env.OT_PROBE_RID ?? 2827);
const DATE = process.env.OT_PROBE_DATE ?? '2026-05-01';
const TIME = process.env.OT_PROBE_TIME ?? '20:45';
const PARTY = Number(process.env.OT_PROBE_PARTY ?? 5);

const client = new OpenTableClient();
await client.start();

const body = {
  operationName: 'RestaurantsAvailability',
  variables: {
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
  },
  extensions: {
    persistedQuery: { version: 1, sha256Hash: RESTAURANTS_AVAILABILITY_HASH },
  },
};

const resp = await client.fetchJson<unknown>(
  '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
  {
    method: 'POST',
    headers: { 'ot-page-type': 'home', 'ot-page-group': 'seo-landing-home' },
    body,
  }
);
console.log(JSON.stringify(resp, null, 2));
await client.close();
process.exit(0);
