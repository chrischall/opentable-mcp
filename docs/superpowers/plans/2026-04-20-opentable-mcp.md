# opentable-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that exposes OpenTable reservation management (profile, search, slots, booking, cancellation, favorites, notify) to Claude via stdio, matching the conventions of `resy-mcp`.

**Architecture:** TypeScript/ESM stdio server on `@modelcontextprotocol/sdk`. A single `OpenTableClient` handles email+password login, session cookies (in-memory jar), and retry/error mapping. One `src/tools/*.ts` file per tool group exposes tools via `McpServer.registerTool` with `zod` inputs. Unit tests mock `fetch` (for the client) or `OpenTableClient.request` (for tools) via `vitest` and an in-memory MCP test harness. A smoke script pins down candidate endpoints against the live API. Three GitHub Actions workflows: CI on PRs, MCPB+npm release on `v*` tags, manual tag-and-bump.

**Tech Stack:** TypeScript 6, Node ≥ 18, `@modelcontextprotocol/sdk`, `zod`, `dotenv`, `esbuild`, `vitest`, `@vitest/coverage-v8`, `tsx`.

**Spec:** [`docs/superpowers/specs/2026-04-20-opentable-mcp-design.md`](../specs/2026-04-20-opentable-mcp-design.md)

**Working directory:** `/Users/chris/git/opentable-mcp`. Git is initialised; remote is `chrischall/opentable-mcp` on GitHub; branch is `main`. The spec doc is the only code-tracked content so far.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "opentable-mcp",
  "version": "0.1.0",
  "description": "OpenTable MCP server for Claude — developed and maintained by AI (Claude Code)",
  "author": "Claude Code (AI) <https://www.anthropic.com/claude>",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/chrischall/opentable-mcp.git"
  },
  "license": "MIT",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "claude",
    "ai",
    "opentable",
    "reservations",
    "restaurants",
    "dining",
    "booking"
  ],
  "type": "module",
  "bin": {
    "opentable-mcp": "dist/bundle.js"
  },
  "files": [
    "dist",
    ".claude-plugin",
    ".mcp.json"
  ],
  "scripts": {
    "build": "tsc --noEmit && npm run bundle",
    "bundle": "esbuild src/index.ts --bundle --platform=node --format=esm --external:dotenv --outfile=dist/bundle.js",
    "dev": "node dist/bundle.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "smoke": "tsx scripts/smoke.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "dotenv": "^17.4.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.5.2",
    "@vitest/coverage-v8": "^4.1.2",
    "esbuild": "^0.28.0",
    "tsx": "^4.19.0",
    "typescript": "^6.0.2",
    "vitest": "^4.1.2"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: Write `.env.example`**

```
OPENTABLE_EMAIL=you@example.com
OPENTABLE_PASSWORD=changeme
```

- [ ] **Step 5: Install dependencies**

Run: `cd /Users/chris/git/opentable-mcp && npm install`
Expected: `added <N> packages` with no errors. Creates `node_modules/` and `package-lock.json`.

- [ ] **Step 6: Verify typecheck runs**

Run: `npx tsc --noEmit`
Expected: exits 0 (no src files yet, but the config should parse).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example
git commit -m "chore: project scaffold (package.json, tsconfig, vitest config, env example)"
```

---

## Task 2: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_call:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.2

      - uses: actions/setup-node@v6.3.0
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add build+test workflow"
git push
```

- [ ] **Step 3: Verify CI runs**

Run: `gh run list --workflow ci.yml --limit 1`
Expected: a single queued/in-progress/completed run appears. The run will fail because there's no `src/` yet — that's expected; subsequent tasks will green it.

---

## Task 3: In-memory MCP test harness

**Files:**
- Create: `tests/helpers.ts`

- [ ] **Step 1: Write `tests/helpers.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export async function createTestHarness(
  registerFn: (server: McpServer) => void
): Promise<{
  client: Client;
  server: McpServer;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  listTools: () => Promise<{ name: string }[]>;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerFn(server);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    callTool: async (name, args) =>
      client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
    listTools: async () => {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name }));
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/helpers.ts
git commit -m "test: add in-memory MCP harness"
```

---

## Task 4: `CookieJar` utility (TDD)

Cookie-jar parsing is isolated logic — we test it as a pure unit before wiring it into the client.

**Files:**
- Create: `tests/cookie-jar.test.ts`
- Create: `src/cookie-jar.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/cookie-jar.test.ts
import { describe, it, expect } from 'vitest';
import { CookieJar } from '../src/cookie-jar.js';

describe('CookieJar', () => {
  it('is empty on construction', () => {
    expect(new CookieJar().toHeader()).toBeUndefined();
  });

  it('ingests a single set-cookie and emits it on toHeader', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc123; Path=/; HttpOnly']);
    expect(jar.toHeader()).toBe('OT_SESSION=abc123');
    expect(jar.has('OT_SESSION')).toBe(true);
  });

  it('ingests multiple cookies in one call', () => {
    const jar = new CookieJar();
    jar.ingest([
      'OT_SESSION=abc; Path=/',
      'otd=xyz; Secure',
    ]);
    expect(jar.toHeader()).toBe('OT_SESSION=abc; otd=xyz');
  });

  it('updates a cookie when re-ingested', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=old']);
    jar.ingest(['OT_SESSION=new']);
    expect(jar.toHeader()).toBe('OT_SESSION=new');
  });

  it('deletes a cookie on max-age=0', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.ingest(['OT_SESSION=; Max-Age=0']);
    expect(jar.toHeader()).toBeUndefined();
    expect(jar.has('OT_SESSION')).toBe(false);
  });

  it('deletes a cookie on empty value', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.ingest(['OT_SESSION=']);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('ignores headers without an `=`', () => {
    const jar = new CookieJar();
    jar.ingest(['nonsense; Path=/']);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('tolerates null / empty input', () => {
    const jar = new CookieJar();
    jar.ingest(null);
    jar.ingest([]);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('clear() empties the jar', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.clear();
    expect(jar.toHeader()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/cookie-jar.test.ts`
Expected: FAIL — `Cannot find module '../src/cookie-jar.js'`.

- [ ] **Step 3: Implement `CookieJar`**

```ts
// src/cookie-jar.ts
export class CookieJar {
  private jar = new Map<string, string>();

  ingest(setCookieHeaders: string[] | null | undefined): void {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return;
    for (const header of setCookieHeaders) {
      const firstPart = header.split(';', 1)[0] ?? '';
      const eq = firstPart.indexOf('=');
      if (eq < 0) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (!name) continue;

      const maxAgeMatch = /(?:^|;)\s*Max-Age\s*=\s*(-?\d+)/i.exec(header);
      const shouldDelete =
        value === '' || (maxAgeMatch !== null && Number(maxAgeMatch[1]) <= 0);

      if (shouldDelete) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  toHeader(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  clear(): void {
    this.jar.clear();
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/cookie-jar.test.ts`
Expected: `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/cookie-jar.ts tests/cookie-jar.test.ts
git commit -m "feat(client): add CookieJar utility with parsing + emission"
```

---

## Task 5: `OpenTableClient` login flow (TDD)

**Files:**
- Create: `tests/client.test.ts` (login section only; extended in Task 6)
- Create: `src/client.ts`

- [ ] **Step 1: Write failing tests — login**

```ts
// tests/client.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenTableClient } from '../src/client.js';

const mockFetch = vi.fn();
// @ts-expect-error — global.fetch is assignable at runtime
globalThis.fetch = mockFetch;

function mkResponse(init: {
  status?: number;
  statusText?: string;
  body?: unknown;
  setCookie?: string[];
}): Response {
  const headers = new Headers();
  for (const c of init.setCookie ?? []) headers.append('set-cookie', c);
  return new Response(
    init.body === undefined ? '' : JSON.stringify(init.body),
    { status: init.status ?? 200, statusText: init.statusText ?? 'OK', headers }
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.OPENTABLE_EMAIL = 'chris@example.com';
  process.env.OPENTABLE_PASSWORD = 's3cret';
});
afterEach(() => {
  delete process.env.OPENTABLE_EMAIL;
  delete process.env.OPENTABLE_PASSWORD;
});

describe('OpenTableClient — login', () => {
  it('throws when OPENTABLE_EMAIL is missing', async () => {
    delete process.env.OPENTABLE_EMAIL;
    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(/OPENTABLE_EMAIL/);
  });

  it('throws when OPENTABLE_PASSWORD is missing', async () => {
    delete process.env.OPENTABLE_PASSWORD;
    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(/OPENTABLE_PASSWORD/);
  });

  it('calls the login endpoint with JSON credentials and stores session cookies', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=abc; Path=/'] })) // login
      .mockResolvedValueOnce(mkResponse({ body: { ok: true } })); // GET /x

    const client = new OpenTableClient();
    const result = await client.request<{ ok: boolean }>('GET', '/x');

    expect(result).toEqual({ ok: true });

    const loginCall = mockFetch.mock.calls[0];
    expect(loginCall[0]).toMatch(/\/authenticate\/api\/login$/);
    expect(loginCall[1].method).toBe('POST');
    expect(loginCall[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(loginCall[1].body)).toEqual({
      email: 'chris@example.com',
      password: 's3cret',
    });

    const apiCall = mockFetch.mock.calls[1];
    expect(apiCall[1].headers.Cookie).toBe('OT_SESSION=abc');
  });

  it('throws a clear error when login returns non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(
      mkResponse({ status: 400, statusText: 'Bad Request', body: { error: 'nope' } })
    );

    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(/OpenTable login failed: 400/);
  });

  it('only calls login once for two concurrent requests', async () => {
    let loginResolve!: (r: Response) => void;
    const loginPromise = new Promise<Response>((r) => (loginResolve = r));
    mockFetch
      .mockReturnValueOnce(loginPromise)
      .mockResolvedValueOnce(mkResponse({ body: { a: 1 } }))
      .mockResolvedValueOnce(mkResponse({ body: { b: 2 } }));

    const client = new OpenTableClient();
    const r1 = client.request('GET', '/x');
    const r2 = client.request('GET', '/y');
    loginResolve(mkResponse({ setCookie: ['OT_SESSION=abc'] }));
    await Promise.all([r1, r2]);

    const loginCalls = mockFetch.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('/authenticate/api/login')
    );
    expect(loginCalls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — `Cannot find module '../src/client.js'`.

- [ ] **Step 3: Implement login skeleton in `src/client.ts`**

```ts
// src/client.ts
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CookieJar } from './cookie-jar.js';

