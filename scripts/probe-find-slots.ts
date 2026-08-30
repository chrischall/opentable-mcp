#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { probeDate } from './probe-date.js';
import {
  classifyProbeFailure,
  describeProbeFailure,
  exitCodeFor,
  formatProbeOutput,
  type ProbeFailureKind,
} from './probe-outcome.js';

/**
 * Exit with a classified code instead of 0.
 *
 * The MCP SDK turns a throwing tool handler into a SUCCESSFUL JSON-RPC
 * response carrying `isError: true`, so reading `content[0].text` without
 * checking that flag printed the error and reported success — "bridge up but
 * no tab open" was indistinguishable from a live round-trip. `detail` goes
 * through `formatProbeOutput` because an upstream error message routinely
 * quotes the URL it was sent, tokens and all.
 */
function fail(message: string, fallback: ProbeFailureKind = 'other'): never {
  const kind = classifyProbeFailure(message, fallback);
  console.error(describeProbeFailure(kind));
  console.error(`\ndetail: ${formatProbeOutput(message)}`);
  process.exit(exitCodeFor(kind));
}

const client = new Client({ name: 't', version: '0' });
try {
  await client.connect(
    new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] })
  );
} catch (e) {
  // The server never came up, so this is a transport failure by construction.
  fail(e instanceof Error ? e.message : String(e), 'bridge_unavailable');
}

let r;
try {
  r = await client.callTool({
    name: 'opentable_find_slots',
    arguments: { restaurant_id: 54232, date: probeDate(), time: '19:00', party_size: 2 },
  });
} catch (e) {
  await client.close().catch(() => {});
  fail(e instanceof Error ? e.message : String(e), 'bridge_unavailable');
}

const text = (r.content as Array<{ text: string }>)[0]!.text;
if (r.isError) {
  await client.close().catch(() => {});
  fail(text);
}

console.log('first 600 chars:');
console.log(formatProbeOutput(text.slice(0, 600)));
console.log('---');
try {
  const parsed = JSON.parse(text);
  console.log(
    `${parsed.length} slots; first=${JSON.stringify(formatProbeOutput(parsed[0] ?? null))?.slice(0, 200)}`
  );
} catch (e) {
  // A non-JSON body on a non-error response is itself a failure: the tool
  // claimed success and returned something unparseable.
  await client.close().catch(() => {});
  fail(`unparseable tool output: ${e instanceof Error ? e.message : String(e)}`);
}
await client.close();
