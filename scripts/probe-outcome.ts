// Shared outcome handling for the read-only probe scripts.
//
// WHY THIS EXISTS. `probe-list-res.ts` used to do:
//
//     const r = await c.callTool({ name: 'opentable_list_reservations', ... });
//     console.log((r.content[0] as { text: string }).text);   // ← DON'T
//
// The MCP SDK turns a throwing tool handler into a *successful* JSON-RPC
// response carrying `isError: true` and the message as text. Reading
// `content[0].text` without looking at `isError` prints the failure and
// exits 0 — so "FetchProxy is up but no opentable.com tab is open" was
// indistinguishable from a real live round-trip, and CI treated it as a
// pass. This module makes the probe's exit code mean something.
//
// The classifier deliberately keys off the *real* error strings emitted
// upstream (see the fixtures in tests/probe-outcome.test.ts), and reuses
// @fetchproxy/server's own `classifyFetchError` for the bridge-side kinds
// rather than duplicating its regexes here — that table is upstream's to
// maintain, and every extension wording change lands there first.
import { classifyFetchError } from '@fetchproxy/server';

/** Why a probe did not complete a live round-trip. */
export type ProbeFailureKind =
  /** No browser tab is open on opentable.com, so the bridge has nothing
   *  to fetch through. FetchProxy itself is fine. */
  | 'no_tab'
  /** The bridge is unreachable: extension offline, MV3 service worker
   *  evicted, or the content script never loaded in the matched tab. */
  | 'bridge_unavailable'
  /** A tab exists and the bridge works, but the session isn't signed in
   *  (OpenTable served the sign-in interstitial). */
  | 'not_authenticated'
  /** Anything else — an upstream HTTP error, a parser change, a bug. */
  | 'other';

/**
 * Process exit codes. Distinct per kind so a CI job (or a human reading
 * `$?`) can tell an environment problem from a real regression without
 * scraping stderr.
 */
export const PROBE_EXIT = {
  ok: 0,
  other: 1,
  no_tab: 2,
  bridge_unavailable: 3,
  not_authenticated: 4,
} as const satisfies Record<'ok' | ProbeFailureKind, number>;

/** Exit code for a given failure kind. */
export function exitCodeFor(kind: ProbeFailureKind): number {
  return PROBE_EXIT[kind];
}

/**
 * Classify a failure message into a {@link ProbeFailureKind}.
 *
 * ORDER IS LOAD-BEARING, because these messages overlap textually:
 *
 * - The no-tab message ends "…open a tab on that host and **sign in**,
 *   then re-run", and the bridge-down message says "make sure a tab is
 *   open, fully loaded, and **signed in**". A loose /sign(ed)? in/ test
 *   therefore matches all three cases. Auth is detected only by the
 *   canonical `Not signed in to <service>` prefix that
 *   `SessionNotAuthenticatedError` builds, and it is checked LAST.
 * - `content_script_unreachable` ("Could not establish connection") is a
 *   bridge problem that mentions a tab, so bridge_unavailable is checked
 *   before the no-tab fallback.
 *
 * @param message  Raw text from a tool result (`isError: true`) or a
 *                 thrown error's `.message`.
 * @param fallback Kind to return when nothing matches. Call sites that
 *                 already know the failure's family pass it here instead
 *                 of hoping a regex guesses right — the server-startup
 *                 path does this, since "the MCP server never came up"
 *                 is a transport failure by construction, whatever the
 *                 SDK happened to word the error as ("Connection
 *                 closed", a spawn errno, …).
 */
