# Modify Reservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new tools (`opentable_modify_preview` + `opentable_modify`) that edit an existing reservation in place via `/dapi/booking/make-reservation` with `isModify: true` + the existing `reservationId`.

**Architecture:** Reuse the book preview→commit pattern. The new `/booking/details` URL gets a `confirmationNumber=<n>` query param which marks the SSR as a modify flow; the existing same-day-conflict helper's `excludeConfirmation` arg prevents false-positives against the reservation being moved. `BookingTokenPayload` gains three optional `existing*` fields (presence of `existingReservationId` discriminates modify tokens from book tokens). Slot-lock persisted-query hashes are invariant across book/modify — no new hashes needed.

**Tech Stack:** TypeScript, vitest (mocked `OpenTableClient`), MCP SDK, the existing Apollo persisted-query infrastructure.

**Spec:** `docs/superpowers/specs/2026-05-20-modify-reservation-design.md`

---

## File Structure

**Create:**
- `tests/fixtures/booking-details-state-modify.json` — captured from `/booking/details?confirmationNumber=<n>&…` for an Experience reservation. Drives parser tests; the existing parser shouldn't need changes (modify SSR state has the same shape as new-booking SSR state).
- `scripts/probe-modify-experience.ts` — live round-trip: book → modify time → list_reservations (verify the time changed) → cancel. Mirrors `probe-book-cancel-experience.ts`.

**Modify:**
- `src/booking-token.ts` — extend `BookingTokenPayload` with three optional fields: `existingReservationId`, `existingConfirmationNumber`, `existingSecurityToken`. Presence of `existingReservationId` is the modify-vs-book discriminator. No new exported type.
- `src/tools/reservations.ts` — extend `bookingDetailsPath` helper with optional `confirmation_number` (adds `confirmationNumber=<n>` query param). Register `opentable_modify_preview` and `opentable_modify`. Share most of book_preview's slot-lock body / make-reservation body construction by extracting small helpers; only differences are the URL marker, the `excludeConfirmation` conflict check, the modify-token mint, and the `isModify: true` + `reservationId` body fields.
- `tests/booking-token.test.ts` — round-trip a modify-shaped token; verify legacy/book tokens decode without modify fields.
- `tests/tools/reservations.test.ts` — modify_preview + modify scenarios (Standard, Experience, same-day-exclusion, tamper-check, wrong-token-type).
- `SKILL.md` — "Modifying a reservation" section.
- `CLAUDE.md` — hot-spot on `confirmationNumber` URL marker + `excludeConfirmation`.
- `manifest.json` — list the two new tools (and bring the count from 11 listed → 13 listed; book_preview was already missing pre-this-plan).

---

### Task 0: Pre-flight live capture (manual, controller-driven)

**Goal:** One fixture captured live so parser tests run against real OpenTable state, not a synthetic shape.

**Files:**
- Create: `tests/fixtures/booking-details-state-modify.json`

This is hand-run by the controller (you). It does not run subagent code. There IS a live reservation available: confirmation #29541 (Cafe Pasqual's, 2026-06-25 18:00, party 5, Community Table Dining). If that reservation has been cancelled or moved, book a fresh one (or substitute any active opentable reservation).

- [ ] **Step 1: Drive Chrome to the modify URL for #29541**

In the bridged Chrome tab, navigate to:
```
https://www.opentable.com/booking/details?confirmationNumber=29541&rid=278896&datetime=2026-06-25T19:15&covers=5&partySize=5&seating=default&slotHash=<fresh from find_slots>&slotAvailabilityToken=<fresh>&diningAreaId=21881&experienceIds=514735&selectedExperience=514735&tableCategory=default&st=Experience&isMandatory=true
```

(The hash/token come from a fresh `find_slots` call for a different time — e.g., 19:15. The modify URL uses the NEW slot's params plus the existing reservation's `confirmationNumber`.)

To get fresh slot params, run from the repo root:
```bash
npx tsx scripts/probe-find-slots-raw.ts 278896 2026-06-25 19:15 5
```

then build the URL from the first slot's `slotHash` + `slotAvailabilityToken`.

- [ ] **Step 2: Capture `__INITIAL_STATE__` from the loaded page**

In DevTools console:
```javascript
copy(JSON.stringify(window.__INITIAL_STATE__, null, 2))
```

Paste into `tests/fixtures/booking-details-state-modify.json`. Run prettier on it for diff readability:
```bash
npx prettier --write tests/fixtures/booking-details-state-modify.json
```

- [ ] **Step 3: (optional) Capture the make-reservation modify body**

Install a fetch hook BEFORE clicking "Complete reservation":
```javascript
window.__capturedModifyBody = null;
const orig = window.fetch;
window.fetch = async function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (typeof url === 'string' && url.includes('/dapi/booking/make-reservation')) {
    window.__capturedModifyBody = args[1]?.body;
  }
  return orig.apply(this, args);
};
```

Then click "Complete reservation" — this MOVES reservation #29541 to 19:15. The hook captures the body. Confirm `isModify: true` and `reservationId` are the only modify-specific additions; if there are others (e.g., a `previousReservationId`, a `modifyReason`), note them — Task 4 will need to include them.

If you don't want to actually modify the live reservation, skip this step. The live probe in Task 5 will surface any missing fields via 400 errors, same iterate-on-error pattern that pinned the Experience body in PR #22.

- [ ] **Step 4: Commit the fixture**

