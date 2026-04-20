#!/usr/bin/env tsx
/**
 * End-to-end proof: fetch the live OpenTable dining dashboard from Node
 * and run it through `parseDiningDashboard`. Needs two ingredients:
 *
 *   1. `cycletls` (installed as a devDep) — spoofs the Chrome JA3 TLS
 *      fingerprint. Without this, Akamai Bot Manager returns 403.
 *   2. `/tmp/ot-cookies.txt` (mode 600) — the full `document.cookie` from
 *      an authenticated Chrome session on opentable.com. Includes the
 *      Akamai session cookies (`_abck`, `bm_sz`, `bm_so`, etc.) *and* the
 *      OpenTable auth cookies (`authCke`, `ha_userSession`).
 *
 * Run:
 *     npm install --save-dev cycletls   # one-time
 *     # (export cookies from an authenticated Chrome tab into /tmp/ot-cookies.txt)
 *     npx tsx scripts/e2e-list-reservations.ts
 *
 * This script is a spike, not a shipped tool: it hard-codes the cookie
 * file path and runs exactly one probe. Operationalising into the MCP
 * server needs a sustainable cookie-refresh story and handling of the
 * `_abck` rotation Akamai does on failed checks.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import initCycleTLS from 'cycletls';
import {
  parseDiningDashboard,
  type FormattedReservation,
} from '../src/parse-dining-dashboard.ts';

const COOKIE_FILE = '/tmp/ot-cookies.txt';

if (!existsSync(COOKIE_FILE)) {
  console.error(
    `Missing ${COOKIE_FILE}. Export document.cookie from an authenticated\n` +
      `opentable.com tab (DevTools → Console → \`copy(document.cookie)\`), then\n` +
      `write to the file with chmod 600.`
  );
  process.exit(1);
}
const cookieHeader = readFileSync(COOKIE_FILE, 'utf8').trim();

// JA3 matches desktop Chrome 131 on macOS. If Akamai starts rejecting
// requests, capture the ClientHello from a real session and update.
const CHROME_131_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,' +
  '0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cycletls = await initCycleTLS();
let html: string;
try {
  const resp = await cycletls(
    'https://www.opentable.com/user/dining-dashboard',
    {
      ja3: CHROME_131_JA3,
      userAgent: CHROME_UA,
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        Cookie: cookieHeader,
      },
      timeout: 25,
    },
    'GET'
  );
  if (resp.status !== 200) {
    throw new Error(`OpenTable responded ${resp.status} — cookies may be expired`);
  }
  html = typeof resp.data === 'string' ? resp.data : String(resp.data);
  console.log('fetched', html.length, 'bytes, status', resp.status);
} finally {
  await cycletls.exit();
}

const upcoming = parseDiningDashboard(html, 'upcoming');
const past = parseDiningDashboard(html, 'past');

// Redacted summary: no PII on stdout. Shape-only so CI / logs are safe.
const summary = (r: FormattedReservation) => ({
  date: r.date,
  time: r.time,
  party_size: r.party_size,
  status: r.status,
  reservation_type: r.reservation_type,
  restaurant_name_len: r.restaurant_name.length,
  has_security_token: r.security_token.length > 0,
});
console.log('upcoming:', upcoming.length, upcoming.map(summary));
console.log('past:', past.length, 'entries; first:', past.slice(0, 1).map(summary));

// Full result (contains PII) → /tmp/ot-e2e-result.json (0600) for manual
// inspection. Repo .gitignore already excludes /tmp/ implicitly.
writeFileSync(
  '/tmp/ot-e2e-result.json',
  JSON.stringify({ upcoming, past }, null, 2),
  { mode: 0o600 }
);
console.log('full result → /tmp/ot-e2e-result.json (chmod 600)');
