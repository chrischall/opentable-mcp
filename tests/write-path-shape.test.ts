import { describe, it, expect, vi } from 'vitest';
import { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport, FetchInit, FetchResult } from '../src/transport.js';
import { lockSlot, makeReservation, type BookProfile } from '../src/tools/booking-flow.js';

/**
 * Wire shape of the booking writes, pinned against the page's own requests
 * captured 2026-09-02 (Sophia's Lounge, rid 985138):
 *
 *   - the page fires BookDetailsStandardSlotLock (persisted hash 1100bf68…)
 *     from /booking/details when the diner clicks "Complete reservation",
 *     and its Standard input carries `slotAvailabilityToken`;
 *   - the resulting slotLockId rides on POST /dapi/booking/make-reservation,
 *     alongside `tcAccepted: true` whenever the page showed a terms checkbox;
 *   - nothing is flagged for the page's MAIN world. 0.18.1 routed the
 *     mutations through `fetch_in_page`; the 403 it was chasing came from a
 *     relay tab without a CSRF token, not from the isolated world (see
 *     transport-fetchproxy.test.ts). Reintroducing the flag hands page
 *     script the request, CSRF header included, so this file fails on it.
 */

const ENDPOINTS = {
  standardPath: '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock',
  experiencePath: '/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock',
  standardHash: 'h1',
  experienceHash: 'h2',
};

const PROFILE: BookProfile = {
  first_name: 'A',
  last_name: 'B',
  email: 'a@b.c',
  mobile_phone_number: '5550000',
  country_id: 'US',
};

function makeClient(reply: (init: FetchInit) => string): {
  client: OpenTableClient;
  calls: FetchInit[];
} {
  const calls: FetchInit[] = [];
  const transport: OpenTableTransport = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    fetch: vi.fn(async (init: FetchInit): Promise<FetchResult> => {
      calls.push(init);
      return { status: 200, body: reply(init), url: `https://www.opentable.com${init.path}` };
    }),
    graphqlQuery: vi.fn(async () => ({})),
  };
  return { client: new OpenTableClient({ transport }), calls };
}

const lockReply = (init: FetchInit): string =>
  init.path.includes('Experience')
    ? JSON.stringify({ data: { lockExperienceSlot: { success: true, slotLock: { slotLockId: 43 } } } })
    : JSON.stringify({ data: { lockSlot: { success: true, slotLock: { slotLockId: 42 } } } });

describe('slot-lock request shape', () => {
  it('Standard: sends slotAvailabilityToken like the page does, from the isolated world', async () => {
    const { client, calls } = makeClient(lockReply);
    const id = await lockSlot(client, {
      restaurantId: 985138,
      reservationDateTime: '2026-09-24T19:00',
      partySize: 2,
      databaseRegion: 'NA',
      slotHash: '2519060671',
      diningAreaId: 1,
      reservationToken: 'slot-tok',
      endpoints: ENDPOINTS,
    });

    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input).toEqual({
      restaurantId: 985138,
      seatingOption: 'DEFAULT',
      reservationDateTime: '2026-09-24T19:00',
      partySize: 2,
      databaseRegion: 'NA',
      slotHash: '2519060671',
      reservationType: 'STANDARD',
      diningAreaId: 1,
      slotAvailabilityToken: 'slot-tok',
    });
    expect(calls[0]).not.toHaveProperty('inPage');
  });

  it('Experience: keeps the Experience input shape, also from the isolated world', async () => {
    const { client, calls } = makeClient(lockReply);
    const id = await lockSlot(client, {
      restaurantId: 278896,
      reservationDateTime: '2026-06-25T19:15',
      partySize: 5,
      databaseRegion: 'NA',
      slotHash: '4444',
      diningAreaId: 21881,
      reservationToken: 'slot-tok',
      experience: { experienceId: 514735, experienceVersion: 7 },
      endpoints: ENDPOINTS,
    });

    expect(id).toBe(43);
    expect(calls[0]!.path).toBe(ENDPOINTS.experiencePath);
    const body = JSON.parse(calls[0]!.body!) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input).toMatchObject({
      experienceId: 514735,
      experienceVersion: 7,
      slotAvailabilityToken: 'slot-tok',
      bookingType: 'Table',
    });
    expect(calls[0]).not.toHaveProperty('inPage');
  });
});

describe('make-reservation request shape', () => {
  const base = {
    restaurantId: 985138,
    reservationDateTime: '2026-09-24T19:00',
    partySize: 2,
    slotHash: '2519060671',
    reservationToken: 'slot-tok',
    slotLockId: 139630438,
    diningAreaId: 1,
    profile: PROFILE,
    bookingType: 'standard' as const,
    paymentCard: null,
    endpoint: '/dapi/booking/make-reservation',
  };
  const okReply = () => JSON.stringify({ confirmationNumber: 47190, securityToken: 's', points: 100 });

  it('carries the slotLockId and sends tcAccepted only when terms were shown', async () => {
    const withTerms = makeClient(okReply);
    await makeReservation(withTerms.client, { ...base, tcAccepted: true });
    const body1 = JSON.parse(withTerms.calls[0]!.body!) as Record<string, unknown>;
    expect(body1.slotLockId).toBe(139630438);
    expect(body1.tcAccepted).toBe(true);
    expect(body1.isModify).toBe(false);
    expect(withTerms.calls[0]).not.toHaveProperty('inPage');

    const noTerms = makeClient(okReply);
    await makeReservation(noTerms.client, base);
    const body2 = JSON.parse(noTerms.calls[0]!.body!) as Record<string, unknown>;
    expect(body2).not.toHaveProperty('tcAccepted');
  });

  it('modify: sends isModify + confnumber + securityToken and never reservationId', async () => {
    const { client, calls } = makeClient(okReply);
    await makeReservation(client, {
      ...base,
      modify: { confirmationNumber: 47190, securityToken: 'existing-token-placeholder' },
    });
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      isModify: true,
      confnumber: 47190,
      securityToken: 'existing-token-placeholder',
    });
    expect(body).not.toHaveProperty('reservationId');
  });
});