try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: join(__dirname, '..', '.env'), override: false });
} catch {
  // mcpb bundle won't have dotenv — rely on process.env set by mcp_config.env
}

const BASE_URL = 'https://www.opentable.com';
const LOGIN_PATH = '/authenticate/api/login';

const SPOOF_HEADERS = {
  Origin: BASE_URL,
  Referer: `${BASE_URL}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

export type OpenTableBody = undefined | Record<string, unknown> | URLSearchParams;

export class OpenTableClient {
  private readonly jar = new CookieJar();
  private authenticated = false;
  private loginPromise: Promise<void> | null = null;

  async request<T>(method: string, path: string, body?: OpenTableBody): Promise<T> {
    await this.ensureAuthenticated();
    return this.doRequest<T>(method, path, body, false);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login()
        .then(() => {
          this.authenticated = true;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }
    return this.loginPromise;
  }

  private async login(): Promise<void> {
    const email = process.env.OPENTABLE_EMAIL;
    const password = process.env.OPENTABLE_PASSWORD;
    if (!email || !password) {
      const missing = [!email && 'OPENTABLE_EMAIL', !password && 'OPENTABLE_PASSWORD']
        .filter(Boolean)
        .join(' and ');
      throw new Error(`${missing} must be set`);
    }

    const response = await fetch(`${BASE_URL}${LOGIN_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...SPOOF_HEADERS,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OpenTable login failed: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`
      );
    }

    this.jar.ingest(response.headers.getSetCookie?.() ?? null);
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: OpenTableBody,
    _isRetry: boolean
  ): Promise<T> {
    const isForm = body instanceof URLSearchParams;
    const headers: Record<string, string> = { ...SPOOF_HEADERS };
    const cookie = this.jar.toHeader();
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) {
      headers['Content-Type'] = isForm
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined
        ? { body: isForm ? (body as URLSearchParams).toString() : JSON.stringify(body) }
        : {}),
    });

    this.jar.ingest(response.headers.getSetCookie?.() ?? null);

    if (!response.ok) {
      throw new Error(
        `OpenTable API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }
}
```

- [ ] **Step 4: Run login tests to confirm pass**

Run: `npx vitest run tests/client.test.ts`
Expected: all 5 login tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat(client): add OpenTableClient login + cookie-based auth"
```

---

## Task 6: `OpenTableClient` retry + error mapping (TDD)

Adds 401/419 re-login, 429 backoff, 403 captcha detection, and 500-auth handling to the already-working login path.

**Files:**
- Modify: `tests/client.test.ts`
- Modify: `src/client.ts`

- [ ] **Step 1: Append retry/error tests to `tests/client.test.ts`**

Add below the existing `describe('OpenTableClient — login', ...)` block:

```ts
describe('OpenTableClient — retry + error mapping', () => {
  it('re-logs in and retries once on 401', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] })) // login 1
      .mockResolvedValueOnce(mkResponse({ status: 401, statusText: 'Unauthorized' })) // GET /x fail
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=b'] })) // login 2
      .mockResolvedValueOnce(mkResponse({ body: { ok: true } })); // GET /x retry succeeds

    const client = new OpenTableClient();
    const result = await client.request<{ ok: boolean }>('GET', '/x');

    expect(result).toEqual({ ok: true });
    const loginCalls = mockFetch.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('/authenticate/api/login')
    );
    expect(loginCalls.length).toBe(2);
  });

  it('throws session-rejected after two consecutive 401s', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(mkResponse({ status: 401 }))
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=b'] }))
      .mockResolvedValueOnce(mkResponse({ status: 401 }));

    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(/session rejected/i);
  });

  it('sleeps and retries on 429', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(mkResponse({ status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(mkResponse({ body: { ok: true } }));

    const client = new OpenTableClient();
    const pending = client.request<{ ok: boolean }>('GET', '/x');

    // Advance past the 2s backoff
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('throws rate-limited after two consecutive 429s', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(mkResponse({ status: 429 }))
      .mockResolvedValueOnce(mkResponse({ status: 429 }));

    const client = new OpenTableClient();
    const pending = client.request('GET', '/x');

    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).rejects.toThrow(/Rate limited/);
    vi.useRealTimers();
  });

  it('throws bot-detection message on 403 with captcha body', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(
        mkResponse({ status: 403, body: { message: 'captcha required' } })
      );

    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(/bot-detection/i);
  });

  it('treats 500 with auth-like body as auth failure and re-logs', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(
        mkResponse({ status: 500, body: { error: 'unauthorized token' } })
      )
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=b'] }))
      .mockResolvedValueOnce(mkResponse({ body: { ok: true } }));

    const client = new OpenTableClient();
    const result = await client.request<{ ok: boolean }>('GET', '/x');
    expect(result).toEqual({ ok: true });
  });

  it('throws a generic API error for non-2xx with no special handling', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(mkResponse({ status: 503, statusText: 'Unavailable' }));

    const client = new OpenTableClient();
    await expect(client.request('GET', '/x')).rejects.toThrow(
      /OpenTable API error: 503/
    );
  });

  it('serialises URLSearchParams as form-encoded', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse({ setCookie: ['OT_SESSION=a'] }))
      .mockResolvedValueOnce(mkResponse({ body: { ok: true } }));

    const client = new OpenTableClient();
    const body = new URLSearchParams({ foo: 'bar' });
    await client.request('POST', '/thing', body);

    const postCall = mockFetch.mock.calls[1];
    expect(postCall[1].headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(postCall[1].body).toBe('foo=bar');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/client.test.ts`
