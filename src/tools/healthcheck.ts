import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { runBridgeHealthcheck, bridgeHealthcheckDescription } from '@chrischall/mcp-utils/fetchproxy';
import type { OpenTableClient } from '../client.js';
import type { OpenTableTransport } from '../transport.js';

/**
 * Round-trip a small public opentable.com URL through the full bridge so one
 * tool call says WHICH hop is broken: the WebSocket bridge, the fetchproxy
 * extension, the relay tab, or OpenTable itself.
 *
 * The probe loop, error classification, result shape and hint ladder all live
 * in `registerBridgeHealthcheckTool` (`@chrischall/mcp-utils/fetchproxy`) —
 * the same helper alltrails-mcp and etix-mcp use. Only the OpenTable-specific
 * bits are wired here.
 *
 * `/robots.txt` rather than a signed-in page on purpose: the probe must
 * distinguish "the bridge cannot reach OpenTable" from "you are signed out",
 * and a page behind auth conflates the two.
 */
const PROBE_PATH = '/robots.txt';

/**
 * Registered only when the transport actually HAS a bridge. A transport
 * without one (mcp-chrome) would otherwise get a tool that reports bridge
 * fields it cannot measure — worse than no tool, because a healthcheck is
 * trusted precisely when everything else is confusing.
 */
export function registerHealthcheckTools(
  server: McpServer,
  client: OpenTableClient,
  transport: OpenTableTransport,
): void {
  const { runProbe, bridgeStatus } = transport;
  if (!runProbe || !bridgeStatus) return;

  server.registerTool('opentable_healthcheck', {
    description: bridgeHealthcheckDescription('www.opentable.com', PROBE_PATH) + ' Tests bridge transport only. Search/menus/availability are reported only from observed real reads; booking is never probed.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({}),
  }, async () => {
    const response = await runBridgeHealthcheck({
    server,
    prefix: 'opentable',
    probePath: PROBE_PATH,
    hostLabel: 'www.opentable.com',
    transport: {
      runProbe: (fetchFn, probePath) =>
        runProbe.call(transport, fetchFn, probePath) as never,
      status: () => bridgeStatus.call(transport) as never,
    },
    probeFn: async (path) => {
      const html = await client.fetchHtml(path);
      if (/^\s*<!doctype\s+html|<html[\s>]/i.test(html)) throw new Error('robots probe returned HTML instead of robots.txt; downstream response is unverified');
      return html;
    },
  });
    return withCapabilities(response, {
      scope: 'bridge_transport_only', capabilities: client.capabilityStatus(),
      capability_note: 'Observations belong to this MCP process and are fresh for five minutes, not proof of the current browser session. Not-probed/stale capabilities remain unverified. Booking is never tested by this read-only probe.' });
  });
}

type ToolReply = Awaited<ReturnType<typeof runBridgeHealthcheck>>;

/**
 * Merge the capability report into the bridge healthcheck's reply. That reply
 * is normally one JSON-object text block, but its shape belongs to mcp-utils:
 * anything else is kept verbatim and the report appended as its own block, so
 * a changed upstream shape degrades the layout rather than throwing away the
 * bridge result the user called the healthcheck for.
 */
export function withCapabilities(response: ToolReply, extra: Record<string, unknown>): ToolReply {
  const [first, ...rest] = response.content;
  if (first?.type === 'text') {
    try {
      const body: unknown = JSON.parse(first.text);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return { ...response, content: [{ type: 'text', text: JSON.stringify({ ...body, ...extra }) }, ...rest] };
      }
    } catch { /* not JSON: fall through and append */ }
  }
  return { ...response, content: [...response.content, { type: 'text', text: JSON.stringify(extra) }] };
}
