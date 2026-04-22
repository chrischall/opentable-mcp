// OpenTableClient is the thin, tool-facing API over the extension bridge.
// Every tool goes through fetchHtml() (SSR pages) or fetchJson() (API
// endpoints) — which ultimately routes to the companion Chrome extension
// via OpenTableWsServer. See extension/README.md for the transport and
// CLAUDE.md for the architecture diagram.
//
// This file is deliberately small; error mapping (non-2xx, sign-in
// interstitial, empty 204 body) lives here so tool authors never have
// to think about it.
import { OpenTableWsServer, type FetchInit, type FetchResult } from './ws-server.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to OpenTable. Open the pinned OpenTable tab in your browser and sign in, then try again.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

export interface OpenTableClientOptions {
  port?: number;
}

export class OpenTableClient {
  private readonly server: OpenTableWsServer;

  constructor(opts: OpenTableClientOptions = {}) {
    this.server = new OpenTableWsServer({ port: opts.port });
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * GET an opentable.com path, return the HTML body. Throws if the response
   * is a non-2xx or appears to be the sign-in page.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.server.fetch({ path, method: 'GET' });
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
    const result = await this.server.fetch(serialised);
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
    // Include the response body (trimmed) — OpenTable's 4xx bodies usually name
    // the missing/invalid field, which is essential for debugging write tools.
    const bodyPreview = result.body
      ? ` — ${result.body.slice(0, 500).replace(/\s+/g, ' ').trim()}${
          result.body.length > 500 ? '…' : ''
        }`
      : '';
    throw new Error(
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
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}
