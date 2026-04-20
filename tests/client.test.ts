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
    // Attach a swallow-handler before advancing timers so Node doesn't flag
    // the rejection as unhandled during the tick when it fires.
    pending.catch(() => {});

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
