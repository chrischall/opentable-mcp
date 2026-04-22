# CC-required booking flow — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `opentable_book_preview` (readOnly) that surfaces cancellation policy + saved card details, plus thread a stateless `booking_token` through `opentable_book` so CC-required slots require the explicit two-step confirmation. Standard-no-guarantee flow stays unchanged.

**Architecture:** Preview runs OpenTable's slot-lock call (the only way to see the cancellation policy), reads the user's default saved payment method, and returns both plus an opaque base64-JSON `booking_token` carrying every field `opentable_book` needs to call `make-reservation`. Book is modified to decode the token, tamper-check against its own args, and skip re-lock. No server-side state.

**Tech Stack:** TypeScript, vitest, zod. New pure parsers: `src/parse-slot-lock.ts`, `src/parse-payment-methods.ts`. Tool logic extends `src/tools/reservations.ts`.

**Spec:** `docs/superpowers/specs/2026-04-21-cc-required-booking-design.md`

---

## Files touched

- `src/parse-slot-lock.ts` — NEW. Pure function: slot-lock JSON → `{ slotLockId, paymentRequired, policy }`.
- `src/parse-payment-methods.ts` — NEW. Pure function: payment-methods JSON → `{ id, brand, last4 } | null`.
- `tests/parse-slot-lock.test.ts` — NEW.
- `tests/parse-payment-methods.test.ts` — NEW.
- `tests/fixtures/slot-lock-*.json` — NEW. Captured fixtures.
- `tests/fixtures/payment-methods-*.json` — NEW.
- `src/tools/reservations.ts` — extend: new `opentable_book_preview` registration, modify existing `opentable_book` handler for token path + CC-required gating.
- `tests/tools/reservations.test.ts` — extend.
- `scripts/probe-book-cc-cancel.ts` — NEW. Live probe (books + immediately cancels).
- `docs/superpowers/roadmap.md` — NEW. v2 feature list seeded.
- `SKILL.md` — document preview→book flow.
- `CLAUDE.md` — hot-spots note on `booking_token` opacity.

No changes to: `src/ws-server.ts`, `src/client.ts`, `extension/*`.

---

## Task 1: Capture CC-required XHRs (investigation)

This is the prerequisite gate. Nothing in the plan compiles without knowing the real OpenTable shapes. The captures go into git as fixtures and drive every subsequent test.

**Files:**
- Create: `tests/fixtures/slot-lock-no-guarantee.json` (optional — can be built by mocking; include only if captured during this step)
- Create: `tests/fixtures/slot-lock-cc-guarantee.json` (REQUIRED)
- Create: `tests/fixtures/payment-methods.json` (REQUIRED)
- Create: `tests/fixtures/find-slots-cc-guarantee.json` (OPTIONAL, helpful for detection shortcut)

- [ ] **Step 1: Identify a CC-required restaurant**

Prime-time reservations at busy restaurants usually require a CC guarantee. Ask the user for a known-good example (or scan their area via search). Candidates typically include steakhouses, prime-time 7-8pm weekend slots at Michelin-starred or popular spots.

Say to the user:

> "I need you to drive the opentable.com browser through a CC-required booking so the extension captures the real XHR shapes. Find a restaurant + slot that asks for a credit card (prime-time at a busy spot — you'll see 'Credit card required' on the booking page). Walk through the booking up to but **not through** final confirmation. Then open DevTools console on that tab and run `copy(JSON.stringify(window.__otMcpCaptures, null, 2))` — paste the output in chat."

Wait for the paste. Do not proceed without real captures.

- [ ] **Step 2: Extract slot-lock response into fixture**

From the pasted captures, find the `BookDetailsStandardSlotLock` (or `BookDetailsGuaranteedSlotLock` if OpenTable uses a separate hash) POST. Copy the response body into `tests/fixtures/slot-lock-cc-guarantee.json`, formatted with 2-space indent.

