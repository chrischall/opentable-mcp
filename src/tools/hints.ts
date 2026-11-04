/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, spec 2026-11-03 D4). Inert data: a host that does not read
 * them sees an extra `_meta` key and nothing else. The shape is fixed by the
 * host's contract, so it is restated here rather than imported — this server
 * takes no dependency on mcp-host.
 *
 * `subject` and `when` name THIS tool's own argument names (the host fills
 * them), never values; `aliases` are the words a person says, lowercase, at
 * most 8, each at most 40 chars. No tool here declares a `subject`: the
 * account is one diner, so there is no listable set of people or places to
 * fan an ask out over.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for an OpenTable tool: every tool here is in the `food` domain. */
export function foodMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'food', intent, ...extra } };
}

/** What people call a restaurant booking. */
export const RESERVATION_ALIASES = ['dinner', 'reservations', 'restaurant', 'table', 'eating out', 'dinner plans'];
