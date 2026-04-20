/**
 * Extract an `__INITIAL_STATE__` JSON object from an OpenTable HTML page.
 *
 * OpenTable renders state in one of two forms:
 *   1. `window.__INITIAL_STATE__ = {...};` — a JS assignment in a <script> tag
 *      (seen after hydration, and sometimes in the server-rendered HTML too).
 *   2. `"__INITIAL_STATE__":{...}` — a JSON key inside a larger embedded blob
 *      (the current server-rendered form for most user-facing pages).
 *
 * Both forms use the same JSON object; this extractor locates it and walks
 * the brace/string structure to find its matching close (can't use regex —
 * the state contains nested objects and escaped strings).
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function extractInitialState(html: string): Record<string, unknown> {
  const markers = ['window.__INITIAL_STATE__', '"__INITIAL_STATE__"'];
  let idx = -1;
  let markerLen = 0;
  for (const m of markers) {
    const i = html.indexOf(m);
    if (i >= 0) {
      idx = i;
      markerLen = m.length;
      break;
    }
  }
  if (idx < 0) {
    throw new ParseError('__INITIAL_STATE__ marker not found in HTML');
  }

  let start = idx + markerLen;
  while (start < html.length && html[start] !== '{') start++;
  if (start >= html.length) {
    throw new ParseError('Could not locate start of __INITIAL_STATE__ JSON');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    throw new ParseError('Unmatched braces in __INITIAL_STATE__');
  }

  const json = html.slice(start, end);
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `Failed to parse __INITIAL_STATE__ JSON: ${(err as Error).message}`
    );
  }
}
