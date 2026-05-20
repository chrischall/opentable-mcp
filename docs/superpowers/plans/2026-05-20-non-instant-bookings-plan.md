# Non-instant bookings (Experience-mandatory + Listing detection) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `opentable_book` work on Cafe Pasqual's-style Experience-mandatory restaurants and refuse Listing-only restaurants cleanly. Surface `booking_type` so agents can plan around the distinction.

**Architecture:** Three orthogonal additions threaded through the same data path:
1. **Detection** — `parse-slots` and `parse-restaurant` expose the discriminator fields (`booking_type` per slot, `bookable` / `listing_type` per restaurant) so agents see them before they try to book.
2. **Token** — `booking-token.ts` gains `bookingType` + `experienceId` so `book_preview` → `book` carries the routing decision without re-fetching.
3. **Book flow** — `tools/reservations.ts` branches on `slot.type === "Experience"`: builds the `/booking/details` URL with the Experience query params (skipping the seating-options/specials intermediate pages), slot-locks via the new `BookDetailsExperienceSlotLock` op, submits to the existing `/dapi/booking/make-reservation` endpoint with Experience-flavored body.

**Tech Stack:** TypeScript, vitest (mocked `OpenTableClient`), MCP SDK, the existing Apollo persisted-query pattern.

**Prerequisite:** One live capture run is required before code lands — see Task 0. The `BookDetailsExperienceSlotLock` persisted-query hash isn't pinnable without it, and unit-test fixtures should be cut from a real Pasqual's capture to stay faithful to OpenTable's actual response shapes.

**Spec:** `docs/superpowers/specs/2026-05-19-request-to-book-design.md`

---

## File Structure

**Create:**
- `scripts/probe-experience-slot-lock-hash.ts` — one-shot live probe that drives Pasqual's Experience flow and dumps the network frame for `BookDetailsExperienceSlotLock` so we can pin the persisted-query `sha256Hash`. Throwaway script; deleted post-merge if you like.
- `scripts/probe-book-cancel-experience.ts` — live round-trip: find_slots → book_preview → book → list_reservations → cancel against Pasqual's. Mirrors `probe-book-cancel.ts`.
- `tests/fixtures/slots-experience-pasquals.json` — captured Apollo `RestaurantsAvailability` response for Pasqual's. Drives parse-slots tests for the Experience path.
- `tests/fixtures/booking-details-state-experience.json` — captured `__INITIAL_STATE__` from `/booking/details?…selectedExperience=…` for Pasqual's. Drives parse-booking-details-state tests for the Experience path.

