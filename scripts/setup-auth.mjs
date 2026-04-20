#!/usr/bin/env node
/**
 * OpenTable MCP auth setup.
 *
 * Reads session cookies from the clipboard (after the user exports them
 * from an authenticated opentable.com tab) and writes them to the
 * cookies file the server reads.
 *
 * We originally tried puppeteer-core for a fully-automated flow (same as
 * creditkarma-mcp does for creditkarma.com), but Akamai Bot Manager
 * detects puppeteer-driven Chrome regardless of stealth flags and serves
 * an Access Denied page. So: no automation. The user signs in themselves
 * in their regular Chrome, which has a real TLS/JS fingerprint Akamai is
 * happy with, and just pastes the cookies here.
 *
 * Usage:
 *   setup-auth.mjs                  -> writes to ~/.config/opentable-mcp/cookies.txt
 *   setup-auth.mjs <ENV_FILE>       -> writes OPENTABLE_COOKIES=<value> to ENV_FILE
 *   setup-auth.mjs --open           -> also opens opentable.com in the default browser
 *   setup-auth.mjs --print          -> also prints the cookie string to stdout
 */
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_COOKIE_FILE = path.join(
  os.homedir(),
  '.config',
  'opentable-mcp',
  'cookies.txt'
);
const AUTH_COOKIE_NAME = 'authCke';

/**
 * Try to read the system clipboard. Returns null if unavailable.
 */
function readClipboard() {
  const runners = {
    darwin: ['pbpaste', []],
    linux: ['xclip', ['-selection', 'clipboard', '-o']],
    win32: ['powershell', ['-command', 'Get-Clipboard']],
  };
  const [cmd, args] = runners[process.platform] ?? [null, []];
  if (!cmd) return null;
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function openInBrowser(url) {
  const runners = {
    darwin: 'open',
    linux: 'xdg-open',
    win32: 'start',
  };
  const cmd = runners[process.platform];
  if (!cmd) return;
  try {
    execSync(`${cmd} ${JSON.stringify(url)}`, { stdio: 'ignore' });
  } catch {
    // best effort
  }
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

export function writeEnvVar(envPath, key, value) {
  let contents = '';
  if (fs.existsSync(envPath)) contents = fs.readFileSync(envPath, 'utf8');
  const lineRe = new RegExp(`^${key}=.*$`, 'm');
  if (lineRe.test(contents)) {
    contents = contents.replace(lineRe, `${key}=${value}`);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += `${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, contents, { mode: 0o600 });
}

function validateCookieHeader(raw) {
  if (!raw || raw.length < 100) {
    return { ok: false, reason: 'empty or too short — expected a few KB' };
  }
  if (!raw.includes(`${AUTH_COOKIE_NAME}=`)) {
    return {
      ok: false,
      reason: `missing ${AUTH_COOKIE_NAME}= (are you signed in?)`,
    };
  }
  if (!raw.includes('_abck=')) {
    return {
      ok: false,
      reason:
        'missing Akamai _abck cookie — did you copy from opentable.com specifically?',
    };
  }
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: setup-auth.mjs [--open] [--print] [ENV_FILE]');
    console.log('');
    console.log('  No args:  writes cookies to ~/.config/opentable-mcp/cookies.txt.');
    console.log('  --open:   also opens opentable.com in your default browser.');
    console.log('  --print:  also prints the cookie string to stdout (for MCPB paste).');
    console.log('  ENV_FILE: writes OPENTABLE_COOKIES=<value> to that env file.');
    return;
  }
  const shouldOpen = args.includes('--open');
  const shouldPrint = args.includes('--print');
  const envFile = args.find((a) => !a.startsWith('-'));

  console.log('');
  console.log('OpenTable session capture');
  console.log('─────────────────────────');
  console.log('');
  console.log('1. Open https://www.opentable.com/ in your regular Chrome.');
  console.log('2. Sign in (email OTP — click "Use email instead" on the popup).');
  console.log('3. Once signed in, open DevTools → Console and run:');
  console.log('');
  console.log('     copy(document.cookie)');
  console.log('');
  console.log('4. Come back here and press Enter.');
  console.log('');
  console.log(
    '   (Nothing sensitive is printed back. Cookies go to a mode-600 file.)'
  );
  console.log('');

  if (shouldOpen) openInBrowser('https://www.opentable.com/');

  await prompt('Press Enter once you have copied the cookie string… ');

  let raw = readClipboard();
  if (!raw) {
    console.log(
      "Couldn't read the clipboard automatically. Paste the cookies below and press Enter:"
    );
    raw = (await prompt('> ')).trim();
  }

  // Some users paste with leading "Cookie: " or with surrounding quotes; strip.
  raw = raw.replace(/^Cookie:\s*/i, '').replace(/^["']|["']$/g, '').trim();

  const check = validateCookieHeader(raw);
  if (!check.ok) {
    console.error(`✗ Cookie string looks wrong: ${check.reason}`);
    console.error('  Re-run the setup when you are signed in to opentable.com.');
    process.exit(1);
  }

  if (envFile) {
    writeEnvVar(path.resolve(envFile), 'OPENTABLE_COOKIES', raw);
    console.log('');
    console.log(`✓ Wrote OPENTABLE_COOKIES to ${envFile}`);
    console.log('  Restart Claude (or `node dist/bundle.js`) to pick it up.');
  } else {
    fs.mkdirSync(path.dirname(DEFAULT_COOKIE_FILE), { recursive: true });
    fs.writeFileSync(DEFAULT_COOKIE_FILE, raw, { mode: 0o600 });
    console.log('');
    console.log(
      `✓ Wrote ${raw.length} bytes to ${DEFAULT_COOKIE_FILE} (mode 600)`
    );
    console.log('  That is the default path the MCP server reads from.');
  }

  if (shouldPrint) {
    console.log('');
    console.log('OPENTABLE_COOKIES (paste into MCPB / Claude Desktop config):');
    console.log('');
    console.log(raw);
    console.log('');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Setup failed:', err?.message ?? err);
    process.exit(1);
  });
}
