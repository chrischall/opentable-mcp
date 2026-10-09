import { describe, it, expect } from 'vitest';
import type { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport } from '../src/transport.js';
import { registerReservationTools } from '../src/tools/reservations.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFavoriteTools } from '../src/tools/favorites.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Fleet meta-test: every tool says whether it is a read, every write CHOOSES
 * its destructiveHint (the spec defaults it to true, so a forgotten one
 * publishes as destructive and nothing fails), no read claims to be
 * destructive, and every tool declares openWorldHint — all of them reach
 * opentable.com through the browser bridge.
 *
 * Reads the REGISTERED config rather than a hand-kept list, so a new tool is
 * covered the moment it is registered.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  const client = {} as OpenTableClient;
  // A transport WITH a bridge, so the healthcheck registers too.
  const transport = {
    runProbe: async () => undefined,
    bridgeStatus: () => undefined,
  } as unknown as OpenTableTransport;
  registerReservationTools(server, client);
  registerUserTools(server, client);
  registerFavoriteTools(server, client);
  registerSearchTools(server, client);
  registerRestaurantTools(server, client);
  registerHealthcheckTools(server, client, transport);
  return seen;
}

describe('every tool declares its annotations', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(15);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool openWorld (all of them reach opentable.com)', () => {
    const notOpen = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(notOpen).toEqual([]);
  });

  it('holds the destructive set at book / modify / cancel', () => {
    const destructive = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual(['opentable_book', 'opentable_cancel', 'opentable_modify']);
  });
});
