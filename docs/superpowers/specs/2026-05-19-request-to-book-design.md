# Non-instant booking support — design

**Status:** approved (Experience-mandatory + Listing detection ready to plan;
true Request-to-Book submission deferred pending live capture)
**Date:** 2026-05-19 (revised 2026-05-20 after live investigation)
**Author:** Claude (with Chris)

## Context

The motivating bug: Cafe Pasqual's appeared with `instant_bookable: false`
in tool output, and `opentable_book` failed opaquely on its slots. Original
hypothesis was Request-to-Book (manual restaurant approval). Live
investigation via the Chrome bridge proved the picture is more nuanced:

OpenTable has **three distinct non-instant booking shapes**, and they
need different handling:

| Shape | UX | Submit endpoint | Confirmation | Today's behavior |
|---|---|---|---|---|
| **Experience-mandatory** | Multi-step picker (seating-options → specials → details) before the standard "Complete reservation" page. | Standard `/dapi/booking/make-reservation`, but slot-lock uses `BookDetailsExperienceSlotLock` op (not Standard). | Instant. | `opentable_book` fails — it hits Standard slot-lock + bypasses the seating/experience pickers. |
| **Listing-only** | Restaurant has an OpenTable info page but no booking flow at all (other reservation platform or no online booking). | None. | N/A. | `opentable_book` fails opaquely — there is no slot to lock. |
| **Request-to-Book (RTB)** | Same `/booking/details` page, but submit button reads "Request to Book" / "Send request." Restaurant manually approves within hours-to-days. | TBD per live capture. | Async (REQUESTED → CONFIRMED / DECLINED / EXPIRED). | `opentable_book` fails — endpoint differs from instant `/dapi/booking/make-reservation`. |

Live investigation (2026-05-20, Chrome bridge against opentable.com)
confirmed Experience-mandatory and Listing-only details fully (see
"Investigation results" §). True RTB was not surfaced live in available
restaurants surveyed — Le Bernardin returned `restaurant.type: "Listing"`
(not RTB), and Pasqual's `instant_bookable: false` was actually
Experience-mandatory. **The spec ships Experience-mandatory +
Listing-only now; true RTB submission ships in a follow-up spec once
a live RTB restaurant is captured.**

## Non-goals (deferred, see §"Follow-up specs")

- **True RTB submission flow** — endpoint, payload, response shape,
  REQUESTED-state lifecycle, approval/decline notifications. Deferred to
  its own spec.
- **Polling for RTB outcomes.** Even when RTB ships, the bridge
  architecture doesn't run when the user isn't actively driving an
  agent. Agents check status on demand via `opentable_list_reservations`.
- **Alternate-time proposals** and **notes-to-restaurant.** Both depend
  on the RTB submission flow.
- **Experience add-ons.** Pasqual's investigation showed
  `ExperienceAddOns` and `CalculateExperienceAddOnsTotals` GraphQL ops
  fire when add-ons exist. v1 books Experience slots without add-ons
  (skip the optional picker). v2 surfaces them.

## Tool surface

### `opentable_find_slots` — extended output

Each slot in the response array gains a `booking_type` field:

```jsonc
{
  "restaurant_id": 278896,
  "reservation_token": "…",
  "slot_hash": "431673495",
  "date": "2026-06-25",
  "time": "18:00",
  "party_size": 5,
  "type": "Experience",
  "attributes": ["default"],
  "points": 100,
  "booking_type": "experience_mandatory",   // ← new
  "experience_ids": [514735, 627696]        // ← new; only present for type: "Experience"
}
```

`booking_type` values:
- `"instant"` — slot.type === "Standard", restaurant is GuestCenter,
  one-click `/booking/details` flow. Today's path.
- `"experience_mandatory"` — slot.type === "Experience". Booking requires
  the user (or the agent, via book_preview) to commit to one of the
  Experiences in `experience_ids` before we can slot-lock.
- `"request"` — deferred to follow-up spec. Detection logic is wired
  through but currently always returns false; will flip on once the RTB
  signal field is known.