Expected: the 8 new tests fail (401 retry, 429 retry, 403 captcha, 500-auth, etc.), because `doRequest` currently has no retry path.

- [ ] **Step 3: Replace `doRequest` with the full retry/error mapping**

Replace the body of `doRequest` in `src/client.ts` with:

```ts
  private async doRequest<T>(
    method: string,
    path: string,
    body: OpenTableBody,
    isRetry: boolean
  ): Promise<T> {
    const isForm = body instanceof URLSearchParams;
    const headers: Record<string, string> = { ...SPOOF_HEADERS };
    const cookie = this.jar.toHeader();
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) {
      headers['Content-Type'] = isForm
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined
        ? { body: isForm ? (body as URLSearchParams).toString() : JSON.stringify(body) }
        : {}),
    });

    this.jar.ingest(response.headers.getSetCookie?.() ?? null);

    const text = await response.text();

    const looksLikeAuthFailure =
      response.status === 401 ||
      response.status === 419 ||
      (response.status === 500 && /unauthorized|auth|session|token/i.test(text));

    if (looksLikeAuthFailure && !isRetry) {
      this.jar.clear();
      this.authenticated = false;
      await this.ensureAuthenticated();
      return this.doRequest<T>(method, path, body, true);
    }
    if (looksLikeAuthFailure) {
      throw new Error(
        'OpenTable session rejected — verify OPENTABLE_EMAIL / OPENTABLE_PASSWORD'
      );
    }

    if (response.status === 429 && !isRetry) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      return this.doRequest<T>(method, path, body, true);
    }
    if (response.status === 429) {
      throw new Error('Rate limited by OpenTable API');
    }

    if (response.status === 403 && /captcha|bot|challenge/i.test(text)) {
      throw new Error(
        'OpenTable bot-detection challenge. Try again later or log in via a browser on this machine first.'
      );
    }

    if (!response.ok) {
      throw new Error(
        `OpenTable API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    return (text ? JSON.parse(text) : null) as T;
  }
