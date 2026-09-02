import { describe, it, expect, vi } from 'vitest';
import { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport, FetchInit, FetchResult } from '../src/transport.js';

/**
 * Routing the GraphQL mutations through the page's MAIN world.
 *
 * OpenTable's edge rejects a GraphQL *mutation* POST issued from the
 * extension's isolated world with 403, while accepting the byte-identical
 * request issued by the page — GraphQL queries and REST writes pass from
 * either world. That 403 is what breaks every booking write. fetchproxy
 * 2.4.0's `fetch_in_page` capability + per-request `inPage` flag is the
 * escape hatch; this file pins WHICH requests get flagged.
 *
 * The flag is deliberately narrow. Marking a request `inPage` gives up the
 * isolated world's tamper resistance — page script can read and alter it —
 * so it belongs only on the calls that genuinely cannot work without it.
 */

function makeTransport(): {
  transport: OpenTableTransport;
  calls: FetchInit[];
} {
  const calls: FetchInit[] = [];
  const transport: OpenTableTransport = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    fetch: vi.fn(async (init: FetchInit): Promise<FetchResult> => {
      calls.push(init);
      return { status: 200, body: '{"data":{}}', url: `https://www.opentable.com${init.path}` };
    }),
    graphqlQuery: vi.fn(async () => ({})),
  };
  return { transport, calls };
}

describe('client.fetchJson inPage passthrough', () => {
  it('omits inPage entirely when not requested', async () => {
    const { transport, calls } = makeTransport();
    const client = new OpenTableClient({ transport });
    await client.fetchJson('/dapi/wishlist/add', { body: { rid: 1 } });
    expect(calls[0]).not.toHaveProperty('inPage');
  });

  it('forwards inPage: true to the transport when requested', async () => {
    const { transport, calls } = makeTransport();
    const client = new OpenTableClient({ transport });
    await client.fetchJson('/dapi/fe/gql?optype=mutation', {
      body: { operationName: 'X' },
      inPage: true,
    });
    expect(calls[0]!.inPage).toBe(true);
  });

  it('does not disturb the headers/body it already sends', async () => {
    const { transport, calls } = makeTransport();
    const client = new OpenTableClient({ transport });
    await client.fetchJson('/x', { body: { a: 1 }, inPage: true });
    expect(calls[0]!.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(calls[0]!.body).toBe('{"a":1}');
    expect(calls[0]!.method).toBe('POST');
  });
});

describe('which OpenTable calls are flagged inPage', () => {
  it('flags the standard slot-lock mutation', async () => {
    const { transport, calls } = makeTransport();
    const client = new OpenTableClient({ transport });
    const { lockSlot } = await import('../src/tools/booking-flow.js');
    // Keep recording into `calls` while returning the lock response shape the
    // helper expects — a bare mockResolvedValue would replace the recorder and
    // leave nothing to assert against.
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (init: FetchInit) => {
      calls.push(init);
      return {
        status: 200,
        body: JSON.stringify({
          data: { lockSlot: { success: true, slotLock: { slotLockId: 42 } } },
        }),
        url: `https://www.opentable.com${init.path}`,
      };
    });
    await lockSlot(client, {
      restaurantId: 985138,
      reservationDateTime: '2026-09-24T19:00',
      partySize: 2,
      databaseRegion: 'NA',
      slotHash: '2519060671',
      diningAreaId: 1,
      reservationToken: 'tok',
      endpoints: {
        standardPath: '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock',
        experiencePath: '/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock',
        standardHash: 'h1',
        experienceHash: 'h2',
      },
    } as Parameters<typeof lockSlot>[1]);

    const lockCall = calls.find((c) => c.path.includes('SlotLock'));
    expect(lockCall, 'slot-lock request should have been issued').toBeDefined();
    expect(lockCall!.inPage).toBe(true);
  });
});
