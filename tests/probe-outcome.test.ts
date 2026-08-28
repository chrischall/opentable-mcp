import { describe, it, expect } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyNoTabError,
} from '@fetchproxy/server';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';
import {
  classifyProbeFailure,
  describeProbeFailure,
  exitCodeFor,
  formatProbeOutput,
  PROBE_EXIT,
  redactSensitive,
  REDACTED,
} from '../scripts/probe-outcome.js';

// The fixtures below are built from the REAL upstream error constructors
// rather than hand-copied strings. If @fetchproxy/server or mcp-utils
// rewords a message, these fail loudly here instead of silently defeating
// the classifier in a live probe run.
const NO_TAB = new FetchproxyNoTabError(
  'no tab matching https://www.opentable.com/'
).message;
const BRIDGE_DOWN = new FetchproxyBridgeDownError({
  originalError: 'Could not establish connection. Receiving end does not exist.',
  url: 'https://www.opentable.com/user/dining-dashboard',
}).message;
const NOT_SIGNED_IN = new SessionNotAuthenticatedError('OpenTable', 'opentable.com').message;

describe('classifyProbeFailure', () => {
  it('classifies the real no-tab message', () => {
    expect(classifyProbeFailure(NO_TAB)).toBe('no_tab');
  });

  it('classifies the real bridge-down message', () => {
    expect(classifyProbeFailure(BRIDGE_DOWN)).toBe('bridge_unavailable');
  });

  it('classifies the real not-signed-in message', () => {
    expect(classifyProbeFailure(NOT_SIGNED_IN)).toBe('not_authenticated');
  });

  it('falls back to "other" for an unrelated failure', () => {
    expect(
      classifyProbeFailure('OpenTable API error: 500 for GET /user/dining-dashboard')
    ).toBe('other');
    expect(classifyProbeFailure('')).toBe('other');
  });

  // THE ORDERING TRAP. All three messages talk about tabs and signing in,
  // so a loose match collapses them into one bucket — which is exactly the
  // ambiguity this patch exists to remove.
  describe('overlapping wording stays distinguishable', () => {
    it('does not read the no-tab message as an auth failure', () => {
      // It literally ends "...open a tab on that host and sign in, then re-run."
      expect(NO_TAB).toMatch(/sign in/i);
      expect(classifyProbeFailure(NO_TAB)).toBe('no_tab');
    });

    it('does not read the bridge-down message as an auth or no-tab failure', () => {
      // It says "...open, fully loaded, and signed in" and mentions a tab.
      expect(BRIDGE_DOWN).toMatch(/signed in/i);
      expect(BRIDGE_DOWN).toMatch(/tab/i);
      expect(classifyProbeFailure(BRIDGE_DOWN)).toBe('bridge_unavailable');
    });

    it('all three kinds are mutually distinct', () => {
      const kinds = [NO_TAB, BRIDGE_DOWN, NOT_SIGNED_IN].map(classifyProbeFailure);
      expect(new Set(kinds).size).toBe(3);
    });
  });

  // Upstream's own classifier anchors on `^`, so a wrapped message (MCP SDK
  // prefix, tool context) slips past it. These cover the fallback branch.
  describe('wrapped messages', () => {
    it('detects a wrapped no-tab error', () => {
      expect(classifyProbeFailure(`MCP error -32603: ${NO_TAB}`)).toBe('no_tab');
    });

    it('detects a wrapped bridge-down error', () => {
      expect(classifyProbeFailure(`tool opentable_list_reservations failed: ${BRIDGE_DOWN}`)).toBe(
        'bridge_unavailable'
      );
    });

    it('detects a wrapped auth error', () => {
      expect(classifyProbeFailure(`MCP error -32603: ${NOT_SIGNED_IN}`)).toBe('not_authenticated');
    });

    it('treats a refused stdio/server startup as bridge_unavailable', () => {
      expect(
        classifyProbeFailure('could not start the OpenTable MCP server: connect ECONNREFUSED')
      ).toBe('bridge_unavailable');
    });
  });

  // The startup path passes its own fallback because the SDK's wording for
  // "the server never came up" ("MCP error -32000: Connection closed") names
  // no bridge concept at all — a string-only classifier calls it 'other' and
  // the probe then tells the user it is "not a bridge problem", which is
  // exactly backwards.
  describe('fallback kind', () => {
    it('defaults to "other"', () => {
      expect(classifyProbeFailure('something unrecognised')).toBe('other');
    });

    it('uses the caller-supplied fallback when nothing matches', () => {
      expect(
        classifyProbeFailure(
          'could not start the OpenTable MCP server: MCP error -32000: Connection closed',
          'bridge_unavailable'
        )
      ).toBe('bridge_unavailable');
    });

    it('never lets the fallback override a recognised kind', () => {
      expect(classifyProbeFailure(NO_TAB, 'bridge_unavailable')).toBe('no_tab');
      expect(classifyProbeFailure(NOT_SIGNED_IN, 'bridge_unavailable')).toBe('not_authenticated');
    });

    it('still yields a nonzero exit for a startup failure', () => {
      const kind = classifyProbeFailure(
        'could not start the OpenTable MCP server: MCP error -32000: Connection closed',
        'bridge_unavailable'
      );
      expect(exitCodeFor(kind)).not.toBe(0);
    });
  });
});

