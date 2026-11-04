import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport } from '../src/transport.js';
import { registerReservationTools } from '../src/tools/reservations.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFavoriteTools } from '../src/tools/favorites.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), asserted
 * against the served tool list — what a host actually sees.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const READ_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  opentable_list_reservations: 'whats-on',
  opentable_find_slots: 'lookup',
  opentable_book_preview: 'other',
  opentable_modify_preview: 'other',
  opentable_book: 'change',
  opentable_modify: 'change',
  opentable_cancel: 'change',
  opentable_get_profile: 'lookup',
  opentable_list_favorites: 'lookup',
  opentable_add_favorite: 'change',
  opentable_remove_favorite: 'change',
  opentable_search_restaurants: 'lookup',
  opentable_get_restaurant: 'lookup',
  opentable_get_menu: 'lookup',
};

const mockFetchHtml = vi.fn();
const client = { fetchHtml: mockFetchHtml } as unknown as OpenTableClient;
const transport = {
  runProbe: async () => ({}),
  bridgeStatus: () => ({}),
} as unknown as OpenTableTransport;

async function harness() {
  return createTestHarness((server) => {
    registerReservationTools(server, client);
    registerUserTools(server, client);
    registerFavoriteTools(server, client);
    registerSearchTools(server, client);
    registerRestaurantTools(server, client);
    registerHealthcheckTools(server, client, transport);
  });
}

async function served(): Promise<Listed[]> {
  const h = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const hinted = (tools: Listed[]) => tools.filter((t) => !t.name.endsWith('_healthcheck'));

afterEach(() => vi.clearAllMocks());

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    const tools = await served();
    expect(tools.map((t) => t.name)).toContain('opentable_healthcheck');
    expect(hinted(tools).map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('every tool except the healthcheck carries domain food and its intent', async () => {
    for (const t of hinted(await served())) {
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(m!.domain, t.name).toBe('food');
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('the healthcheck joins no group', async () => {
    const hc = (await served()).find((t) => t.name === 'opentable_healthcheck');
    expect(hc?._meta?.mint).toBeUndefined();
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of hinted(await served())) {
      const m = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) expect(m.canonical, t.name).toBe(true);
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^opentable_/);
        }
      }
    }
  });

  it('canonical only on read-only whats-new/due/on reads, at most one per intent', async () => {
    const canonical = hinted(await served()).filter((t) => t._meta!.mint!.canonical === true);
    for (const t of canonical) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(READ_INTENTS, t.name).toContain(t._meta!.mint!.intent);
    }
    for (const intent of READ_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
    expect(canonical.map((t) => t.name)).toEqual(['opentable_list_reservations']);
  });

  it('the reservations read declares its range and no subject (one diner, nothing to list)', async () => {
    const t = (await served()).find((x) => x.name === 'opentable_list_reservations')!;
    expect(t._meta!.mint).toEqual({
      domain: 'food',
      intent: 'whats-on',
      canonical: true,
      when: { start: 'start_date', end: 'end_date' },
      aliases: ['dinner', 'reservations', 'restaurant', 'table', 'eating out', 'dinner plans'],
    });
    expect(t.inputSchema.properties!.view.enum).toContain('brief');
  });
});

function htmlWith(state: unknown): string {
  return `<!DOCTYPE html><html><head></head><body><script>{"__INITIAL_STATE__":${JSON.stringify(
    state,
  )}}</script></body></html>`;
}

const reservation = (over: Record<string, unknown>) => ({
  confirmationNumber: 1,
  dateTime: '2026-05-01T19:00:00',
  partySize: 2,
  reservationState: 'CONFIRMED',
  reservationType: 'Standard',
  restaurantId: 42,
  restaurantName: 'Testeria',
  securityToken: 't',
  ...over,
});

const BRIEF = /^.+ — (\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?|no date) — .+$/;

/** The brief answer: the fleet untrusted-data envelope, `data` holding the lines. */
function briefOf(result: { content: unknown[] }): { text: string; envelope: { untrusted_content: unknown; note: unknown; data: string[] } } {
  const text = (result.content[0] as { text: string }).text;
  return { text, envelope: JSON.parse(text) };
}

const dashboard = (...upcoming: Record<string, unknown>[]) =>
  htmlWith({ diningDashboard: { upcomingReservations: upcoming, pastReservations: [] } });

