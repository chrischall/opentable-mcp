import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseMenu } from '../src/parse-menu.js';
import { ParseError } from '../src/initial-state.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/restaurant-menus-state.json', import.meta.url), 'utf8'));
const url = 'https://www.opentable.com/r/fixture-cafe';
// Synthetic content, with the embedded JSON/menu shape observed on 2026-10-06.
function htmlWith(state: unknown): string {
  return `<script type="application/json">${JSON.stringify({ windowVariables: { __INITIAL_STATE__: state } })}</script>`;
}

describe('parseMenu', () => {
  it('reads every published menu from the embedded page JSON with provenance', () => {
    const result = parseMenu(htmlWith(fixture), url);
    expect(result).toMatchObject({
      restaurant_id: 42, name: 'Fixture Cafe', url, status: 'available',
      available_menus: ['Breakfast', 'Dinner'], menu_url: 'https://example.com/menu',
    });
    expect(result.menus).toEqual(fixture.restaurantProfile.menus.menuData);
  });

  it('also accepts the window assignment form', () => {
    expect(parseMenu(`<script>window.__INITIAL_STATE__ = ${JSON.stringify(fixture)};</script>`, url).menus).toHaveLength(2);
  });

  it('selects an exact menu title case-insensitively and keeps the available titles', () => {
    const result = parseMenu(htmlWith(fixture), url, ' dinner ');
    expect(result.status).toBe('available');
    expect(result.available_menus).toEqual(['Breakfast', 'Dinner']);
    expect(result.menus).toEqual([fixture.restaurantProfile.menus.menuData[1]]);
  });

  it('reports a missing selection without claiming that no menus exist', () => {
    expect(parseMenu(htmlWith(fixture), url, 'Lunch')).toMatchObject({
      status: 'menu_not_found', menus: [], available_menus: ['Breakfast', 'Dinner'],
      menu_url: 'https://example.com/menu',
    });
  });

  it('preserves string/zero/null prices, variations, text, metadata, and unknown fields', () => {
    const state = structuredClone(fixture);
    state.restaurantProfile.menus.menuData[1].futureField = { value: 'preserve me' };
    const result = parseMenu(htmlWith(state), url, 'Dinner');
    expect(result.menus[0]).toEqual(state.restaurantProfile.menus.menuData[1]);
  });

  it.each([undefined, null, { menuData: [] }])('reports absent menus (%j)', (menus) => {
    expect(parseMenu(htmlWith({ restaurantProfile: { restaurant: { restaurantId: 42 }, menus } }), url))
      .toMatchObject({ status: 'not_available', menus: [], available_menus: [], menu_url: null });
  });

  it('returns an external-only menu without fetching it', () => {
    const state = { restaurantProfile: { restaurant: {}, menus: { menuInfo: { url: '//example.com/menu.pdf' } } } };
    expect(parseMenu(htmlWith(state), url)).toMatchObject({ status: 'external_only', menu_url: 'https://example.com/menu.pdf', menus: [] });
  });

  it.each(['javascript:alert(1)', 'data:text/html,menu', 'file:///etc/passwd'])('does not expose a non-HTTP menu link (%s)', (link) => {
    const state = { restaurantProfile: { restaurant: {}, menus: { menuInfo: { url: link } } } };
    expect(parseMenu(htmlWith(state), url)).toMatchObject({ status: 'not_available', menu_url: null });
  });

  it('keeps menus with optional metadata or item fields absent', () => {
    const menus = [{ title: 'Menú', sections: [{ description: 'Notes only' }] }];
    const state = { restaurantProfile: { restaurant: {}, menus: { menuData: menus } } };
    expect(parseMenu(htmlWith(state), url, 'MENÚ').menus).toEqual(menus);
  });

  it.each(['invalid', { menuData: {} }, { menuData: [null] }])('does not turn malformed menu containers into an empty result (%j)', (menus) => {
    expect(() => parseMenu(htmlWith({ restaurantProfile: { restaurant: {}, menus } }), url)).toThrow(ParseError);
  });

  it('does not interpret a challenge page or missing restaurant state as no menu', () => {
    expect(() => parseMenu('<html>Verify you are human</html>', url)).toThrow(ParseError);
    expect(() => parseMenu(htmlWith({ restaurantProfile: { menus: {} } }), url)).toThrow(ParseError);
  });
});