`type` (Standard | Experience | POP) stays — it describes the
seating/experience tier. `booking_type` describes how to *book* it.
The two dimensions are correlated but not identical: a Standard slot is
always `instant`; an Experience slot is `experience_mandatory` in v1
(RTB-on-Experience is a future combination we'll discover only when
true RTB ships).

### `opentable_get_restaurant` — extended output

A new top-level `bookable` field, plus `phone` + `url` ready for fallback
when bookable is false:

```jsonc
{
  // … existing fields …
  "phone": "(505) 983-9340",
  "url": "https://www.opentable.com/r/cafe-pasquals-santa-fe",
  "bookable": true,            // ← new; false when restaurant.type === "Listing"
  "listing_type": "GuestCenter"  // ← new: "GuestCenter" | "Listing"
}
```

When `bookable: false`, the search/listing tools surface enough info to
let the agent direct the user to the restaurant's phone or external
booking URL.

### `opentable_book_preview` — Experience flow + bookable check

Preview gains two behaviors:

1. **Refuse non-bookable restaurants.** If the restaurant's `listing_type
   === "Listing"`, throw a clear error pointing the agent at the
   restaurant's phone + URL. No slot-lock attempted.

2. **Handle Experience-mandatory slots.** Today, preview hits
   `BookDetailsStandardSlotLock` regardless. For Experience slots it
   must:
   - Navigate `/booking/details` with `experienceIds={...}` query param
     (mandatory).
   - When the slot exposes multiple seating areas
     (`timeSlot.diningAreasBySeating[].length > 1` — Pasqual's has
     "Community Table" + "Individual Table"), require an explicit
     `dining_area_id` in the preview args (mirrors today's CC-required
     restaurant gating).
   - When the dining area exposes multiple experiences
     (`bookableExperienceIds.length > 1`), require an explicit
     `experience_id` arg. With single-experience cases (Pasqual's
     Community Table → just experience 514735), auto-select.
   - Slot-lock via `BookDetailsExperienceSlotLock` (different
     persisted-query hash from Standard).

The returned token carries `bookingType: "experience"` and
`experienceId` so `opentable_book` can pick the right submission path.

```jsonc
{
  "booking_token": "eyJ…",                       // now carries experienceId
  "booking_type": "experience_mandatory",        // ← new
  "experience": {                                // ← new; present only for experience_mandatory
    "experience_id": 514735,
    "name": "Community Table Dining",
    "type_enum": "PRIX_FIXE",
    "description": "We will do our best to accommodate your seating request. Community Table seating may be subject to change depending on the restaurant's capacity.",
    "price_per_cover": null
  },
  "reservation": { … },
  "payment_method": { … },                       // CC still required at Pasqual's
  "cancellation_policy": { … },
  "terms": { … },
  "charges_at_booking": { … }
}
```

### `opentable_book` — auto-routes on bookingType

`booking_token` decoded; its `bookingType` field drives which slot-lock
+ which submission payload `/dapi/booking/make-reservation` receives.

- `bookingType: "standard"` (default, existing) → unchanged.
- `bookingType: "experience"` → slot-lock via
  `BookDetailsExperienceSlotLock`, then submit
  `/dapi/booking/make-reservation` with the experience-flavored body
  (selectedExperienceId + diningAreaId + tableCategory). Result still
  comes back as a normal confirmation with `confirmation_number` +
  `security_token`.

The no-token path (`opentable_book` without first calling preview)
gains the same experience auto-handling: detect Experience from the
slot, pick the dining area / experience (require explicit args when
ambiguous), then run the two-step lock+submit.

### `opentable_list_reservations` / `opentable_cancel`

**Unchanged in v1.** Experience-confirmed reservations come back as
normal Confirmed/Pending bookings — the dashboard doesn't distinguish
them. RTB-specific states (REQUESTED, DECLINED) defer to the follow-up
spec.

## Data flow

### Preview — Experience-mandatory path (new)

```
opentable_book_preview(slot args)
  │
  ├─ refuse if restaurant.listing_type === "Listing"
  │
  ├─ fetchProfile()                          # existing
  │
  ├─ if slot.booking_type === "experience_mandatory":
  │     ├─ require dining_area_id arg if multiple diningAreasBySeating
  │     ├─ require experience_id arg if multiple bookableExperienceIds
  │     ├─ build /booking/details URL with experienceIds + selectedExperience
  │     │   + diningAreaId + tableCategory + st=Experience
  │     ├─ fetch /booking/details                 # SSR; same parser, broader
  │     ├─ parseBookingDetailsState              # existing + experience extraction
  │     └─ lockSlot via BookDetailsExperienceSlotLock  # new persisted-query path
  │
  ├─ else (standard):                         # existing path unchanged
  │     ├─ fetch /booking/details
  │     ├─ parseBookingDetailsState
  │     └─ lockSlot via BookDetailsStandardSlotLock
  │
  ├─ sameDayConflicts() check                # existing
  ├─ encode booking_token (bookingType + experienceId)
  └─ return preview
