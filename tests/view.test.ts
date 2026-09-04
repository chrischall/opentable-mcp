import { describe, it, expect } from 'vitest';
import { OT_VIEWS, viewArg, viewResponse } from '../src/view.js';

/** The text a tool result actually carries, which is the thing under test. */
function textOf(result: ReturnType<typeof viewResponse>): string {
  return (result.content[0] as { text: string }).text;
}

/** …parsed back, for the assertions that are about content rather than bytes. */
function parse<T = Record<string, unknown>>(result: ReturnType<typeof viewResponse>): T {
  return JSON.parse(textOf(result)) as T;
}

describe('viewResponse', () => {
  // The entire claim of the compact-view rollout is that the CHEAP rung is what
  // a caller gets without asking. A `view` parameter that had to be passed is an
  // efficiency nobody uses; if this ever regresses to full-by-default the feature
  // is inert while still looking shipped, so it is pinned first and separately.
  it('answers in compact when no view is passed at all', () => {
    const payload = { name: 'Testeria', photo: 'https://img.example.com/a.jpg' };
    expect(parse(viewResponse(undefined, payload))).toEqual({ name: 'Testeria' });
  });

  // The opposite rung, and the escape hatch the compact docblock promises: a
  // caller who needs the URL we stripped must have a way to get it back. Equality
  // against the input object (not a subset check) is deliberate — `full` means
  // untouched, so anything added or removed here fails.
  it('returns OpenTable\'s payload untouched under view: "full"', () => {
    const payload = {
      name: 'Testeria',
      photo: 'https://img.example.com/a.jpg',
      avatar: 'https://img.example.com/b.png',
      nested: { thumbnail: 'https://img.example.com/c.gif', rating: 4.6 },
    };
    expect(parse(viewResponse('full', payload))).toEqual(payload);
  });

  // The subtractive promise, and the reason src/view.ts refuses to invent a field
  // list. Compact here strips media and NOTHING else, so a field this repo has
  // never heard of — a key OpenTable adds next month — must arrive intact. A
  // projection built from a guessed allowlist would silently drop it and the
  // record would read like a verified answer with a hole in it.
  it('passes through a field nobody anticipated, at every depth', () => {
    const payload = {
      restaurant_id: 42,
      somethingNobodyAnticipated: 'keep me',
      nested: { alsoUnanticipated: [1, 2, 3], deeper: { brandNewField: false } },
    };
    expect(parse(viewResponse(undefined, payload))).toEqual(payload);
  });

  // A `null` is data, not absence: OpenTable reports "no security token" and "we
  // did not tell you" differently, and compact must not collapse the two. (The
  // fleet helper documents drop-nulls as rejected on purpose; this pins that the
  // decision holds here.)
  it('keeps nulls and empty strings, which are answers rather than absences', () => {
    const payload = { security_token: null, description: '', points: 0 };
    expect(parse(viewResponse(undefined, payload))).toEqual(payload);
  });

  // Formatting whitespace is ours to drop; whitespace INSIDE a value is the
  // caller's content. A restaurant description is exactly where that bites —
  // paragraph breaks carry the shape of the text — so the round trip is asserted
  // byte-for-byte, not merely "looks similar". Any hand-rolled minifier (a regex
  // over the serialised text, a collapse of \s+) fails this.
  it('leaves whitespace inside a value byte-identical', () => {
    const description = 'First paragraph.\n\n  Indented second line.\n\tTabbed third.\n\nEnd.';
    for (const view of [undefined, 'compact', 'full']) {
      expect(parse<{ description: string }>(viewResponse(view, { description })).description).toBe(
        description
      );
    }
  });

  // The saving itself. Indentation is ~a fifth of a large response and nothing
  // downstream reads it, so the emitted text must be one line — checked on the
  // serialised bytes, because a pretty-printed result parses identically and
  // would sail past every content assertion above.
  it('emits a single line of text on every rung', () => {
    const payload = { a: 1, b: { c: [1, 2, 3] }, d: 'x' };
    for (const view of [undefined, 'compact', 'full']) {
      const text = textOf(viewResponse(view, payload));
      expect(text.split('\n')).toHaveLength(1);
      expect(text).not.toMatch(/\n|\r/);
      expect(text).toBe(JSON.stringify(payload));
    }
  });

  // This server honours two rungs, not the fleet's three. A caller that names
  // `raw` — a rung that exists elsewhere in the fleet and is an easy thing to
  // reach for — gets the cheap answer, not an exception: a small correct response
  // beats a failed tool call for a mistake the caller cannot see they made. The
  // schema is the first line of defence (below); this is the second.
  it('falls back to compact for a rung this server does not honour', () => {
    const payload = { name: 'Testeria', photo: 'https://img.example.com/a.jpg' };
    expect(OT_VIEWS).not.toContain('raw');
    expect(parse(viewResponse('raw', payload))).toEqual({ name: 'Testeria' });
    expect(parse(viewResponse('nonsense', payload))).toEqual({ name: 'Testeria' });
  });
});

describe('viewArg', () => {
  // The schema must advertise only what src/view.ts can honour, or a host shows
  // the model a rung that silently aliases to another one.
  it('accepts the honoured rungs, rejects the ones this server has no answer for', () => {
    const schema = viewArg();
    expect(schema.parse(undefined)).toBeUndefined();
    for (const rung of OT_VIEWS) expect(schema.parse(rung)).toBe(rung);
    expect(schema.safeParse('raw').success).toBe(false);
  });

  // The description is the only place a caller learns what compact costs them.
  // `.describe()` has to land on the OPTIONAL wrapper — applied to the inner enum
  // it comes back blank, which is a parameter documented to nobody.
  it('carries the per-tool note on the wrapper a host actually reads', () => {
    expect(viewArg().description).toContain('image/avatar URLs');
  });
});