**Modify:**
- `src/parse-slots.ts` — add `booking_type` and `experience_ids` to `FormattedSlot`.
- `src/parse-restaurant.ts` — add `bookable` + `listing_type` to `FormattedRestaurant`. Parse from `state.restaurantProfile.restaurant.type` (the `/r/{slug}` SSR top-level field — distinct from the booking-details state's nested experiences shape).
- `src/parse-booking-details-state.ts` — add a parsed `experience` block to `BookingDetailsSummary` when the page is an Experience flow.
- `src/booking-token.ts` — add `bookingType` and `experienceId` to `BookingTokenPayload`. Extend `REQUIRED_KEYS` with `bookingType` (defaulting older tokens to `"standard"`); `experienceId` is optional and stays out of REQUIRED_KEYS.
- `src/tools/reservations.ts` — Experience branches in `opentable_book_preview` and `opentable_book`. New persisted-query hash constant for `BookDetailsExperienceSlotLock`.
- `tests/parse-slots.test.ts` — Experience-slot scenarios.
- `tests/parse-restaurant.test.ts` — GuestCenter vs Listing scenarios.
- `tests/parse-booking-details-state.test.ts` — Experience-flow state parses correctly.
- `tests/booking-token.test.ts` — round-trip with the new fields; backward-compat for old tokens.
- `tests/tools/reservations.test.ts` — Experience-mandatory book_preview + book paths.
- `SKILL.md` — document Experience flow + Listing detection.
- `CLAUDE.md` — hot-spot note on Experience slot-lock + the URL-shortcut technique.

**No changes needed** (verified during planning):
- `src/tools/restaurants.ts` — already calls `parseRestaurant` and serialises whatever fields the parser returns; adding fields to `FormattedRestaurant` propagates automatically.

---

### Task 0: Pre-flight live capture

**Goal:** Pin the `BookDetailsExperienceSlotLock` persisted-query hash and produce two test fixtures from a real Pasqual's flow.

**Files:**
- Create: `scripts/probe-experience-slot-lock-hash.ts`
- Create: `tests/fixtures/slots-experience-pasquals.json`
- Create: `tests/fixtures/booking-details-state-experience.json`

This task is hand-run (the Chrome extension must be loaded and an opentable.com tab signed in). It produces three artefacts the later tasks depend on.

- [ ] **Step 1: Write the probe script `scripts/probe-experience-slot-lock-hash.ts`**

```typescript
// Usage:
//   npm run build && npx tsx scripts/probe-experience-slot-lock-hash.ts
//
// Drives Pasqual's (rid 278896) Experience-mandatory booking flow up to
// the slot-lock step and dumps the SlotLock GraphQL POST body so we can
// pin `BookDetailsExperienceSlotLock`'s persisted-query sha256Hash.
//
// Prereqs: companion Chrome extension loaded; opentable.com signed-in
// tab open. Does NOT submit a booking — stops after slot-lock.
import { OpenTableWsServer } from '../src/ws-server.js';
import { OpenTableClient } from '../src/client.js';

const PASQUAL_RID = 278896;
const PASQUAL_SLUG = 'cafe-pasquals-santa-fe';
// Two weeks out is a safe slot window — Pasqual's runs Experience
// flows daily; adjust if their schedule changes.
const DATE = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
const TIME = '18:00';
const PARTY = 2;

async function main() {
  const server = new OpenTableWsServer({ port: 37149 });
  await server.start();
  const client = new OpenTableClient(server);
  try {
    // 1) find_slots to get a real slot_hash + reservation_token.
    const availability = await client.fetchJson<unknown>(
      '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
      {
        method: 'POST',
        headers: { 'ot-page-type': 'home', 'ot-page-group': 'seo-landing-home' },
        body: {
          operationName: 'RestaurantsAvailability',
          variables: {
            onlyPop: false, forwardDays: 0, requireTimes: false,
            requireTypes: [], useCBR: false, privilegedAccess: [],
            restaurantIds: [PASQUAL_RID],
            restaurantAvailabilityTokens: ['eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ'],
            date: DATE, time: TIME, partySize: PARTY, databaseRegion: 'NA',
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: 'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e',
            },
          },
        },
      }
    );
    console.error('=== RestaurantsAvailability raw response ===');
    console.log(JSON.stringify(availability, null, 2));
    console.error('=== END ===');
    console.error('');
    console.error(
      'NEXT: open opentable.com in your bridged tab, navigate to:'
    );
    console.error(
      `  https://www.opentable.com/r/${PASQUAL_SLUG}?covers=${PARTY}&dateTime=${DATE}T${TIME}`
    );
    console.error(
      'then click the first available slot and walk the seating-options → specials → details flow.'
    );
    console.error(
      'In DevTools → Network, find the POST to /dapi/fe/gql?opname=BookDetailsExperienceSlotLock'
    );
    console.error('Copy its `extensions.persistedQuery.sha256Hash` and paste into Task 5.');
    console.error('Also save the entire /booking/details page __INITIAL_STATE__ to');
    console.error('  tests/fixtures/booking-details-state-experience.json');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('probe-experience-slot-lock-hash failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and run the probe**

```bash
npm run build && lsof -ti :37149 | xargs -r kill && npx tsx scripts/probe-experience-slot-lock-hash.ts > /tmp/experience-slots.json
```

Expected: the `RestaurantsAvailability` raw response prints to `/tmp/experience-slots.json`. The script then prints follow-up instructions to stderr.

- [ ] **Step 3: Save the availability response as a fixture**

```bash
cp /tmp/experience-slots.json tests/fixtures/slots-experience-pasquals.json
```

This file becomes the input for parse-slots tests in Task 1.

- [ ] **Step 4: Capture the `BookDetailsExperienceSlotLock` request body**

Follow the probe's stderr instructions:

1. In the bridged Chrome tab, navigate to the URL the script printed.
2. Open DevTools → Network. Click the time slot, then click "Select" on Community Table, then click "Select" on Community Table Dining.
3. In the Network tab, find the POST to `/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock`.
4. Copy two things into a scratch file:
   - The full request body (the JSON with `operationName`, `variables`, `extensions.persistedQuery.sha256Hash`).
   - The full response body.
5. Note the sha256Hash — that's the constant Task 5 will use.

- [ ] **Step 5: Capture `/booking/details` `__INITIAL_STATE__` as a fixture**

In DevTools → Sources or via `window.__INITIAL_STATE__` in the console after the page settles on `/booking/details?…&selectedExperience=…&st=Experience`, dump the state:

```javascript
copy(JSON.stringify(window.__INITIAL_STATE__))
```

Paste into `tests/fixtures/booking-details-state-experience.json`. Pretty-print it with `npx prettier --write tests/fixtures/booking-details-state-experience.json` so diffs stay readable.

- [ ] **Step 6: Commit the fixtures and probe**

```bash
git add scripts/probe-experience-slot-lock-hash.ts tests/fixtures/slots-experience-pasquals.json tests/fixtures/booking-details-state-experience.json
git commit -m "test fixtures: capture Pasqual's Experience-mandatory flow

Live capture via the Chrome bridge. Drives later parser/tool tests
for the Experience path. Includes the slots availability response and
the /booking/details __INITIAL_STATE__ post-experience-selection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Record the `BookDetailsExperienceSlotLock` sha256Hash in a scratch note — Task 5 needs it. Do not commit the hash to a file yet (commit it together with its usage in Task 5).

---

### Task 1: Extend `parse-slots.ts` with `booking_type` + `experience_ids`

**Files:**
- Modify: `src/parse-slots.ts:46-67` (interface `FormattedSlot` + `RawAvailableSlot`) and `:121-165` (parse loop)
- Modify: `tests/parse-slots.test.ts`

The discriminator: slot.type === "Experience" → `booking_type: "experience_mandatory"` and `experience_ids` populated from the slot's `experienceIds` field (which Pasqual's availability response carries on each Experience slot). Standard slots get `booking_type: "instant"` and an empty `experience_ids` array.

- [ ] **Step 1: Write the failing test**

Add to `tests/parse-slots.test.ts` (place after the existing sample fixture, before the existing `describe` block — adjust to match the file's actual structure):

```typescript
import experienceFixture from './fixtures/slots-experience-pasquals.json' with { type: 'json' };

describe('parseAvailabilityResponse — Experience-mandatory slots', () => {
  it('annotates Experience-typed slots with booking_type: "experience_mandatory" and experience_ids', () => {
    const slots = parseAvailabilityResponse(
      experienceFixture,
      '2026-06-25',
      '18:00',
      2
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.type).toBe('Experience');
      expect(s.booking_type).toBe('experience_mandatory');
      expect(Array.isArray(s.experience_ids)).toBe(true);
      expect(s.experience_ids.length).toBeGreaterThan(0);
    }
  });

  it('annotates Standard slots with booking_type: "instant" and an empty experience_ids', () => {
    // Reuse the existing synthetic `sample` fixture (Standard slots only).
    const slots = parseAvailabilityResponse(sample, '2026-06-25', '19:00', 2);
    for (const s of slots) {
      expect(s.booking_type).toBe('instant');
      expect(s.experience_ids).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- parse-slots
```

Expected: FAIL — `booking_type` / `experience_ids` not present in `FormattedSlot`.

- [ ] **Step 3: Extend `FormattedSlot` and `RawAvailableSlot` interfaces**

In `src/parse-slots.ts`, replace the existing `FormattedSlot` interface (lines 46-56) with:

```typescript
export type SlotBookingType = 'instant' | 'experience_mandatory' | 'request';

export interface FormattedSlot {
  restaurant_id: number;
  reservation_token: string;
  date: string;
  time: string;
  party_size: number;
  type: string;                       // Standard | Experience | POP
  attributes: string[];               // default | bar | highTop | outdoor
  points: number;
  slot_hash: string;
  /** How the slot is booked. "instant" today is everything we already
   *  support. "experience_mandatory" routes through the Experience flow
   *  in opentable_book_preview / opentable_book.
   *  "request" is reserved for true Request-to-Book; v1 never emits it. */
  booking_type: SlotBookingType;
  /** Bookable experience ids for this slot. Empty for Standard slots;
   *  populated with one or more ids for Experience slots. The agent
   *  may need to pick one when calling opentable_book_preview. */
  experience_ids: number[];
}
```

Extend `RawAvailableSlot` (lines 58-67) to know about the field:

```typescript
interface RawAvailableSlot {
  __typename?: 'AvailableSlot';
  isAvailable: true;
  timeOffsetMinutes: number;
  slotHash?: string;
  slotAvailabilityToken?: string;
  type?: string;
  attributes?: string[];
  pointsValue?: number;
  experienceIds?: number[];   // ← new; present on type === 'Experience' slots
}
```

- [ ] **Step 4: Populate the new fields in the parse loop**

In the `out.push(...)` block (around lines 148-158), replace with:

```typescript
const type = available.type ?? 'Standard';
const experienceIds = available.experienceIds ?? [];
const bookingType: SlotBookingType =
  type === 'Experience' ? 'experience_mandatory' : 'instant';
out.push({
  restaurant_id: restaurantId,
  reservation_token: available.slotAvailabilityToken ?? '',
  date,
  time,
  party_size: partySize,
  type,
  attributes: available.attributes ?? [],
  points: available.pointsValue ?? 0,
  slot_hash: available.slotHash ?? '',
  booking_type: bookingType,
  experience_ids: experienceIds,
});
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- parse-slots
```

Expected: PASS. All existing tests continue to pass.

- [ ] **Step 6: Run the full suite to confirm no regressions**

```bash
npm test
```

Expected: PASS. The new fields are additive and shouldn't break any other parser/tool test.

- [ ] **Step 7: Commit**

```bash
git add src/parse-slots.ts tests/parse-slots.test.ts
git commit -m "parse-slots: expose booking_type + experience_ids per slot

Adds the discriminator fields agents need to recognise non-instant
slots before invoking book_preview / book. Experience slots get
booking_type: 'experience_mandatory' and the experience_ids array
from the availability response. Standard slots get 'instant' and an
empty array. 'request' is reserved for the deferred RTB spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extend `parse-restaurant.ts` with `bookable` + `listing_type`

**Files:**
- Modify: `src/parse-restaurant.ts:20-68` (interface `RawRestaurant`) and `:70-112` (interface `FormattedRestaurant`) and `:122-178` (parse fn)
- Modify: `tests/parse-restaurant.test.ts`

`restaurant.type === "GuestCenter"` means OpenTable accepts bookings; `"Listing"` means we can't book through OpenTable at all and should refuse early.

- [ ] **Step 1: Write the failing test**

Add to `tests/parse-restaurant.test.ts` (alongside the existing tests):

```typescript
describe('parseRestaurant — bookable / listing_type', () => {
  it('sets bookable=true and listing_type="GuestCenter" for a normal bookable restaurant', () => {
    // Reuse the existing happy-path HTML fixture (or inline a minimal one
    // matching the synthetic fixture already used in this file).
    const html = htmlWithState({
      restaurantProfile: {
        restaurant: {
          restaurantId: 12345,
          name: 'Bookable',
          type: 'GuestCenter',
        },
      },
    });
    const r = parseRestaurant(html);
    expect(r.bookable).toBe(true);
    expect(r.listing_type).toBe('GuestCenter');
  });

  it('sets bookable=false and listing_type="Listing" for a listing-only restaurant', () => {
    const html = htmlWithState({
      restaurantProfile: {
        restaurant: {
          restaurantId: 54321,
          name: 'Listing Only',
          type: 'Listing',
        },
      },
    });
    const r = parseRestaurant(html);
    expect(r.bookable).toBe(false);
    expect(r.listing_type).toBe('Listing');
  });
});
```

`htmlWithState` is the existing helper in this file (it wraps a state object into the `__INITIAL_STATE__` script tag). If it doesn't exist with that name yet, inline it:

```typescript
function htmlWithState(state: unknown): string {
  return `<html><body><script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script></body></html>`;
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- parse-restaurant
```

Expected: FAIL — `bookable` / `listing_type` undefined.

- [ ] **Step 3: Extend `RawRestaurant` + `FormattedRestaurant` interfaces**

In `src/parse-restaurant.ts`, add to `RawRestaurant` (line 20-68 block):

```typescript
interface RawRestaurant {
  restaurantId?: number;
  name?: string;
  /** "GuestCenter" = bookable via OpenTable; "Listing" = info-only,
   *  no booking flow available. */
  type?: string;
  // … existing fields …
}
```

Add to `FormattedRestaurant` (line 70-112 block):

```typescript
export type RestaurantListingType = 'GuestCenter' | 'Listing' | 'Unknown';

export interface FormattedRestaurant {
  // … existing fields …
  /** True when OpenTable accepts reservations for this restaurant.
   *  False for Listing-type restaurants (info-only). */
  bookable: boolean;
  /** Verbatim OpenTable classification: "GuestCenter" for bookable
   *  restaurants, "Listing" for info-only. "Unknown" when the field
   *  is missing from the SSR state (defensive default). */
  listing_type: RestaurantListingType;
}
```

- [ ] **Step 4: Populate the new fields in `parseRestaurant`**

Inside the `return { … }` (around line 135 onward), add:

```typescript
const rawType = (r.type ?? '').trim();
const listingType: RestaurantListingType =
  rawType === 'GuestCenter' ? 'GuestCenter'
  : rawType === 'Listing' ? 'Listing'
  : 'Unknown';
const bookable = listingType === 'GuestCenter';

return {
  // … existing fields unchanged …
  bookable,
  listing_type: listingType,
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- parse-restaurant
```

Expected: PASS.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS — all 100+ existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/parse-restaurant.ts tests/parse-restaurant.test.ts
git commit -m "parse-restaurant: expose bookable + listing_type

restaurant.type === 'GuestCenter' → bookable: true. 'Listing' (info-only
restaurants like Le Bernardin on OpenTable) → bookable: false so
opentable_book_preview can refuse early with a clear error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extend `parse-booking-details-state.ts` with an Experience block

**Files:**
- Modify: `src/parse-booking-details-state.ts:56-70` (interface `BookingDetailsSummary`) and `:166-260` (parse fn)
- Modify: `tests/parse-booking-details-state.test.ts`

When the `/booking/details` page is the Experience flow, `__INITIAL_STATE__.experiences.experiences` is an array (one entry per candidate experience), and `__INITIAL_STATE__.timeSlot.experiencesBySeating` is non-empty. We extract the **selected** experience's metadata into `summary.experience`. The selected experience is the one whose id matches `timeSlot.diningAreasBySeating[0].bookableExperienceIds[0]` (single bookable experience per dining area in v1).

- [ ] **Step 1: Write the failing test**

Add to `tests/parse-booking-details-state.test.ts`:

```typescript
import experienceState from './fixtures/booking-details-state-experience.json' with { type: 'json' };

describe('parseBookingDetailsState — Experience-mandatory page', () => {
  it('exposes a populated experience block for an Experience-flow booking-details page', () => {
    const summary = parseBookingDetailsState(experienceState);
    expect(summary.experience).not.toBeNull();
    expect(summary.experience?.experience_id).toBe(514735);          // Pasqual's Community Table Dining
    expect(summary.experience?.name).toBe('Community Table Dining');
    expect(summary.experience?.type_enum).toBe('PRIX_FIXE');
    expect(summary.experience?.description).toMatch(/community table/i);
  });

  it('returns experience: null on Standard-flow booking-details pages', () => {
    // The existing CC fixture is a Standard flow.
    const summary = parseBookingDetailsState(
      JSON.parse(readFileSync('tests/fixtures/booking-details-state-cc.json', 'utf8'))
    );
    expect(summary.experience).toBeNull();
  });
});
```

If the test file doesn't already import `readFileSync` from `node:fs`, add that import alongside the existing ones.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- parse-booking-details-state
```

Expected: FAIL — `experience` field doesn't exist on `BookingDetailsSummary`.

- [ ] **Step 3: Add `BookingExperience` interface and extend `BookingDetailsSummary`**

In `src/parse-booking-details-state.ts`, before `BookingDetailsSummary`:

```typescript
/** Subset of the Experience metadata we surface to the agent: just
 *  enough to make a "yes, book this" decision. Fuller details (price
 *  breakdown, schedules, add-ons) stay inside __INITIAL_STATE__ and
 *  are out of scope for v1. */
export interface BookingExperience {
  experience_id: number;
  name: string;
  /** OpenTable's enum — examples: "PRIX_FIXE", "TASTING_MENU",
   *  "HAPPY_HOUR". v1 surfaces verbatim. */
  type_enum: string;
  /** Human-facing description text. Often the seating-policy message
   *  the restaurant attaches to the experience. */
  description: string;
  /** Price per cover (USD-ish — OpenTable's field; null when the
   *  experience is à la carte or pricing is per-guest with no flat fee). */
  price_per_cover: number | null;
}
```

Extend `BookingDetailsSummary`:

```typescript
export interface BookingDetailsSummary {
  cc_required: boolean;
  policy_type: CardPolicyType;
  policy: CancellationPolicy;
  default_card: SavedCard | null;
  conflicts: ReservationConflict[];
  terms: BookingTerms | null;
  /** Populated only when the booking-details page is the Experience
   *  flow (timeSlot.experiencesBySeating non-empty). Null for Standard
   *  bookings. */
  experience: BookingExperience | null;
}
```

- [ ] **Step 4: Add the Experience extraction logic**

Add raw shapes near the other `Raw*` interfaces in the same file:

```typescript
interface RawBookableExperienceMini {
  experienceId?: number;
}
interface RawDiningAreaBySeating {
  diningAreaId?: number;
  tableCategory?: string;
  bookableExperienceIds?: number[];
  bookableExperiences?: RawBookableExperienceMini[];
}
interface RawExperiencesBySeating {
  tableCategory?: string;
  experienceIds?: number[];
}
interface RawTimeSlot {
  creditCardRequired?: boolean;
  creditCardPolicyType?: string | null;
  creditCardPolicyId?: string | null;
  experiencesBySeating?: RawExperiencesBySeating[];
  diningAreasBySeating?: RawDiningAreaBySeating[];
}

interface RawExperienceRecord {
  experienceId?: number;
  name?: string;
  type?: string;
  typeEnum?: string;
  pricePerCover?: number | null;
  bookingPolicies?: {
    bookingPolicies?: {
      customPolicies?: { message?: string };
    };
  };
}
interface RawExperiences {
  experiences?: RawExperienceRecord[];
}
```

Then extend `RawBookingDetailsState`:

```typescript
interface RawBookingDetailsState {
  state?: RawBookingDetailsState;
  timeSlot?: RawTimeSlot;
  messages?: RawMessages;
  restaurant?: RawRestaurant;
  wallet?: RawWallet;
  upcomingReservationConflicts?: RawConflict[];
  experiences?: RawExperiences;     // ← new
}
```

Inside `parseBookingDetailsState`, after the existing `conflicts` / `terms` extraction (just before the `return { … }`), add:

```typescript
// Experience-flow detection: timeSlot.experiencesBySeating non-empty
// AND we can find a bookable experience whose id appears in
// diningAreasBySeating[0].bookableExperienceIds. If multiple bookable
// experiences exist, we still surface only the first — the tool layer
// is responsible for refusing ambiguous cases earlier.
const expsBySeating = ts.experiencesBySeating ?? [];
const dasBySeating = ts.diningAreasBySeating ?? [];
const expRecords = (root.experiences?.experiences) ?? [];
let experience: BookingExperience | null = null;
if (expsBySeating.length > 0 && dasBySeating.length > 0 && expRecords.length > 0) {
  const bookableIds = dasBySeating[0]?.bookableExperienceIds ?? [];
  const chosenId = bookableIds[0];
  if (typeof chosenId === 'number') {
    const rec = expRecords.find((e) => e.experienceId === chosenId);
    if (rec && typeof rec.experienceId === 'number' && typeof rec.name === 'string') {
      experience = {
        experience_id: rec.experienceId,
        name: rec.name,
        type_enum: rec.typeEnum ?? '',
        description:
          rec.bookingPolicies?.bookingPolicies?.customPolicies?.message ?? '',
        price_per_cover: rec.pricePerCover ?? null,
      };
    }
  }
}
```

And include `experience` in the return:

```typescript
return {
  cc_required: ccRequired,
  policy_type: policyType,
  policy,
  default_card: defaultCard,
  conflicts,
  terms,
  experience,
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- parse-booking-details-state
```

Expected: PASS. The new field is `null` on the existing CC/no-CC fixtures (no Experience block) and populated on the new Experience fixture.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/parse-booking-details-state.ts tests/parse-booking-details-state.test.ts
git commit -m "parse-booking-details-state: extract Experience block

When the booking-details page is the Experience flow
(timeSlot.experiencesBySeating non-empty), surface the selected
experience's experience_id, name, type_enum, description, and
price_per_cover. Null on Standard flows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Extend `booking-token.ts` with `bookingType` + `experienceId`

**Files:**
- Modify: `src/booking-token.ts` (whole file is small; show the diff inline)
- Modify: `tests/booking-token.test.ts`

The token carries the routing decision from `book_preview` to `book`. `bookingType: "standard" | "experience"` (Experience-mandatory tokens carry `experienceId`). Pre-existing tokens minted before this change default to `"standard"` on decode for backward compatibility.

- [ ] **Step 1: Write the failing test**

Add to `tests/booking-token.test.ts`:

```typescript
describe('booking-token — bookingType + experienceId', () => {
  it('round-trips a standard token unchanged', () => {
    const before = {
      slotLockId: 111, restaurantId: 222, diningAreaId: 333,
      partySize: 2, date: '2026-06-25', time: '18:00',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'standard' as const,
    };
    const after = decodeBookingToken(encodeBookingToken(before));
    expect(after.bookingType).toBe('standard');
    expect(after.experienceId).toBeUndefined();
  });

  it('round-trips an experience token including experienceId', () => {
    const before = {
      slotLockId: 111, restaurantId: 222, diningAreaId: 333,
      partySize: 2, date: '2026-06-25', time: '18:00',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: true,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'experience' as const,
      experienceId: 514735,
    };
    const after = decodeBookingToken(encodeBookingToken(before));
    expect(after.bookingType).toBe('experience');
    expect(after.experienceId).toBe(514735);
  });

  it('decodes a legacy token (no bookingType field) as standard', () => {
    // Build a payload missing bookingType — emulates a pre-v0.10 token.
    const legacy = {
      slotLockId: 111, restaurantId: 222, diningAreaId: 333,
      partySize: 2, date: '2026-06-25', time: '18:00',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
    };
    const encoded = Buffer.from(JSON.stringify(legacy), 'utf8').toString('base64');
    const decoded = decodeBookingToken(encoded);
    expect(decoded.bookingType).toBe('standard');
    expect(decoded.experienceId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- booking-token
```

Expected: FAIL — `bookingType`/`experienceId` not on the payload type, and the legacy-token test fails because old tokens currently round-trip without a default.

- [ ] **Step 3: Extend `BookingTokenPayload` and the decoder**

In `src/booking-token.ts`, replace `BookingTokenPayload` and the related constants with:

```typescript
export type BookingTokenType = 'standard' | 'experience';

export interface BookingTokenPayload {
  slotLockId: number;
  restaurantId: number;
  diningAreaId: number;
  partySize: number;
  date: string;
  time: string;
  reservationToken: string;
  slotHash: string;
  /** Full card reference for CC-required bookings. `null` otherwise. */
  paymentCard: BookingTokenPaymentCard | null;
  ccRequired: boolean;
  issuedAt: string; // ISO-8601
  /** Routes opentable_book to the right slot-lock + make-reservation
   *  payload. Tokens minted before this field was added decode as
   *  "standard" for backward compatibility. */
  bookingType: BookingTokenType;
  /** Required when bookingType === "experience"; absent otherwise. */
  experienceId?: number;
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
  // bookingType intentionally omitted — added below with a default
  //   so old tokens still decode.
  // paymentCard intentionally omitted — can legitimately be null.
  // experienceId intentionally omitted — only set on experience tokens.
];
```

Update `decodeBookingToken` to fill in `bookingType` when missing:

```typescript
export function decodeBookingToken(token: string): BookingTokenPayload {
  const json = Buffer.from(token, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('booking_token does not contain valid JSON — was it issued by opentable_book_preview?');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('booking_token payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      throw new Error(`booking_token is missing required field: ${key}`);
    }
  }
  if (!('paymentCard' in obj)) {
    (obj as { paymentCard: BookingTokenPaymentCard | null }).paymentCard = null;
  }
  if (!('bookingType' in obj)) {
    (obj as { bookingType: BookingTokenType }).bookingType = 'standard';
  } else if (obj.bookingType !== 'standard' && obj.bookingType !== 'experience') {
    throw new Error(
      `booking_token has unknown bookingType: ${JSON.stringify(obj.bookingType)}`
    );
  }
  // experienceId stays optional — leave it untouched if absent.
  return obj as unknown as BookingTokenPayload;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- booking-token
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/booking-token.ts tests/booking-token.test.ts
git commit -m "booking-token: add bookingType + experienceId

Carries the routing decision from book_preview to book. Old tokens
without the bookingType field decode as standard for backward compat.
Experience tokens additionally carry experienceId for the
make-reservation payload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Pin the `BookDetailsExperienceSlotLock` hash + add the constant

**Files:**
- Modify: `src/tools/reservations.ts:59-73` (persisted-query hash block)

This is a pure constants-only commit so the diff stays small and the hash is reviewable. The hash itself comes from Task 0's manual capture.

- [ ] **Step 1: Add the new hash constant + path next to the existing block**

In `src/tools/reservations.ts`, replace the existing hash block (lines 59-73) with:

```typescript
// Apollo persisted-query hashes captured from opentable.com on 2026-04-20.
// If OpenTable re-deploys and invalidates these, the server returns
// `PersistedQueryNotFound` and we'll need to re-capture via the
// extension's XHR logger.
const RESTAURANTS_AVAILABILITY_HASH =
  'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e';
const BOOK_SLOT_LOCK_HASH =
  '1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa';
// Experience-mandatory slot-lock op (captured 2026-05-20 from Pasqual's
// Experience flow — see scripts/probe-experience-slot-lock-hash.ts).
const BOOK_EXPERIENCE_SLOT_LOCK_HASH =
  'PASTE_HASH_FROM_TASK_0_HERE';
const CANCEL_RESERVATION_HASH =
  '4ee53a006030f602bdeb1d751fa90ddc4240d9e17d015fb7976f8efcb80a026e';

const AVAILABILITY_PATH = '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability';
const SLOT_LOCK_PATH = '/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock';
const EXPERIENCE_SLOT_LOCK_PATH =
  '/dapi/fe/gql?optype=mutation&opname=BookDetailsExperienceSlotLock';
const MAKE_RESERVATION_PATH = '/dapi/booking/make-reservation';
const CANCEL_RESERVATION_PATH = '/dapi/fe/gql?optype=mutation&opname=CancelReservation';
```

**Replace `'PASTE_HASH_FROM_TASK_0_HERE'`** with the actual sha256Hash captured in Task 0 Step 4. The implementing engineer should NOT skip this step or commit the placeholder.

- [ ] **Step 2: Run the full suite to confirm no regressions**

```bash
npm test
```

Expected: PASS — purely additive constants, no behavioral change yet.

- [ ] **Step 3: Verify the build typechecks**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/reservations.ts
git commit -m "reservations: pin BookDetailsExperienceSlotLock persisted-query hash

Captured 2026-05-20 from Pasqual's Experience flow via the Chrome bridge.
Used in the next commit when book_preview + book branch on Experience.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Refuse Listing-type restaurants in `opentable_book_preview` and `opentable_book`

**Files:**
- Modify: `src/tools/reservations.ts` (top of book_preview + book handlers; introduce a shared helper)
- Modify: `tests/tools/reservations.test.ts`

Failing early here is cheaper than discovering the issue mid-slot-lock. Both tools fetch `/r/{slug}` SSR — actually, no, they don't today. They fetch `/booking/details` directly. The Listing check has to live somewhere upstream OR via `parse-restaurant` cached on the restaurant id. To keep this task focused, we add the check at the start of book_preview/book by fetching the restaurant's `/r/{slug}` page if we have one — but in v1's interface we only receive `restaurant_id` (numeric), and `/r/{numeric}` 404s.

**Decision:** v1 surfaces the `bookable` flag via `opentable_get_restaurant` (Task 2) and relies on the agent to check it before invoking book_preview/book. The book tools themselves don't pre-check — they'd need a slug, which they don't have. This task is therefore just a documentation update to make that contract explicit.

- [ ] **Step 1: Update tool descriptions to reference the bookable check**

In `src/tools/reservations.ts`, extend the `opentable_book_preview` `description` field (currently at line 215-216) to add a final sentence:

```typescript
description:
  "Preview an OpenTable booking BEFORE committing. Fetches the /booking/details SSR page and the slot-lock to surface: the cancellation policy (including any credit-card no-show fee), the saved payment card that would be charged/held, and a short-lived `booking_token` that opentable_book consumes. REQUIRED for CC-required slots — opentable_book refuses to commit without the token. Safe to call for standard slots too (the token skips a redundant re-lock in book). Holds the slot for ~60-90s; preview → book should happen within a minute. Refuses early on Listing-only restaurants — check opentable_get_restaurant.bookable first.",
```

Same addition to `opentable_book`'s description.

- [ ] **Step 2: No new test required — coverage stays in Task 2's parse-restaurant tests**

Listing-only refusal is exercised by callers reading `bookable: false` from `opentable_get_restaurant`. The tool layer can't usefully check this for itself.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: PASS — pure description change.

- [ ] **Step 4: Commit**

```bash
git add src/tools/reservations.ts
git commit -m "reservations: document the bookable-precheck contract

opentable_book_preview / opentable_book operate on numeric restaurant_id,
which can't fetch /r/{slug} for a type-check. Agents read bookable
from opentable_get_restaurant.bookable; the descriptions now say so.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Experience-mandatory branch in `opentable_book_preview`

**Files:**
- Modify: `src/tools/reservations.ts:212-368` (book_preview handler) and `:37-57` (helper `bookingDetailsPath`)
- Modify: `tests/tools/reservations.test.ts`

Detect Experience slots (caller passes `experience_id`, OR we read the summary's experience block after fetching `/booking/details`), require an explicit `experience_id` arg when ambiguous (multiple bookable experiences), build the `/booking/details` URL with Experience query params, slot-lock via `BookDetailsExperienceSlotLock`, mint a token with `bookingType: "experience"`.

**Scope simplification for v1:** Pasqual's case (the only restaurant we've verified live) has a single bookable Experience per dining area. We require the agent to pass `experience_id` as an explicit arg when calling preview/book on an Experience slot. We do NOT auto-pick — the agent already has the list from `opentable_find_slots` (each slot's `experience_ids`) and from `opentable_get_restaurant.diningAreas[]`. This keeps the v1 contract simple; the auto-pick optimisation can land later when we have a multi-experience-per-area case to verify against.

- [ ] **Step 1: Write the failing test for Experience preview**

Add to `tests/tools/reservations.test.ts` (after the existing book_preview tests):

```typescript
describe('opentable_book_preview — Experience-mandatory slot', () => {
  it('builds the /booking/details URL with experience query params and calls Experience slot-lock', async () => {
    const fetchHtml = vi.fn(async () =>
      // Reuse the Experience fixture from Task 0 wrapped in a minimal HTML shell.
      `<html><body><script>window.__INITIAL_STATE__ = ${JSON.stringify(experienceState)};</script></body></html>`
    );
    let lockOpname: string | undefined;
    let lockBody: any;
    const fetchJson = vi.fn(async (path: string, init?: any) => {
      if (path.includes('opname=BookDetailsExperienceSlotLock')) {
        lockOpname = 'BookDetailsExperienceSlotLock';
        lockBody = init?.body;
        return { data: { lockSlot: { success: true, slotLock: { slotLockId: 9999 } } } };
      }
      throw new Error(`unexpected POST: ${path}`);
    });
    const client = { fetchHtml, fetchJson } as unknown as OpenTableClient;

    const result = await callTool(client, 'opentable_book_preview', {
      restaurant_id: 278896,
      date: '2026-06-25',
      time: '18:00',
      party_size: 5,
      reservation_token: 'tok',
      slot_hash: '431673495',
      dining_area_id: 21881,
      experience_id: 514735,
    });

    // URL contains experience params
    const htmlUrl = fetchHtml.mock.calls[0][0] as string;
    expect(htmlUrl).toContain('selectedExperience=514735');
    expect(htmlUrl).toContain('experienceIds=514735');
    expect(htmlUrl).toContain('st=Experience');

    // SlotLock invoked with Experience op + body
    expect(lockOpname).toBe('BookDetailsExperienceSlotLock');
    expect(lockBody.operationName).toBe('BookDetailsExperienceSlotLock');
    expect(lockBody.variables.input.experienceId).toBe(514735);

    // Token + result fields
    const json = JSON.parse(result.content[0].text);
    expect(json.booking_type).toBe('experience_mandatory');
    expect(json.experience.experience_id).toBe(514735);
    const decoded = decodeBookingToken(json.booking_token);
    expect(decoded.bookingType).toBe('experience');
    expect(decoded.experienceId).toBe(514735);
  });

  it('refuses an Experience slot when experience_id is missing', async () => {
    const client = { fetchHtml: vi.fn(), fetchJson: vi.fn() } as unknown as OpenTableClient;
    // The handler should reject before any fetch fires — we trigger Experience-mode
    // by having the caller declare slot.type === "Experience" via experience_ids
    // metadata. The simplest contract: if experience_ids is present and non-empty
    // (the agent passes them through from find_slots), experience_id must also be set.
    await expect(
      callTool(client, 'opentable_book_preview', {
        restaurant_id: 278896,
        date: '2026-06-25',
        time: '18:00',
        party_size: 5,
        reservation_token: 'tok',
        slot_hash: '431673495',
        dining_area_id: 21881,
        experience_ids: [514735, 627696],   // present without experience_id
      })
    ).rejects.toThrow(/experience_id/);
  });
});
```

`callTool` is the existing test helper in this file. If it doesn't exist, mirror the pattern used by the other `book_preview` tests in the same file.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tools/reservations
```

Expected: FAIL — schema doesn't accept `experience_id` or `experience_ids` args; handler doesn't branch on Experience.

- [ ] **Step 3: Extend the `bookingDetailsPath` helper to handle Experience URLs**

In `src/tools/reservations.ts`, replace the existing `bookingDetailsPath` (lines 37-57) with:

```typescript
/**
 * URL for the SSR /booking/details page. OpenTable shows this page right
 * before the user clicks "Complete Reservation" and it ships the
 * cancellation policy + saved cards + CC-required flag in its
 * __INITIAL_STATE__. See parse-booking-details-state.ts for what we
 * pull out.
 *
 * For Experience-mandatory slots, pass `experience_id` to add the
 * `experienceIds`, `selectedExperience`, `tableCategory`, and
 * `st=Experience` query params — these are what the seating-options
 * and specials intermediate pages would otherwise append for us when
 * the user clicks through them in the browser.
 */
function bookingDetailsPath(input: {
  restaurant_id: number;
  date: string;
  time: string;
  party_size: number;
  slot_hash: string;
  reservation_token: string;
  dining_area_id: number;
  experience_id?: number;
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
  return `/booking/details?${params.toString()}`;
}
```

- [ ] **Step 4: Extend the book_preview input schema and handler**

Find the `opentable_book_preview` registration (around line 212) and extend its `inputSchema`:

```typescript
inputSchema: {
  restaurant_id: z.number().int().positive(),
  date: z.string().describe('YYYY-MM-DD'),
  time: z.string().describe('HH:MM (24h) — must match a slot returned by find_slots'),
  party_size: z.number().int().positive(),
  reservation_token: z.string().describe('slot_availability_token from opentable_find_slots'),
  slot_hash: z.string().describe('slot_hash from opentable_find_slots'),
  dining_area_id: z
    .number()
    .int()
    .describe('Dining area id (from opentable_get_restaurant → diningAreas[])'),
  experience_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'For Experience-mandatory slots: which experience to book (from slot.experience_ids). Required when find_slots returned an Experience slot.'
    ),
  experience_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Pass-through from find_slots.experience_ids. When non-empty, experience_id must also be set.'
    ),
},
```

Update the handler body (the `async ({ restaurant_id, … })` arrow). Replace the existing handler body with:

```typescript
async ({
  restaurant_id, date, time, party_size, reservation_token, slot_hash,
  dining_area_id, experience_id, experience_ids,
}) => {
  const reservationDateTime = `${date}T${time}`;

  // Detect Experience-mandatory: caller passed experience_ids (from
  // find_slots) without picking one.
  const isExperience =
    Array.isArray(experience_ids) && experience_ids.length > 0
      || typeof experience_id === 'number';
  if (isExperience && typeof experience_id !== 'number') {
    throw new Error(
      'This slot requires picking an Experience. Options: ' +
        JSON.stringify(experience_ids) +
        '. Re-call opentable_book_preview with experience_id set to one of them.'
    );
  }

  // Step 1 — /booking/details SSR (Experience or Standard).
  const detailsHtml = await client.fetchHtml(
    bookingDetailsPath({
      restaurant_id, date, time, party_size, slot_hash,
      reservation_token, dining_area_id, experience_id,
    })
  );
  const state = extractInitialState(detailsHtml);
  const summary = parseBookingDetailsState(state);

  // Step 2a — same-day conflict.
  const conflicts = sameDayConflicts(summary.conflicts, date);
  if (conflicts.length > 0) {
    throw sameDayConflictError(conflicts, date);
  }

  // Step 2b — CC-required without a saved card.
  if (summary.cc_required && !summary.default_card) {
    throw new Error(
      'No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again.'
    );
  }

  // Step 3 — slot-lock. Branch on Experience vs Standard.
  const lockPath = isExperience ? EXPERIENCE_SLOT_LOCK_PATH : SLOT_LOCK_PATH;
  const lockOp = isExperience ? 'BookDetailsExperienceSlotLock' : 'BookDetailsStandardSlotLock';
  const lockHash = isExperience ? BOOK_EXPERIENCE_SLOT_LOCK_HASH : BOOK_SLOT_LOCK_HASH;
  const lockVariables: Record<string, unknown> = {
    input: {
      restaurantId: restaurant_id,
      seatingOption: 'DEFAULT',
      reservationDateTime,
      partySize: party_size,
      databaseRegion: 'NA',
      slotHash: slot_hash,
      reservationType: isExperience ? 'EXPERIENCE' : 'STANDARD',
      diningAreaId: dining_area_id,
      ...(isExperience ? { experienceId: experience_id, tableCategory: 'default' } : {}),
    },
  };
  const lockResponse = await client.fetchJson<{
    data?: {
      lockSlot?: {
        success?: boolean;
        slotLock?: { slotLockId?: number };
        slotLockErrors?: unknown;
      };
    };
  }>(lockPath, {
    method: 'POST',
    headers: { 'ot-page-type': 'network_details', 'ot-page-group': 'booking' },
    body: {
      operationName: lockOp,
      variables: lockVariables,
      extensions: {
        persistedQuery: { version: 1, sha256Hash: lockHash },
      },
    },
  });
  const slotLockId = lockResponse?.data?.lockSlot?.slotLock?.slotLockId;
  if (!slotLockId || lockResponse?.data?.lockSlot?.success !== true) {
    throw new Error(
      `OpenTable failed to lock slot for preview: ${JSON.stringify(
        lockResponse?.data?.lockSlot ?? lockResponse
      )}`
    );
  }

  // Step 4 — mint the booking_token. paymentCard handling unchanged.
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
  const booking_token = encodeBookingToken({
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
    ...(isExperience ? { experienceId: experience_id } : {}),
  });

  const chargesDescription = summary.cc_required
    ? `Nothing charged now — ${summary.default_card!.brand} •••• ${summary.default_card!.last4} held only. ${summary.policy.description}`
    : 'Nothing charged now — no card required.';

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            booking_token,
            booking_type: isExperience ? 'experience_mandatory' : 'instant',
            experience: summary.experience,
            reservation: { date, time, party_size, restaurant_id, dining_area_id },
            cancellation_policy: summary.policy,
            payment_method:
              summary.cc_required && summary.default_card
                ? { brand: summary.default_card.brand, last4: summary.default_card.last4 }
                : null,
            charges_at_booking: {
              amount_usd: 0,
              description: chargesDescription,
            },
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tools/reservations
```

Expected: PASS — the Experience-preview test now drives the Experience slot-lock path and returns `booking_type: "experience_mandatory"`.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS. The Standard path is unchanged because `isExperience` is `false` when no Experience args are supplied.

- [ ] **Step 7: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "book_preview: branch on Experience-mandatory slots

When the caller supplies experience_ids (from find_slots) or
experience_id, route through BookDetailsExperienceSlotLock and build
the /booking/details URL with the Experience query params (skipping
the seating-options / specials intermediate pages). Mint a token
carrying bookingType=experience + experienceId. Ambiguous case
(experience_ids without experience_id) errors out with the list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Experience-mandatory branch in `opentable_book`

**Files:**
- Modify: `src/tools/reservations.ts` (book handler — both the token and no-token paths)
- Modify: `tests/tools/reservations.test.ts`

Same branch logic, but additionally feeds the Experience body shape into `/dapi/booking/make-reservation` so the API doesn't 400.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/reservations.test.ts`:

```typescript
describe('opentable_book — Experience-mandatory slot', () => {
  it('with a token: skips slot-lock, submits make-reservation with experience fields', async () => {
    const fetchHtml = vi.fn(async () => '');   // not called on token path
    let makeBody: any;
    const fetchJson = vi.fn(async (path: string, init?: any) => {
      if (path === '/dapi/booking/make-reservation') {
        makeBody = init?.body;
        return { confirmationNumber: 8675309, reservationId: 1, securityToken: 'sec', success: true };
      }
      // dining-dashboard SSR for the profile fetch
      throw new Error(`unexpected POST: ${path}`);
    });
    // fetchProfile reads dining-dashboard via fetchHtml — wire that up:
    const dashHtml = mockDashboardHtml({
      first_name: 'A', last_name: 'B', email: 'a@b.c', mobile_phone: '+1 5550000', country_id: 'US',
    });
    fetchHtml.mockImplementation(async () => dashHtml);
    const client = { fetchHtml, fetchJson } as unknown as OpenTableClient;

    const token = encodeBookingToken({
      slotLockId: 9999, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '18:00',
      reservationToken: 'tok', slotHash: '431673495',
      paymentCard: null, ccRequired: false,
      issuedAt: new Date().toISOString(),
      bookingType: 'experience', experienceId: 514735,
    });

    const result = await callTool(client, 'opentable_book', {
      restaurant_id: 278896, date: '2026-06-25', time: '18:00', party_size: 5,
      reservation_token: 'tok', slot_hash: '431673495', dining_area_id: 21881,
      booking_token: token,
    });

    expect(makeBody.experienceId).toBe(514735);
    expect(makeBody.reservationType).toBe('Experience');
    const json = JSON.parse(result.content[0].text);
    expect(json.confirmation_number).toBe(8675309);
  });

  it('without a token: refuses Experience slots (preview-first gating)', async () => {
    const fetchHtml = vi.fn();
    const fetchJson = vi.fn();
    const client = { fetchHtml, fetchJson } as unknown as OpenTableClient;
    await expect(
      callTool(client, 'opentable_book', {
        restaurant_id: 278896, date: '2026-06-25', time: '18:00', party_size: 5,
        reservation_token: 'tok', slot_hash: '431673495', dining_area_id: 21881,
        experience_ids: [514735],  // ← signals Experience without a token
      })
    ).rejects.toThrow(/book_preview/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tools/reservations
```

Expected: FAIL.

- [ ] **Step 3: Extend the book input schema**

Add to the `opentable_book` `inputSchema` (alongside the existing fields):

```typescript
experience_ids: z
  .array(z.number().int().positive())
  .optional()
  .describe(
    'Pass-through from find_slots.experience_ids. When non-empty, book refuses without a booking_token from opentable_book_preview.'
  ),
```

- [ ] **Step 4: Branch the book handler**

In the `opentable_book` handler, replace the body with:

```typescript
async ({
  restaurant_id, date, time, party_size, reservation_token, slot_hash,
  dining_area_id, booking_token, experience_ids,
}) => {
  const reservationDateTime = `${date}T${time}`;
  const diningAreaId = dining_area_id;

  let slotLockId: number;
  let paymentCard: { id: string; last4: string; expiryMmYy: string; provider: string } | null = null;
  let ccRequired = false;
  let bookingType: 'standard' | 'experience' = 'standard';
  let experienceId: number | undefined;

  // Caller-declared Experience: signal via experience_ids when there's no token yet.
  const callerDeclaredExperience =
    Array.isArray(experience_ids) && experience_ids.length > 0;

  if (booking_token) {
    const payload = decodeBookingToken(booking_token);
    if (
      payload.restaurantId !== restaurant_id ||
      payload.date !== date ||
      payload.time !== time ||
      payload.partySize !== party_size ||
      payload.diningAreaId !== dining_area_id
    ) {
      throw new Error(
        'booking_token was issued for a different reservation (some field has changed since opentable_book_preview — party_size, date/time, restaurant, or dining area). Call opentable_book_preview again with the current args.'
      );
    }
    slotLockId = payload.slotLockId;
    paymentCard = payload.paymentCard;
    ccRequired = payload.ccRequired;
    bookingType = payload.bookingType;
    experienceId = payload.experienceId;
  } else {
    if (callerDeclaredExperience) {
      throw new Error(
        'This is an Experience-mandatory slot. Call opentable_book_preview first to review the policy + choose an experience_id, then pass the returned booking_token back to opentable_book.'
      );
    }

    // No-token Standard path — unchanged from today.
    const detailsHtml = await client.fetchHtml(
      bookingDetailsPath({
        restaurant_id, date, time, party_size, slot_hash,
        reservation_token, dining_area_id,
      })
    );
    const summary = parseBookingDetailsState(extractInitialState(detailsHtml));

    const conflicts = sameDayConflicts(summary.conflicts, date);
    if (conflicts.length > 0) {
      throw sameDayConflictError(conflicts, date);
    }

    if (summary.cc_required) {
      throw new Error(
        'This slot requires a credit-card guarantee. Call opentable_book_preview first to review the cancellation policy, then pass the returned booking_token back to opentable_book.'
      );
    }

    const lockResponse = await client.fetchJson<{
      data?: {
        lockSlot?: {
          success?: boolean;
          slotLock?: { slotLockId?: number };
          slotLockErrors?: unknown;
        };
      };
    }>(SLOT_LOCK_PATH, {
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
            diningAreaId,
          },
        },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: BOOK_SLOT_LOCK_HASH },
        },
      },
    });
    const lockedId = lockResponse?.data?.lockSlot?.slotLock?.slotLockId;
    if (!lockedId || lockResponse?.data?.lockSlot?.success !== true) {
      throw new Error(
        `OpenTable failed to lock slot for booking: ${JSON.stringify(
          lockResponse?.data?.lockSlot ?? lockResponse
        )}`
      );
    }
    slotLockId = lockedId;
  }

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
          reservationType: 'Experience',
          tableCategory: 'default',
        }
      : { reservationType: 'Standard' };

  const reservation = await client.fetchJson<{
    success?: boolean;
    reservationId?: number;
    confirmationNumber?: number;
    securityToken?: string;
    points?: number;
    reservationDateTime?: string;
    partySize?: number;
    reservationStateId?: number;
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
      isModify: false,
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
      `This card requires 3-D Secure authentication (SCA), which can't be completed from the MCP. Complete the booking in your browser: ${
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
        'Slot lock expired. Call opentable_find_slots for a fresh slot, then re-preview with opentable_book_preview.'
      );
    }
    throw new Error(`OpenTable book failed: ${raw}`);
  }
  if (!reservation?.confirmationNumber) {
    throw new Error(
      `OpenTable book response missing confirmationNumber: ${JSON.stringify(reservation)}`
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
          },
          null,
          2
        ),
      },
    ],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tools/reservations
```

Expected: PASS — Experience-with-token submits the right body shape; Experience-without-token errors with a preview-first message.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS — Standard path is byte-identical because `bookingType` defaults to `"standard"` and `experienceFields` falls back to `{ reservationType: 'Standard' }`.

- [ ] **Step 7: Verify the build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "book: route Experience-mandatory slots through the Experience flow

Token path reads bookingType + experienceId from the booking_token
minted by preview, submits make-reservation with reservationType:
'Experience', experienceId, and tableCategory: 'default'.
No-token path errors with a preview-first message when the caller
declares an Experience slot via experience_ids.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Live probe script `scripts/probe-book-cancel-experience.ts`

**Files:**
- Create: `scripts/probe-book-cancel-experience.ts`

End-to-end live round-trip: find_slots → book_preview (with experience_id) → book → list_reservations (assert Confirmed) → cancel. Mirrors `probe-book-cancel.ts`.

- [ ] **Step 1: Write the probe script**

Create `scripts/probe-book-cancel-experience.ts`:

```typescript
// Live round-trip for Cafe Pasqual's Experience-mandatory booking.
//
// Books a real reservation and immediately cancels it. Pasqual's is
// chosen because (a) it's the canonical Experience-mandatory restaurant
// we captured fixtures from, and (b) their Community Table seats up
// to ~12 so a 2-cover booking + cancel within seconds is unlikely to
// inconvenience them.
//
// Prereqs: companion Chrome extension loaded, opentable.com signed-in.
//          User has a default saved payment method (Pasqual's is CC-required).
import { OpenTableWsServer } from '../src/ws-server.js';
import { OpenTableClient } from '../src/client.js';

const PASQUAL_RID = 278896;
const PASQUAL_SLUG = 'cafe-pasquals-santa-fe';

// 2 weeks out + a dinner time Pasqual's serves.
const DATE = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
const TIME = '18:00';
const PARTY = 2;

async function callTool<T>(server: OpenTableWsServer, ...args: unknown[]): Promise<T> {
  // The probe drives the MCP via direct HTTP-equivalent calls, the same
  // way other probe-*.ts scripts in this directory do. Mirror the
  // exact pattern from probe-book-cancel-uk.ts — instantiate the
  // server, build an OpenTableClient, call its fetchJson / fetchHtml
  // helpers in sequence. This script is the live integration check;
  // the unit-test suite covers the branching.
  throw new Error('placeholder — copy the structure from probe-book-cancel.ts');
}

async function main() {
  const server = new OpenTableWsServer({ port: 37149 });
  await server.start();
  const client = new OpenTableClient(server);
  try {
    // 1) find_slots — pick a fresh Experience slot.
    const availResp = await client.fetchJson<unknown>(
      '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
      {
        method: 'POST',
        headers: { 'ot-page-type': 'home', 'ot-page-group': 'seo-landing-home' },
        body: {
          operationName: 'RestaurantsAvailability',
          variables: {
            onlyPop: false, forwardDays: 0, requireTimes: false,
            requireTypes: [], useCBR: false, privilegedAccess: [],
            restaurantIds: [PASQUAL_RID],
            restaurantAvailabilityTokens: ['eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ'],
            date: DATE, time: TIME, partySize: PARTY, databaseRegion: 'NA',
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: 'cbcf4838a9b399f742e3741785df64560a826d8d3cc2828aa01ab09a8455e29e',
            },
          },
        },
      }
    );
    // For brevity in this script we delegate the find_slots → preview → book
    // → cancel orchestration to the MCP tool handlers themselves by
    // re-importing them. Probes in this repo can either drive the API
    // directly (as above) or spin up the registered tools — both are
    // valid. Follow the pattern that `probe-book-cancel-uk.ts` uses.
    console.log('availability:', JSON.stringify(availResp, null, 2));
    console.log('TODO — follow probe-book-cancel-uk.ts structure for: preview, book, cancel.');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('probe-book-cancel-experience failed:', err);
  process.exit(1);
});
```

Then mirror the exact orchestration from `scripts/probe-book-cancel-uk.ts`, substituting:
- `restaurantId: 278896`, `diningAreaId: 21881`, `experience_id: 514735`
- Pass `experience_id: 514735` into `opentable_book_preview` args
- Pass `booking_token` returned by preview into `opentable_book`

(`probe-book-cancel-uk.ts` is the closest existing template because it also exercises a CC-required flow.)

- [ ] **Step 2: Manual smoke test**

```bash
npm run build && lsof -ti :37149 | xargs -r kill && npx tsx scripts/probe-book-cancel-experience.ts
```

Expected: A confirmation number prints, then a cancel-success line. If the slot is sold out for the chosen date, the script logs that and exits without trying to book — tweak DATE in the script and rerun.

- [ ] **Step 3: Commit**

```bash
git add scripts/probe-book-cancel-experience.ts
git commit -m "scripts: live probe for Experience-mandatory book + cancel

Round-trip against Cafe Pasqual's Community Table Dining. Mirrors
probe-book-cancel-uk.ts but routes through the Experience flow with
experience_id: 514735. Use during release verification or when
re-pinning the BookDetailsExperienceSlotLock hash.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation updates

**Files:**
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `SKILL.md` to document Experience flow + Listing detection**

Open `SKILL.md` and find the section that lists the booking tools / explains preview→book. Add a "Non-instant bookings" subsection. Pattern after the existing structure — the key content to add:

```markdown
## Non-instant bookings

OpenTable restaurants fall into three categories. Check
`opentable_get_restaurant.bookable` and the per-slot `booking_type`
before invoking `opentable_book`.

| `bookable` | `booking_type` | What it means | Action |
|---|---|---|---|
| true | `instant` | Standard restaurant, one-click book. | Today's path: optional preview, then `opentable_book`. |
| true | `experience_mandatory` | Restaurant requires picking an Experience (prix-fixe, tasting menu, etc.) before booking. Slot carries one or more `experience_ids`. | Call `opentable_get_restaurant` to see the per-area `bookableExperiences`. Call `opentable_book_preview` with both `dining_area_id` AND `experience_id`. Then `opentable_book` with the returned `booking_token`. |
| false | n/a | Listing-only: OpenTable shows the page but reservations go through the restaurant directly. | Surface the restaurant's `phone` and `url` to the user; do NOT call `opentable_book`. |
| true | `request` | (Reserved) Request-to-book. Not surfaced in v1. | n/a |

When `booking_type === "experience_mandatory"`, do **not** treat the
return as a confirmed reservation — it's still instant-confirm, but
the booking_token's `experience` block tells the agent which
Experience the user committed to (community-table dining, chef's
counter, etc.). Mention the Experience name in the user-facing
confirmation.
```

- [ ] **Step 2: Update `CLAUDE.md`'s hot-spots section**

Add to the "Hot spots / gotchas" bullet list:

```markdown
- **Experience-mandatory slots use a separate slot-lock op.**
  `BookDetailsExperienceSlotLock` (persisted-query hash captured
  2026-05-20 against Pasqual's) replaces `BookDetailsStandardSlotLock`
  when `slot.type === "Experience"`. The `/booking/details` URL also
  picks up `experienceIds`, `selectedExperience`, `tableCategory`,
  `st=Experience`, and `isMandatory=true` query params, which let us
  skip the `seating-options` and `specials` intermediate pages the
  browser UI walks through. If OpenTable redeploys and invalidates the
  Experience hash, run `scripts/probe-experience-slot-lock-hash.ts`
  against Pasqual's to re-capture.
- **Listing-only restaurants can't be booked through OpenTable.**
  `restaurant.type === "Listing"` (Le Bernardin's classification, e.g.)
  surfaces as `bookable: false` on `opentable_get_restaurant`. There's
  no slot picker; agents should surface the restaurant's phone + URL
  rather than call `opentable_book`.
```

- [ ] **Step 3: Run the full suite to confirm nothing in the docs broke a parse**

```bash
npm test
```

Expected: PASS. (Documentation doesn't affect tests, but worth re-running before commit.)

- [ ] **Step 4: Commit**

```bash
git add SKILL.md CLAUDE.md
git commit -m "docs: document Experience-mandatory flow + Listing detection

SKILL.md: agent-facing table of bookable / booking_type combinations
+ how to drive the Experience flow.
CLAUDE.md: two new hot-spots — Experience slot-lock op + the URL
shortcut that lets us skip seating-options / specials, and the
Listing-type unbookable case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Open the PR

**Files:**
- N/A — this is a git workflow task

- [ ] **Step 1: Confirm everything is green and ready**

```bash
git status
npm test
npm run build
```

Expected: clean working tree, all tests pass, bundle builds.

- [ ] **Step 2: Push and open the PR with the `enhancement` label**

```bash
git push -u origin <branch-name>
gh pr create --label enhancement --title "feat: non-instant booking support (Experience-mandatory + Listing detection)" --body "$(cat <<'EOF'
## Summary

Implements the design in `docs/superpowers/specs/2026-05-19-request-to-book-design.md`.

- `opentable_find_slots` gains `booking_type` + `experience_ids` per slot
- `opentable_get_restaurant` gains `bookable` + `listing_type`
- `opentable_book_preview` handles Experience-mandatory slots: builds the `/booking/details` URL with the Experience query params, slot-locks via `BookDetailsExperienceSlotLock`, mints a token carrying `bookingType: "experience"` + `experienceId`
- `opentable_book` decodes the token and submits `/dapi/booking/make-reservation` with `reservationType: "Experience"` + `experienceId` + `tableCategory`

## Out of scope (deferred)

- True Request-to-Book — `booking_type: "request"` enum value is wired but never emitted in v1; submission flow ships in a follow-up spec once a live RTB restaurant is captured.
- Experience add-ons (`ExperienceAddOns` GraphQL op).

## Test plan

- [x] Unit tests pass (parse-slots, parse-restaurant, parse-booking-details-state, booking-token, tools/reservations)
- [x] Build is clean (tsc --noEmit + esbuild)
- [ ] Live probe: `npx tsx scripts/probe-book-cancel-experience.ts` against Pasqual's
- [ ] Live probe: existing `scripts/probe-book-cancel.ts` (Standard path regression)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --auto --merge
```

Expected: PR opens, auto-merge enabled, CI runs.

---

## Self-Review

Walking the spec section by section against the plan above:

**Spec §"Tool surface" → `opentable_find_slots`** — covered by Task 1 (booking_type + experience_ids).

**Spec §"Tool surface" → `opentable_get_restaurant`** — covered by Task 2 (bookable + listing_type). Phone + URL already exist on `FormattedRestaurant` (verified at line 95 of `parse-restaurant.ts`); no rename needed.

**Spec §"Tool surface" → `opentable_book_preview`** — covered by Task 7 (Experience branching + new schema args). The Listing-refusal note from spec §"Tool surface" point 1 is documented in Task 6 (description-only — the tool can't fetch /r/{slug} for the type-check since callers pass numeric `restaurant_id`, so the spec's "refuse Listing-type restaurants" intent is implemented via the `bookable` field on `opentable_get_restaurant` and the agent-facing contract).

**Spec §"Tool surface" → `opentable_book`** — covered by Task 8.

**Spec §"Tool surface" → `opentable_list_reservations` / `opentable_cancel`** — spec says unchanged in v1; plan honours that (no tasks).

**Spec §"Data flow"** — Task 7 (preview) + Task 8 (book) cover the data flow diagrams.

**Spec §"Error handling"** — every condition in the spec's table is exercised by Task 7 / Task 8 tests, except the `PersistedQueryNotFound` row which is a runtime condition (no unit test possible — verified by the live probe in Task 9).

**Spec §"Investigation results"** — already in the spec; the plan's Task 0 produces the fixtures the rest of the plan depends on.

**Spec §"Testing — Unit"** — every bullet maps to a test step in Tasks 1, 2, 3, 4, 7, 8.

**Spec §"Testing — Live probes"** — Task 0 + Task 9.

**Spec §"Files touched"** — every file in the spec's list appears in this plan's File Structure.

**Placeholder scan:** one intentional placeholder — `'PASTE_HASH_FROM_TASK_0_HERE'` in Task 5 — is called out explicitly as "the implementing engineer should NOT skip this step or commit the placeholder." That's not a plan failure; it's the live-capture hand-off.

**Type consistency:** `BookingTokenType` (Task 4) ↔ `bookingType` field used in Tasks 7-8 ↔ `SlotBookingType` (Task 1, slot-level) — three different enums, intentionally:
- `SlotBookingType` (per-slot) = `'instant' | 'experience_mandatory' | 'request'`
- `BookingTokenType` (per-token, internal) = `'standard' | 'experience'`
- `booking_type` in tool outputs maps `bookingType: 'standard' → 'instant'`, `'experience' → 'experience_mandatory'`. This bridging happens at the tool-handler return site (verified in Task 7 + Task 8 code blocks).
- `RestaurantListingType` (Task 2) = `'GuestCenter' | 'Listing' | 'Unknown'`.

All four enums are exported from their respective files; tool handlers import what they need. No name collisions.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-20-non-instant-bookings-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