```

- [ ] **Step 4: Run all client tests to confirm pass**

Run: `npx vitest run tests/client.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat(client): add 401 re-login, 429 backoff, 403 captcha, 500-auth handling"
```

---

## Task 7: `opentable_get_profile` (TDD)

**Files:**
- Create: `tests/tools/user.test.ts`
- Create: `src/tools/user.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/tools/user.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('user tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerUserTools(server, mockClient));
  });

  describe('opentable_get_profile', () => {
    it('calls GET /api/v2/users/me and returns a sanitised profile', async () => {
      mockRequest.mockResolvedValue({
        first_name: 'Chris',
        last_name: 'Chall',
        email: 'chris@example.com',
        phone: '+15551234567',
        loyalty: { tier: 'Gold', points: 1234 },
        member_since: '2020-01-15',
        payment_methods: [{ id: 99, brand: 'visa' }], // should be stripped
      });

      const result = await harness.callTool('opentable_get_profile');

      expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me');
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"first_name": "Chris"');
      expect(text).toContain('"email": "chris@example.com"');
      expect(text).toContain('"phone": "+15551234567"');
      expect(text).toContain('"loyalty_tier": "Gold"');
      expect(text).toContain('"points_balance": 1234');
      expect(text).not.toContain('payment_methods');
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/user.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/user.js'`.

- [ ] **Step 3: Implement `src/tools/user.ts`**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

interface OpenTableUser {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  loyalty?: { tier?: string; points?: number };
  member_since?: string;
}

export function registerUserTools(server: McpServer, client: OpenTableClient): void {
  server.registerTool('opentable_get_profile', {
    description:
      "Get the authenticated OpenTable user's profile (name, email, phone, loyalty tier, points, member-since date). Payment method details are not exposed.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request<OpenTableUser>('GET', '/api/v2/users/me');
    const profile = {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      phone: data.phone,
      loyalty_tier: data.loyalty?.tier,
      points_balance: data.loyalty?.points,
      member_since: data.member_since,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run tests/tools/user.test.ts`
Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/user.ts tests/tools/user.test.ts
git commit -m "feat(tools): add opentable_get_profile"
```

---

## Task 8: `opentable_search_restaurants` + `opentable_get_restaurant` (TDD)

**Files:**
- Create: `tests/tools/restaurants.test.ts`
- Create: `src/tools/restaurants.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/tools/restaurants.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('restaurant tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerRestaurantTools(server, mockClient)
    );
  });

  describe('opentable_search_restaurants', () => {
    it('posts the search query and formats the results', async () => {
      mockRequest.mockResolvedValue({
        restaurants: [
          {
            id: 'ristorante-milano-sf',
            name: 'Ristorante Milano',
            cuisine: 'Italian',
            neighborhood: 'Hayes Valley',
            address: { city: 'San Francisco' },
            rating: 4.7,
            review_count: 1200,
            price_range: '$$$',
            profile_url: '/restaurant/ristorante-milano-sf',
            availability: [
              { token: 'tok-1', time: '19:00' },
              { token: 'tok-2', time: '19:30' },
            ],
          },
        ],
      });

      const result = await harness.callTool('opentable_search_restaurants', {
        location: 'San Francisco',
        date: '2026-05-01',
        party_size: 2,
        time: '19:00',
      });

      expect(result.isError).toBeFalsy();
      expect(mockRequest).toHaveBeenCalledWith(
        'POST',
        '/dtp/eatery/graphql',
        expect.objectContaining({
          operation: 'Search',
          variables: expect.objectContaining({
            location: 'San Francisco',
            date: '2026-05-01',
            partySize: 2,
            time: '19:00',
          }),
        })
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"restaurant_id": "ristorante-milano-sf"');
      expect(text).toContain('"name": "Ristorante Milano"');
      expect(text).toContain('"url": "https://www.opentable.com/restaurant/ristorante-milano-sf"');
      expect(text).toContain('"reservation_token": "tok-1"');
    });

    it('rejects missing location via zod', async () => {
      const result = await harness.callTool('opentable_search_restaurants', {
        date: '2026-05-01',
        party_size: 2,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('opentable_get_restaurant', () => {
    it('calls GET /api/v2/restaurants/{id} and formats the response', async () => {
      mockRequest.mockResolvedValue({
        id: 'ristorante-milano-sf',
        name: 'Ristorante Milano',
        description: 'Northern Italian in Hayes Valley.',
        cuisine: 'Italian',
        address: '123 Market St, San Francisco, CA',
        phone: '+14155551234',
        hours: 'Daily 5–10pm',
        rating: 4.7,
        review_count: 1200,
        price_range: '$$$',
        features: ['Outdoor seating', 'Wheelchair accessible'],
        profile_url: '/restaurant/ristorante-milano-sf',
      });

      const result = await harness.callTool('opentable_get_restaurant', {
        restaurant_id: 'ristorante-milano-sf',
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/restaurants/ristorante-milano-sf'
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"restaurant_id": "ristorante-milano-sf"');
      expect(text).toContain('"phone": "+14155551234"');
      expect(text).toContain('"features"');
      expect(text).toContain('"url": "https://www.opentable.com/restaurant/ristorante-milano-sf"');
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/restaurants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/restaurants.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

const GRAPHQL_PATH = '/dtp/eatery/graphql';
const BASE_URL = 'https://www.opentable.com';

export interface RawRestaurant {
  id?: string;
  name?: string;
  cuisine?: string;
  neighborhood?: string;
  address?: string | { city?: string };
  rating?: number;
  review_count?: number;
  price_range?: string;
  profile_url?: string;
  description?: string;
  phone?: string;
  hours?: string;
  features?: string[];
  availability?: Array<{ token?: string; time?: string; type?: string }>;
}

export function formatRestaurant(
  raw: RawRestaurant,
  opts: { date?: string; partySize?: number } = {}
) {
  const url = raw.profile_url
    ? `${BASE_URL}${raw.profile_url.startsWith('/') ? raw.profile_url : `/${raw.profile_url}`}`
    : undefined;

  const address =
    typeof raw.address === 'string'
      ? raw.address
      : raw.address?.city ?? undefined;

  const slots =
    opts.date !== undefined && opts.partySize !== undefined
      ? (raw.availability ?? []).map((a) => ({
          reservation_token: a.token ?? '',
          date: opts.date!,
          time: a.time ?? '',
          party_size: opts.partySize!,
          type: a.type,
        }))
      : undefined;

  return {
    restaurant_id: raw.id,
    name: raw.name,
    cuisine: raw.cuisine,
    neighborhood: raw.neighborhood,
    address_city: address,
    address: typeof raw.address === 'string' ? raw.address : undefined,
    phone: raw.phone,
    hours: raw.hours,
    description: raw.description,
    rating: raw.rating,
    review_count: raw.review_count,
    price_range: raw.price_range,
    features: raw.features,
    url,
    slots,
  };
}

export function registerRestaurantTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_search_restaurants',
    {
      description:
        'Search OpenTable for restaurants with availability. Returns restaurants plus any bookable reservation_tokens for the requested date + party size.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().optional(),
        location: z.string().describe('City, neighborhood, or address'),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().optional().describe('HH:MM (24h)'),
        party_size: z.number().int().positive(),
        cuisine: z.string().optional(),
        price_range: z.enum(['$', '$$', '$$$', '$$$$']).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, location, date, time, party_size, cuisine, price_range, limit }) => {
      const variables = {
        location,
        date,
        time,
        partySize: party_size,
        query,
        cuisine,
        priceRange: price_range,
        limit: limit ?? 20,
      };
      const data = await client.request<{ restaurants?: RawRestaurant[] }>(
        'POST',
        GRAPHQL_PATH,
        { operation: 'Search', variables }
      );
      const formatted = (data.restaurants ?? []).map((r) =>
        formatRestaurant(r, { date, partySize: party_size })
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_get_restaurant',
    {
      description: 'Get full details for a single OpenTable restaurant by id.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.string(),
      },
    },
    async ({ restaurant_id }) => {
      const data = await client.request<RawRestaurant>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}`
      );
      const formatted = formatRestaurant(data);
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/restaurants.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/restaurants.ts tests/tools/restaurants.test.ts
git commit -m "feat(tools): add search_restaurants + get_restaurant"
```

---

## Task 9: `opentable_find_slots` (TDD)

Will live in `src/tools/reservations.ts`; later tasks extend this file with `list`, `cancel`, `book`.

**Files:**
- Create: `tests/tools/reservations.test.ts`
- Create: `src/tools/reservations.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/tools/reservations.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerReservationTools } from '../../src/tools/reservations.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('reservation tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerReservationTools(server, mockClient)
    );
  });

  describe('opentable_find_slots', () => {
    it('returns slots sorted by time ascending', async () => {
      mockRequest.mockResolvedValue({
        availability: [
          { token: 't-2', time: '19:30' },
          { token: 't-1', time: '18:00' },
          { token: 't-3', time: '20:00' },
        ],
      });

      const result = await harness.callTool('opentable_find_slots', {
        restaurant_id: 'r1',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/api/v2/restaurants/r1/availability')
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text) as Array<{
        time: string;
      }>;
      expect(parsed.map((s) => s.time)).toEqual(['18:00', '19:30', '20:00']);
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/reservations.ts` with `find_slots` only**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export interface RawSlot {
  token?: string;
  time?: string;
  type?: string;
}

export function formatSlot(
  raw: RawSlot,
  date: string,
  partySize: number
): { reservation_token: string; date: string; time: string; party_size: number; type?: string } {
  return {
    reservation_token: raw.token ?? '',
    date,
    time: raw.time ?? '',
    party_size: partySize,
    type: raw.type,
  };
}

function compareHHMM(a: string, b: string): number {
  const parse = (s: string) => {
    const [h, m] = s.split(':').map((n) => Number(n));
    return (h || 0) * 60 + (m || 0);
  };
  return parse(a) - parse(b);
}

export function registerReservationTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_find_slots',
    {
      description:
        'List available reservation slots at a specific restaurant for a date + party size. Tokens expire quickly; book soon after fetching.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        time: z.string().optional().describe('HH:MM (24h)'),
      },
    },
    async ({ restaurant_id, date, party_size, time }) => {
      const params = new URLSearchParams({
        date,
        party_size: String(party_size),
      });
      if (time) params.set('time', time);
      const data = await client.request<{ availability?: RawSlot[] }>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}/availability?${params.toString()}`
      );
      const slots = (data.availability ?? [])
        .map((s) => formatSlot(s, date, party_size))
        .sort((a, b) => compareHHMM(a.time, b.time));
      return { content: [{ type: 'text' as const, text: JSON.stringify(slots, null, 2) }] };
    }
  );
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(tools): add find_slots"
```

---

## Task 10: `opentable_list_reservations` (TDD)

**Files:**
- Modify: `tests/tools/reservations.test.ts`
- Modify: `src/tools/reservations.ts`

- [ ] **Step 1: Append test**

Add inside the `describe('reservation tools', ...)` block:

```ts
  describe('opentable_list_reservations', () => {
    it('defaults to scope=upcoming and formats each entry', async () => {
      mockRequest.mockResolvedValue({
        reservations: [
          {
            id: 'res-1',
            confirmation_number: 'ABC123',
            restaurant_name: 'Milano',
            date: '2026-05-01',
            time: '19:00',
            party_size: 2,
            status: 'confirmed',
          },
        ],
      });

      const result = await harness.callTool('opentable_list_reservations');

      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/users/me/reservations?scope=upcoming'
      );
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"reservation_id": "res-1"');
      expect(text).toContain('"confirmation_number": "ABC123"');
    });

    it('passes scope=past through', async () => {
      mockRequest.mockResolvedValue({ reservations: [] });
      await harness.callTool('opentable_list_reservations', { scope: 'past' });
      expect(mockRequest).toHaveBeenCalledWith(
        'GET',
        '/api/v2/users/me/reservations?scope=past'
      );
    });
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: two new tests fail — tool not registered.

- [ ] **Step 3: Add the tool**

Append inside `registerReservationTools` in `src/tools/reservations.ts`:

```ts
  interface RawReservation {
    id?: string;
    confirmation_number?: string;
    restaurant_name?: string;
    restaurant?: { name?: string };
    date?: string;
    time?: string;
    party_size?: number;
    status?: string;
    special_requests?: string;
  }

  server.registerTool(
    'opentable_list_reservations',
    {
      description:
        'List the user\'s OpenTable reservations. Defaults to upcoming; pass scope="past" or scope="all" to broaden.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z.enum(['upcoming', 'past', 'all']).optional(),
      },
    },
    async ({ scope }) => {
      const scopeParam = scope ?? 'upcoming';
      const data = await client.request<{ reservations?: RawReservation[] }>(
        'GET',
        `/api/v2/users/me/reservations?scope=${encodeURIComponent(scopeParam)}`
      );
      const formatted = (data.reservations ?? []).map((r) => ({
        reservation_id: r.id ?? '',
        confirmation_number: r.confirmation_number,
        restaurant_name: r.restaurant_name ?? r.restaurant?.name ?? 'Unknown',
        date: r.date ?? '',
        time: r.time ?? '',
        party_size: r.party_size ?? 0,
        status: r.status,
        special_requests: r.special_requests,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
    }
  );
```

Note: `RawReservation` is a local interface inside the `register…Tools` function to keep the file a single unit. If you prefer, lift it to module scope alongside `RawSlot`.

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(tools): add list_reservations"
```

---

## Task 11: `opentable_cancel` (TDD)

**Files:**
- Modify: `tests/tools/reservations.test.ts`
- Modify: `src/tools/reservations.ts`

- [ ] **Step 1: Append tests**

```ts
  describe('opentable_cancel', () => {
    it('POSTs cancel and reports cancelled=true on positive signal', async () => {
      mockRequest.mockResolvedValue({ status: 'cancelled' });

      const result = await harness.callTool('opentable_cancel', {
        reservation_id: 'res-1',
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'POST',
        '/api/v2/reservations/res-1/cancel'
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(true);
      expect(parsed.raw).toEqual({ status: 'cancelled' });
    });

    it('reports cancelled=false on explicit error field', async () => {
      mockRequest.mockResolvedValue({ error: 'already cancelled' });
      const result = await harness.callTool('opentable_cancel', {
        reservation_id: 'res-1',
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(false);
    });
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: two new tests fail — tool not registered.

- [ ] **Step 3: Add the tool**

Append inside `registerReservationTools`:

```ts
  server.registerTool(
    'opentable_cancel',
    {
      description:
        'Cancel an OpenTable reservation by its reservation_id (from opentable_book or opentable_list_reservations).',
      inputSchema: { reservation_id: z.string() },
    },
    async ({ reservation_id }) => {
      const data = await client.request<Record<string, unknown>>(
        'POST',
        `/api/v2/reservations/${reservation_id}/cancel`
      );
      const status = typeof data.status === 'string' ? data.status.toLowerCase() : undefined;
      const hasErrorField = 'error' in data || 'error_message' in data;
      const explicitSuccess =
        (status !== undefined && /cancel/.test(status)) || data.ok === true;
      const explicitFailure =
        data.ok === false ||
        (status !== undefined && /fail|error|denied/.test(status)) ||
        hasErrorField;
      const cancelled = explicitSuccess || !explicitFailure;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ cancelled, raw: data }, null, 2) },
        ],
      };
    }
  );
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(tools): add cancel"
```

---

## Task 12: `opentable_book` composite (TDD)

The biggest single tool: find → (optional details) → book. Supports `desired_time` with exact match or closest-time fallback, and carries `special_requests` through.

**Files:**
- Modify: `tests/tools/reservations.test.ts`
- Modify: `src/tools/reservations.ts`

- [ ] **Step 1: Append tests**

```ts
  describe('opentable_book', () => {
    it('books the closest-time slot when desired_time is not an exact match', async () => {
      mockRequest
        // 1. find
        .mockResolvedValueOnce({
          availability: [
            { token: 't-7pm', time: '19:00' },
            { token: 't-8pm', time: '20:00' },
          ],
        })
        // 2. book
        .mockResolvedValueOnce({
          reservation_id: 'res-1',
          confirmation_number: 'ABC123',
          restaurant_name: 'Milano',
          profile_url: '/restaurant/milano-sf',
          date: '2026-05-01',
          time: '19:00',
          party_size: 2,
          status: 'confirmed',
        });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        desired_time: '19:10',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.reservation_id).toBe('res-1');
      expect(parsed.confirmation_number).toBe('ABC123');
      expect(parsed.restaurant_url).toBe('https://www.opentable.com/restaurant/milano-sf');
      expect(parsed.time).toBe('19:00');

      // Verify book call carries the chosen token
      const bookCall = mockRequest.mock.calls[1];
      expect(bookCall[0]).toBe('POST');
      expect(bookCall[1]).toBe('/api/v2/restaurants/milano-sf/reservations');
      expect(bookCall[2]).toMatchObject({ reservation_token: 't-7pm', party_size: 2 });
    });

    it('books the exact match if desired_time hits one', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [
            { token: 't-7pm', time: '19:00' },
            { token: 't-730', time: '19:30' },
          ],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-2',
          restaurant_name: 'Milano',
          time: '19:30',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        desired_time: '19:30',
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({ reservation_token: 't-730' });
    });

    it('falls back to first slot when desired_time is omitted', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [
            { token: 't-first', time: '17:00' },
            { token: 't-second', time: '19:00' },
          ],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-3',
          restaurant_name: 'Milano',
          time: '17:00',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({ reservation_token: 't-first' });
    });

    it('throws when no slots are available', async () => {
      mockRequest.mockResolvedValueOnce({ availability: [] });

      const result = await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/No available slots/i);
    });

    it('forwards special_requests in the book payload', async () => {
      mockRequest
        .mockResolvedValueOnce({
          availability: [{ token: 't', time: '19:00' }],
        })
        .mockResolvedValueOnce({
          reservation_id: 'res-4',
          restaurant_name: 'Milano',
          time: '19:00',
          party_size: 2,
        });

      await harness.callTool('opentable_book', {
        restaurant_id: 'milano-sf',
        date: '2026-05-01',
        party_size: 2,
        special_requests: 'Window seat please',
      });

      expect(mockRequest.mock.calls[1][2]).toMatchObject({
        special_requests: 'Window seat please',
      });
    });
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: five new tests fail — `opentable_book` not registered.

- [ ] **Step 3: Add the composite tool**

Append inside `registerReservationTools`:

```ts
  server.registerTool(
    'opentable_book',
    {
      description:
        'Book an OpenTable reservation. Composite: internally runs find-slots → book. Pass desired_time (HH:MM, 24-hour) to target a specific slot; otherwise the first available slot is used. Closest-time fallback if desired_time is not an exact match.',
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        desired_time: z.string().optional().describe('HH:MM (24h)'),
        special_requests: z.string().optional(),
      },
    },
    async ({ restaurant_id, date, party_size, desired_time, special_requests }) => {
      // 1. find fresh slots
      const findParams = new URLSearchParams({
        date,
        party_size: String(party_size),
      });
      const findData = await client.request<{ availability?: RawSlot[] }>(
        'GET',
        `/api/v2/restaurants/${restaurant_id}/availability?${findParams.toString()}`
      );
      const slots = (findData.availability ?? [])
        .map((s) => formatSlot(s, date, party_size))
        .sort((a, b) => compareHHMM(a.time, b.time));
      if (slots.length === 0) {
        throw new Error(
          'No available slots for this restaurant/date/party size. The restaurant may be fully booked.'
        );
      }

      // 2. pick slot — exact, else closest, else first
      let chosen = slots[0];
      if (desired_time) {
        const exact = slots.find((s) => s.time === desired_time);
        if (exact) {
          chosen = exact;
        } else {
          const toMin = (t: string) => {
            const [h, m] = t.split(':').map((n) => Number(n));
            return (h || 0) * 60 + (m || 0);
          };
          const desired = toMin(desired_time);
          chosen = slots.reduce((best, s) =>
            Math.abs(toMin(s.time) - desired) < Math.abs(toMin(best.time) - desired) ? s : best
          );
        }
      }

      // 3. book
      const bookPayload = {
        reservation_token: chosen.reservation_token,
        party_size,
        date,
        time: chosen.time,
        ...(special_requests !== undefined ? { special_requests } : {}),
      };
      interface BookResponse {
        reservation_id?: string;
        confirmation_number?: string;
        restaurant_name?: string;
        restaurant?: { name?: string };
        profile_url?: string;
        date?: string;
        time?: string;
        party_size?: number;
        status?: string;
      }
      const booked = await client.request<BookResponse>(
        'POST',
        `/api/v2/restaurants/${restaurant_id}/reservations`,
        bookPayload
      );

      const restaurantUrl = booked.profile_url
        ? `https://www.opentable.com${
            booked.profile_url.startsWith('/') ? booked.profile_url : `/${booked.profile_url}`
          }`
        : undefined;

      const result = {
        reservation_id: booked.reservation_id,
        confirmation_number: booked.confirmation_number,
        restaurant_name: booked.restaurant_name ?? booked.restaurant?.name ?? 'Unknown',
        restaurant_url: restaurantUrl,
        date: booked.date ?? date,
        time: booked.time ?? chosen.time,
        party_size: booked.party_size ?? party_size,
        status: booked.status,
        special_requests,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(tools): add book (composite: find → book)"
```

---

## Task 13: Favorites (list / add / remove) (TDD)

**Files:**
- Create: `tests/tools/favorites.test.ts`
- Create: `src/tools/favorites.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/tools/favorites.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerFavoriteTools } from '../../src/tools/favorites.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('favorite tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerFavoriteTools(server, mockClient)
    );
  });

  it('list_favorites: GET /api/v2/users/me/favorites and passes through', async () => {
    mockRequest.mockResolvedValue({ favorites: [{ id: 'r1', name: 'Milano' }] });
    const result = await harness.callTool('opentable_list_favorites');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me/favorites');
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Milano');
  });

  it('add_favorite: POSTs restaurant_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_add_favorite', {
      restaurant_id: 'r1',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'POST',
      '/api/v2/users/me/favorites',
      { restaurant_id: 'r1' }
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ favorited: true, restaurant_id: 'r1' });
  });

  it('remove_favorite: DELETEs by restaurant_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_remove_favorite', {
      restaurant_id: 'r1',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'DELETE',
      '/api/v2/users/me/favorites/r1'
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ removed: true, restaurant_id: 'r1' });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/favorites.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/favorites.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export function registerFavoriteTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_favorites',
    {
      description: 'List the user\'s favorited OpenTable restaurants ("saved restaurants").',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request<Record<string, unknown>>(
        'GET',
        '/api/v2/users/me/favorites'
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_add_favorite',
    {
      description: 'Add a restaurant to the user\'s favorites by restaurant_id.',
      inputSchema: { restaurant_id: z.string() },
    },
    async ({ restaurant_id }) => {
      await client.request<unknown>('POST', '/api/v2/users/me/favorites', { restaurant_id });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ favorited: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_remove_favorite',
    {
      description: 'Remove a restaurant from the user\'s favorites by restaurant_id.',
      inputSchema: { restaurant_id: z.string() },
    },
    async ({ restaurant_id }) => {
      await client.request<unknown>('DELETE', `/api/v2/users/me/favorites/${restaurant_id}`);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ removed: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/favorites.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/favorites.ts tests/tools/favorites.test.ts
git commit -m "feat(tools): add favorites (list/add/remove)"
```

---

## Task 14: Notify (list / add / remove) (TDD)

**Files:**
- Create: `tests/tools/notify.test.ts`
- Create: `src/tools/notify.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/tools/notify.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerNotifyTools } from '../../src/tools/notify.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('notify tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerNotifyTools(server, mockClient)
    );
  });

  it('list_notify: GET /api/v2/users/me/notifications', async () => {
    mockRequest.mockResolvedValue({ notifications: [] });
    await harness.callTool('opentable_list_notify');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/api/v2/users/me/notifications');
  });

  it('add_notify: POSTs payload and returns identifier', async () => {
    mockRequest.mockResolvedValue({
      notify_id: 'n-1',
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
    });
    const result = await harness.callTool('opentable_add_notify', {
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
      time_window: '19:00-21:00',
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/api/v2/notifications', {
      restaurant_id: 'r1',
      date: '2026-05-01',
      party_size: 2,
      time_window: '19:00-21:00',
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.notify_id).toBe('n-1');
  });

  it('remove_notify: DELETEs by notify_id', async () => {
    mockRequest.mockResolvedValue({});
    const result = await harness.callTool('opentable_remove_notify', {
      notify_id: 'n-1',
    });
    expect(mockRequest).toHaveBeenCalledWith('DELETE', '/api/v2/notifications/n-1');
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ removed: true, notify_id: 'n-1' });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/notify.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

export function registerNotifyTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_list_notify',
    {
      description: 'List the user\'s OpenTable notify-me subscriptions.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request<Record<string, unknown>>(
        'GET',
        '/api/v2/users/me/notifications'
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_add_notify',
    {
      description:
        'Subscribe to notify-me for a restaurant + date + party size. Optional time_window narrows the alert (e.g. "19:00-21:00").',
      inputSchema: {
        restaurant_id: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        time_window: z.string().optional().describe('HH:MM-HH:MM'),
      },
    },
    async ({ restaurant_id, date, party_size, time_window }) => {
      const payload: Record<string, unknown> = { restaurant_id, date, party_size };
      if (time_window !== undefined) payload.time_window = time_window;
      const data = await client.request<Record<string, unknown>>(
        'POST',
        '/api/v2/notifications',
        payload
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'opentable_remove_notify',
    {
      description: 'Cancel a notify-me subscription by notify_id.',
      inputSchema: { notify_id: z.string() },
    },
    async ({ notify_id }) => {
      await client.request<unknown>('DELETE', `/api/v2/notifications/${notify_id}`);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ removed: true, notify_id }, null, 2) },
        ],
      };
    }
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/notify.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/notify.ts tests/tools/notify.test.ts
git commit -m "feat(tools): add notify (list/add/remove)"
```

---

## Task 15: Bootstrap `src/index.ts`

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerRestaurantTools } from './tools/restaurants.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerFavoriteTools } from './tools/favorites.js';
import { registerNotifyTools } from './tools/notify.js';

const client = new OpenTableClient();
const server = new McpServer({ name: 'opentable-mcp', version: '0.1.0' });

registerUserTools(server, client);
registerRestaurantTools(server, client);
registerReservationTools(server, client);
registerFavoriteTools(server, client);
registerNotifyTools(server, client);

console.error(
  '[opentable-mcp] This project was developed and is maintained by AI (Claude Opus 4.7). Use at your own discretion.'
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all tests across `tests/` pass (client + cookie-jar + 5 tool groups).

- [ ] **Step 3: Build the bundle**

Run: `npm run build`
Expected: `dist/bundle.js` is created; typecheck is clean.

- [ ] **Step 4: Sanity-check the bundle and tool registration**

Verify `dist/bundle.js` has a shebang (so MCPB can exec it):
Run: `head -1 dist/bundle.js`
Expected: `#!/usr/bin/env node`.

Verify the server lists all 13 tools via the MCP SDK client (no real network):
Run:
```bash
OPENTABLE_EMAIL=placeholder OPENTABLE_PASSWORD=placeholder node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 't', version: '0' });
const transport = new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(tools.length, tools.map(t => t.name).sort().join(','));
await client.close();
"
```
Expected: `13` followed by a comma-separated list of all 13 `opentable_*` tool names. (Listing tools doesn't trigger login, so placeholder credentials are fine.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire tool registrations into stdio MCP server"
```

---

## Task 16: MCPB manifest (`manifest.json`)

**Files:**
- Create: `manifest.json`

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/anthropics/dxt/main/dist/mcpb-manifest.schema.json",
  "manifest_version": "0.3",
  "name": "opentable-mcp",
  "display_name": "OpenTable",
  "version": "0.1.0",
  "description": "OpenTable reservation management for Claude — search restaurants, book tables, manage reservations, favorites, and notify-me",
  "author": {
    "name": "Chris Chall",
    "email": "chris.c.hall@gmail.com",
    "url": "https://github.com/chrischall"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/chrischall/opentable-mcp"
  },
  "homepage": "https://github.com/chrischall/opentable-mcp",
  "support": "https://github.com/chrischall/opentable-mcp/issues",
  "license": "MIT",
  "keywords": [
    "opentable",
    "reservations",
    "restaurants",
    "dining",
    "booking"
  ],
  "server": {
    "type": "node",
    "entry_point": "dist/bundle.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/dist/bundle.js"],
      "env": {
        "OPENTABLE_EMAIL": "${user_config.opentable_email}",
        "OPENTABLE_PASSWORD": "${user_config.opentable_password}"
      }
    }
  },
  "user_config": {
    "opentable_email": {
      "type": "string",
      "title": "OpenTable Email",
      "description": "Your OpenTable account email",
      "required": true
    },
    "opentable_password": {
      "type": "string",
      "title": "OpenTable Password",
      "description": "Your OpenTable account password",
      "required": true,
      "sensitive": true
    }
  },
  "tools": [
    { "name": "opentable_get_profile",        "description": "Get the authenticated OpenTable user's profile" },
    { "name": "opentable_search_restaurants", "description": "Search restaurants with availability" },
    { "name": "opentable_get_restaurant",     "description": "Get full restaurant details by id" },
    { "name": "opentable_find_slots",         "description": "List available reservation slots at a restaurant" },
    { "name": "opentable_book",               "description": "Book a reservation (composite: find → book)" },
    { "name": "opentable_list_reservations",  "description": "List upcoming/past reservations" },
    { "name": "opentable_cancel",             "description": "Cancel a reservation by id" },
    { "name": "opentable_list_favorites",     "description": "List favorited restaurants" },
    { "name": "opentable_add_favorite",       "description": "Add a restaurant to favorites" },
    { "name": "opentable_remove_favorite",    "description": "Remove a restaurant from favorites" },
    { "name": "opentable_list_notify",        "description": "List notify-me subscriptions" },
    { "name": "opentable_add_notify",         "description": "Subscribe to notify-me" },
    { "name": "opentable_remove_notify",      "description": "Cancel a notify-me subscription" }
  ],
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=18.0.0" }
  }
}
```

- [ ] **Step 2: Verify the manifest builds an `.mcpb`**

Run: `npx @anthropic-ai/mcpb pack`
Expected: creates `opentable-mcp.mcpb` in the working directory. Delete it after verifying — it's gitignored.

```bash
rm opentable-mcp.mcpb
```

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: add MCPB manifest with user_config prompts"
```

---

## Task 17: Smoke script

**Files:**
- Create: `scripts/smoke.ts`

- [ ] **Step 1: Write the smoke script**

```ts
#!/usr/bin/env tsx
/**
 * Manual smoke test: probes each read-only endpoint against live OpenTable
 * using .env credentials. Used once before release to pin down candidate
 * endpoint paths and confirm response shapes.
 *
 * Read-only operations only — no booking, no cancellation, no favoriting,
 * no notify subscription. Run: npm run smoke.
 */
import 'dotenv/config';
import { OpenTableClient } from '../src/client.js';

interface Probe {
  name: string;
  run: (client: OpenTableClient) => Promise<unknown>;
}

const probes: Probe[] = [
  { name: 'GET /api/v2/users/me',                     run: (c) => c.request('GET', '/api/v2/users/me') },
  { name: 'GET /api/v2/users/me/reservations?...',    run: (c) => c.request('GET', '/api/v2/users/me/reservations?scope=upcoming') },
  { name: 'GET /api/v2/users/me/favorites',           run: (c) => c.request('GET', '/api/v2/users/me/favorites') },
  { name: 'GET /api/v2/users/me/notifications',       run: (c) => c.request('GET', '/api/v2/users/me/notifications') },
];

const client = new OpenTableClient();

for (const probe of probes) {
  const label = probe.name.padEnd(50);
  try {
    const data = await probe.run(client);
    const preview = JSON.stringify(data).slice(0, 160);
    console.log(`✓ ${label} ${preview}${preview.length === 160 ? '…' : ''}`);
  } catch (err) {
    console.log(`✗ ${label} ${(err as Error).message}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/smoke.ts
git commit -m "chore: add read-only smoke probe script"
```

---

## Task 18: `README.md` + `CLAUDE.md`

**Files:**
- Create: `README.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# opentable-mcp

OpenTable reservation management as an MCP server for Claude — search restaurants, book tables, manage reservations, favorites, and notify-me via natural language.

> ⚠️ OpenTable does not publish a comprehensive API. This server uses the same private endpoints opentable.com's web app calls, authenticated with your email + password (session cookie). Use at your own discretion.

## Tools

| Tool | Purpose |
| --- | --- |
| `opentable_get_profile` | Current user profile (name, email, loyalty tier) |
| `opentable_search_restaurants` | Search restaurants with availability for a location + date + party size |
| `opentable_get_restaurant` | Full restaurant details |
| `opentable_find_slots` | List bookable slots at a restaurant |
| `opentable_book` | Book a reservation (composite: find → book) |
| `opentable_list_reservations` | Upcoming / past reservations |
| `opentable_cancel` | Cancel by reservation_id |
| `opentable_list_favorites` | Favorited restaurants |
| `opentable_add_favorite` / `opentable_remove_favorite` | Manage favorites |
| `opentable_list_notify` | Notify-me subscriptions |
| `opentable_add_notify` / `opentable_remove_notify` | Manage notify-me |

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in:

```
OPENTABLE_EMAIL=you@example.com
OPENTABLE_PASSWORD=changeme
```

For MCPB / Claude Desktop install, the packaged manifest prompts for `OpenTable Email` and `OpenTable Password` at configure time.

Accounts with MFA enabled are not supported in v1. Use an account without MFA or create an app-specific credential.

## Run (local stdio)

```bash
node dist/bundle.js
```

## Test

```bash
npm test             # unit tests (mocked fetch)
npm run smoke        # live endpoint probe — requires real .env
```

## Notes

- Bot-detection: OpenTable may return a captcha challenge (403). If that happens, log in via a browser on this machine once to warm up the session, or retry later.
- Endpoint paths are reverse-engineered; if live endpoints differ, run `npm run smoke` and adjust.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
```

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## Commands

- `npm test` — vitest, mocked fetch, no network.
- `npm run build` — tsc + esbuild bundle to `dist/bundle.js`.
- `npm run smoke` — live probe of `/api/v2/users/me`, `/users/me/reservations`, `/users/me/favorites`, `/users/me/notifications` using `.env`.
- `npx tsc --noEmit` — typecheck only.

## Layout

- `src/client.ts` — `OpenTableClient`: lazy login, in-memory cookie jar, 401/419 re-login+retry, 429 backoff+retry, 403 captcha detection, 500-auth handling.
- `src/cookie-jar.ts` — minimal cookie parsing/emission utility.
- `src/tools/*.ts` — one file per concern (user / restaurants / reservations / favorites / notify). Each exports a `registerXxxTools(server, client)` function.
- `src/index.ts` — MCP bootstrap; wires tool registrations over stdio.
- `tests/` — 1:1 mirror of `src/`, plus `tests/helpers.ts` for the in-memory MCP harness.

## Conventions

- All tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- Prefer JSON bodies (OpenTable is JSON-first); use `URLSearchParams` only if a live endpoint demands form-encoding.
- Write a failing test before implementation. Keep tests in `tests/tools/<name>.test.ts` and mock `OpenTableClient.request`.

## Known unknowns

Endpoint paths under `/api/v2/...` and the GraphQL search operation are candidates pending smoke verification. See `scripts/smoke.ts` and the "open questions" block in `docs/superpowers/specs/2026-04-20-opentable-mcp-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add README and CLAUDE.md"
```

---

## Task 19: Release + tag-and-bump workflows

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/tag-and-bump.yml`

- [ ] **Step 1: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  release:
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write

    steps:
      - uses: actions/checkout@v6.0.2

      - uses: actions/setup-node@v6.3.0
        with:
          node-version: 24
          cache: npm
          registry-url: https://registry.npmjs.org

      # Strip always-auth from .npmrc (set by setup-node, deprecated in npm 11)
      - run: sed -i '/always-auth/d' "$NPM_CONFIG_USERCONFIG"

      - run: npm ci
      - run: npm run build

      - name: Extract version
        run: |
          VERSION=$(node -p "require('./package.json').version")
          echo "VERSION=${VERSION}" >> "$GITHUB_ENV"

      # Sync manifest.json version from package.json and build .mcpb
      - name: Build .mcpb bundle
        run: |
          node -e "
            const fs = require('fs');
            const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
            m.version = '$VERSION';
            fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
          "
          npx @anthropic-ai/mcpb pack
          mv opentable-mcp.mcpb "opentable-mcp-${VERSION}.mcpb"

      - name: Publish to npm
        run: npm publish --access public --provenance

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v3.0.0
        with:
          files: |
            opentable-mcp-${{ env.VERSION }}.mcpb
          generate_release_notes: true
```

- [ ] **Step 2: Write `.github/workflows/tag-and-bump.yml`**

```yaml
name: Tag & Bump

on:
  workflow_dispatch:

jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  tag-and-bump:
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v6.0.2
        with:
          # PAT required — GITHUB_TOKEN pushes don't trigger other workflows
          token: ${{ secrets.RELEASE_PAT }}

      - uses: actions/setup-node@v6.3.0
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      # Tag the current commit with the current version
      - name: Tag current version
        run: |
          CURRENT=$(node -p "require('./package.json').version")
          git tag "v${CURRENT}"
          echo "TAGGED_VERSION=${CURRENT}" >> "$GITHUB_ENV"

      # Bump patch version in all locations
      - name: Bump patch version
        run: |
          npm version patch --no-git-tag-version
          NEXT=$(node -p "require('./package.json').version")
          echo "NEXT_VERSION=${NEXT}" >> "$GITHUB_ENV"

          # src/index.ts — MCP server version
          sed -i "s/version: '${TAGGED_VERSION}'/version: '${NEXT}'/" src/index.ts

          # manifest.json
          node -e "
            const fs = require('fs');
            const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
            m.version = '${NEXT}';
            fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
          "

      - name: Rebuild
        run: npm run build

      - name: Commit and push
        run: |
          git add -A
          git commit -m "chore: bump version to v${NEXT_VERSION}"
          git push origin main
          git push origin "v${TAGGED_VERSION}"
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/release.yml .github/workflows/tag-and-bump.yml
git commit -m "ci: add release (v* tag) and manual tag-and-bump workflows"
git push
```

- [ ] **Step 4: Verify CI is green**

Run: `gh run list --workflow ci.yml --limit 1`
Expected: the most recent run is completed / conclusion `success`. If it's failing, fix in-place before continuing.

---

## Task 20: Live smoke & endpoint resolution (manual)

This is where the "open questions" in the spec get resolved. Run the smoke script against a real OpenTable account; for each failing probe, capture the actual URL/body/headers from opentable.com devtools and update the corresponding candidate in source until every probe is green (or deferred by an accompanying test).

**Files touched (likely):**
- `src/client.ts` — `LOGIN_PATH`, possibly extra headers (e.g. `x-csrf-token` sourcing).
- `src/tools/*.ts` — tool path constants / body shapes.
- `tests/**/*.test.ts` — only if response shape differs from spec.

- [ ] **Step 1: Fill `.env` with real credentials**

```bash
cp .env.example .env
# edit .env with real OPENTABLE_EMAIL / OPENTABLE_PASSWORD
```

Ensure `.env` is gitignored (it already is).

- [ ] **Step 2: Run the smoke probe**

Run: `npm run smoke`
Expected: four lines of output, one per probe. Likely outcomes on first run:
- `✓` — probe worked; endpoint is correct.
- `✗ OpenTable login failed: 404 …` — the login URL is wrong. Update `LOGIN_PATH` in `src/client.ts` and re-run. If `/authenticate/api/login` 404s, try `/api/v2/users/login`, then `/dtp/eatery/login`. Capture the real login POST from opentable.com devtools if none of the candidates work.
- `✗ OpenTable API error: 404 …` — the endpoint path is wrong. Update the candidate in the matching `src/tools/*.ts` file and re-run.
- `✗ OpenTable bot-detection challenge …` — log into opentable.com in a browser on this machine first, then re-run.

- [ ] **Step 3: Iterate until all probes are ✓**

For each failure, open DevTools → Network on opentable.com, reproduce the action manually, copy the request URL/method/body/headers, and update the source. Keep changes scoped: URL / body / headers only, not tool inputs or outputs.

- [ ] **Step 4: Re-run unit tests**

Run: `npm test`
Expected: all tests still pass. If a response shape drifted (a field renamed), update both the tool formatter and the matching unit test; do not broaden scope.

- [ ] **Step 5: Commit endpoint fixes**

```bash
git add src/ tests/
git commit -m "fix: pin down live endpoint paths + shapes from smoke probe"
git push
```

- [ ] **Step 6: Tag v0.1.0 once smoke is green**

Run the manual workflow to tag + bump:
```bash
gh workflow run tag-and-bump.yml
```
Expected: after the run completes, `v0.1.0` is tagged on the commit that closed the smoke work, `main` is bumped to `0.1.1`, and the `Release` workflow kicks off. Verify with:
```bash
gh run list --workflow release.yml --limit 1
```

## Self-review checklist (for the engineer executing this plan)

- [ ] Every `git commit` in the plan has been executed. If you skipped any, go back and split the work before moving on.
- [ ] `npm test` is green at the end of every task, not just the final one.
- [ ] `npm run build` succeeds with no TS errors after Task 15.
- [ ] `.env` is never committed (check with `git status` before every commit).
- [ ] `manifest.json`, `package.json`, and `src/index.ts` all report the same version string.
- [ ] Coverage spot-check: `npm run test:coverage` — `src/client.ts` and each `src/tools/*.ts` should be ≥ 80% lines. If under, add the missing test and commit.
