import { describe, it, expect } from 'vitest';
import { extractInitialState, IncompletePageError, INCOMPLETE_PAGE_MAX_CHARS, ParseError } from '../src/initial-state.js';

// OpenTable sometimes answers a page fetch with HTTP 200 and a short
// placeholder (≈2.7 KB, no title, no state) before the real ≈438 KB page has
// loaded, or with a human-verification page (#269). That is a browser-session
// condition the user can fix, not a page-format change, so it gets its own
// error with a recovery step — still a ParseError for every existing catch.
const placeholder = `<!doctype html><html><head><meta charset="utf-8"></head><body>${'<div></div>'.repeat(200)}</body></html>`;

describe('extractInitialState', () => {
  it('reports a short page with no state as an incomplete page, with a recovery step', () => {
    let thrown: unknown;
    try { extractInitialState(placeholder); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(IncompletePageError);
    expect(thrown).toBeInstanceOf(ParseError);
    const message = (thrown as Error).message;
    expect(message).toContain(`${placeholder.length} characters`);
    expect(message).toMatch(/not a change in the page format/);
    expect(message).toMatch(/refresh the restaurant's page .*in the signed-in bridged browser/);
    expect(message).toMatch(/retry once/);
  });

  it('keeps a full-size page with no state a genuine parse error (the format changed)', () => {
    const big = `<html><title>Restaurant</title>${'x'.repeat(INCOMPLETE_PAGE_MAX_CHARS)}</html>`;
    expect(() => extractInitialState(big)).toThrow(ParseError);
    expect(() => extractInitialState(big)).not.toThrow(IncompletePageError);
  });

  it('keeps a short page whose state marker is present but broken a genuine parse error', () => {
    const broken = '<script>window.__INITIAL_STATE__ = {"restaurantProfile": </script>';
    expect(() => extractInitialState(broken)).toThrow('__INITIAL_STATE__ not found or unparseable in HTML');
    expect(() => extractInitialState(broken)).not.toThrow(IncompletePageError);
  });

  it('still parses a short page that carries its state', () => {
    expect(extractInitialState('<script>window.__INITIAL_STATE__ = {"a":1};</script>')).toEqual({ a: 1 });
  });
});