export function classifyProbeFailure(
  message: string,
  fallback: ProbeFailureKind = 'other'
): ProbeFailureKind {
  // Upstream's table first — it owns the canonical mapping. Its patterns
  // are anchored (`/^no tab matching /`), so it only fires when the
  // bridge error is the whole message.
  switch (classifyFetchError(message)) {
    case 'no_tab':
      return 'no_tab';
    case 'content_script_unreachable':
      return 'bridge_unavailable';
    default:
      break;
  }

  // Fallbacks for the same errors *wrapped* by another layer (the MCP
  // SDK, a tool's own context prefix), where upstream's `^` anchors
  // can't match. Substring form, same phrases.
  if (
    /fetchproxy bridge down/i.test(message) ||
    /FetchproxyBridgeDownError/.test(message) ||
    /Could not establish connection/i.test(message) ||
    /Receiving end does not exist/i.test(message) ||
    /service worker is not responding/i.test(message) ||
    /\bECONNREFUSED\b/.test(message)
  ) {
    return 'bridge_unavailable';
  }

  if (/no tab matching /i.test(message)) {
    return 'no_tab';
  }

  // Checked last, and only on the canonical phrase — see the ordering
  // note above.
  if (/Not signed in to /i.test(message) || /SessionNotAuthenticatedError/.test(message)) {
    return 'not_authenticated';
  }

  return fallback;
}

/** One-line, human-readable headline for a failure kind. */
export function describeProbeFailure(kind: ProbeFailureKind): string {
  switch (kind) {
    case 'no_tab':
      return 'NO TAB — FetchProxy is connected, but no opentable.com tab is open. Open one, sign in, and re-run.';
    case 'bridge_unavailable':
      return 'BRIDGE UNAVAILABLE — the OpenTable MCP server or the FetchProxy bridge is not reachable (server failed to start, extension offline, or its service worker was evicted). Check `npm run build` has produced dist/bundle.js, reload the extension from chrome://extensions, reload the tab, and re-run.';
    case 'not_authenticated':
      return 'NOT SIGNED IN — the opentable.com tab exists but the session is signed out. Sign in at opentable.com and re-run.';
    case 'other':
      return 'PROBE FAILED — the live call errored for a reason that is not a tab/bridge/session problem.';
  }
}

/**
 * Field names whose values never get printed by default.
 *
 * These are live provider credentials and identifiers: a `security_token`
 * plus a `confirmation_number` is enough to cancel or modify someone's
 * real reservation, and probe output routinely ends up in terminal
 * scrollback, CI logs, and pasted bug reports. Matching is on the
 * normalised key (lowercased, `_`/`-` stripped) so snake_case and
 * camelCase spellings are covered by one entry.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'confirmationnumber',
  'confnumber',
  'reservationid',
  'reservationtoken',
  'securitytoken',
  'slothash',
  'slotavailabilitytoken',
  // parse-restaurant.ts emits `availability_token`; without this the token it
  // carries survives redaction on the very path this exists to protect.
  'availabilitytoken',
  'bookingtoken',
  'modifytoken',
  'cookie',
  'cookies',
  'setcookie',
  'csrftoken',
  'gpid',
  'partnerscaredirecturl',
];

/** Placeholder substituted for a redacted value. */
export const REDACTED = '[redacted]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.includes(key.toLowerCase().replace(/[_-]/g, ''));
}

/**
 * Deep-copy `value`, replacing every sensitive field's value with
 * {@link REDACTED}.
 *
 * The key is KEPT (rather than deleted) on purpose: the probe's job is
 * to show the shape of what came back, and a missing key reads as "the
 * parser dropped it" — the exact regression these probes exist to
 * catch. Non-sensitive fields (restaurant name, date, time, party size,
 * status) survive untouched, which is all "spot a dangling reservation
 * from a probe run" actually needs.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}

/**
 * Render a successful tool result for printing.
 *
 * Redacts by default. Set `PROBE_SHOW_SENSITIVE=1` to print raw values —
 * needed when you actually have to act on a dangling reservation (cancel
 * it by hand), and deliberately opt-in so it can't happen by accident.
 * Non-JSON text is passed through unchanged; these tools always return
 * JSON, so a non-JSON body is itself the interesting signal.
 */
export function formatProbeOutput(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.PROBE_SHOW_SENSITIVE === '1') return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(redactSensitive(parsed), null, 2);
}