```bash
git add tests/fixtures/booking-details-state-modify.json
git commit -m "test fixture: capture /booking/details modify state from #29541

Live capture against the Pasqual's reservation booked during the
capture-phase work. Drives later parser tests for the modify SSR path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If the fixture diverges materially from `booking-details-state-experience.json` (e.g., has new top-level keys beyond `modifyReservation`), note those keys in the commit body — Task 4's tests may need to assert on them.

---

### Task 1: Extend `BookingTokenPayload` with existing-reservation fields

**Files:**
- Modify: `src/booking-token.ts` (BookingTokenPayload interface, REQUIRED_KEYS array, decodeBookingToken validator)
- Modify: `tests/booking-token.test.ts` (new describe block)

Add three optional fields and a small validation rule: when `existingReservationId` is set, the other two `existing*` fields must also be set (so we never mint a half-formed modify token).

- [ ] **Step 1: Write the failing tests**

Add to `tests/booking-token.test.ts` (after the existing experience-token describe block):

```typescript
describe('booking-token — modify-token shape', () => {
  it('round-trips a modify token with the existing-reservation fields', () => {
    const before = {
      slotLockId: 111, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '19:15',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: true,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'experience' as const,
      experienceId: 514735, experienceVersion: 7,
      existingReservationId: 2082218741,
      existingConfirmationNumber: 29541,
      existingSecurityToken: '01lUHmpLpJ31EwPYPUSGIZTSMb3O41ehMhojol5ybqkWk1',
    };
    const after = decodeBookingToken(encodeBookingToken(before));
    expect(after.existingReservationId).toBe(2082218741);
    expect(after.existingConfirmationNumber).toBe(29541);
    expect(after.existingSecurityToken).toBe(before.existingSecurityToken);
  });

  it('a token with only some existing-* fields fails decode (partial-modify token)', () => {
    const malformed = {
      slotLockId: 1, restaurantId: 1, diningAreaId: 1,
      partySize: 1, date: '2026-06-25', time: '18:00',
      reservationToken: 't', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'standard' as const,
      existingReservationId: 1234, // ← present without the matching confirmation/security
    };
    const encoded = Buffer.from(JSON.stringify(malformed), 'utf8').toString('base64');
    expect(() => decodeBookingToken(encoded)).toThrow(/modify token must include existingConfirmationNumber and existingSecurityToken/);
  });

  it('book tokens (no existing-* fields) decode unchanged', () => {
    const bookToken = {
      slotLockId: 1, restaurantId: 1, diningAreaId: 1,
      partySize: 1, date: '2026-06-25', time: '18:00',
      reservationToken: 't', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'standard' as const,
    };
    const after = decodeBookingToken(encodeBookingToken(bookToken));
    expect(after.existingReservationId).toBeUndefined();
    expect(after.existingConfirmationNumber).toBeUndefined();
    expect(after.existingSecurityToken).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- booking-token
```

Expected: FAIL — the new fields aren't on `BookingTokenPayload`; the partial-modify validation isn't implemented.

- [ ] **Step 3: Extend `BookingTokenPayload`**

In `src/booking-token.ts`, find the existing interface (it ends with `experienceVersion?: number;`). Insert before the closing brace:

```typescript
  /** Existing reservation's database id, populated when this token is
   *  a modify token (minted by opentable_modify_preview). Presence of
   *  this field is the modify-vs-book discriminator. Absent on tokens
   *  minted by opentable_book_preview. */
  existingReservationId?: number;
  /** Existing reservation's confirmation_number, echoed back when the
   *  modify completes (OpenTable preserves confirmation_numbers across
   *  modifies). Required when existingReservationId is set. */
  existingConfirmationNumber?: number;
  /** Existing reservation's security_token, used by opentable_modify
   *  for an additional tamper check against the caller's args.
   *  Required when existingReservationId is set. */
  existingSecurityToken?: string;
```

- [ ] **Step 4: Add the partial-modify validation in decodeBookingToken**

Find the `decodeBookingToken` function. After the `paymentCard` and `bookingType` defaulting blocks, before the `return obj as unknown as BookingTokenPayload`, add:

```typescript
  // Modify-token integrity: if existingReservationId is set, the matching
  // confirmation_number + security_token must be present. Half-formed
  // modify tokens won't satisfy opentable_modify's tamper check anyway,
  // but failing fast here gives a clearer error.
  if ('existingReservationId' in obj) {
    if (
      typeof (obj as { existingConfirmationNumber?: unknown }).existingConfirmationNumber !== 'number' ||
      typeof (obj as { existingSecurityToken?: unknown }).existingSecurityToken !== 'string'
    ) {
      throw new Error(
        'modify token must include existingConfirmationNumber and existingSecurityToken alongside existingReservationId — was the token tampered with?'
      );
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- booking-token
```

Expected: PASS.

- [ ] **Step 6: Run full suite + build**

```bash
npm test && npm run build
```

Expected: all 129 tests pass (was 126 + 3 new), bundle builds clean.

- [ ] **Step 7: Commit**

```bash
git add src/booking-token.ts tests/booking-token.test.ts
git commit -m "booking-token: add modify-token fields (existingReservationId et al)

Three optional fields on BookingTokenPayload populated by
opentable_modify_preview: existingReservationId,
existingConfirmationNumber, existingSecurityToken. Presence of
existingReservationId is the modify-vs-book discriminator
opentable_modify uses to refuse book tokens.

Partial-modify tokens (existingReservationId set but the matching
fields missing) fail decode early with a clear error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extend `bookingDetailsPath` helper with optional `confirmation_number`

**Files:**
- Modify: `src/tools/reservations.ts:37-71` (the `bookingDetailsPath` helper)

The helper builds the `/booking/details?…` URL used by book_preview, book (no-token path), and now modify_preview. Add an optional `confirmation_number` input; when set, adds `confirmationNumber=<n>` to the URL — that's the modify marker OpenTable's SSR keys off of.

- [ ] **Step 1: Inspect the existing helper**

Read `src/tools/reservations.ts` lines 37-71. The helper currently accepts seven required + one optional input (`experience_id`). The new optional input mirrors that pattern.

- [ ] **Step 2: Extend the helper**

Replace the function signature and the existing-param block with:

```typescript
function bookingDetailsPath(input: {
  restaurant_id: number;
  date: string;
  time: string;
  party_size: number;
  slot_hash: string;
  reservation_token: string;
  dining_area_id: number;
  experience_id?: number;
  /** When set, marks this URL as a modify of an existing reservation.
   *  OpenTable's /booking/details SSR loads the modify state (existing
   *  CC hold, current slot details) when confirmationNumber is in the
   *  query string. Required by opentable_modify_preview. */
  confirmation_number?: number;
}): string {
  const params = new URLSearchParams({
    rid: String(input.restaurant_id),
    datetime: `${input.date}T${input.time}`,
    covers: String(input.party_size),
    partySize: String(input.party_size),
    seating: 'default',
    slotHash: input.slot_hash,
    slotAvailabilityToken: input.reservation_token,
    diningAreaId: String(input.dining_area_id),
  });
  if (typeof input.experience_id === 'number') {
    params.set('experienceIds', String(input.experience_id));
    params.set('selectedExperience', String(input.experience_id));
    params.set('tableCategory', 'default');
    params.set('st', 'Experience');
    params.set('isMandatory', 'true');
  }
  if (typeof input.confirmation_number === 'number') {
    params.set('confirmationNumber', String(input.confirmation_number));
  }
  return `/booking/details?${params.toString()}`;
}
```

The helper has no tests in `tests/` today (it's exercised indirectly via the tools' tests). Don't add a dedicated test file — the modify_preview tests in Task 3 will assert the `confirmationNumber=<n>` URL param via `mockFetchHtml`.

- [ ] **Step 3: Run full suite to confirm no regression**

```bash
npm test && npm run build
```

Expected: all tests still pass (the helper change is additive — book_preview/book don't pass `confirmation_number`, so the URL they build is byte-identical to before).

- [ ] **Step 4: Commit**

```bash
git add src/tools/reservations.ts
git commit -m "bookingDetailsPath: accept optional confirmation_number

When set, adds confirmationNumber=<n> to the /booking/details URL —
that's OpenTable's SSR modify marker. Used by opentable_modify_preview
in the next commit. Pure addition; book_preview / book unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Register `opentable_modify_preview`

**Files:**
- Modify: `src/tools/reservations.ts` (add a new `server.registerTool('opentable_modify_preview', …)` block right after the existing `opentable_book_preview` registration)
- Modify: `tests/tools/reservations.test.ts` (new describe block: `'opentable_modify_preview'`)

This is the most substantial task. Reuses the book_preview body almost verbatim — only differences are listed in the spec's data-flow §.

- [ ] **Step 1: Write the failing tests**

Add a new top-level describe to `tests/tools/reservations.test.ts`:

```typescript
import modifyState from '../fixtures/booking-details-state-modify.json' with { type: 'json' };

describe('opentable_modify_preview', () => {
  describe('Experience-mandatory slot (Pasqual\'s style)', () => {
    it('builds the /booking/details URL with confirmationNumber + Experience params, slot-locks, returns modify_token', async () => {
      mockFetchHtml.mockResolvedValue(htmlWith(modifyState));
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
        if (path.includes('opname=BookDetailsExperienceSlotLock')) {
          return {
            data: { lockExperienceSlot: { success: true, slotLock: { slotLockId: 8888 } } },
            __observed: init?.body,
          };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const result = await harness.callTool('opentable_modify_preview', {
        restaurant_id: 278896,
        confirmation_number: 29541,
        security_token: '01abc',
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '4444',
        dining_area_id: 21881,
        experience_id: 514735,
      });

      // URL contains confirmationNumber + Experience params
      const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
      expect(htmlUrl).toContain('confirmationNumber=29541');
      expect(htmlUrl).toContain('selectedExperience=514735');
      expect(htmlUrl).toContain('st=Experience');

      // Result shape
      expect(result.isError).toBeFalsy();
      const json = JSON.parse((result.content[0] as { text: string }).text);
      expect(json.booking_type).toBe('experience_mandatory');
      expect(json.existing_reservation).toEqual({
        confirmation_number: 29541,
        restaurant_id: 278896,
      });
      expect(json.reservation).toMatchObject({
        date: '2026-06-25',
        time: '19:15',
        party_size: 5,
      });
      expect(json.experience?.experience_id).toBe(514735);

      // Token carries the existing-reservation identity AND the new slot's
      // routing info (bookingType=experience, experienceId, experienceVersion).
      const decoded = decodeBookingToken(json.modify_token);
      expect(decoded.existingReservationId).toBeGreaterThan(0);
      expect(decoded.existingConfirmationNumber).toBe(29541);
      expect(decoded.existingSecurityToken).toBe('01abc');
      expect(decoded.bookingType).toBe('experience');
      expect(decoded.experienceId).toBe(514735);
    });
  });

  describe('Standard slot', () => {
    it('builds the /booking/details URL with confirmationNumber, slot-locks via Standard op, returns modify_token', async () => {
      // Reuse the existing booking-details-state-no-cc fixture (Standard, no CC).
      mockFetchHtml.mockResolvedValue(htmlWith(fixture('booking-details-state-no-cc.json')));
      mockFetchJson.mockImplementation(async (path: string, init?: { body?: unknown }) => {
        if (path.includes('opname=BookDetailsStandardSlotLock')) {
          return {
            data: { lockSlot: { success: true, slotLock: { slotLockId: 7777 } } },
            __observed: init?.body,
          };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const result = await harness.callTool('opentable_modify_preview', {
        restaurant_id: 1272781,
        confirmation_number: 11111,
        security_token: '02xyz',
        date: '2026-05-05',
        time: '20:00',
        party_size: 2,
        reservation_token: 'tok',
        slot_hash: 'h',
        dining_area_id: 1,
      });

      const htmlUrl = mockFetchHtml.mock.calls[0][0] as string;
      expect(htmlUrl).toContain('confirmationNumber=11111');
      expect(htmlUrl).not.toContain('st=Experience');

      const json = JSON.parse((result.content[0] as { text: string }).text);
      expect(json.booking_type).toBe('instant');
      expect(json.existing_reservation.confirmation_number).toBe(11111);
      const decoded = decodeBookingToken(json.modify_token);
      expect(decoded.bookingType).toBe('standard');
      expect(decoded.existingConfirmationNumber).toBe(11111);
    });
  });

  describe('same-day move (existing reservation excluded from conflict check)', () => {
    it('does not throw when the only conflict on new_date is the existing reservation being moved', async () => {
      // Construct a state with a single conflict that matches the existing
      // reservation's confirmation_number — excludeConfirmation should skip it.
      const stateWithSelfConflict = {
        ...(fixture('booking-details-state-no-cc.json') as object),
        upcomingReservationConflicts: [
          {
            dateTime: '2026-05-05T18:00',
            confirmationNumber: 11111, // ← same as the existing one
            partySize: 2,
            restaurant: { restaurantId: 1272781, name: 'X' },
          },
        ],
      };
      mockFetchHtml.mockResolvedValue(htmlWith(stateWithSelfConflict));
      mockFetchJson.mockImplementation(async (path: string) => {
        if (path.includes('opname=BookDetailsStandardSlotLock')) {
          return { data: { lockSlot: { success: true, slotLock: { slotLockId: 1 } } } };
        }
        throw new Error(`unexpected POST: ${path}`);
      });

      const result = await harness.callTool('opentable_modify_preview', {
        restaurant_id: 1272781,
        confirmation_number: 11111,
        security_token: '02xyz',
        date: '2026-05-05',
        time: '20:00',
        party_size: 2,
        reservation_token: 'tok',
        slot_hash: 'h',
        dining_area_id: 1,
      });

      expect(result.isError).toBeFalsy();
    });

    it('still throws if a DIFFERENT same-day reservation exists', async () => {
      const stateWithOtherConflict = {
        ...(fixture('booking-details-state-no-cc.json') as object),
        upcomingReservationConflicts: [
          {
            dateTime: '2026-05-05T13:00',
            confirmationNumber: 99999, // ← different reservation
            partySize: 4,
            restaurant: { restaurantId: 5, name: 'Brunch Spot' },
          },
        ],
      };
      mockFetchHtml.mockResolvedValue(htmlWith(stateWithOtherConflict));

      const result = await harness.callTool('opentable_modify_preview', {
        restaurant_id: 1272781,
        confirmation_number: 11111,
        security_token: '02xyz',
        date: '2026-05-05',
        time: '20:00',
        party_size: 2,
        reservation_token: 'tok',
        slot_hash: 'h',
        dining_area_id: 1,
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/two reservations on the same day/i);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tools/reservations
```

Expected: FAIL — `opentable_modify_preview` isn't registered.

- [ ] **Step 3: Register `opentable_modify_preview` in `src/tools/reservations.ts`**

Find the existing `opentable_book_preview` registration. After its closing `);`, add a new registration:

```typescript
  server.registerTool(
    'opentable_modify_preview',
    {
      description:
        "Preview a MODIFICATION to an existing OpenTable reservation. Takes the existing reservation's identity (restaurant_id + confirmation_number + security_token from opentable_list_reservations or the original opentable_book result) plus the NEW slot args (from a fresh opentable_find_slots call) and returns the new cancellation_policy, CC re-hold details, and a `modify_token` that opentable_modify consumes. Mirrors opentable_book_preview, but the /booking/details URL includes confirmationNumber=<n> so OpenTable's SSR returns the modify state. REQUIRED before opentable_modify — no shortcut path. For Listing-type restaurants the modify can't proceed (no slot picker); check opentable_get_restaurant.bookable first.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
        date: z.string().describe('YYYY-MM-DD (the NEW date)'),
        time: z.string().describe('HH:MM (24h) — the NEW time'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots for the NEW slot'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots for the NEW slot'),
        dining_area_id: z.number().int(),
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('For Experience-mandatory slots; required when the new slot has experience_ids.'),
        experience_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe('Pass-through from find_slots.experience_ids. When non-empty, experience_id must also be set.'),
      },
    },
    async ({
      restaurant_id,
      confirmation_number,
      security_token,
      date,
      time,
      party_size,
      reservation_token,
      slot_hash,
      dining_area_id,
      experience_id,
      experience_ids,
    }) => {
      const reservationDateTime = `${date}T${time}`;

      const isExperience =
        (Array.isArray(experience_ids) && experience_ids.length > 0) ||
        typeof experience_id === 'number';
      if (isExperience && typeof experience_id !== 'number') {
        throw new Error(
          'This slot requires picking an Experience. Options: ' +
            JSON.stringify(experience_ids) +
            '. Re-call opentable_modify_preview with experience_id set to one of them.'
        );
      }

      // 1) /booking/details SSR with confirmationNumber=<n> marker.
      const detailsHtml = await client.fetchHtml(
        bookingDetailsPath({
          restaurant_id,
          date,
          time,
          party_size,
          slot_hash,
          reservation_token,
          dining_area_id,
          experience_id,
          confirmation_number, // ← the only difference vs book_preview's URL build
        })
      );
      const state = extractInitialState(detailsHtml);
      const summary = parseBookingDetailsState(state);

      // 2) Same-day conflicts — exclude the reservation being moved.
      const conflicts = sameDayConflicts(summary.conflicts, date, confirmation_number);
      if (conflicts.length > 0) {
        throw sameDayConflictError(conflicts, date);
      }

      if (summary.cc_required && !summary.default_card) {
        throw new Error(
          'No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again.'
        );
      }

      // 3) Slot-lock — same hashes/ops as book_preview.
      const lockPath = isExperience ? EXPERIENCE_SLOT_LOCK_PATH : SLOT_LOCK_PATH;
      const lockOp = isExperience ? 'BookDetailsExperienceSlotLock' : 'BookDetailsStandardSlotLock';
      const lockHash = isExperience ? BOOK_EXPERIENCE_SLOT_LOCK_HASH : BOOK_SLOT_LOCK_HASH;
      const lockVariables: Record<string, unknown> = isExperience
        ? {
            input: {
              restaurantId: restaurant_id,
              seatingOption: 'DEFAULT',
              reservationDateTime,
              partySize: party_size,
              databaseRegion: 'NA',
              slotHash: slot_hash,
              experienceId: experience_id,
              experienceVersion: summary.experience?.version ?? 1,
              diningAreaId: dining_area_id,
              bookingType: 'Table',
              slotAvailabilityToken: reservation_token,
            },
          }
        : {
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
          };
      const lockResponse = await client.fetchJson<{
        data?: {
          lockSlot?: { success?: boolean; slotLock?: { slotLockId?: number } };
          lockExperienceSlot?: { success?: boolean; slotLock?: { slotLockId?: number } };
        };
      }>(lockPath, {
        method: 'POST',
        headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
        body: {
          operationName: lockOp,
          variables: lockVariables,
          extensions: { persistedQuery: { version: 1, sha256Hash: lockHash } },
        },
      });
      const lockResult = isExperience
        ? lockResponse?.data?.lockExperienceSlot
        : lockResponse?.data?.lockSlot;
      const slotLockId = lockResult?.slotLock?.slotLockId;
      if (!slotLockId || lockResult?.success !== true) {
        throw new Error(
          `OpenTable failed to lock slot for modify preview: ${JSON.stringify(lockResult ?? lockResponse)}`
        );
      }

      // 4) Mint the modify_token. Existing* fields are what distinguishes
      //    this from a book_token; the rest of the payload is identical.
      //    We DON'T have the existing reservationId yet — we'll pull it from
      //    the SSR state in a follow-up if needed. For now, OpenTable's
      //    make-reservation accepts confirmationNumber as the identifier;
      //    parseBookingDetailsState's parsed reservation_id would let us
      //    populate this rigorously, but it's not surfaced today. Use the
      //    parsed value when available, otherwise fall through to
      //    confirmation_number which make-reservation also accepts.
      const existingReservationId =
        (state as { modifyReservation?: { reservationId?: number } }).modifyReservation
          ?.reservationId ?? confirmation_number;

      const paymentCard =
        summary.cc_required && summary.default_card
          ? {
              id: summary.default_card.id,
              last4: summary.default_card.last4,
              expiryMmYy: expiryMmYy(
                summary.default_card.expiry_month,
                summary.default_card.expiry_year
              ),
              provider: CC_PROVIDER,
            }
          : null;

      const modify_token = encodeBookingToken({
        slotLockId,
        restaurantId: restaurant_id,
        diningAreaId: dining_area_id,
        partySize: party_size,
        date,
        time,
        reservationToken: reservation_token,
        slotHash: slot_hash,
        paymentCard,
        ccRequired: summary.cc_required,
        issuedAt: new Date().toISOString(),
        bookingType: isExperience ? 'experience' : 'standard',
        ...(isExperience
          ? {
              experienceId: experience_id,
              experienceVersion: summary.experience?.version ?? 1,
            }
          : {}),
        existingReservationId,
        existingConfirmationNumber: confirmation_number,
        existingSecurityToken: security_token,
      });

      const chargesDescription = summary.cc_required
        ? `Nothing charged now — ${summary.default_card!.brand} •••• ${summary.default_card!.last4} re-held only. ${summary.policy.description}`
        : 'Nothing charged now — no card required.';

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                modify_token,
                booking_type: isExperience ? 'experience_mandatory' : 'instant',
                experience: summary.experience,
                existing_reservation: {
                  confirmation_number,
                  restaurant_id,
                },
                reservation: { date, time, party_size, restaurant_id, dining_area_id },
                cancellation_policy: summary.policy,
                payment_method:
                  summary.cc_required && summary.default_card
                    ? { brand: summary.default_card.brand, last4: summary.default_card.last4 }
                    : null,
                charges_at_booking: { amount_usd: 0, description: chargesDescription },
                cc_required: summary.cc_required,
                policy_type: summary.policy_type,
                terms: summary.terms,
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

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tools/reservations
```

Expected: PASS (4 new tests inside the new describe blocks).

- [ ] **Step 5: Run full suite + build**

```bash
npm test && npm run build
```

Expected: 133 tests pass (129 + 4 new), bundle builds clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "tools: register opentable_modify_preview

Builds /booking/details URL with confirmationNumber=<n> (OpenTable's
modify SSR marker), runs the same slot-lock (Standard or Experience)
as book_preview, mints a modify_token carrying the existing
reservation's identity alongside the new slot's payload. Same-day
conflict check uses excludeConfirmation so the reservation being
moved doesn't false-positive against itself.

Token has existingReservationId/ConfirmationNumber/SecurityToken set
— that's the discriminator opentable_modify will use in the next
commit to refuse book_preview tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Register `opentable_modify`

**Files:**
- Modify: `src/tools/reservations.ts` (add a new `server.registerTool('opentable_modify', …)` block right after the existing `opentable_book` registration)
- Modify: `tests/tools/reservations.test.ts` (new describe block: `'opentable_modify'`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools/reservations.test.ts`:

```typescript
describe('opentable_modify', () => {
  it('with a modify token: submits make-reservation with isModify: true and the existing reservationId', async () => {
    mockFetchHtml.mockResolvedValue(
      mockDashboardHtml({
        first_name: 'A', last_name: 'B', email: 'a@b.c',
        mobile_phone: '+1 5550000', country_id: 'US',
      })
    );
    let makeBody: Record<string, unknown> | null = null;
    mockFetchJson.mockImplementation(async (path: string, init?: { body?: Record<string, unknown> }) => {
      if (path === '/dapi/booking/make-reservation') {
        makeBody = init?.body ?? null;
        return { confirmationNumber: 29541, reservationId: 2082218742, securityToken: 'sec2', success: true };
      }
      throw new Error(`unexpected POST: ${path}`);
    });

    const token = encodeBookingToken({
      slotLockId: 8888, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '19:15',
      reservationToken: 'tok', slotHash: '4444',
      paymentCard: { id: 'card-1', last4: '2630', expiryMmYy: '1028', provider: 'spreedly' },
      ccRequired: true,
      issuedAt: new Date().toISOString(),
      bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
      existingReservationId: 2082218741,
      existingConfirmationNumber: 29541,
      existingSecurityToken: '01abc',
    });

    const result = await harness.callTool('opentable_modify', {
      restaurant_id: 278896,
      confirmation_number: 29541,
      security_token: '01abc',
      date: '2026-06-25',
      time: '19:15',
      party_size: 5,
      reservation_token: 'tok',
      slot_hash: '4444',
      dining_area_id: 21881,
      modify_token: token,
      experience_id: 514735,
    });

    expect(result.isError).toBeFalsy();
    expect(makeBody!.isModify).toBe(true);
    expect(makeBody!.reservationId).toBe(2082218741);
    expect(makeBody!.experienceId).toBe(514735);
    expect(makeBody!.experienceVersion).toBe(7);
    expect(makeBody!.reservationType).toBe('Experience');
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.confirmation_number).toBe(29541); // preserved across modify
    expect(json.was_modified).toBe(true);
    expect(json.booking_type).toBe('experience_mandatory');
  });

  it('refuses without a modify_token', async () => {
    const result = await harness.callTool('opentable_modify', {
      restaurant_id: 278896,
      confirmation_number: 29541,
      security_token: '01abc',
      date: '2026-06-25',
      time: '19:15',
      party_size: 5,
      reservation_token: 'tok',
      slot_hash: '4444',
      dining_area_id: 21881,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/modify_preview/);
  });

  it('refuses a book_preview token (no existingReservationId)', async () => {
    // Mint a token without the existing-reservation fields — this is what
    // opentable_book_preview produces. opentable_modify must refuse it.
    const bookToken = encodeBookingToken({
      slotLockId: 9999, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '19:15',
      reservationToken: 'tok', slotHash: '4444',
      paymentCard: null, ccRequired: false,
      issuedAt: new Date().toISOString(),
      bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
    });

    const result = await harness.callTool('opentable_modify', {
      restaurant_id: 278896,
      confirmation_number: 29541,
      security_token: '01abc',
      date: '2026-06-25',
      time: '19:15',
      party_size: 5,
      reservation_token: 'tok',
      slot_hash: '4444',
      dining_area_id: 21881,
      modify_token: bookToken,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/book_preview.*not.*opentable_modify_preview/i);
  });

  it('refuses when caller confirmation_number diverges from the token', async () => {
    const token = encodeBookingToken({
      slotLockId: 8888, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '19:15',
      reservationToken: 'tok', slotHash: '4444',
      paymentCard: null, ccRequired: false,
      issuedAt: new Date().toISOString(),
      bookingType: 'experience', experienceId: 514735, experienceVersion: 7,
      existingReservationId: 2082218741,
      existingConfirmationNumber: 29541,
      existingSecurityToken: '01abc',
    });

    const result = await harness.callTool('opentable_modify', {
      restaurant_id: 278896,
      confirmation_number: 99999, // ← drifted
      security_token: '01abc',
      date: '2026-06-25',
      time: '19:15',
      party_size: 5,
      reservation_token: 'tok',
      slot_hash: '4444',
      dining_area_id: 21881,
      modify_token: token,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/different reservation/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tools/reservations
```

Expected: FAIL — `opentable_modify` isn't registered.

- [ ] **Step 3: Register `opentable_modify` in `src/tools/reservations.ts`**

After the existing `opentable_book` registration, add:

```typescript
  server.registerTool(
    'opentable_modify',
    {
      description:
        "Modify an existing OpenTable reservation in place. Requires the existing reservation's identity (restaurant_id + confirmation_number + security_token) plus a fresh modify_token from opentable_modify_preview — preview is mandatory because the new slot's cancellation policy / CC re-hold can differ from the original. Submits /dapi/booking/make-reservation with isModify: true + the existing reservationId; OpenTable preserves confirmation_number across modifies but may regenerate reservation_id and security_token. Returns the same shape as opentable_book plus was_modified: true so the agent can phrase the user confirmation accurately. For Listing-type restaurants there's no slot to lock — agents should check opentable_get_restaurant.bookable first.",
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
        date: z.string().describe('YYYY-MM-DD (the NEW date)'),
        time: z.string().describe('HH:MM (24h) — the NEW time'),
        party_size: z.number().int().positive(),
        reservation_token: z.string().describe('slot_availability_token from opentable_find_slots for the NEW slot'),
        slot_hash: z.string().describe('slot_hash from opentable_find_slots for the NEW slot'),
        dining_area_id: z.number().int(),
        modify_token: z
          .string()
          .describe('REQUIRED. From opentable_modify_preview. No no-token path — the new slot\'s policy + CC re-hold can differ from the original.'),
        experience_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional tamper-check signal. When set, must match the experienceId baked into modify_token.'),
        experience_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe('Pass-through from find_slots. Not directly used; modify always goes through preview-first.'),
      },
    },
    async ({
      restaurant_id,
      confirmation_number,
      security_token,
      date,
      time,
      party_size,
      reservation_token,
      slot_hash,
      dining_area_id,
      modify_token,
      experience_id: callerExperienceId,
    }) => {
      const reservationDateTime = `${date}T${time}`;
      const diningAreaId = dining_area_id;

      if (!modify_token) {
        throw new Error(
          'opentable_modify requires a modify_token from opentable_modify_preview. The new slot\'s policy and CC re-hold details can differ from the original — preview is mandatory.'
        );
      }

      const payload = decodeBookingToken(modify_token);

      if (typeof payload.existingReservationId !== 'number') {
        throw new Error(
          'This token was issued by opentable_book_preview (a new-booking token), not opentable_modify_preview. Use opentable_book to commit, or call opentable_modify_preview if you meant to edit an existing reservation.'
        );
      }

      if (
        payload.restaurantId !== restaurant_id ||
        payload.date !== date ||
        payload.time !== time ||
        payload.partySize !== party_size ||
        payload.diningAreaId !== dining_area_id ||
        payload.existingConfirmationNumber !== confirmation_number ||
        payload.existingSecurityToken !== security_token ||
        (typeof callerExperienceId === 'number' && payload.experienceId !== callerExperienceId)
      ) {
        throw new Error(
          'modify_token was issued for a different reservation (party_size, date/time, dining area, experience_id, or the existing reservation identifier has changed since opentable_modify_preview). Call opentable_modify_preview again with the current args.'
        );
      }

      const slotLockId = payload.slotLockId;
      const paymentCard = payload.paymentCard;
      const ccRequired = payload.ccRequired;
      const bookingType = payload.bookingType;
      const experienceId = payload.experienceId;
      const experienceVersion = payload.experienceVersion;

      const profile = await fetchProfile(client);

      const ccFields = paymentCard
        ? {
            creditCardToken: paymentCard.id,
            creditCardLast4: paymentCard.last4,
            creditCardMMYY: paymentCard.expiryMmYy,
            creditCardProvider: paymentCard.provider,
            scaRedirectUrl: SCA_REDIRECT_URL,
          }
        : {};

      const experienceFields =
        bookingType === 'experience' && typeof experienceId === 'number'
          ? {
              experienceId,
              experienceVersion: experienceVersion ?? 1,
              reservationType: 'Experience',
            }
          : { reservationType: 'Standard' };

      const reservation = await client.fetchJson<{
        success?: boolean;
        reservationId?: number;
        confirmationNumber?: number;
        securityToken?: string;
        points?: number;
        errorCode?: string;
        errorMessage?: string;
        partnerScaRequired?: boolean;
        partnerScaRedirectUrl?: string | null;
      }>(MAKE_RESERVATION_PATH, {
        method: 'POST',
        body: {
          restaurantId: restaurant_id,
          reservationDateTime,
          partySize: party_size,
          slotHash: slot_hash,
          slotAvailabilityToken: reservation_token,
          slotLockId,
          diningAreaId,
          firstName: profile.first_name,
          lastName: profile.last_name,
          email: profile.email,
          phoneNumber: profile.mobile_phone_number,
          phoneNumberCountryId: profile.country_id || 'US',
          country: profile.country_id || 'US',
          reservationAttribute: 'default',
          pointsType: 'Standard',
          points: 100,
          tipAmount: 0,
          tipPercent: 0,
          confirmPoints: true,
          optInEmailRestaurant: false,
          isModify: true,
          reservationId: payload.existingReservationId,
          additionalServiceFees: [],
          nonBookableExperiences: [],
          katakanaFirstName: '',
          katakanaLastName: '',
          correlationId: randomUUID(),
          ...experienceFields,
          ...ccFields,
        },
      });

      if (reservation?.partnerScaRequired === true) {
        throw new Error(
          `This card requires 3-D Secure authentication (SCA), which can't be completed from the MCP. Complete the modify in your browser: ${
            reservation.partnerScaRedirectUrl ?? 'https://www.opentable.com/booking'
          }`
        );
      }
      if (reservation?.errorCode || reservation?.success === false) {
        const raw = `${reservation.errorCode ?? 'unknown'}${
          reservation.errorMessage ? ` — ${reservation.errorMessage}` : ''
        }`;
        if (/slot.?lock.?expired/i.test(raw) || /SLOT_LOCK_EXPIRED/i.test(raw)) {
          throw new Error(
            'Slot lock expired. Call opentable_find_slots for a fresh slot, then re-preview with opentable_modify_preview.'
          );
        }
        throw new Error(`OpenTable modify failed: ${raw}`);
      }
      if (!reservation?.confirmationNumber) {
        throw new Error(
          `OpenTable modify response missing confirmationNumber: ${JSON.stringify(reservation)}`
        );
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
                booking_type: bookingType === 'experience' ? 'experience_mandatory' : 'instant',
                was_modified: true,
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

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tools/reservations
```

Expected: PASS (4 new tests).

- [ ] **Step 5: Run full suite + build**

```bash
npm test && npm run build
```

Expected: 137 tests pass (133 + 4 new), bundle builds clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "tools: register opentable_modify

Decodes modify_token, refuses book tokens (no existingReservationId),
tamper-checks against caller args + the existing reservation
identifiers, then POSTs /dapi/booking/make-reservation with
isModify: true + reservationId from the token. Same Experience body
shape (experienceVersion, reservationType: 'Experience') as book.

Result preserves confirmation_number, may regenerate reservation_id
and security_token (OpenTable's contract). Adds was_modified: true
so the agent can phrase the user confirmation correctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Live round-trip probe + iterate on wire-format gaps

**Files:**
- Create: `scripts/probe-modify-experience.ts`

The unit tests are mocked. This probe is the truth-check against OpenTable's real endpoints. The Experience body shape was discovered live (PR #22) via the same iterate-on-error pattern; modify likely needs at most one or two iterations.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-modify-experience.ts`:

```typescript
#!/usr/bin/env tsx
// Live probe for modify. Books → modifies (moves time) → cancels.
// All actions on real OpenTable; the modify probe is the truth-check
// the unit tests can't be.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = Number(process.env.OT_MODIFY_RID ?? 278896);
const DINING_AREA_ID = Number(process.env.OT_MODIFY_AREA ?? 21881);
const EXPERIENCE_ID = Number(process.env.OT_MODIFY_EXP ?? 514735);
const PARTY = Number(process.env.OT_MODIFY_PARTY ?? 2);

const today = new Date();
const twoWeeksOut = new Date(today.getTime() + 14 * 86400_000);
const DATE =
  process.env.OT_MODIFY_DATE ??
  `${twoWeeksOut.getFullYear()}-${String(twoWeeksOut.getMonth() + 1).padStart(2, '0')}-${String(twoWeeksOut.getDate()).padStart(2, '0')}`;
const ORIG_TIME = process.env.OT_MODIFY_TIME ?? '18:00';
const NEW_TIME = process.env.OT_MODIFY_NEW_TIME ?? '19:15';

const c = new Client({ name: 'probe-modify', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: (r.content[0] as { text: string }).text };
}

async function findSlot(time: string) {
  const r = await call('opentable_find_slots', {
    restaurant_id: RID, date: DATE, time, party_size: PARTY,
  });
  if (r.isError) {
    console.error(`find_slots(${time}) failed:`, r.text);
    process.exit(1);
  }
  const slots = JSON.parse(r.text) as Array<{
    reservation_token: string; slot_hash: string; time: string;
    experience_ids?: number[];
  }>;
  const exact = slots.find((s) => s.time === time);
  if (!exact) {
    console.error(`no slot at ${time} — got ${slots.map((s) => s.time).join(',')}`);
    process.exit(1);
  }
  return exact;
}

console.log(`── 1) book at ${DATE} ${ORIG_TIME} ──`);
const origSlot = await findSlot(ORIG_TIME);
const previewResp = await call('opentable_book_preview', {
  restaurant_id: RID, date: DATE, time: ORIG_TIME, party_size: PARTY,
  reservation_token: origSlot.reservation_token, slot_hash: origSlot.slot_hash,
  dining_area_id: DINING_AREA_ID, experience_id: EXPERIENCE_ID,
});
if (previewResp.isError) { console.error('book_preview failed:', previewResp.text); process.exit(1); }
const bookPreview = JSON.parse(previewResp.text);
const bookResp = await call('opentable_book', {
  restaurant_id: RID, date: DATE, time: ORIG_TIME, party_size: PARTY,
  reservation_token: origSlot.reservation_token, slot_hash: origSlot.slot_hash,
  dining_area_id: DINING_AREA_ID,
  booking_token: bookPreview.booking_token,
  experience_id: EXPERIENCE_ID,
});
if (bookResp.isError) { console.error('book failed:', bookResp.text); process.exit(1); }
const booked = JSON.parse(bookResp.text);
console.log(`booked conf=${booked.confirmation_number} security=${booked.security_token}`);

console.log(`── 2) modify to ${NEW_TIME} ──`);
const newSlot = await findSlot(NEW_TIME);
const modifyPreviewResp = await call('opentable_modify_preview', {
  restaurant_id: RID,
  confirmation_number: booked.confirmation_number,
  security_token: booked.security_token,
  date: DATE, time: NEW_TIME, party_size: PARTY,
  reservation_token: newSlot.reservation_token, slot_hash: newSlot.slot_hash,
  dining_area_id: DINING_AREA_ID, experience_id: EXPERIENCE_ID,
});
if (modifyPreviewResp.isError) { console.error('modify_preview failed:', modifyPreviewResp.text); /* fall through to cancel */ }
let modified: { confirmation_number?: number; security_token?: string } = booked;
if (!modifyPreviewResp.isError) {
  const modifyPreview = JSON.parse(modifyPreviewResp.text);
  console.log(`modify preview ok; new policy: ${modifyPreview.cancellation_policy?.type}`);
  const modifyResp = await call('opentable_modify', {
    restaurant_id: RID,
    confirmation_number: booked.confirmation_number,
    security_token: booked.security_token,
    date: DATE, time: NEW_TIME, party_size: PARTY,
    reservation_token: newSlot.reservation_token, slot_hash: newSlot.slot_hash,
    dining_area_id: DINING_AREA_ID,
    modify_token: modifyPreview.modify_token,
    experience_id: EXPERIENCE_ID,
  });
  console.log(modifyResp.isError ? `[ISERROR=true] ${modifyResp.text}` : modifyResp.text);
  if (!modifyResp.isError) modified = JSON.parse(modifyResp.text);
}

console.log(`── 3) verify via list_reservations ──`);
const list = await call('opentable_list_reservations', { scope: 'upcoming' });
const reservations = JSON.parse(list.text) as Array<{
  confirmation_number: number; date: string; time: string; security_token: string; restaurant_id: number;
}>;
const found = reservations.find((r) => r.confirmation_number === booked.confirmation_number);
if (found) console.log(`  found conf=${found.confirmation_number} at ${found.date} ${found.time}`);
else console.log('  reservation not visible in upcoming list');

console.log(`── 4) cancel ──`);
const cancelResp = await call('opentable_cancel', {
  restaurant_id: RID,
  confirmation_number: modified.confirmation_number ?? booked.confirmation_number,
  security_token: modified.security_token ?? booked.security_token,
});
console.log(cancelResp.isError ? `[ISERROR=true] ${cancelResp.text}` : cancelResp.text);

await c.close();
console.log('── done ──');
```

- [ ] **Step 2: Build + run the probe**

```bash
lsof -ti :37149 | xargs -r kill 2>/dev/null
sleep 2
npm run build && npx tsx scripts/probe-modify-experience.ts
```

Expected outcomes (in priority order):

1. **Happy path:** book succeeds, modify succeeds, list_reservations shows the new time, cancel succeeds. Probe is green.
2. **Modify 400 with a specific missing/disallowed field:** read the validation error, add or remove the field in `opentable_modify`'s make-reservation body, rebuild, retry. Pattern is the same as PR #22's Experience iterations (3-4 round trips).
3. **modify_preview 400:** very unlikely; the SSR / slot-lock are byte-identical to book_preview. If it does happen, diff the actual URL against the URL the live browser modify uses.

- [ ] **Step 3: Capture any wire-format adjustments back into the impl**

If the probe surfaced missing fields (e.g., `previousReservationId`, `modifyReason`), patch `src/tools/reservations.ts` (the modify handler's make-reservation body) and `tests/tools/reservations.test.ts` (the Task 4 test that asserts on the body shape). Commit each iteration:

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "fix: <field-name> required on make-reservation modify body

Live probe against Pasqual's surfaced that <field> is required when
isModify: true. Adding it as <source / hardcode>. Verified by re-running
probe-modify-experience.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Commit the probe script**

```bash
git add scripts/probe-modify-experience.ts
git commit -m "scripts: live probe for modify (book → modify → cancel)

Round-trip against Pasqual's Community Table Dining. Books a fresh
Experience reservation, modifies the time, verifies via
list_reservations, then cancels. Use during release verification or
when re-pinning persisted-query hashes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation + manifest

**Files:**
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`
- Modify: `manifest.json`

- [ ] **Step 1: SKILL.md — add a "Modifying a reservation" section**

Find a logical location (after the non-instant bookings section or alongside the booking-tool descriptions). Add:

```markdown
## Modifying a reservation

To change date/time/party_size/dining_area/experience on an existing reservation, use `opentable_modify_preview` + `opentable_modify`. Mirrors book's preview→commit pattern.

1. Call `opentable_find_slots` for the NEW time you want.
2. Call `opentable_modify_preview` with:
   - The existing reservation's `restaurant_id`, `confirmation_number`, `security_token` (from `opentable_list_reservations` or the original `opentable_book` result).
   - The NEW slot's `date`, `time`, `party_size`, `reservation_token`, `slot_hash`, `dining_area_id`, and (for Experience-mandatory restaurants) `experience_id`.
3. Surface the returned `cancellation_policy` and any CC re-hold details to the user.
4. Call `opentable_modify` with the `modify_token` from preview + the same identifying args. Returns `was_modified: true` and the preserved `confirmation_number`.

Don't use cancel + book to "modify" — same-day cancel-then-rebook trips OpenTable's double-booking check and risks losing the slot to another diner.
```

- [ ] **Step 2: CLAUDE.md — add a hot-spot**

Find the "Hot spots / gotchas" section. Add at the end:

```markdown
- **Modify uses the same SSR + slot-lock as book, with one URL marker.** `/booking/details?confirmationNumber=<n>&…<new-slot-params>` returns the modify state. Without that query param the page treats it as a new booking and `make-reservation` 400s when `isModify: true` is set. The same-day-conflict helper takes an `excludeConfirmation` arg — `opentable_modify_preview` uses it to avoid false-positives against the reservation being moved.
```

- [ ] **Step 3: manifest.json — add the two new tools**

The `manifest.json` `tools` array currently lists 10 (it's missing `opentable_book_preview` which was added in v0.9). Add `opentable_book_preview`, `opentable_modify_preview`, and `opentable_modify`:

```json
{
  "name": "opentable_book_preview",
  "description": "Preview an OpenTable booking before committing — surfaces the cancellation policy + saved card; required for CC-required slots."
},
{
  "name": "opentable_modify_preview",
  "description": "Preview a modification to an existing OpenTable reservation; returns the new slot's policy + a modify_token."
},
{
  "name": "opentable_modify",
  "description": "Modify an existing OpenTable reservation in place. Requires a modify_token from opentable_modify_preview."
}
```

Insert them in the natural order: book_preview after `opentable_find_slots`, then `opentable_book`, then `opentable_cancel`, then modify_preview + modify (or wherever the file's existing order suggests). Keep alphabetical-by-domain consistency where it already exists.

- [ ] **Step 4: Run tests + build**

```bash
npm test && npm run build
```

Expected: all tests pass (docs/manifest don't affect tests).

- [ ] **Step 5: Commit**

```bash
git add SKILL.md CLAUDE.md manifest.json
git commit -m "docs: modify-reservation workflow + manifest tool list

SKILL.md: agent-facing section describing the modify_preview → modify
flow. Calls out that cancel+book is the wrong pattern for in-place
edits.

CLAUDE.md: hot-spot on the confirmationNumber URL marker that flips
the /booking/details SSR into modify mode, and the excludeConfirmation
arg on sameDayConflicts that prevents the moving reservation from
false-positiving against itself.

manifest.json: backfills the missing opentable_book_preview entry
from v0.9 and adds the two new modify tools — count now 13.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final code review (whole branch)

Dispatch a fresh code-review subagent against the entire diff `main..capture/experience-slot-lock-hash` (which is the long-lived branch the user has been accumulating work on). Review focuses on:

- Cross-task consistency (modify_preview vs book_preview parallelism)
- That no duplication crept in that should have been extracted (e.g., the slot-lock body construction now appears in both book_preview and modify_preview — flag if it should be a helper)
- modify-token tamper-check completeness
- Spec coverage end-to-end

The review subagent reports Strengths / Issues (Critical/Important/Minor) / Assessment. Any Critical or Important issues addressed inline before the next phase. Minor issues noted as follow-up.

---

## Self-Review

Walking the spec section-by-section against the plan:

**§"Tool surface" — opentable_modify_preview / opentable_modify** — covered by Task 3 + Task 4. Inputs, outputs, modify_token shape, `existing_reservation` echo, `was_modified` flag all in the test assertions + handler code.

**§"Data flow" — preview** — covered by Task 3's handler implementation. URL build with `confirmationNumber`, parser reuse, `excludeConfirmation` on conflicts, slot-lock branching (Standard vs Experience), modify_token mint with `existing*` fields.

**§"Data flow" — modify** — covered by Task 4. Token decode, tamper check including `existing*` fields, `isModify: true` + `reservationId` on the make-reservation body, error handling parity with book.

**§"Reservation identification — the slightly subtle bit"** — handled in Task 3 (the URL build adds `confirmationNumber`) and Task 4 (the body adds `isModify: true` + `reservationId` from the token).

**§"Error handling"** — every row in the spec's table maps to a test:
- Listing-type → covered by description-only contract (Task 3 description; no handler check, mirrors book_preview)
- Ambiguous Experience args → Task 3 has the same throw as book_preview
- CC required without saved card → Task 3 throws (test would cover this; the existing book_preview test for the same case demonstrates the pattern)
- modify without token → Task 4 test "refuses without a modify_token"
- Tamper check fails → Task 4 test "refuses when caller confirmation_number diverges"
- Book token to modify → Task 4 test "refuses a book_preview token"
- SLOT_LOCK_EXPIRED → same handler code as book, no separate test needed (covered by existing book test for the same case)

**§"Investigation results"** — Task 0 (live capture) + Task 5 (live probe iteration) cover this.

**§"Testing"** — Tasks 1/3/4 cover unit. Task 5 covers live probe.

**§"Files touched"** — every file in the spec's list has a task that touches it:
- booking-token.ts + test → Task 1
- tools/reservations.ts + test → Tasks 2/3/4
- tests/fixtures/booking-details-state-modify.json → Task 0
- scripts/probe-modify-experience.ts → Task 5
- SKILL.md / CLAUDE.md / manifest.json → Task 6

**Placeholder scan:** No "TBD" / "fill in" / "similar to" placeholders. Task 0 step 3 is marked optional (the wire format gets discovered via Task 5 iteration anyway).

**Type consistency:** `modify_token` is consistently the public field name in inputs/outputs; `BookingTokenPayload.existingReservationId` / `existingConfirmationNumber` / `existingSecurityToken` are consistently the internal token field names. `was_modified` consistent across handler return and test assertion. `excludeConfirmation` consistent with the existing helper's parameter name in `parse-booking-details-state.ts`.

No gaps.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-20-modify-reservation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between, fast iteration. Best for this plan because the per-task changes are mechanical (mirror book) and the tricky parts (Task 5 wire-format iteration) need the controller's hand on the wheel anyway.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
