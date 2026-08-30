import { describe, it, expect } from 'vitest';
import {
  OPENTABLE_BASE_URL,
  absoluteAssetUrl,
  opentableUrl,
  restaurantCandidatePaths,
  restaurantProfilePath,
} from '../src/urls.js';

describe('restaurantProfilePath', () => {
  // Live-verified 2026-08-27 on two real venues: /restaurant/profile/{id}
  // returns the full restaurantProfile SSR state, while /r/{id} 404s. The ids
  // below are synthetic — see the note in src/urls.ts.
  it('builds the numeric-id detail route', () => {
    expect(restaurantProfilePath(7654321)).toBe('/restaurant/profile/7654321');
  });

  it('accepts a numeric id that arrived as a string', () => {
    expect(restaurantProfilePath('7654322')).toBe('/restaurant/profile/7654322');
  });

  it('never emits the /r/{numeric-id} shape, which 404s', () => {
    expect(restaurantProfilePath(2508)).not.toBe('/r/2508');
  });
});

describe('restaurantCandidatePaths', () => {
  it('routes a numeric id to the profile route only', () => {
    expect(restaurantCandidatePaths(7654321)).toEqual(['/restaurant/profile/7654321']);
  });

  it('routes an all-digits string to the profile route too', () => {
    expect(restaurantCandidatePaths('7654321')).toEqual(['/restaurant/profile/7654321']);
  });

  it('tries /r/{slug} before the legacy root /{slug} for a bare slug', () => {
    expect(restaurantCandidatePaths('le-serpent-montreal')).toEqual([
      '/r/le-serpent-montreal',
      '/le-serpent-montreal',
    ]);
  });

  it('uses an absolute path verbatim as the single candidate', () => {
    expect(restaurantCandidatePaths('/the-cellar-at-duckworths')).toEqual([
      '/the-cellar-at-duckworths',
    ]);
  });

  it('reduces a full URL to its path (+ query) and uses it verbatim', () => {
    expect(
      restaurantCandidatePaths('https://www.opentable.com/r/le-serpent-montreal')
    ).toEqual(['/r/le-serpent-montreal']);
    expect(
      restaurantCandidatePaths('https://www.opentable.com/r/x?covers=2')
    ).toEqual(['/r/x?covers=2']);
  });

  it('drops a foreign origin rather than letting it retarget the transport', () => {
    // The transport pins opentable.com, so only the path can survive. Assert
    // the host is gone rather than smuggled into the path.
    const [path] = restaurantCandidatePaths('https://evil.example/r/le-serpent-montreal');
    expect(path).toBe('/r/le-serpent-montreal');
    expect(path).not.toContain('evil.example');
  });

  it('trims surrounding whitespace before deciding the shape', () => {
    expect(restaurantCandidatePaths('  7654321  ')).toEqual([
      '/restaurant/profile/7654321',
    ]);
  });

  it('percent-encodes a slug so it cannot escape its path segment', () => {
    expect(restaurantCandidatePaths('a/b')).toEqual(['/r/a%2Fb', '/a%2Fb']);
  });
});

describe('absoluteAssetUrl', () => {
  // OpenTable's SSR state ships photos protocol-relative; that form resolves
  // in a browser and nowhere else, so it must not reach a tool result.
  it('gives a protocol-relative URL an https scheme', () => {
    expect(absoluteAssetUrl('//resizer.otstatic.com/v3/photos/80193677-2')).toBe(
      'https://resizer.otstatic.com/v3/photos/80193677-2'
    );
  });

  it('leaves an already-absolute URL untouched', () => {
    expect(absoluteAssetUrl('https://cdn.example/hero.jpg')).toBe(
      'https://cdn.example/hero.jpg'
    );
    expect(absoluteAssetUrl('http://cdn.example/hero.jpg')).toBe(
      'http://cdn.example/hero.jpg'
    );
  });

  it('resolves a root-relative URL against the opentable.com origin', () => {
    expect(absoluteAssetUrl('/img/x.jpg')).toBe(`${OPENTABLE_BASE_URL}/img/x.jpg`);
  });

  it('returns empty string for missing / blank input', () => {
    expect(absoluteAssetUrl(undefined)).toBe('');
    expect(absoluteAssetUrl(null)).toBe('');
    expect(absoluteAssetUrl('')).toBe('');
    expect(absoluteAssetUrl('   ')).toBe('');
  });

  it('produces something new URL() actually accepts', () => {
    const out = absoluteAssetUrl('//resizer.otstatic.com/v3/photos/1-2');
    expect(() => new URL(out)).not.toThrow();
  });
});

describe('opentableUrl', () => {
  it('joins a root-relative path onto the canonical origin', () => {
    expect(opentableUrl('/user/dining-dashboard')).toBe(
      'https://www.opentable.com/user/dining-dashboard'
    );
  });

  it('inserts the missing slash rather than concatenating into the host', () => {
    expect(opentableUrl('user/favorites')).toBe(
      'https://www.opentable.com/user/favorites'
    );
    expect(opentableUrl('user/favorites')).not.toContain('comuser');
  });

  it('passes an absolute URL through unchanged', () => {
    expect(opentableUrl('https://www.opentable.com/r/x')).toBe(
      'https://www.opentable.com/r/x'
    );
  });
});

describe('canonical routes stay pinned', () => {
  // These are the read-only paths the tools depend on. Live-verified
  // 2026-08-27 through the bridged session: the dining dashboard backs
  // list_reservations + get_profile, and /user/favorites returns a list.
  it('uses the documented dashboard and favorites routes', () => {
    expect(opentableUrl('/user/dining-dashboard')).toBe(
      'https://www.opentable.com/user/dining-dashboard'
    );
    expect(opentableUrl('/user/favorites')).toBe(
      'https://www.opentable.com/user/favorites'
    );
  });
});
