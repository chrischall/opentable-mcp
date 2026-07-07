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
import { extractJsonAfterMarker } from '@chrischall/mcp-utils';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function extractInitialState(html: string): Record<string, unknown> {
  const state = extractJsonAfterMarker(html, [
    'window.__INITIAL_STATE__',
    '"__INITIAL_STATE__"',
  ]);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new ParseError('__INITIAL_STATE__ not found or unparseable in HTML');
  }
  return state as Record<string, unknown>;
}