```

### Book — Experience path

Decode token → tamper-check (now includes experienceId) → if token has
`bookingType: "experience"`, run the Experience slot-lock first (TTL ≈
90s, same as Standard) → POST `/dapi/booking/make-reservation` with
experience body → return confirmation.

The no-token branch mirrors preview's branching for the cases when the
agent calls `opentable_book` directly.

## Error handling

| Condition | Error |
|---|---|
| `book_preview` on Listing-type restaurant | `"<restaurant> doesn't accept reservations through OpenTable. Phone: <number>. Restaurant page: <url>."` |
| `book_preview` Experience slot without `dining_area_id` when multiple areas exist | `"<restaurant> at <time> requires choosing a seating area first. Options: <list of {dining_area_id, name}>. Re-call with dining_area_id."` |
| `book_preview` Experience slot without `experience_id` when multiple bookable experiences exist | `"<restaurant> at <time> in <area> offers multiple experiences. Options: <list of {experience_id, name, type_enum, description}>. Re-call with experience_id."` |
| `book_preview` Experience slot when the only bookable Experience is soldout | `"<restaurant>'s <experience name> is sold out for this slot."` |
| `BookDetailsExperienceSlotLock` returns `PersistedQueryNotFound` | Surface verbatim; tracked as a known fail-mode that means OpenTable redeployed and the Experience hash needs re-capture. |
| Token tamper-check fails on experienceId | Same as today's tamper-check error — "booking_token doesn't match the args; re-run preview." |

## Investigation results (live capture, 2026-05-20)

### Experience-mandatory case — Cafe Pasqual's (rid 278896)

**Flow URL chain** (party 5, 2026-06-25 18:00):
1. `/r/cafe-pasquals-santa-fe?covers=5&dateTime=2026-06-25T18:00`
2. Click 6:00 PM slot → `/booking/seating-options?…experienceIds=514735,627696&st=Experience&creditCardRequired=true&…`
3. Click "Select" on Community Table → `/booking/specials?…experienceIds=514735&diningAreaId=21881&tableCategory=default&isMandatory=true&…`
4. Click "Select" on Community Table Dining → `/booking/details?…selectedExperience=514735&diningAreaId=21881&tableCategory=default&st=Experience&…` (this is the standard booking-details page we already parse; slot-lock fires here, submit button reads "Complete reservation")

**Direct-fetch shortcut**: steps 2–3 are optional in the live UI but
their URL params are derivable from data we already have at step 1 —
specifically `timeSlot.diningAreasBySeating[].diningAreaId` and the
matching `bookableExperienceIds`. We can build the step-4 URL directly
and skip 2–3.

**`__INITIAL_STATE__.timeSlot` (Experience flow)**:
```
{
  creditCardRequired: true,
  creditCardRequiredForStandard: false,    // CC required only for the Experience
  slotHash: "431673495",
  slotAvailabilityToken: "eyJ…",           // base64 JSON, opaque
  experiencesBySeating: [
    { tableCategory: "default", experienceIds: [514735, 627696], __typename: "ExperiencesBySeating" }
  ],
  diningAreasBySeating: [
    { diningAreaId: 21881, tableCategory: "default", bookableExperienceIds: [514735], bookableExperiences: [{ experienceId: 514735, policies: {…}, __typename: "BookableExperience" }], … }
  ],
  pointsValue: 100,
  pointsType: "Standard",
  attributes: ["default"],
  …
}
```

**Discriminator**: `timeSlot.experiencesBySeating.length > 0` (or
equivalently, `slot.type === "Experience"`). Standard slots have
`experiencesBySeating: []`.

**GraphQL operation names observed** in capture-logger during the
flow:
- `NetworkFlowCalculatePoints`
- `ExperienceAddOns` (2x — fires for each candidate experience)
- `ExperienceCancellationPolicy`
- `CalculateExperienceAddOnsTotals`
- **`BookDetailsExperienceSlotLock`** ← the slot-lock op that replaces
  `BookDetailsStandardSlotLock`

Persisted-query sha256Hash for `BookDetailsExperienceSlotLock`: **NOT
YET CAPTURED** — needs `probe-find-slots-raw`-style instrumentation on
the Experience flow. (The request fired but the capture logger records
URL + method, not body. Implementation task: extend the capture logger
to include `extensions.persistedQuery.sha256Hash` in the recorded
frame, or add a new probe script that drives the Experience flow and
dumps the network tab.)

**Experience records** (3 returned for Pasqual's, only 1 bookable for
this slot):
```
[
  { experienceId: 514735, name: "Community Table Dining", type: "Special menu", typeEnum: "PRIX_FIXE", bookable: true, soldout: false, pricePerCover: null },
  { experienceId: 627684, name: "Cafe Pasqual's Breakfast and Lunch", type: "Happy hour", typeEnum: "HAPPY_HOUR", bookable: false, soldout: false, pricePerCover: null },
  { experienceId: 627696, name: "Cafe Pasqual's Dinner", type: "Happy hour", typeEnum: "HAPPY_HOUR", bookable: false, soldout: false, pricePerCover: null }
]
```

Booking-policy message (under `experiences[0].bookingPolicies.bookingPolicies.customPolicies.message`):
> "We will do our best to accommodate your seating request. Community Table seating may be subject to change depending on the restaurant's capacity."

Submit button on `/booking/details`: **"Complete reservation"** —
confirming Experience-mandatory is instant-confirm, not RTB.

### Listing-only case — Le Bernardin

`/r/le-bernardin` → `window.__INITIAL_STATE__.restaurantProfile.restaurant.type === "Listing"`.

No `availability.restaurantsAvailability` data; UI shows "Find similar
restaurants" CTA instead of a slot picker. No booking flow exists for
the restaurant on OpenTable.

**Discriminator**: `restaurant.type === "Listing"` (vs `"GuestCenter"`
for bookable restaurants). Surface as `listing_type` on
`opentable_get_restaurant`; refuse `book` / `book_preview` early when
this is `"Listing"`.

### True RTB — NOT CAPTURED

Survey attempts:
- `https://www.opentable.com/s?term=tasting%20menu&metroId=8&…` →
  "No restaurants found in this area."