describe('exit codes', () => {
  it('maps success to 0 and every failure to a distinct nonzero code', () => {
    expect(PROBE_EXIT.ok).toBe(0);
    const codes = (['no_tab', 'bridge_unavailable', 'not_authenticated', 'other'] as const).map(
      exitCodeFor
    );
    for (const code of codes) expect(code).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // The regression: FetchProxy connected, no opentable.com tab, exit 0.
  it('exits nonzero when there is no opentable.com tab', () => {
    expect(exitCodeFor(classifyProbeFailure(NO_TAB))).not.toBe(0);
  });

  it('exits nonzero when the bridge is unavailable', () => {
    expect(exitCodeFor(classifyProbeFailure(BRIDGE_DOWN))).not.toBe(0);
  });

  it('exits nonzero when the session is not authenticated', () => {
    expect(exitCodeFor(classifyProbeFailure(NOT_SIGNED_IN))).not.toBe(0);
  });
});

describe('describeProbeFailure', () => {
  it('gives each kind a distinct, actionable headline', () => {
    const kinds = ['no_tab', 'bridge_unavailable', 'not_authenticated', 'other'] as const;
    const lines = kinds.map(describeProbeFailure);
    expect(new Set(lines).size).toBe(kinds.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(describeProbeFailure('no_tab')).toMatch(/tab/i);
    expect(describeProbeFailure('bridge_unavailable')).toMatch(/extension|bridge/i);
    expect(describeProbeFailure('not_authenticated')).toMatch(/sign/i);
  });
});

// A list_reservations payload shaped like a live response.
//
// SYNTHETIC ON PURPOSE. An earlier draft of this file pasted a real
// reservation straight out of a probe run, which would have committed a live
// security_token and its confirmation number — the precise pairing that is
// enough to cancel or modify someone's booking, and the reason
// redactSensitive() exists at all. The shape is what these tests need; the
// values must never be real. Keep it that way.
const FAKE_RESERVATIONS = [
  {
    reservation_id: '1000001',
    confirmation_number: 1000001,
    restaurant_id: 9999999,
    restaurant_name: 'Example Trattoria - Test Ward',
    date: '2099-01-02',
    time: '19:00',
    party_size: 2,
    status: 'PENDING',
    security_token: 'FAKE-SECURITY-TOKEN-FOR-TESTS-ONLY',
  },
];

describe('redactSensitive', () => {
  it('redacts confirmation numbers and security tokens', () => {
    const out = redactSensitive(FAKE_RESERVATIONS) as Array<Record<string, unknown>>;
    expect(out[0].confirmation_number).toBe(REDACTED);
    expect(out[0].security_token).toBe(REDACTED);
    expect(out[0].reservation_id).toBe(REDACTED);
  });

  it('keeps the non-sensitive fields that make a dangling reservation identifiable', () => {
    const out = redactSensitive(FAKE_RESERVATIONS) as Array<Record<string, unknown>>;
    expect(out[0].restaurant_name).toBe('Example Trattoria - Test Ward');
    expect(out[0].date).toBe('2099-01-02');
    expect(out[0].time).toBe('19:00');
    expect(out[0].party_size).toBe(2);
    expect(out[0].status).toBe('PENDING');
  });

  it('keeps the key present so a dropped field still reads as a parser bug', () => {
    const out = redactSensitive(FAKE_RESERVATIONS) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0])).toContain('security_token');
  });

  it('redacts slot hashes and reservation tokens', () => {
    const out = redactSensitive({
      reservation_token: 'eyJ2IjozLCJtIjoxfQ',
      slot_hash: '67009096',
      booking_token: 'abc',
      modify_token: 'def',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('matches camelCase spellings too', () => {
    const out = redactSensitive({
      securityToken: 'x',
      confirmationNumber: 1,
      slotHash: 'y',
      setCookie: 'z',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('redacts nested and array-nested values', () => {
    const out = redactSensitive({
      outer: { inner: [{ security_token: 'deep' }] },
    }) as { outer: { inner: Array<{ security_token: unknown }> } };
    expect(out.outer.inner[0].security_token).toBe(REDACTED);
  });

  it('does not mutate its input', () => {
    const input = structuredClone(FAKE_RESERVATIONS);
    redactSensitive(input);
    expect(input[0].security_token).toBe(FAKE_RESERVATIONS[0].security_token);
  });

  it('passes through primitives and null', () => {
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(3)).toBe(3);
    expect(redactSensitive('plain')).toBe('plain');
  });
});

describe('formatProbeOutput', () => {
  const json = JSON.stringify(FAKE_RESERVATIONS);

  it('redacts by default', () => {
    const out = formatProbeOutput(json, {});
    expect(out).not.toContain('FAKE-SECURITY-TOKEN-FOR-TESTS-ONLY');
    expect(out).toContain(REDACTED);
    // The venue is still identifiable.
    expect(out).toContain('Example Trattoria - Test Ward');
  });

  it('leaks no sensitive value anywhere in the default output', () => {
    const out = formatProbeOutput(json, {});
    expect(out).not.toContain('FAKE-SECURITY-TOKEN-FOR-TESTS-ONLY');
    // 1000001 is the confirmation number *and* the reservation id.
    expect(out).not.toMatch(/"(confirmation_number|reservation_id)":\s*"?1000001"?/);
  });

  it('prints raw values only under the explicit opt-in', () => {
    const out = formatProbeOutput(json, { PROBE_SHOW_SENSITIVE: '1' });
    expect(out).toContain('FAKE-SECURITY-TOKEN-FOR-TESTS-ONLY');
  });

  it('does not opt in on a merely-present or falsey env var', () => {
    for (const value of ['0', '', 'true', 'yes']) {
      expect(formatProbeOutput(json, { PROBE_SHOW_SENSITIVE: value })).toContain(REDACTED);
    }
  });

  it('passes non-JSON text through unchanged', () => {
    expect(formatProbeOutput('not json at all', {})).toBe('not json at all');
  });
});
