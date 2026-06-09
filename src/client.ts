// OpenTableClient is the thin, tool-facing API over an OpenTableTransport.
// Every tool goes through fetchHtml() (SSR pages) or fetchJson() (API
// endpoints). The transport — FetchproxyTransport (wraps
// @fetchproxy/server's FetchproxyServer) by default, or
// HTTP-to-hangwin/mcp-chrome when enabled — handles the actual
// round-trip to the user's Chrome.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it AND so it stays
// consistent across transports.
import {
  SessionNotAuthenticatedError,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import type { FetchInit, FetchResult, OpenTableTransport } from './transport.js';

/**
 * Thrown on any non-2xx response. Carries the numeric `status` so callers
 * can branch on it (e.g. `opentable_get_restaurant` falls back from
 * `/r/{slug}` to `/{slug}` on a 404). The `message` is unchanged from the
 * previous plain-Error form, so existing string/regex assertions still hold.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// Sign-in failures throw the canonical SessionNotAuthenticatedError from
// @chrischall/mcp-utils (re-exported below for existing import sites).
// NOTE: the message changed from the old local copy ("Open the pinned
// OpenTable tab…") to the fleet-wide canonical form ("Not signed in to
// OpenTable. Open opentable.com in your browser and sign in, then try
// again. …").
export { SessionNotAuthenticatedError };

export interface OpenTableClientOptions {
  /** Transport used to relay fetches to the user's browser. Required —
   *  no implicit default since the migration to @fetchproxy/server. */
  transport: OpenTableTransport;
}

export class OpenTableClient {
  private readonly transport: OpenTableTransport;

  constructor(opts: OpenTableClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * GET an opentable.com path, return the HTML body. Throws if the response
   * is a non-2xx or appears to be the sign-in page.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/DELETE a JSON body, return the parsed JSON response. Throws on
   * non-2xx, invalid JSON, or sign-in page.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'POST' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<T> {
    const serialised: FetchInit = {
      path,
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, serialised.method, path);
    this.throwIfSignInPage(result);
    // 204 No Content (common on void mutations like /dapi/wishlist/add): return null.
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `OpenTable ${serialised.method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // Include the response body (collapsed + trimmed) — OpenTable's 4xx bodies
    // usually name the missing/invalid field, which is essential for debugging
    // write tools. truncateErrorMessage (mcp-utils) redacts any bearer/JWT
    // secrets and caps the length at the fleet-wide 500-char budget; we collapse
    // internal whitespace first so multi-line HTML error pages stay one line.
    const collapsed = result.body.replace(/\s+/g, ' ').trim();
    const bodyPreview = collapsed ? ` — ${truncateErrorMessage(collapsed)}` : '';
    throw new HttpError(
      result.status,
      `OpenTable API error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    const signInMarkers = [
      '/authenticate/start',
      'continue-with-email-button',
      'header-sign-in-button',
    ];
    const looksLikeSignIn =
      result.url.includes('/authenticate/') ||
      signInMarkers.some((m) => result.body.includes(m) && result.body.length < 80_000);
    if (looksLikeSignIn) {
      throw new SessionNotAuthenticatedError('OpenTable', 'opentable.com');
    }
  }
}