- `/r/le-bernardin` → Listing-only, not RTB.

A real RTB capture remains future work. The spec field
`booking_type: "request"` is wired in now (always `false` in v1's
detection logic) so adding the discriminator later is a one-line
parser change; the submit flow + state lifecycle are deferred to a
follow-up spec where the shape can be specified from captured data
rather than guessed.

## Testing

### Unit (vitest, mocked `OpenTableClient`)

- `parse-slots` — slot with `experiencesBySeating: []` exposes
  `booking_type: "instant"`. Slot with `experiencesBySeating.length > 0`
  exposes `booking_type: "experience_mandatory"` + populated
  `experience_ids`. Standard slots gain no breaking changes.
- `parse-restaurant` — `restaurant.type === "Listing"` exposes
  `bookable: false` and `listing_type: "Listing"`. GuestCenter exposes
  `bookable: true`.
- `parse-booking-details-state` — Experience-flow `__INITIAL_STATE__`
  parses experience metadata into `BookingDetailsSummary.experience`.
- `booking-token` — `BookingTokenPayload` gains `bookingType: "standard"
  | "experience"` and `experienceId?: number`. Round-trip + tamper
  checks updated; null-safety preserved.
- `tools/reservations.ts`:
  - `book_preview` on Listing-type restaurant throws the unbookable
    error.
  - `book_preview` on Experience slot without `dining_area_id` (when
    multiple) throws the area-required error with options.
  - `book_preview` on Experience slot without `experience_id` (when
    multiple) throws the experience-required error with options.
  - `book_preview` on Experience slot with auto-selectable area/experience
    returns `booking_type: "experience_mandatory"` and a token whose
    decoded payload has `bookingType: "experience"`.
  - `book` with Experience token calls `BookDetailsExperienceSlotLock`
    (mock asserts on path/persisted-query hash) → make-reservation with
    experience body shape (mock asserts on path + body shape) → returns
    a normal Confirmed result.
  - `book` without token on Experience slot follows the same branching.

