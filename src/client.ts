import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: join(__dirname, '..', '.env'), override: false });
} catch {
  // mcpb bundle won't have dotenv — rely on process.env set by mcp_config.env
}

const BASE_URL = 'https://www.opentable.com';

// Desktop Chrome 131 on macOS. If Akamai starts rejecting, capture the
// ClientHello from a real browser session and bump these.
const CHROME_131_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,' +
  '0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function defaultCookiesPath(): string {
  return (
    process.env.OPENTABLE_COOKIES_PATH ||
    join(homedir(), '.config', 'opentable-mcp', 'cookies.txt')
  );
}

export class SessionExpiredError extends Error {
  constructor(cookiesPath: string) {
    super(
      `OpenTable session cookies at ${cookiesPath} are invalid or expired. ` +
        `Re-export document.cookie from an authenticated browser session on opentable.com.`
    );
    this.name = 'SessionExpiredError';
  }
}

export class CookiesMissingError extends Error {
  constructor(cookiesPath: string) {
    super(
      `Cookies file not found at ${cookiesPath}. ` +
        `Export document.cookie from an authenticated browser session on opentable.com ` +
        `and write it to that path (chmod 600 recommended).`
    );
    this.name = 'CookiesMissingError';
  }
}

export interface OpenTableClientOptions {
  cookiesPath?: string;
  ja3?: string;
  userAgent?: string;
}

// cycletls v2's TS types export only the constructor; the returned
// callable doesn't expose a typed overload for GET-shaped calls. Treat the
// live instance as a loose callable + `.exit` method.
type CycleTLSCallable = ((
  url: string,
  opts: Record<string, unknown>,
  method: string
) => Promise<{ status: number; data: unknown; headers?: Record<string, unknown> }>) & {
  exit(): Promise<void>;
};

export class OpenTableClient {
  private readonly cookiesPath: string;
  private readonly ja3: string;
  private readonly userAgent: string;
  private cycle: CycleTLSCallable | null = null;
  private closing = false;

  constructor(opts: OpenTableClientOptions = {}) {
    this.cookiesPath = opts.cookiesPath ?? defaultCookiesPath();
    this.ja3 = opts.ja3 ?? CHROME_131_JA3;
    this.userAgent = opts.userAgent ?? CHROME_UA;
  }

  /**
   * Fetch a user-facing OpenTable page and return its HTML body.
   * Throws SessionExpiredError if the request comes back 403 (bot wall or
   * invalidated cookies), or CookiesMissingError if the cookie file is gone.
   */
  async fetchHtml(path: string): Promise<string> {
    const cookie = this.readCookieHeader();
    const inst = await this.ensureCycle();
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const resp = await inst(
      url,
      {
        ja3: this.ja3,
        userAgent: this.userAgent,
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          Cookie: cookie,
        },
        timeout: 25,
      },
      'GET'
    );

    if (resp.status === 403) throw new SessionExpiredError(this.cookiesPath);
    if (resp.status !== 200) {
      throw new Error(`OpenTable API error: ${resp.status} for GET ${path}`);
    }
    return typeof resp.data === 'string' ? resp.data : String(resp.data);
  }

  /**
   * Close the cycletls Go subprocess. Call this on server shutdown.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.cycle) {
      try {
        await this.cycle.exit();
      } catch {
        // best effort
      }
      this.cycle = null;
    }
  }

  private async ensureCycle(): Promise<CycleTLSCallable> {
    if (this.cycle) return this.cycle;
    const cycletlsModule = await import('cycletls');
    const initCycleTLS = cycletlsModule.default as unknown as () => Promise<CycleTLSCallable>;
    this.cycle = await initCycleTLS();
    return this.cycle;
  }

  private readCookieHeader(): string {
    // Env var wins — convenient for MCPB install where the user can paste
    // cookies into a prompt instead of managing a file.
    const envCookies = process.env.OPENTABLE_COOKIES?.trim();
    if (envCookies) return envCookies;

    if (!existsSync(this.cookiesPath)) throw new CookiesMissingError(this.cookiesPath);
    const raw = readFileSync(this.cookiesPath, 'utf8').trim();
    if (!raw) throw new CookiesMissingError(this.cookiesPath);
    return raw;
  }
}
