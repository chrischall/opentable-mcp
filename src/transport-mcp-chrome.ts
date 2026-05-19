// OpenTableTransport that routes every fetch through hangwin/mcp-chrome's
// Streamable HTTP MCP endpoint (default: http://127.0.0.1:12306/mcp).
//
// Each fetchHtml/fetchJson maps to a single `chrome_network_request` tool
// call, pinned to a tab open at opentable.com via the `tabUrl` parameter.
// If no opentable.com tab is open, mcp-chrome opens one in the background.
//
// REQUIREMENTS — this transport works only against mcp-chrome versions
// that include the `tabUrl`/`tabId`/`windowId`/`background` parameters on
// `chrome_network_request`. That's the PR opened at:
//   https://github.com/hangwin/mcp-chrome/pull/348
//
// Pre-#348 versions are active-tab-only, which breaks credentialed
// cross-origin fetches for everything except the slot when the user is
// reading opentable.com. The transport runs against those versions too
// (no error), but the behavior will be wrong unless the user keeps
// opentable.com as their active tab.
//
// Activated via OT_BRIDGE=mcp-chrome (see src/index.ts).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchInit, FetchResult, OpenTableTransport } from './transport.js';

const DEFAULT_MCP_CHROME_URL = 'http://127.0.0.1:12306/mcp';
const OPENTABLE_ORIGIN = 'https://www.opentable.com/';
const NETWORK_REQUEST_TOOL = 'chrome_network_request';

export interface McpChromeTransportOptions {
  /** Streamable HTTP MCP endpoint. Override to test against a non-default
   *  mcp-chrome install or a mock server. */
  url?: string;
  /** Tab URL to pin every fetch to. opentable.com by default. */
  tabUrl?: string;
  /** Inject a fake MCP client (for tests). When provided, `url` is
   *  ignored and no real network connection is opened. */
  client?: MinimalMcpClient;
}

/** The subset of the MCP SDK Client we actually use — small enough to
 *  mock cleanly in tests. */
export interface MinimalMcpClient {
  connect(transport: unknown): Promise<void>;
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

/** Shape of `chrome_network_request`'s response inside the
 *  ToolResult's content[0].text JSON blob. Mirrors what mcp-chrome's
 *  inject-scripts/network-helper.js returns. */
interface ChromeNetworkResponse {
  success?: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  /** Final URL after redirects (Response.url). */
  url?: string;
  /** Present on transport-level errors (e.g. network unreachable),
   *  not HTTP 4xx/5xx (those come back as success:true with status). */
  error?: string;
}

export class McpChromeTransport implements OpenTableTransport {
  private readonly mcpUrl: string;
  private readonly tabUrl: string;
  private readonly client: MinimalMcpClient;
  private readonly ownsClient: boolean;
  private started = false;

  constructor(opts: McpChromeTransportOptions = {}) {
    this.mcpUrl = opts.url ?? DEFAULT_MCP_CHROME_URL;
    this.tabUrl = opts.tabUrl ?? OPENTABLE_ORIGIN;
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false; // tests own their mock
    } else {
      this.client = new Client({
        name: 'opentable-mcp/transport-mcp-chrome',
        version: '0.9.0',
      }) as unknown as MinimalMcpClient;
      this.ownsClient = true;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.ownsClient) {
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
      await this.client.connect(transport);
    } else {
      // Tests pass a pre-connected mock; nothing to do here.
    }
    this.started = true;
  }

  async close(): Promise<void> {
    if (!this.started) return;
    if (this.ownsClient) {
      await this.client.close();
    }
    this.started = false;
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const requestUrl = init.path.startsWith('http')
      ? init.path
      : `https://www.opentable.com${init.path}`;

    const args: Record<string, unknown> = {
      url: requestUrl,
      method: init.method,
      tabUrl: this.tabUrl,
      background: true,
    };
    if (init.headers && Object.keys(init.headers).length > 0) {
      args.headers = init.headers;
    }
    if (init.body !== undefined) {
      args.body = init.body;
    }

    const rpc = (await this.client.callTool({
      name: NETWORK_REQUEST_TOOL,
      arguments: args,
    })) as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };

    // Tool-level error from mcp-chrome (e.g. "No active tab found",
    // "Tab does not exist"). Map to a synthetic 5xx so OpenTableClient's
    // throwIfNotOk picks it up with a clear message.
    if (rpc.isError) {
      const text =
        rpc.content?.[0]?.type === 'text' ? rpc.content[0].text : 'unknown mcp-chrome error';
      return {
        status: 599,
        body: `mcp-chrome ${NETWORK_REQUEST_TOOL} failed: ${text}`,
        url: requestUrl,
      };
    }

    const text = rpc.content?.[0]?.type === 'text' ? rpc.content[0].text : '';
    let parsed: ChromeNetworkResponse;
    try {
      parsed = JSON.parse(text) as ChromeNetworkResponse;
    } catch {
      return {
        status: 599,
        body: `mcp-chrome returned non-JSON: ${text.slice(0, 200)}`,
        url: requestUrl,
      };
    }

    // Transport-level failure inside network-helper.js (network down,
    // CORS preflight rejected, etc.). Surface as 599; OpenTableClient
    // throws with the body which includes mcp-chrome's error message.
    if (parsed.success === false || parsed.error) {
      return {
        status: parsed.status ?? 599,
        body: parsed.error ?? `mcp-chrome network-helper failed: ${text.slice(0, 200)}`,
        url: parsed.url ?? requestUrl,
      };
    }

    return {
      status: parsed.status ?? 0,
      body: parsed.body ?? '',
      url: parsed.url ?? requestUrl,
    };
  }
}
