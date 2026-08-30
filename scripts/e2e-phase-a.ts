#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  classifyProbeFailure,
  describeProbeFailure,
  exitCodeFor,
  formatProbeOutput,
  type ProbeFailureKind,
} from './probe-outcome.js';

/**
 * CLAUDE.md names this as THE read-only smoke check, so a silent pass here is
 * the most expensive one in the repo.
 *
 * It previously read `content[0].text` without checking `isError` and exited
 * 0 on every failure. It happened to exit non-zero today only because
 * `JSON.parse` throws on the non-JSON error text — accidental, not a
 * contract, and it reported the wrong reason.
 */
function fail(message: string, fallback: ProbeFailureKind = 'other'): never {
  const kind = classifyProbeFailure(message, fallback);
  console.error(describeProbeFailure(kind));
  console.error(`\ndetail: ${formatProbeOutput(message)}`);
  process.exit(exitCodeFor(kind));
}

const client = new Client({ name: 't', version: '0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/bundle.js'],
});
try {
  await client.connect(transport);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e), 'bridge_unavailable');
}

for (const name of ['opentable_list_reservations', 'opentable_get_profile', 'opentable_list_favorites']) {
  let result;
  try {
    result = await client.callTool({ name, arguments: {} });
  } catch (e) {
    await client.close().catch(() => {});
    fail(`${name}: ${e instanceof Error ? e.message : String(e)}`, 'bridge_unavailable');
  }
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  if (result.isError) {
    await client.close().catch(() => {});
    fail(`${name}: ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    await client.close().catch(() => {});
    fail(`${name}: unparseable tool output: ${e instanceof Error ? e.message : String(e)}`);
  }
  const summary = Array.isArray(parsed)
    ? `${parsed.length} entries`
    : Object.keys(parsed as Record<string, unknown>).join(',');
  console.log(`${name}: ${summary}`);
}
await client.close();
