import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { OpenTableClient } from '../src/client.js';
import type { OpenTableTransport } from '../src/transport.js';
import { registerReservationTools } from '../src/tools/reservations.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFavoriteTools } from '../src/tools/favorites.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

const readJson = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

function servedNames(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => void names.push(name) } as never;
  const client = {} as OpenTableClient;
  const transport = { runProbe: async () => undefined, bridgeStatus: () => undefined } as unknown as OpenTableTransport;
  registerReservationTools(server, client);
  registerUserTools(server, client);
  registerFavoriteTools(server, client);
  registerSearchTools(server, client);
  registerRestaurantTools(server, client);
  registerHealthcheckTools(server, client, transport);
  return names.sort();
}

// The env keys the server honours: the three OT_* knobs (src/index.ts) plus
// the two @fetchproxy/server reads we never override (host, identityDir).
// FETCHPROXY_WS_PORT is inert (we always pass port) and --define'd away.
const ENV_KEYS = ['FETCHPROXY_IDENTITY_DIR', 'FETCHPROXY_WS_HOST', 'OT_BRIDGE', 'OT_MCP_CHROME_URL', 'OT_WS_PORT'];

describe('manifest.json / server.json', () => {
  it('manifest tools[] is exactly the served roster', () => {
    const manifest = readJson('manifest.json');
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(servedNames());
  });

  it('manifest declares every honoured env key, all optional', () => {
    const manifest = readJson('manifest.json');
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual(ENV_KEYS);
    for (const [k, v] of Object.entries(manifest.user_config as Record<string, { required: boolean }>)) {
      expect(v.required, k).toBe(false);
    }
  });

  it('server.json declares every honoured env key, all optional', () => {
    const server = readJson('server.json');
    const vars = server.packages[0].environmentVariables as { name: string; isRequired: boolean }[];
    expect(vars.map((v) => v.name).sort()).toEqual(ENV_KEYS);
    expect(vars.every((v) => v.isRequired === false)).toBe(true);
  });
});

describe('.claude-plugin/plugin.json', () => {
  // Claude Code reads the MCP config from `mcpServers`; a bare `mcp` key is
  // an unknown field it silently ignores (only harmless while the path is the
  // ./.mcp.json default).
  it('declares the MCP config under mcpServers, pointing at a file that exists', () => {
    const plugin = readJson('.claude-plugin/plugin.json');
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(existsSync(new URL(`../${plugin.mcpServers}`, import.meta.url))).toBe(true);
  });
});