All existing tests must continue to pass unchanged. New fixtures:
- `tests/fixtures/booking-details-state-experience.json` — captured
  from Pasqual's investigation.
- `tests/fixtures/slots-experience-pasquals.json` — captured.

### Live probes

- `scripts/probe-book-cancel-experience.ts` — find_slots → preview
  (with explicit experience_id) → book (submits real reservation) →
  list_reservations (verify Confirmed) → cancel. Risk envelope: same
  as today's `probe-book-cc-cancel.ts` — Pasqual's CC-required
  Experience is the canonical test case. Slot-lock TTL ~90s, so cancel
  hits well before any 24-hour cancellation deadline.
- `scripts/probe-experience-slot-lock-hash.ts` — dump the network
  capture body for `BookDetailsExperienceSlotLock` to grab the
  persisted-query sha256Hash. One-shot script to pin the hash, similar
  to how Standard slot-lock hashes were originally captured.

## Files touched (estimated)

- `src/parse-slots.ts` — extend with `booking_type`, `experience_ids`.
- `src/parse-restaurant.ts` — extend with `bookable`, `listing_type`,
  `phone`, `url` (last two may already exist).
- `src/parse-booking-details-state.ts` — extend `BookingDetailsSummary`
  with `experience` block parsed from `__INITIAL_STATE__.experiences`.
- `src/booking-token.ts` — add `bookingType` ("standard" | "experience")
  + `experienceId?: number`. Tamper-check extended.
- `src/tools/reservations.ts` — Experience branching in `book_preview`
  + `book`; new persisted-query hash constant for
  `BookDetailsExperienceSlotLock`.
- `src/tools/restaurants.ts` — surface `bookable` + `listing_type`.
- `tests/parse-*.test.ts` — new tests per parser.
- `tests/booking-token.test.ts` — extend.
- `tests/tools/reservations.test.ts` — extend with Experience + Listing
  scenarios.
- `tests/fixtures/booking-details-state-experience.json` — NEW.
- `tests/fixtures/slots-experience-pasquals.json` — NEW.
- `scripts/probe-book-cancel-experience.ts` — NEW.
- `scripts/probe-experience-slot-lock-hash.ts` — NEW (one-shot to pin
  the persisted-query hash before merging the impl).
- `SKILL.md` — document Experience-mandatory flow + Listing detection.
- `CLAUDE.md` — hot-spot note on Experience slot-lock op + the
  multi-step seating-options/specials UI being skippable via direct
  /booking/details URL construction.
- `manifest.json` — no tool list changes (no new tools), but version
  bump.

## Follow-up specs

- **True Request-to-Book.** Once a live RTB restaurant is identified,
  capture the booking flow (button copy, submit URL/op, response shape,
  REQUESTED state lifecycle on dashboard, cancel behavior) and write a
  v2 spec layered on top of this one. The `booking_type: "request"`
  enum value is already wired through so the wiring change is
  small.
- **Experience add-ons.** Pasqual's `ExperienceAddOns` op fires per
  candidate experience and contributes to the cancellation/total
  calculation. v1 skips add-ons; a v2 spec surfaces them via a new
  field on book_preview and accepts them as an optional `add_ons` arg
  on book.
- **3DS / SCA on Experience CC-required slots.** Same handling as
  today's CC-required (`partnerScaRedirectUrl` bail) — already covered.