describe('the canonical read answers view: brief', () => {
  it('one line per item, ≤ 120 chars, "title — <ISO date | no date> — <status>"', async () => {
    mockFetchHtml.mockResolvedValue(
      dashboard(
        reservation({}),
        reservation({ confirmationNumber: 2, restaurantName: 'X'.repeat(300), partySize: 4, dateTime: '2026-05-03T20:30:00' }),
        reservation({ confirmationNumber: 3, dateTime: undefined, reservationState: undefined }),
      ),
    );
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', { view: 'brief' });
    await h.close();
    expect(result.isError).toBeFalsy();
    const lines = briefOf(result).envelope.data;
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(BRIEF);
    }
    expect(lines[0]).toBe('Testeria, party of 2 — 2026-05-01T19:00 — confirmed');
    expect(lines[1]).toMatch(/…, party of 4 — 2026-05-03T20:30 — confirmed$/);
    expect(lines[2]).toBe('Testeria, party of 2 — no date — unknown');
  });

  it('rides the minified untrusted-data envelope: restaurant names are written by the restaurants', async () => {
    mockFetchHtml.mockResolvedValue(dashboard(reservation({})));
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', { view: 'brief' });
    await h.close();
    const { text, envelope } = briefOf(result);
    expect(text).toBe(JSON.stringify(envelope));
    expect(Object.keys(envelope)).toEqual(['untrusted_content', 'note', 'data']);
    expect(envelope.untrusted_content).toBe(true);
    expect(envelope.note).toMatch(/^Restaurant names are written by the restaurants/);
    expect(envelope.data).toEqual(['Testeria, party of 2 — 2026-05-01T19:00 — confirmed']);
  });

  it('answers the single note line "-- none" when there is nothing', async () => {
    mockFetchHtml.mockResolvedValue(dashboard());
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', { view: 'brief' });
    await h.close();
    expect(briefOf(result).envelope.data).toEqual(['-- none']);
  });

  it('escapes a restaurant name that starts with "-- " or "\\" with one leading backslash', async () => {
    mockFetchHtml.mockResolvedValue(
      dashboard(
        reservation({ restaurantName: '-- none' }),
        reservation({ confirmationNumber: 2, restaurantName: '\\Slash Bar' }),
        reservation({ confirmationNumber: 3, restaurantName: '--Dashes' }),
      ),
    );
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', { view: 'brief' });
    await h.close();
    expect(briefOf(result).envelope.data).toEqual([
      '\\-- none, party of 2 — 2026-05-01T19:00 — confirmed',
      '\\\\Slash Bar, party of 2 — 2026-05-01T19:00 — confirmed',
      '--Dashes, party of 2 — 2026-05-01T19:00 — confirmed',
    ]);
  });

  it('cuts the line as a whole, title first: an overlong status is cut too, never only the title', async () => {
    mockFetchHtml.mockResolvedValue(
      dashboard(reservation({ restaurantName: 'Y'.repeat(80), reservationState: 'S'.repeat(200) })),
    );
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', { view: 'brief' });
    await h.close();
    const [line] = briefOf(result).envelope.data;
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(BRIEF);
    expect(line).toMatch(/^Y+…, party of 2 — 2026-05-01T19:00 — s+…$/);
  });

  it('start_date / end_date bound the reservations by date, inclusive', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        diningDashboard: {
          upcomingReservations: [
            reservation({ confirmationNumber: 1, dateTime: '2026-05-01T19:00:00', restaurantName: 'Early' }),
            reservation({ confirmationNumber: 2, dateTime: '2026-05-02T19:00:00', restaurantName: 'Inside' }),
            reservation({ confirmationNumber: 3, dateTime: '2026-05-03T19:00:00', restaurantName: 'Edge' }),
            reservation({ confirmationNumber: 4, dateTime: '2026-05-04T19:00:00', restaurantName: 'Late' }),
          ],
          pastReservations: [],
        },
      }),
    );
    const h = await harness();
    const result = await h.callTool('opentable_list_reservations', {
      view: 'brief',
      start_date: '2026-05-02',
      end_date: '2026-05-03',
    });
    await h.close();
    const titles = briefOf(result).envelope.data.map((l) => l.split(',')[0]);
    expect(titles).toEqual(['Inside', 'Edge']);
  });
});
