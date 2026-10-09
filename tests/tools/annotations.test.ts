import { describe, it, expect, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerReservationTools } from '../../src/tools/reservations.js';
import { registerFavoriteTools } from '../../src/tools/favorites.js';
import { createTestHarness } from '../helpers.js';

// MCP clients auto-approve readOnlyHint tools without a prompt, so a tool
// that writes anything server-side (including a slot-lock) must not claim
// to be read-only. Every write tool is annotated explicitly rather than
// falling back to spec defaults.
const client = {} as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

const EXPECTED: Record<string, Record<string, boolean>> = {
  // Previews POST a slot-lock mutation that holds restaurant inventory for
  // ~90s and then lapses on its own — nothing to undo, so not destructive.
  opentable_book_preview: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  opentable_modify_preview: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // A booking lands on a real restaurant's books (another party) and can
  // hold a card under a cancellation/no-show fee — opentable_cancel cannot
  // un-notify the restaurant or waive that fee, so it is no inverse.
  opentable_book: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Modify replaces the existing reservation's slot.
  opentable_modify: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  opentable_cancel: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // add/remove favorite are each other's inverse on the user's private list.
  opentable_add_favorite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  opentable_remove_favorite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

describe('tool annotations', () => {
  it('write tools (and slot-locking previews) carry explicit, non-read-only annotations', async () => {
    harness = await createTestHarness((server) => {
      registerReservationTools(server, client);
      registerFavoriteTools(server, client);
    });
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations, name).toMatchObject(expected);
    }
  });
});
