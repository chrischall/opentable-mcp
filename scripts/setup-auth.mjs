#!/usr/bin/env node
/**
 * OpenTable MCP auth setup.
 *
 * Launches the user's system Chrome with a dedicated profile, opens
 * opentable.com, waits for them to sign in (email OTP), then captures the
 * full cookie jar — Akamai's bot-manager cookies (`_abck`, `bm_sz`, `bm_so`,
 * `bm_sv`, `bm_lso`) plus OpenTable's auth (`authCke`, `ha_userSession`,
 * session IDs). All are required: Akamai cookies let us past the bot wall,
 * OpenTable cookies identify the logged-in user.
 *
 * Usage:
 *   setup-auth.mjs                  -> writes to ~/.config/opentable-mcp/cookies.txt
 *   setup-auth.mjs <ENV_FILE>       -> writes OPENTABLE_COOKIES=<value> to ENV_FILE
 *   setup-auth.mjs --print          -> prints the cookie string to stdout
 *
 * Pattern cribbed from creditkarma-mcp/scripts/setup-auth.mjs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const LOGIN_URL = 'https://www.opentable.com/';
const AUTH_COOKIE_NAME = 'authCke';
const TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COOKIE_FILE = path.join(os.homedir(), '.config', 'opentable-mcp', 'cookies.txt');

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Update (or create) an env file, preserving other keys. 0600 perms.
 */
export function writeEnvVar(envPath, key, value) {
  let contents = '';
  if (fs.existsSync(envPath)) {
    contents = fs.readFileSync(envPath, 'utf8');
  }
  const lineRe = new RegExp(`^${key}=.*$`, 'm');
  if (lineRe.test(contents)) {
    contents = contents.replace(lineRe, `${key}=${value}`);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += `${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, contents, { mode: 0o600 });
}

async function loadPuppeteer() {
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    console.log('Installing puppeteer-core (~1 MB, one time)...');
    execSync('npm install --no-save puppeteer-core', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    return (await import('puppeteer-core')).default;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: setup-auth.mjs [--print] [ENV_FILE]');
    console.log('');
    console.log('  No args: writes cookies to ~/.config/opentable-mcp/cookies.txt');
    console.log('           (the default location the server reads).');
    console.log('  --print: also prints the cookie string to stdout (for MCPB paste).');
    console.log('  ENV_FILE: writes OPENTABLE_COOKIES=<value> to that env file.');
    return;
  }
  const shouldPrint = args.includes('--print');
  const envFile = args.find((a) => !a.startsWith('-'));

  const chromePath = findChrome();
  if (!chromePath) {
    console.error(
      'Could not find Google Chrome. Install from https://chrome.google.com/ ' +
        'or fall back to the manual DevTools cookie-copy flow in the README.'
    );
    process.exit(1);
  }

  const puppeteer = await loadPuppeteer();

  const profileDir = path.join(os.homedir(), '.opentable-mcp', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('');
  console.log('Launching Chrome with a dedicated profile at:');
  console.log(`  ${profileDir}`);
  console.log('');
  console.log('Sign in to OpenTable when the window opens. OpenTable uses');
  console.log('passwordless OTP — enter your email, click "Use email instead",');
  console.log('then paste the code from your inbox. The script will detect the');
  console.log('login automatically and close the browser.');
  console.log('');

  // OpenTable is behind Akamai Bot Manager (TLS/HTTP-2 fingerprint + JS
  // challenge) which trips hard on Chrome's default automation tells. Strip them:
  //   - drop --enable-automation (sets navigator.webdriver + shows the infobar)
  //   - add --disable-blink-features=AutomationControlled (the actual gate)
  //   - override navigator.webdriver before any page script runs
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir: profileDir,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const [page] = await browser.pages();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const cookies = await waitForLogin(page);
  killBrowser(browser);

  if (!cookies) {
    console.error(
      `Timed out after ${TIMEOUT_MS / 60000} minutes without detecting a login.`
    );
    process.exit(1);
  }

  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  if (envFile) {
    writeEnvVar(path.resolve(envFile), 'OPENTABLE_COOKIES', cookieHeader);
    console.log('');
    console.log(`Wrote OPENTABLE_COOKIES to ${envFile}`);
    console.log('Restart Claude (or `node dist/bundle.js`) to pick it up.');
  } else {
    fs.mkdirSync(path.dirname(DEFAULT_COOKIE_FILE), { recursive: true });
    fs.writeFileSync(DEFAULT_COOKIE_FILE, cookieHeader, { mode: 0o600 });
    console.log('');
    console.log(`Wrote ${cookieHeader.length} bytes to ${DEFAULT_COOKIE_FILE} (mode 600)`);
    console.log('That is the default path the MCP server reads from.');
  }

  if (shouldPrint) {
    console.log('');
    console.log('OPENTABLE_COOKIES (paste into MCPB / Claude Desktop config):');
    console.log('');
    console.log(cookieHeader);
    console.log('');
  }
}

function killBrowser(browser) {
  const proc = browser.process();
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * Poll the page cookie jar every second until authCke appears, then return
 * the full cookie list for opentable.com (Akamai + OT domain cookies).
 */
async function waitForLogin(page) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const cookies = await page.cookies('https://www.opentable.com').catch(() => []);
    const hasAuth = cookies.some((c) => c.name === AUTH_COOKIE_NAME && c.value);
    if (hasAuth) return cookies;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Setup failed:', err?.message ?? err);
    process.exit(1);
  });
}
