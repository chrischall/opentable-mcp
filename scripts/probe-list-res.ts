#!/usr/bin/env tsx
// Read-only check: list upcoming reservations. Use this to spot any
// dangling reservations left over from probe runs, and as the cheapest
// acceptance check that the whole path (MCP server → FetchProxy → signed-in
// tab → opentable.com) is live.
//
// Books nothing, cancels nothing, modifies nothing.
//
// EXIT CODES (see scripts/probe-outcome.ts):
//   0  live OpenTable response
//   1  some other failure
//   2  no opentable.com tab
//   3  FetchProxy bridge unavailable
//   4  not signed in
//
// Reservation identifiers (confirmation numbers, security tokens, …) are
// redacted by default. `PROBE_SHOW_SENSITIVE=1` prints them raw.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  classifyProbeFailure,
  describeProbeFailure,
  exitCodeFor,
  formatProbeOutput,
  PROBE_EXIT,
} from './probe-outcome.js';

import type { ProbeFailureKind } from './probe-outcome.js';

function fail(message: string, fallback: ProbeFailureKind = 'other'): never {
  const kind = classifyProbeFailure(message, fallback);
  console.error(describeProbeFailure(kind));
  console.error(`\ndetail: ${message}`);
  process.exit(exitCodeFor(kind));
}

const c = new Client({ name: 't', version: '0' });

// Startup failures (missing dist/bundle.js, port already held by an orphan
// server) surface here, not as a tool error. The server never came up, so
// this is a transport failure by construction — passed as the fallback kind
// rather than left to a regex, since the SDK's wording for it ("Connection
// closed") names no bridge concept at all.
try {
  await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));
} catch (e) {
  fail(
    `could not start the OpenTable MCP server: ${String((e as Error).message)}`,
    'bridge_unavailable'
  );
}

const r = await c.callTool({
  name: 'opentable_list_reservations',
  arguments: { scope: 'upcoming' },
});
const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';

await c.close();

// The bug this probe used to have: `isError` was never checked, so a
// bridge/tab/auth failure printed its message and exited 0.
if (r.isError) fail(text);

console.log(formatProbeOutput(text));
process.exit(PROBE_EXIT.ok);
