import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Fixtures are often captured from a live signed-in session. Those captures
// carry the account's reservation credentials (confirmationNumber +
// securityToken + restaurantId is enough to cancel or modify a booking),
// its OpenTable person id and card digits. This repo is public: every
// such value must be replaced with an obviously synthetic one before
// commit. This guard fails when a fixture carries something that looks
// real.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');

// String identifiers must be visibly fake.
const SYNTHETIC_STRING = /REDACTED|FIXTURE|example\.com|-abc$/i;
const STRING_KEYS = new Set(['securityToken', 'correlationId', 'cardId', 'email']);
// Card digits must be a well-known test-card suffix.
const TEST_CARD_LAST4 = new Set(['4242', '4444', '1111', '0005']);
const LAST4_KEYS = new Set(['last4', 'creditCardLastFourDigits']);
// OpenTable global person id: never needed by any test, must be zeroed.
const ZERO_KEYS = new Set(['gpid']);

function findings(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findings(v, `${path}[${i}]`, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const at = `${path}.${k}`;
    if (STRING_KEYS.has(k) && typeof v === 'string' && v && !SYNTHETIC_STRING.test(v)) {
      out.push(`${at} looks real: ${v.slice(0, 4)}…`);
    } else if (LAST4_KEYS.has(k) && v != null && !TEST_CARD_LAST4.has(String(v))) {
      out.push(`${at} is not a test-card last4`);
    } else if (ZERO_KEYS.has(k) && v !== 0 && v != null) {
      out.push(`${at} must be 0 in fixtures`);
    }
    findings(v, at, out);
  }
}

describe('fixture hygiene', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no live account credentials or card digits', (file) => {
    const out: string[] = [];
    findings(JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')), file, out);
    expect(out).toEqual([]);
  });
});
