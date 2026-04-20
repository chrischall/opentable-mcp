#!/usr/bin/env tsx
/**
 * Live smoke of the three v0.2.0-alpha.1 tools. Reads cookies from
 * $OPENTABLE_COOKIES_PATH or /tmp/ot-cookies.txt, invokes each tool
 * against the real API, and prints a redacted summary (no PII).
 *
 * Run: OPENTABLE_COOKIES_PATH=/tmp/ot-cookies.txt npx tsx scripts/e2e-phase1.ts
 */
import { OpenTableClient } from '../src/client.ts';
import { parseDiningDashboard } from '../src/parse-dining-dashboard.ts';
import { parseUserProfile } from '../src/parse-user-profile.ts';
import { parseFavorites } from '../src/parse-favorites.ts';

const client = new OpenTableClient();
try {
  console.log('── fetching /user/dining-dashboard ──');
  const ddHtml = await client.fetchHtml('/user/dining-dashboard');
  console.log(`  ${ddHtml.length} bytes`);

  const upcoming = parseDiningDashboard(ddHtml, 'upcoming');
  const past = parseDiningDashboard(ddHtml, 'past');
  console.log(`  list_reservations upcoming=${upcoming.length} past=${past.length}`);
  if (upcoming[0]) {
    console.log(
      `    upcoming[0]: date=${upcoming[0].date} time=${upcoming[0].time} ` +
        `party_size=${upcoming[0].party_size} status=${upcoming[0].status} ` +
        `restaurant_name.length=${upcoming[0].restaurant_name.length} ` +
        `has_security_token=${upcoming[0].security_token.length > 0}`
    );
  }

  const profile = parseUserProfile(ddHtml);
  console.log(
    `  get_profile: first_name.length=${profile.first_name.length} ` +
      `email.length=${profile.email.length} points=${profile.points} ` +
      `metro=${profile.metro.length > 0 ? profile.metro : '(empty)'} ` +
      `member_since=${profile.member_since.slice(0, 10)} is_vip=${profile.is_vip}`
  );

  console.log('── fetching /user/favorites ──');
  const favHtml = await client.fetchHtml('/user/favorites');
  console.log(`  ${favHtml.length} bytes`);
  const favorites = parseFavorites(favHtml);
  console.log(`  list_favorites count=${favorites.length}`);
  if (favorites[0]) {
    console.log(
      `    favorites[0]: name.length=${favorites[0].name.length} ` +
        `restaurant_id.length=${favorites[0].restaurant_id.length} ` +
        `has_url=${favorites[0].url.length > 0}`
    );
  }
} finally {
  await client.close();
}
