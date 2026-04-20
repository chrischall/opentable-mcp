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
