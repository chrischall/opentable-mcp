/**
 * Extract an `__INITIAL_STATE__` JSON object from an OpenTable HTML page.
 *
 * OpenTable renders state in one of two forms:
 *   1. `window.__INITIAL_STATE__ = {...};` — a JS assignment in a <script> tag
 *      (seen after hydration, and sometimes in the server-rendered HTML too).
 *   2. `"__INITIAL_STATE__":{...}` — a JSON key inside a larger embedded blob
 *      (the current server-rendered form for most user-facing pages).
 *
 * Both forms use the same JSON object. The locate-marker + balanced-brace walk
 * + `JSON.parse` is now the fleet-shared `extractJsonAfterMarker` from
 * `@chrischall/mcp-utils` (its `matchBalanced` handles the nested objects and
 * escaped strings a regex can't). We keep the throwing `ParseError` contract
 * that every `parse-*` consumer and its tests rely on: the shared helper
 * returns `null` on any failure (marker absent / unbalanced / invalid JSON),
 * which this wrapper turns into a `ParseError`. No `sanitize` — a JS
 * `undefined` literal must still be a parse failure, not silently coerced.
 */
import { extractJsonAfterMarker } from '@chrischall/mcp-utils/scrape';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * A page this short with no state marker at all is not a restaurant/search
 * page whose format changed: real pages run to hundreds of KB (≈438 KB for a
 * restaurant). It is what OpenTable serves before the real page has loaded
 * (an HTTP-200 placeholder of ≈2.7 KB, #269) or a human-verification page.
 */
export const INCOMPLETE_PAGE_MAX_CHARS = 64_000;

/**
 * OpenTable answered with a placeholder or challenge page instead of the real
 * one. A ParseError subclass, so every existing `instanceof ParseError` catch
 * still applies; the message carries the recovery step a generic parse error
 * can't, since the fix is in the user's browser session, not in this server.
 */
export class IncompletePageError extends ParseError {
  constructor(chars: number) {
    super(
      `OpenTable returned an incomplete page (${chars} characters, no page state): usually a placeholder ` +
        'served before the real page finishes loading, or a human check — not a change in the page format. ' +
        "Open or refresh the restaurant's page (or the search page, for a search) in the signed-in bridged browser, " +
        'let it finish loading, complete any visible check, then retry once.',
    );
    this.name = 'IncompletePageError';
  }
}

const STATE_MARKERS = ['window.__INITIAL_STATE__', '"__INITIAL_STATE__"'];

export function extractInitialState(html: string): Record<string, unknown> {
  const state = extractJsonAfterMarker(html, STATE_MARKERS);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    if (html.length < INCOMPLETE_PAGE_MAX_CHARS && !STATE_MARKERS.some((m) => html.includes(m))) {
      throw new IncompletePageError(html.length);
    }
    throw new ParseError('__INITIAL_STATE__ not found or unparseable in HTML');
  }
  return state as Record<string, unknown>;
}
