import { extractInitialState, ParseError } from './initial-state.js';

export interface RestaurantMenus {
  restaurant_id: number | null;
  name: string;
  url: string;
  status: 'available' | 'external_only' | 'not_available' | 'menu_not_found';
  available_menus: string[];
  // Keep the observed menu payload intact: prices are strings, and variations,
  // currency, provider, updated timestamps and future fields are content.
  menus: Record<string, unknown>[];
  menu_url: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function menuUrl(value: unknown, sourceUrl: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, sourceUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Menus are a sibling of restaurantProfile.restaurant, not a field on it.
 * On 2026-10-06 SOCIAL's embedded application JSON carried all five menus
 * here, including Dinner, without clicking a menu tab or issuing another API
 * call. menuInfo.url can coexist with structured menus or be the only menu.
 */
export function parseMenu(
  html: string,
  sourceUrl: string,
  menuName?: string,
): RestaurantMenus {
  const state = extractInitialState(html);
  const profile = state.restaurantProfile;
  if (!isRecord(profile) || !isRecord(profile.restaurant)) {
    throw new ParseError('restaurantProfile.restaurant not present in __INITIAL_STATE__ (page may not be a restaurant profile)');
  }
  const container = profile.menus;
  if (container != null && !isRecord(container)) {
    throw new ParseError('restaurantProfile.menus is not an object');
  }
  const raw = container?.menuData;
  if (raw != null && (!Array.isArray(raw) || !raw.every(isRecord))) {
    throw new ParseError('restaurantProfile.menus.menuData is not an array of menu objects');
  }
  const menus: Record<string, unknown>[] = raw ?? [];
  const availableMenus = menus.map(menu => menu.title).filter((title): title is string => typeof title === 'string');
  const selected = menuName === undefined ? menus : menus.filter(menu =>
    typeof menu.title === 'string' && menu.title.trim().toLowerCase() === menuName.trim().toLowerCase(),
  );
  const info = container?.menuInfo;
  const externalUrl = menuUrl(isRecord(info) ? info.url : undefined, sourceUrl);
  const status = menus.length > 0
    ? selected.length > 0 ? 'available' : 'menu_not_found'
    : externalUrl ? 'external_only' : 'not_available';

  return {
    restaurant_id: typeof profile.restaurant.restaurantId === 'number' ? profile.restaurant.restaurantId : null,
    name: typeof profile.restaurant.name === 'string' ? profile.restaurant.name : 'Unknown',
    url: sourceUrl,
    status,
    available_menus: availableMenus,
    menus: selected,
    menu_url: externalUrl,
  };
}
