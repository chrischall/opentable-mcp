import { describe, it, expect, vi } from 'vitest';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import type { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport } from '../src/transport.js';

/** Minimal McpServer stand-in that records what got registered. */
function fakeServer() {
  const names: string[] = [];
  return {
    names,
    registerTool: vi.fn((name: string) => {
      names.push(name);
    }),
    tool: vi.fn((name: string) => {
      names.push(name);
    }),
  };
}

const client = {} as OpenTableClient;

function bridgedTransport(): OpenTableTransport {
  return {
    start: vi.fn(),
    close: vi.fn(),
    fetch: vi.fn(),
    graphqlQuery: vi.fn(),
    bridgeStatus: vi.fn(() => ({ role: 'host', port: 37149 })),
    runProbe: vi.fn(async () => ({ ok: true })),
  } as unknown as OpenTableTransport;
}

describe('registerHealthcheckTools', () => {
  it('registers a healthcheck tool when the transport has a bridge', () => {
    const server = fakeServer();
    registerHealthcheckTools(server as never, client, bridgedTransport());
    expect(server.names.some((n) => n.includes('healthcheck'))).toBe(true);
  });

  // The guard is the point of the feature, not a nicety: a healthcheck that
  // reports bridge role/port for a transport with no bridge is worse than no
  // healthcheck, because it is trusted exactly when everything else is
  // confusing.
  it('registers NOTHING when the transport has no bridge (mcp-chrome)', () => {
    const server = fakeServer();
    const bridgeless = {
      start: vi.fn(),
      close: vi.fn(),
      fetch: vi.fn(),
      graphqlQuery: vi.fn(),
    } as unknown as OpenTableTransport;
    registerHealthcheckTools(server as never, client, bridgeless);
    expect(server.names).toHaveLength(0);
  });

  it('registers nothing when only one of the two hooks is present', () => {
    const server = fakeServer();
    const half = {
      start: vi.fn(),
      close: vi.fn(),
      fetch: vi.fn(),
      graphqlQuery: vi.fn(),
      bridgeStatus: vi.fn(),
    } as unknown as OpenTableTransport;
    registerHealthcheckTools(server as never, client, half);
    expect(server.names).toHaveLength(0);
  });

  // `runProbe`/`bridgeStatus` are destructured off the transport, so they must
  // be invoked with it as the receiver — a plain call would lose `this` and
  // throw on the adapter's private field access.
  it('calls the bridge hooks with the transport as receiver', () => {
    const server = fakeServer();
    const transport = bridgedTransport();
    registerHealthcheckTools(server as never, client, transport);
    expect(server.names.some((n) => n.includes('healthcheck'))).toBe(true);
    expect(() => (transport.bridgeStatus as () => unknown).call(transport)).not.toThrow();
  });
});