Redact: nothing (slot-lock responses don't contain PII).

- [ ] **Step 3: Extract payment-methods response into fixture**

Find the request that lists the user's saved cards — likely `UserPaymentMethods` GraphQL or `/dapi/user/payment-methods` REST. Copy the response body into `tests/fixtures/payment-methods.json`.

Redact: replace card-id-like strings (`pm_xxx`, `card_xxx`) with `"pm_test_REDACTED"`. Keep `last4` + `brand` verbatim.

- [ ] **Step 4: Note the persisted-query hash (if new) and endpoint paths**

In `docs/superpowers/specs/2026-04-21-cc-required-booking-design.md`, append an "Investigation results" section at the bottom with:
- The persisted-query hash used for CC-required slot-lock (same as Standard or different).
- The exact path + method for listing payment methods.
- Field paths within the slot-lock response for: `slotLockId`, `paymentRequired` flag, `cancellationPolicy` object.
- Any extra fields `make-reservation` expects for CC-required (compared to standard).

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/ docs/superpowers/specs/2026-04-21-cc-required-booking-design.md
git commit -m "test(fixtures): capture CC-required booking XHRs"
```

---

## Task 2: `parse-slot-lock.ts` — CC-guarantee fixture

Write the parser test-first against the fixture captured in Task 1.

**Files:**
- Create: `src/parse-slot-lock.ts`
- Create: `tests/parse-slot-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/parse-slot-lock.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSlotLock } from '../src/parse-slot-lock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('parseSlotLock', () => {
  it('extracts slotLockId and flags CC-guarantee policy', () => {
    const raw = fixture('slot-lock-cc-guarantee.json');
    const result = parseSlotLock(raw);
    expect(result.slotLockId).toBeTypeOf('number');
    expect(result.paymentRequired).toBe(true);
    expect(result.policy.type).toBe('no_show_fee');
    // Exact fee extracted — confirm against the real fixture:
    expect(result.policy.amount_usd).toBeGreaterThan(0);
    expect(typeof result.policy.raw_text).toBe('string');
    expect(result.policy.raw_text.length).toBeGreaterThan(0);
  });

  it('throws with a clear message when lockSlot.success is false', () => {
    const raw = { data: { lockSlot: { success: false, slotLockErrors: [{ code: 'UNAVAILABLE' }] } } };
    expect(() => parseSlotLock(raw)).toThrow(/slot lock failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/parse-slot-lock.test.ts
```

Expected: FAIL — `parseSlotLock is not a function` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/parse-slot-lock.ts` with shape keyed to the **actual fixture** — the field paths below are placeholders; replace them with the real paths from the captured JSON (recorded in the spec's "Investigation results" section from Task 1):

```typescript
export type CancellationPolicyType = 'none' | 'no_show_fee' | 'late_cancel_fee';

export interface CancellationPolicy {
  type: CancellationPolicyType;
  amount_usd: number | null;
  per_person: boolean;
  free_cancel_until: string | null;
  description: string;
  raw_text: string;
}

export interface SlotLockInfo {
  slotLockId: number;
  paymentRequired: boolean;
  policy: CancellationPolicy;
}

interface SlotLockResponse {
  data?: {
    lockSlot?: {
      success?: boolean;
      slotLock?: { slotLockId?: number };
      slotLockErrors?: unknown;
      // CC-required-specific fields — fill in based on captured fixture:
      paymentRequirement?: { required?: boolean };
      cancellationPolicy?: {
        amountCents?: number;
        perPerson?: boolean;
        freeCancelUntil?: string;
        description?: string;
      };
    };
  };
}

export function parseSlotLock(raw: unknown): SlotLockInfo {
  const resp = raw as SlotLockResponse;
  const lock = resp?.data?.lockSlot;
  if (!lock || lock.success !== true || !lock.slotLock?.slotLockId) {
    throw new Error(
      `slot lock failed: ${JSON.stringify(lock?.slotLockErrors ?? lock ?? raw)}`
    );
  }
  const slotLockId = lock.slotLock.slotLockId;
  const paymentRequired = lock.paymentRequirement?.required === true;
  const cp = lock.cancellationPolicy;
  if (!paymentRequired || !cp) {
    return {
      slotLockId,
      paymentRequired: false,
      policy: {
        type: 'none',
        amount_usd: null,
        per_person: false,
        free_cancel_until: null,
        description: 'No cancellation policy — book freely.',
        raw_text: '',
      },
    };
  }
  return {
    slotLockId,
    paymentRequired: true,
    policy: {
      // Assume no-show-fee until we see a late-cancel-only variant in captures.
      type: 'no_show_fee',
      amount_usd: cp.amountCents != null ? cp.amountCents / 100 : null,
      per_person: cp.perPerson === true,
      free_cancel_until: cp.freeCancelUntil ?? null,
      description: cp.description ?? '',
      raw_text: JSON.stringify(cp),
    },
  };
}
```

**When the captured fixture diverges from the placeholder paths above**, update `SlotLockResponse` and the field-reads inside `parseSlotLock` to match, then re-run the test.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/parse-slot-lock.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/parse-slot-lock.ts tests/parse-slot-lock.test.ts
git commit -m "feat(parse): parseSlotLock extracts CC-guarantee policy + slotLockId"
```

---

## Task 3: `parse-slot-lock.ts` — Standard-no-guarantee branch

Round out the parser with the standard path.

**Files:**
- Modify: `tests/parse-slot-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('parseSlotLock', …)` block in `tests/parse-slot-lock.test.ts`:

```typescript
  it('returns paymentRequired=false and policy.type=none for a no-guarantee lock', () => {
    const raw = {
      data: {
        lockSlot: {
          success: true,
          slotLock: { slotLockId: 99 },
          // no paymentRequirement, no cancellationPolicy
        },
      },
    };
    const result = parseSlotLock(raw);
    expect(result.slotLockId).toBe(99);
    expect(result.paymentRequired).toBe(false);
    expect(result.policy.type).toBe('none');
    expect(result.policy.amount_usd).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it passes (implementation already handles this case)**

```bash
npx vitest run tests/parse-slot-lock.test.ts
```

Expected: PASS (all three cases, no new implementation needed).

- [ ] **Step 3: Commit**

```bash
git add tests/parse-slot-lock.test.ts
git commit -m "test(parse-slot-lock): cover no-guarantee branch"
```

---

## Task 4: `parse-payment-methods.ts`

Extract the user's default saved card. Shape keyed to fixture from Task 1.

**Files:**
- Create: `src/parse-payment-methods.ts`
- Create: `tests/parse-payment-methods.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/parse-payment-methods.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDefaultPaymentMethod } from '../src/parse-payment-methods.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('parseDefaultPaymentMethod', () => {
  it('returns the default card (brand + last4 + id) from the real response', () => {
    const raw = fixture('payment-methods.json');
    const card = parseDefaultPaymentMethod(raw);
    expect(card).not.toBeNull();
    expect(card!.brand.length).toBeGreaterThan(0);
    expect(card!.last4).toMatch(/^\d{4}$/);
    expect(card!.id.length).toBeGreaterThan(0);
  });

  it('returns null when the response has no cards', () => {
    expect(parseDefaultPaymentMethod({ data: { paymentMethods: [] } })).toBeNull();
    expect(parseDefaultPaymentMethod({})).toBeNull();
  });

  it('prefers the card flagged as default when multiple exist', () => {
    const raw = {
      data: {
        paymentMethods: [
          { id: 'pm_a', brand: 'Visa', last4: '1111', isDefault: false },
          { id: 'pm_b', brand: 'Amex', last4: '2222', isDefault: true },
        ],
      },
    };
    const card = parseDefaultPaymentMethod(raw);
    expect(card!.id).toBe('pm_b');
    expect(card!.brand).toBe('Amex');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/parse-payment-methods.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/parse-payment-methods.ts`. Field paths below are placeholders — align with the captured `payment-methods.json` from Task 1:

```typescript
export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
}

interface PaymentMethodsResponse {
  data?: {
    paymentMethods?: Array<{
      id?: string;
      brand?: string;
      last4?: string;
      isDefault?: boolean;
    }>;
  };
  // Fall-back shape if OpenTable returns a flat array:
  paymentMethods?: Array<{
    id?: string;
    brand?: string;
    last4?: string;
    isDefault?: boolean;
  }>;
}

export function parseDefaultPaymentMethod(raw: unknown): PaymentMethod | null {
  const resp = raw as PaymentMethodsResponse;
  const methods = resp?.data?.paymentMethods ?? resp?.paymentMethods ?? [];
  if (methods.length === 0) return null;
  const preferred = methods.find((m) => m.isDefault === true) ?? methods[0];
  if (!preferred.id || !preferred.brand || !preferred.last4) return null;
  return {
    id: preferred.id,
    brand: preferred.brand,
    last4: preferred.last4,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/parse-payment-methods.test.ts
```

Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/parse-payment-methods.ts tests/parse-payment-methods.test.ts
git commit -m "feat(parse): parseDefaultPaymentMethod picks the default saved card"
```

---

## Task 5: `booking_token` codec

Two tiny pure functions with their own tests.

**Files:**
- Create: `src/booking-token.ts`
- Create: `tests/booking-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/booking-token.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { encodeBookingToken, decodeBookingToken, type BookingTokenPayload } from '../src/booking-token.js';

const samplePayload: BookingTokenPayload = {
  slotLockId: 12345,
  restaurantId: 1272781,
  diningAreaId: 48750,
  partySize: 2,
  date: '2026-05-01',
  time: '19:00',
  reservationToken: 'rt_xxx',
  slotHash: 'sh_xxx',
  paymentMethodId: 'pm_xxx',
  ccRequired: true,
  issuedAt: '2026-04-21T00:00:00Z',
};

describe('booking-token', () => {
  it('round-trips a payload through encode → decode', () => {
    const token = encodeBookingToken(samplePayload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+=*$/); // base64url-ish
    expect(decodeBookingToken(token)).toEqual(samplePayload);
  });

  it('throws on invalid base64 input', () => {
    expect(() => decodeBookingToken('!!!not-a-token!!!')).toThrow(/booking_token/i);
  });

  it('throws on base64 that decodes to invalid JSON', () => {
    const junk = Buffer.from('not json', 'utf8').toString('base64');
    expect(() => decodeBookingToken(junk)).toThrow(/booking_token/i);
  });

  it('throws when a required field is missing', () => {
    const { slotLockId: _drop, ...rest } = samplePayload;
    const junk = Buffer.from(JSON.stringify(rest), 'utf8').toString('base64');
    expect(() => decodeBookingToken(junk)).toThrow(/booking_token/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/booking-token.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/booking-token.ts`:

```typescript
export interface BookingTokenPayload {
  slotLockId: number;
  restaurantId: number;
  diningAreaId: number;
  partySize: number;
  date: string;
  time: string;
  reservationToken: string;
  slotHash: string;
  /** pm_... for CC-required bookings, null otherwise. */
  paymentMethodId: string | null;
  ccRequired: boolean;
  issuedAt: string; // ISO-8601
}

const REQUIRED_KEYS: Array<keyof BookingTokenPayload> = [
  'slotLockId',
  'restaurantId',
  'diningAreaId',
  'partySize',
  'date',
  'time',
  'reservationToken',
  'slotHash',
  'ccRequired',
  'issuedAt',
];

export function encodeBookingToken(payload: BookingTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodeBookingToken(token: string): BookingTokenPayload {
  let json: string;
  try {
    json = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    throw new Error('booking_token is not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('booking_token does not contain valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('booking_token payload is not an object');
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in (parsed as Record<string, unknown>))) {
      throw new Error(`booking_token is missing required field: ${key}`);
    }
  }
  return parsed as BookingTokenPayload;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/booking-token.test.ts
```

Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/booking-token.ts tests/booking-token.test.ts
git commit -m "feat(token): stateless base64-JSON booking_token codec"
```

---

## Task 6: `opentable_book_preview` — happy path (CC-guarantee)

First tool test: full preview on a CC-required slot. Uses the fixtures from Task 1 + parsers from Tasks 2-5.

**Files:**
- Modify: `src/tools/reservations.ts`
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/tools/reservations.test.ts`, add at the end (outside existing describes):

```typescript
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeBookingToken } from '../../src/booking-token.js';
import { buildTestServer } from '../helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8'));

describe('opentable_book_preview (CC-guarantee)', () => {
  it('runs slot-lock + payment-methods and returns policy + token', async () => {
    const slotLockResp = fixture('slot-lock-cc-guarantee.json');
    const paymentMethods = fixture('payment-methods.json');
    const diningDashboardHtml = readFileSync(
      join(here, '..', 'fixtures', 'dining-dashboard.html'),
      'utf8'
    );

    const fetchJson = vi.fn(async (path: string) => {
      if (path.includes('BookDetailsStandardSlotLock')) return slotLockResp;
      if (path.includes('payment-methods') || path.includes('UserPaymentMethods')) return paymentMethods;
      throw new Error(`unexpected path: ${path}`);
    });
    const fetchHtml = vi.fn(async () => diningDashboardHtml);
    const { client, server } = buildTestServer({ fetchJson, fetchHtml });
    // Need to register tools — the helper already does this in existing tests.

    const result = await client.callTool({
      name: 'opentable_book_preview',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt_xxx',
        slot_hash: 'sh_xxx',
        dining_area_id: 48750,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.cancellation_policy.type).toBe('no_show_fee');
    expect(body.payment_method.last4).toMatch(/^\d{4}$/);
    expect(typeof body.booking_token).toBe('string');

    const decoded = decodeBookingToken(body.booking_token);
    expect(decoded.restaurantId).toBe(1272781);
    expect(decoded.partySize).toBe(2);
    expect(decoded.ccRequired).toBe(true);
    expect(decoded.paymentMethodId).toBeTruthy();

    await server.close();
  });
});
```

**If `tests/helpers.ts` doesn't already export a `buildTestServer` that lets us inject a custom `fetchJson`/`fetchHtml`, first inspect the helper (read `tests/helpers.ts`) and either use whatever primitive it exposes or add a thin variant. Do NOT rewrite existing test infra — mirror the style of existing tests in `tests/tools/reservations.test.ts`.**

Also: if `tests/fixtures/dining-dashboard.html` doesn't exist yet, grep `tests/` for how existing tests provide profile HTML, follow that pattern.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'book_preview'
```

Expected: FAIL — `opentable_book_preview` is not a registered tool.

- [ ] **Step 3: Write minimal implementation — register `opentable_book_preview`**

In `src/tools/reservations.ts`:

1. Add import:
   ```typescript
   import { parseSlotLock } from '../parse-slot-lock.js';
   import { parseDefaultPaymentMethod } from '../parse-payment-methods.js';
   import { encodeBookingToken, decodeBookingToken } from '../booking-token.js';
   ```

2. Add a module constant near the other paths:
   ```typescript
   const PAYMENT_METHODS_PATH = '/dapi/??'; // fill in from Task 1 investigation notes
   ```

3. Inside `registerReservationTools`, register the new tool. Shape mirrors existing `opentable_book`:

   ```typescript
   server.registerTool(
     'opentable_book_preview',
     {
       description:
         'Preview an OpenTable booking: runs the slot-lock step and returns the cancellation policy, the saved card that would be held/charged, and any at-booking charges — plus an opaque booking_token. Required before opentable_book for CC-required slots. Safe to call for non-guaranteed slots too. The booking_token expires when the slot lock does (~60-90s from this call).',
       annotations: { readOnlyHint: true },
       inputSchema: {
         restaurant_id: z.number().int().positive(),
         date: z.string().describe('YYYY-MM-DD'),
         time: z.string().describe('HH:MM (24h)'),
         party_size: z.number().int().positive(),
         reservation_token: z.string(),
         slot_hash: z.string(),
         dining_area_id: z.number().int(),
       },
     },
     async ({ restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id }) => {
       const reservationDateTime = `${date}T${time}`;

       // 1. Slot lock
       const lockRaw = await client.fetchJson<unknown>(SLOT_LOCK_PATH, {
         method: 'POST',
         headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
         body: {
           operationName: 'BookDetailsStandardSlotLock',
           variables: {
             input: {
               restaurantId: restaurant_id,
               seatingOption: 'DEFAULT',
               reservationDateTime,
               partySize: party_size,
               databaseRegion: 'NA',
               slotHash: slot_hash,
               reservationType: 'STANDARD',
               diningAreaId: dining_area_id,
             },
           },
           extensions: {
             persistedQuery: { version: 1, sha256Hash: BOOK_SLOT_LOCK_HASH },
           },
         },
       });
       const lockInfo = parseSlotLock(lockRaw);

       // 2. Payment method (only needed if CC-required, but cheap to always fetch)
       let paymentMethod = null as null | { id: string; brand: string; last4: string };
       if (lockInfo.paymentRequired) {
         const pmRaw = await client.fetchJson<unknown>(PAYMENT_METHODS_PATH, { method: 'POST', body: {} /* adjust per Task 1 notes */ });
         paymentMethod = parseDefaultPaymentMethod(pmRaw);
         if (!paymentMethod) {
           throw new Error(
             'No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again.'
           );
         }
       }

       // 3. Issue token
       const booking_token = encodeBookingToken({
         slotLockId: lockInfo.slotLockId,
         restaurantId: restaurant_id,
         diningAreaId: dining_area_id,
         partySize: party_size,
         date,
         time,
         reservationToken: reservation_token,
         slotHash: slot_hash,
         paymentMethodId: paymentMethod?.id ?? null,
         ccRequired: lockInfo.paymentRequired,
         issuedAt: new Date().toISOString(),
       });

       // 4. Assemble response
       return {
         content: [
           {
             type: 'text' as const,
             text: JSON.stringify(
               {
                 booking_token,
                 restaurant: {
                   id: restaurant_id,
                   name: null, // lookup deferred — not critical for v1; LLM can echo from find_slots
                   dining_area: null,
                 },
                 reservation: { date, time, party_size },
                 payment_method: paymentMethod
                   ? { brand: paymentMethod.brand, last4: paymentMethod.last4 }
                   : null,
                 cancellation_policy: lockInfo.policy,
                 charges_at_booking: {
                   amount_usd: 0,
                   description: lockInfo.paymentRequired
                     ? `Nothing charged now — ${paymentMethod!.brand} •••• ${paymentMethod!.last4} held only.`
                     : 'Nothing charged now — no card required.',
                 },
               },
               null,
               2
             ),
           },
         ],
       };
     }
   );
   ```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'book_preview'
```

Expected: PASS.

- [ ] **Step 5: Run the full suite to make sure nothing else broke**

```bash
npm test
```

Expected: all tests pass (72 existing + 1 new = 73+, exact count depends on what Tasks 2-5 added).

- [ ] **Step 6: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(tools): opentable_book_preview — CC-guarantee happy path"
```

---

## Task 7: `opentable_book_preview` — no-guarantee branch

Same tool, verify it handles Standard-no-guarantee gracefully (empty policy, null payment_method, still issues token).

**Files:**
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe('opentable_book_preview …')` block:

```typescript
  it('on a Standard no-guarantee slot returns null payment_method + type=none', async () => {
    const lockNoGuarantee = {
      data: {
        lockSlot: {
          success: true,
          slotLock: { slotLockId: 77 },
        },
      },
    };
    const fetchJson = vi.fn(async () => lockNoGuarantee);
    const fetchHtml = vi.fn(async () => '<html></html>');
    const { client, server } = buildTestServer({ fetchJson, fetchHtml });

    const result = await client.callTool({
      name: 'opentable_book_preview',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.cancellation_policy.type).toBe('none');
    expect(body.payment_method).toBeNull();
    expect(body.charges_at_booking.amount_usd).toBe(0);
    expect(typeof body.booking_token).toBe('string');

    await server.close();
  });
```

- [ ] **Step 2: Run test to verify it passes (existing implementation already handles this case)**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'book_preview'
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/reservations.test.ts
git commit -m "test(book_preview): cover Standard no-guarantee branch"
```

---

## Task 8: `opentable_book_preview` — no payment method error

**Files:**
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
  it('throws a clear error when CC-required and no default card on file', async () => {
    const lockCC = fixture('slot-lock-cc-guarantee.json');
    const emptyPayments = { data: { paymentMethods: [] } };

    const fetchJson = vi.fn(async (path: string) => {
      if (path.includes('BookDetailsStandardSlotLock')) return lockCC;
      return emptyPayments;
    });
    const { client, server } = buildTestServer({ fetchJson, fetchHtml: vi.fn(async () => '<html></html>') });

    const result = await client.callTool({
      name: 'opentable_book_preview',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/default payment method/i);
    expect(text).toMatch(/opentable\.com\/account\/payment-methods/);

    await server.close();
  });
```

- [ ] **Step 2: Run test to verify it passes (error thrown from Task 6 implementation)**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'book_preview'
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/reservations.test.ts
git commit -m "test(book_preview): missing default payment method error"
```

---

## Task 9: `opentable_book` — CC-required without token → reject

**Files:**
- Modify: `src/tools/reservations.ts`
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/reservations.test.ts`:

```typescript
describe('opentable_book (CC-required gating)', () => {
  it('rejects with a preview-first error when the slot is CC-required and no booking_token is passed', async () => {
    const lockCC = fixture('slot-lock-cc-guarantee.json');

    // No booking_token in args. Tool should perform the lock internally,
    // detect CC-required, and error out.
    const fetchJson = vi.fn(async () => lockCC);
    const { client, server } = buildTestServer({
      fetchJson,
      fetchHtml: vi.fn(async () => '<html></html>'),
    });

    const result = await client.callTool({
      name: 'opentable_book',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/opentable_book_preview/i);
    expect(text).toMatch(/credit-card guarantee/i);

    await server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'CC-required gating'
```

Expected: FAIL — existing `opentable_book` doesn't gate on CC-required.

- [ ] **Step 3: Modify `opentable_book` to add gating**

In `src/tools/reservations.ts`, inside the existing `opentable_book` handler, **before** the existing `makeReservation` step:

Insert a `booking_token` schema entry:

```typescript
        booking_token: z
          .string()
          .optional()
          .describe(
            'Opaque token from opentable_book_preview. Required for CC-required slots (otherwise the tool errors pointing you at preview).'
          ),
```

Replace the handler's body so it branches on `booking_token`:

```typescript
async ({
  restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id, booking_token,
}) => {
  const reservationDateTime = `${date}T${time}`;
  let slotLockId: number;
  let paymentMethodId: string | null = null;
  let ccRequired = false;

  if (booking_token) {
    const payload = decodeBookingToken(booking_token);
    // Tamper / staleness check
    if (
      payload.restaurantId !== restaurant_id ||
      payload.date !== date ||
      payload.time !== time ||
      payload.partySize !== party_size ||
      payload.diningAreaId !== dining_area_id
    ) {
      throw new Error(
        `booking_token was issued for a different reservation. Call opentable_book_preview again with the current args.`
      );
    }
    slotLockId = payload.slotLockId;
    paymentMethodId = payload.paymentMethodId;
    ccRequired = payload.ccRequired;
  } else {
    // Existing flow: lock the slot ourselves
    const lockRaw = await client.fetchJson<unknown>(SLOT_LOCK_PATH, {
      method: 'POST',
      headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
      body: {
        operationName: 'BookDetailsStandardSlotLock',
        variables: {
          input: {
            restaurantId: restaurant_id,
            seatingOption: 'DEFAULT',
            reservationDateTime,
            partySize: party_size,
            databaseRegion: 'NA',
            slotHash: slot_hash,
            reservationType: 'STANDARD',
            diningAreaId: dining_area_id,
          },
        },
        extensions: { persistedQuery: { version: 1, sha256Hash: BOOK_SLOT_LOCK_HASH } },
      },
    });
    const lockInfo = parseSlotLock(lockRaw);
    if (lockInfo.paymentRequired) {
      throw new Error(
        'This slot requires a credit-card guarantee. Call opentable_book_preview first to review the cancellation policy, then pass the returned booking_token back to opentable_book.'
      );
    }
    slotLockId = lockInfo.slotLockId;
  }

  // Existing make-reservation call, with paymentMethodId threaded through when present.
  const profile = await fetchProfile(client);
  const reservation = await client.fetchJson<{
    success?: boolean;
    reservationId?: number;
    confirmationNumber?: number;
    securityToken?: string;
    points?: number;
    errorCode?: string;
    errorMessage?: string;
  }>(MAKE_RESERVATION_PATH, {
    method: 'POST',
    body: {
      restaurantId: restaurant_id,
      reservationDateTime,
      partySize: party_size,
      slotHash: slot_hash,
      slotAvailabilityToken: reservation_token,
      slotLockId,
      diningAreaId: dining_area_id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      email: profile.email,
      phoneNumber: profile.mobile_phone_number,
      phoneNumberCountryId: profile.country_id || 'US',
      country: profile.country_id || 'US',
      reservationType: 'Standard',
      reservationAttribute: 'default',
      pointsType: 'Standard',
      points: 100,
      tipAmount: 0,
      tipPercent: 0,
      confirmPoints: true,
      optInEmailRestaurant: false,
      isModify: false,
      additionalServiceFees: [],
      nonBookableExperiences: [],
      katakanaFirstName: '',
      katakanaLastName: '',
      ...(paymentMethodId ? { paymentMethodId } : {}),
    },
  });

  if (reservation?.errorCode || reservation?.success === false) {
    // Map common errors to actionable messages
    const raw = `${reservation.errorCode ?? 'unknown'}${reservation.errorMessage ? ` — ${reservation.errorMessage}` : ''}`;
    if (/slot.*lock.*expired/i.test(raw) || /SLOT_LOCK_EXPIRED/i.test(raw)) {
      throw new Error('Slot lock expired. Call opentable_find_slots for a fresh slot and re-preview.');
    }
    throw new Error(`OpenTable book failed: ${raw}`);
  }
  if (!reservation?.confirmationNumber) {
    throw new Error(`OpenTable book response missing confirmationNumber: ${JSON.stringify(reservation)}`);
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            confirmation_number: reservation.confirmationNumber,
            reservation_id: reservation.reservationId ?? null,
            security_token: reservation.securityToken ?? '',
            restaurant_id,
            date,
            time,
            party_size,
            points: reservation.points ?? 0,
            status: 'Pending',
            cc_required: ccRequired,
          },
          null,
          2
        ),
      },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'CC-required gating'
```

Expected: PASS.

- [ ] **Step 5: Run full suite — none of the existing `opentable_book` tests should regress**

```bash
npm test
```

Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "feat(book): gate CC-required slots behind booking_token"
```

---

## Task 10: `opentable_book` — tamper check on booking_token

**Files:**
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
  it('rejects a booking_token whose fields do not match the call args', async () => {
    const token = encodeBookingToken({
      slotLockId: 12345,
      restaurantId: 1272781,
      diningAreaId: 48750,
      partySize: 2,
      date: '2026-05-01',
      time: '19:00',
      reservationToken: 'rt',
      slotHash: 'sh',
      paymentMethodId: 'pm_xxx',
      ccRequired: true,
      issuedAt: '2026-04-21T00:00:00Z',
    });

    const fetchJson = vi.fn(); // should never be called
    const { client, server } = buildTestServer({
      fetchJson,
      fetchHtml: vi.fn(async () => '<html></html>'),
    });

    const result = await client.callTool({
      name: 'opentable_book',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 4, // user changed party_size after preview
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
        booking_token: token,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/different reservation/i);
    expect(fetchJson).not.toHaveBeenCalled();

    await server.close();
  });
```

Add import at the top if missing:

```typescript
import { encodeBookingToken } from '../../src/booking-token.js';
```

- [ ] **Step 2: Run test to verify it passes (tamper check already implemented in Task 9)**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'does not match'
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/reservations.test.ts
git commit -m "test(book): tamper-check booking_token against call args"
```

---

## Task 11: `opentable_book` — token happy path (CC + non-CC)

**Files:**
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
  it('commits a CC-required booking with a valid booking_token (skips re-lock)', async () => {
    const token = encodeBookingToken({
      slotLockId: 12345,
      restaurantId: 1272781,
      diningAreaId: 48750,
      partySize: 2,
      date: '2026-05-01',
      time: '19:00',
      reservationToken: 'rt',
      slotHash: 'sh',
      paymentMethodId: 'pm_real',
      ccRequired: true,
      issuedAt: '2026-04-21T00:00:00Z',
    });

    let lockCalls = 0;
    const fetchJson = vi.fn(async (path: string, init?: { body?: unknown }) => {
      if (path.includes('BookDetailsStandardSlotLock')) {
        lockCalls++;
        return { data: { lockSlot: { success: true, slotLock: { slotLockId: 99999 } } } };
      }
      // make-reservation
      const body = init?.body as Record<string, unknown>;
      expect(body.slotLockId).toBe(12345);
      expect(body.paymentMethodId).toBe('pm_real');
      return {
        success: true,
        reservationId: 424242,
        confirmationNumber: 8675309,
        securityToken: 'st_real',
        points: 100,
      };
    });
    const fetchHtml = vi.fn(async () =>
      readFileSync(join(here, '..', 'fixtures', 'dining-dashboard.html'), 'utf8')
    );
    const { client, server } = buildTestServer({ fetchJson, fetchHtml });

    const result = await client.callTool({
      name: 'opentable_book',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
        booking_token: token,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.confirmation_number).toBe(8675309);
    expect(body.cc_required).toBe(true);
    expect(lockCalls).toBe(0); // critical: no re-lock

    await server.close();
  });
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'valid booking_token'
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/reservations.test.ts
git commit -m "test(book): CC-required commit path with valid booking_token"
```

---

## Task 12: `opentable_book` — slot-lock-expired error mapping

**Files:**
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
  it('maps slot-lock-expired responses to a clear error', async () => {
    const token = encodeBookingToken({
      slotLockId: 12345,
      restaurantId: 1272781,
      diningAreaId: 48750,
      partySize: 2,
      date: '2026-05-01',
      time: '19:00',
      reservationToken: 'rt',
      slotHash: 'sh',
      paymentMethodId: 'pm_real',
      ccRequired: true,
      issuedAt: '2026-04-21T00:00:00Z',
    });

    const fetchJson = vi.fn(async (path: string) => {
      if (path.includes('make-reservation')) {
        return { success: false, errorCode: 'SLOT_LOCK_EXPIRED', errorMessage: 'slot lock expired' };
      }
      return {};
    });
    const fetchHtml = vi.fn(async () =>
      readFileSync(join(here, '..', 'fixtures', 'dining-dashboard.html'), 'utf8')
    );
    const { client, server } = buildTestServer({ fetchJson, fetchHtml });

    const result = await client.callTool({
      name: 'opentable_book',
      arguments: {
        restaurant_id: 1272781,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        reservation_token: 'rt',
        slot_hash: 'sh',
        dining_area_id: 48750,
        booking_token: token,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/slot lock expired/i);
    expect(text).toMatch(/opentable_find_slots/);

    await server.close();
  });
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npx vitest run tests/tools/reservations.test.ts -t 'slot-lock-expired'
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/reservations.test.ts
git commit -m "test(book): map SLOT_LOCK_EXPIRED to actionable error"
```

---

## Task 13: Live probe script

This is a live test that books a CC-required slot then cancels. High-risk by design — mis-cancel = real money.

**Files:**
- Create: `scripts/probe-book-cc-cancel.ts`

- [ ] **Step 1: Write the probe**

Create `scripts/probe-book-cc-cancel.ts`:

```typescript
#!/usr/bin/env tsx
// Live probe: CC-required find_slots → book_preview → book → cancel.
//
// ⚠️ RISK ⚠️
// This makes a REAL CC-guarantee reservation and immediately cancels it.
// If the cancel step fails, you are on the hook for whatever no-show fee
// the cancellation policy specifies. Read the probe output carefully and
// intervene (cancel manually at opentable.com) if anything looks off.
//
// Inputs (all via env):
//   OT_PROBE_CC_RID     — restaurant id known to require a CC guarantee
//   OT_PROBE_CC_AREA    — dining area id from opentable_get_restaurant
//   OT_PROBE_CC_DATE    — YYYY-MM-DD (far enough out to not penalise you
//                         if something goes wrong, but close enough to
//                         guarantee the CC requirement is in force)
//   OT_PROBE_CC_TIME    — HH:MM (prime-time; guarantee usually kicks in
//                         around 18:30-21:00 weekends)
//
// Exits non-zero if the chosen slot turns out NOT to require a CC —
// we'd rather halt than silently exercise the non-guarantee path and
// miss the point of the probe.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_PROBE_CC_RID ?? '');
const AREA = Number(process.env.OT_PROBE_CC_AREA ?? '');
const DATE = process.env.OT_PROBE_CC_DATE ?? '';
const TIME = process.env.OT_PROBE_CC_TIME ?? '';

if (!RID || !AREA || !DATE || !TIME) {
  console.error(
    'Set OT_PROBE_CC_RID, OT_PROBE_CC_AREA, OT_PROBE_CC_DATE (YYYY-MM-DD), OT_PROBE_CC_TIME (HH:MM)'
  );
  process.exit(2);
}

const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content[0] as { text: string }).text;
  return { isError: !!r.isError, text };
}

console.log(`── find_slots rid=${RID} ${DATE} ${TIME} ──`);
const slotsRaw = await call('opentable_find_slots', {
  restaurant_id: RID,
  date: DATE,
  time: TIME,
  party_size: 2,
});
if (slotsRaw.isError) {
  console.error('find_slots failed:', slotsRaw.text);
  process.exit(1);
}
const slots = JSON.parse(slotsRaw.text) as Array<{
  reservation_token: string;
  slot_hash: string;
  date: string;
  time: string;
}>;
if (!slots[0]) {
  console.error('no slots');
  process.exit(1);
}
const chosen = slots[0];

console.log(`── book_preview ${chosen.date} ${chosen.time} ──`);
const preview = await call('opentable_book_preview', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: 2,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: AREA,
});
if (preview.isError) {
  console.error('book_preview failed:', preview.text);
  process.exit(1);
}
console.log(preview.text);
const previewBody = JSON.parse(preview.text) as {
  booking_token: string;
  cancellation_policy: { type: string };
  payment_method: { brand: string; last4: string } | null;
};
if (previewBody.cancellation_policy.type === 'none') {
  console.error(
    'ABORT: chosen slot is not CC-required. Pick a higher-demand time/day or a different restaurant.'
  );
  process.exit(3);
}
console.log(
  `  policy=${previewBody.cancellation_policy.type} card=${previewBody.payment_method?.brand} •••• ${previewBody.payment_method?.last4}`
);

console.log(`── book (CC-required) ──`);
const bookResp = await call('opentable_book', {
  restaurant_id: RID,
  date: chosen.date,
  time: chosen.time,
  party_size: 2,
  reservation_token: chosen.reservation_token,
  slot_hash: chosen.slot_hash,
  dining_area_id: AREA,
  booking_token: previewBody.booking_token,
});
if (bookResp.isError) {
  console.error('book failed:', bookResp.text);
  process.exit(1);
}
console.log(bookResp.text);
const booking = JSON.parse(bookResp.text) as {
  confirmation_number: number;
  security_token: string;
  restaurant_id: number;
  cc_required: boolean;
};

console.log(`── cancel ${booking.confirmation_number} ──`);
const cancelResp = await call('opentable_cancel', {
  restaurant_id: booking.restaurant_id,
  confirmation_number: booking.confirmation_number,
  security_token: booking.security_token,
});
console.log(cancelResp.text);
const cancel = JSON.parse(cancelResp.text) as { cancelled: boolean };
if (!cancel.cancelled) {
  console.error('‼️ CANCEL FAILED — go cancel at opentable.com NOW');
  process.exit(1);
}

await c.close();
console.log('✅ round-trip clean');
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/probe-book-cc-cancel.ts
git commit -m "test: live probe for CC-required book + immediate cancel"
```

---

## Task 14: Investigation update + cross-check CLAUDE.md + SKILL.md

**Files:**
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/roadmap.md`

- [ ] **Step 1: Update `SKILL.md`**

In `SKILL.md`, add to the **Bookings** table row:

```markdown
| `opentable_book_preview(restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id)` | Preview a booking: runs slot-lock, returns cancellation policy + card last4 + a short-lived `booking_token`. Required before `opentable_book` for CC-required slots; safe to call for others. |
```

Update the `opentable_book` row to mention `booking_token`:

```markdown
| `opentable_book(..., booking_token?)` | Book a slot. Pass `booking_token` from `opentable_book_preview` for CC-required slots (the tool errors out directing you to preview if you don't). For non-guaranteed slots, `booking_token` is optional. Returns `confirmation_number` + `security_token`. |
```

Add a new **Workflows** entry:

````markdown
**Book a CC-required (guarantee) slot:**
```
opentable_find_slots(...)                                   # pick one
opentable_book_preview(...)                                 # shows the cancellation policy + card last4
   → user reads policy, confirms
opentable_book(..., booking_token: <from preview>)          # commits
```
````

Add a Notes entry:

```markdown
- **CC-required bookings:** `opentable_book_preview` must run before `opentable_book` for any slot that carries a credit-card guarantee. The `booking_token` it issues is opaque, stateless, and expires with OpenTable's ~60–90s slot lock — preview → book should happen within a minute. If the user has no default payment method on opentable.com, preview throws a pointer to the account settings page.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the **Hot spots / gotchas** section, add:

```markdown
- **`booking_token` is stateless + opaque.** `opentable_book_preview` issues a base64-JSON blob encoding the slot-lock id, payment method id, and trip fields. `opentable_book` decodes it, tamper-checks against its call args, and skips the re-lock step. The server never caches it — OpenTable's ~90s slot-lock TTL is the only expiry. If a `booking_token`'s fields don't match the caller's args (e.g. party_size changed), we error out rather than commit the stale intent.
- **CC-required slot detection** lives in `src/parse-slot-lock.ts`. The flag comes from `lockSlot.paymentRequirement` (verify via capture-logger if OpenTable ever reshapes this).
```

- [ ] **Step 3: Create `docs/superpowers/roadmap.md`**

```markdown
# opentable-mcp roadmap

## v2 — CC/payment flow extensions

Tracked from the CC-required booking spec (2026-04-21). Each bullet is a
separate plan when we're ready to build.

- **Experience / ticketed slots** — full prepayment at booking (tasting
  menus, NYE, themed dinners). Different persisted-query hash for slot-lock;
  `make-reservation` shape differs. Live probe needs a pay-and-refund cycle
  or a willing test restaurant.
- **POP (Priority Offered) slots** — OpenTable's paid-priority slots. Same
  pattern as Experience but different flag in the slot response.
- **Deposit-required slots** — partial charge at booking, remainder at
  meal. Preview needs to surface both `charges_at_booking` and any
  post-meal charges clearly.
- **Explicit `payment_method_id` on `opentable_book_preview`** — let the
  user pick a non-default saved card.
- **Reservation modification** — change date/time/party_size on an
  existing confirmation. Probably a third tool (`opentable_modify`) with
  its own preview step.
```

- [ ] **Step 4: Commit**

```bash
git add SKILL.md CLAUDE.md docs/superpowers/roadmap.md
git commit -m "docs: CC-required booking flow + v2 roadmap"
```

---

## Task 15: Full verification pass

- [ ] **Step 1: Run full unit suite**

```bash
npm test
```

Expected: all tests pass (72 prior + 1 `parseSlotLock` file × multiple cases + 1 `parseDefaultPaymentMethod` file × 3 cases + 1 `booking-token` file × 4 cases + multiple new `book_preview` + `book` cases).

- [ ] **Step 2: Typecheck + build**

```bash
npm run build
```

Expected: clean typecheck, esbuild produces `dist/bundle.js`.

- [ ] **Step 3: Commit any incidental formatting**

If nothing to commit, skip. Otherwise:

```bash
git add -A
git commit -m "chore: formatting after CC-required build"
```

- [ ] **Step 4: Live probe (optional, coordinate with user)**

Only run after getting explicit go-ahead from the user — this books a real CC-guarantee reservation. Ask which restaurant/date/time to use.

```bash
export OT_PROBE_CC_RID=<id>
export OT_PROBE_CC_AREA=<area>
export OT_PROBE_CC_DATE=<YYYY-MM-DD>
export OT_PROBE_CC_TIME=<HH:MM>
lsof -ti :37149 | xargs -r kill 2>/dev/null; sleep 1
npx tsx scripts/probe-book-cancel.ts   # sanity: standard flow still works
npx tsx scripts/probe-book-cc-cancel.ts
```

Expected:
- `probe-book-cancel.ts` — identical output shape to pre-change runs (no regression).
- `probe-book-cc-cancel.ts` — `policy=no_show_fee`, card last4 shown, confirmation number, `✅ round-trip clean`.

If the CC probe reports `ABORT: chosen slot is not CC-required`, pick a higher-demand time and re-run.

- [ ] **Step 5: Push**

```bash
git push
```

---

## Self-review checklist

Walked the plan vs spec:

- ✅ Spec §"Tool surface" — covered by Tasks 6, 9 (preview + book modifications).
- ✅ Spec §"`booking_token` — opaque, stateless" — Task 5 implements the codec, Task 9 implements tamper check.
- ✅ Spec §"Data flow / Preview" — Task 6 matches the fetchProfile (implicit, existing) + fetchPaymentMethod + lockSlot + token flow.
- ✅ Spec §"Data flow / Book (CC-required path)" — Task 9 matches decode → assert → make-reservation with paymentMethodId.
- ✅ Spec §"Data flow / Book (Standard no-guarantee path, no token — unchanged)" — Task 9's `else` branch preserves the existing code path, Task 15 probe confirms.
- ✅ Spec §"Error handling" — Tasks 8, 9, 10, 12 cover each row of the error table.
- ✅ Spec §"Investigation step" — Task 1 is the gated first task.
- ✅ Spec §"Testing / Unit" — Tasks 2, 3, 4, 5, 7, 8, 10, 11, 12.
- ✅ Spec §"Testing / Live probe" — Task 13.
- ✅ Spec §"Deferred to v2" — Task 14 creates `roadmap.md`.
- ✅ Spec §"Files touched" — all listed files appear in at least one task.

Placeholder scan: no "TBD" / "fill in later" / "handle edge cases" / "similar to task N" — every step has full code or a full command.

Type consistency: `BookingTokenPayload` defined in Task 5 is used verbatim in Tasks 9, 10, 11. `SlotLockInfo`, `CancellationPolicy`, `PaymentMethod` defined in Tasks 2-4 used in Task 6. No drift.

Two known coupling points that depend on Task 1 captures:
1. **`PAYMENT_METHODS_PATH`** in `src/tools/reservations.ts` — placeholder `/dapi/??` in Task 6; fill in from Task 1's "Investigation results" section before Step 4 of Task 6.
2. **Field paths in `parse-slot-lock.ts` / `parse-payment-methods.ts`** — placeholders noted inline in Tasks 2 and 4; re-key against real fixtures when they land.

Both are called out explicitly in the task text.
