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
