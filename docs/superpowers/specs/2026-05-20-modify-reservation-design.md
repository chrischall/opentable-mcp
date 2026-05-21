# Modify reservation — design

**Status:** approved, ready for plan
**Date:** 2026-05-20
**Author:** Claude (with Chris)

## Context

The MCP today exposes 11 tools and modify isn't one of them — you can `book` and `cancel` but not edit an existing reservation in place. The underlying OpenTable API supports modify: `/dapi/booking/make-reservation` accepts `isModify: true` + the existing `reservationId`, and `/booking/details?confirmationNumber=<n>&…` loads the SSR state for editing.

Adding modify removes a real friction case (cancel + rebook loses your spot in line, trips OpenTable's "double trouble" same-day check, and may shift the CC hold to different terms). It also matters for the v0.9 non-instant work that just landed: an Experience reservation's policy and CC re-hold can shift when you cross the 24h cancellation cutoff, so the modify flow has to surface the new policy *before* committing.

## Non-goals

- **Cross-restaurant transfers.** Out of scope. That's cancel + book at the new restaurant.
- **Adding a CC mid-modify** when none was previously held. If the new slot requires a CC and the diner has no saved card, fail with the same error book_preview emits — the user fixes their account, then re-previews.
- **Notes-to-restaurant text** on modify. Deferred (same as the deferred Request-to-Book note field).
- **Modify of a REQUESTED state reservation.** RTB lifecycle isn't surfaced yet; comes when true RTB ships.

## Tool surface

Two new tools, mirroring book's preview→commit pattern. Both follow the existing conventions in `src/tools/reservations.ts` (snake_case JSON, `readOnlyHint: true` only on preview, persisted-query hashes pinned at the top of the file).

### `opentable_modify_preview` — read-only

Slot-locks the new slot, fetches `/booking/details` with the existing reservation's `confirmationNumber` query param (which tells OpenTable's SSR "this is a modify, not a new booking"), and mints a `modify_token`.

```jsonc
inputSchema: {
  // Identity of the existing reservation
  restaurant_id: number,
  confirmation_number: number,
  security_token: string,

  // The NEW slot from opentable_find_slots
  date: string,
  time: string,
  party_size: number,
  reservation_token: string,
  slot_hash: string,
  dining_area_id: number,

  // Experience-mandatory args (same shape as book_preview)
  experience_id?: number,
  experience_ids?: number[],
}
```

Returns the same shape as `opentable_book_preview` plus an `existing_reservation` echo so the agent can confirm with the user what's moving:

```jsonc
{
  "modify_token": "eyJ…",            // ← name change from "booking_token" to clarify intent
  "booking_type": "experience_mandatory" | "instant",
  "experience": BookingExperience | null,
  "existing_reservation": {           // ← new
    "confirmation_number": 29541,
    "date": "2026-06-25",
    "time": "18:00",
    "party_size": 5,
    "restaurant_id": 278896,
    "dining_area_id": 21881
  },
  "reservation": {                    // the NEW slot's coordinates
    "date": "2026-06-25",
    "time": "19:15",
    "party_size": 5,
    "restaurant_id": 278896,
    "dining_area_id": 21881
  },
  "cancellation_policy": CancellationPolicy,
  "payment_method": { brand, last4 } | null,
  "charges_at_booking": { amount_usd: 0, description: string },
  "cc_required": boolean,
  "policy_type": "none" | "hold" | "deposit",
  "terms": BookingTerms | null
}
```

`modify_token` is a `BookingTokenPayload` with three optional fields populated: `existingReservationId`, `existingConfirmationNumber`, `existingSecurityToken`. The book/modify split doesn't need a separate token type — the presence of `existingReservationId` is the discriminator.

### `opentable_modify` — write

Decodes the `modify_token`, tamper-checks against the caller's args (restaurant/date/time/party/dining_area/experience_id + the existing reservation identifiers), and POSTs `/dapi/booking/make-reservation` with `isModify: true` + the token's `existingReservationId`.

```jsonc
inputSchema: {
  // Identity of the existing reservation (must match the modify_token)
  restaurant_id: number,
  confirmation_number: number,
  security_token: string,

  // The NEW slot
  date: string,
  time: string,
  party_size: number,
  reservation_token: string,
  slot_hash: string,
  dining_area_id: number,

  // REQUIRED — no no-token path for modify. The new slot's policy / CC
  // re-hold details can differ from the original, so we always go through
  // preview to surface them.
  modify_token: string,

  // Same Experience args as opentable_book — tamper-checked vs the token
  // when present.
  experience_id?: number,
  experience_ids?: number[],
}
```

Returns the same shape as `opentable_book`'s result. The `confirmation_number` is preserved across modifies (OpenTable's contract). `reservation_id` and `security_token` may be regenerated.

```jsonc
{
  "confirmation_number": 29541,        // unchanged
  "reservation_id": 2082218742,        // may be new
  "security_token": "01…",             // may be new
  "restaurant_id": 278896,
  "date": "2026-06-25",
  "time": "19:15",
  "party_size": 5,
  "points": 100,
  "status": "Pending",
  "cc_required": true,
  "booking_type": "experience_mandatory",
  "was_modified": true                 // ← new; lets the agent phrase the user confirmation correctly
}
```

### `opentable_list_reservations` / `opentable_cancel` / `opentable_book*`

No changes.

## Data flow

### Preview

```
opentable_modify_preview(existing_conf + new_slot_args)
  │
  ├─ fetchProfile()                                 # existing helper
  │
  ├─ isExperience detection (same as book_preview):
  │     experience_ids non-empty || typeof experience_id === 'number'
  │     ↳ if ambiguous (experience_ids set, experience_id missing): throw with options list
  │
  ├─ build /booking/details URL — same as book_preview PLUS
  │     confirmationNumber=<existing_conf>           # ← modify marker
  │
  ├─ fetch /booking/details (SSR HTML)
  ├─ parseBookingDetailsState                        # unchanged from book
  │
  ├─ sameDayConflicts(summary.conflicts, new_date,
  │                   excludeConfirmation=<existing_conf>)
  │     ↳ existing reservation appears in conflicts but is excluded —
  │       prevents false-positive "double trouble" on same-day moves
  │
  ├─ if cc_required && !default_card: throw
  │
  ├─ slot-lock (Standard or Experience, same persisted-query hashes as book)
  │     ↳ NO new hashes — slot-lock op is invariant on book vs modify
  │
  ├─ mint modify_token (BookingTokenPayload extended with existing* fields)
  │
  └─ return preview {
       modify_token,
       existing_reservation: { … },
       booking_type, experience,
       reservation: { … new slot coords … },
       cancellation_policy, payment_method,
       cc_required, policy_type, terms,
       charges_at_booking,
     }
```

### Modify

```
opentable_modify(modify_token + new_slot_args + existing_conf)
  │
  ├─ decode modify_token
  │
  ├─ tamper-check:
  │     payload.restaurantId === restaurant_id
  │     payload.date === date && payload.time === time
  │     payload.partySize === party_size
  │     payload.diningAreaId === dining_area_id
  │     payload.existingConfirmationNumber === confirmation_number
  │     payload.existingSecurityToken === security_token
  │     (if caller passed experience_id, must match payload.experienceId)
  │     payload.existingReservationId !== undefined  # discriminator: this IS a modify token
  │
  ├─ fetchProfile()
  │
  ├─ build make-reservation body — same as book PLUS:
  │     isModify: true,
  │     reservationId: payload.existingReservationId,
  │
  │     experienceFields (Experience: { experienceId, experienceVersion,
  │                                     reservationType: "Experience" })
  │     ccFields        (from payload.paymentCard — same as book)
  │
  ├─ POST /dapi/booking/make-reservation
  │
  ├─ handle errors same as book:
  │     partnerScaRequired → 3DS bail
  │     SLOT_LOCK_EXPIRED → "re-find_slots + re-preview"
  │     other errorCode → pass-through verbatim
  │
  └─ return modified-reservation shape (see Tool surface above).
```

### Reservation identification — the slightly subtle bit

The `/booking/details?confirmationNumber=<n>&…` URL is what tells OpenTable's SSR that this is a modify. Without that query param, the SSR returns a "new booking" state and `make-reservation` 400s when you set `isModify: true`. The `confirmationNumber` is also why we don't need to send the existing reservation's `reservation_id` to the SSR endpoint — OpenTable looks it up server-side from confirmation + signed-in user context.

The same `confirmationNumber` query param surfaces the existing CC hold's terms in the SSR state, which we use to populate `payment_method` on the preview response. If the user already has a card held for this reservation, the same card flows through on modify (no second hold; OpenTable releases-and-re-holds atomically).

## Error handling

All errors throw from the tool handler.

| Condition | Error |
|---|---|
| `modify_preview` on a Listing-type restaurant | (same as book_preview — descriptions tell agents to pre-check via `opentable_get_restaurant.bookable`; the tools don't enforce since they receive numeric restaurant_id, not a slug) |
| `modify_preview` on an Experience slot without `experience_id` (when ambiguous) | Same as book_preview: throw with the options list, ask to re-call |
| `modify_preview` requires CC but no saved card | Same as book_preview |
| `modify` without a `modify_token` | `"opentable_modify requires a modify_token from opentable_modify_preview. The new slot's policy and CC re-hold details can differ from the original — preview is mandatory."` |
| `modify_token` tamper-check fails | `"modify_token was issued for a different reservation (party_size, date/time, dining area, experience_id, or the existing reservation identifier has changed since opentable_modify_preview). Call opentable_modify_preview again with the current args."` |
| `modify_token` is actually a book token (no `existingReservationId`) | `"This token was issued by opentable_book_preview (a new-booking token), not opentable_modify_preview. Use opentable_book to commit, or call opentable_modify_preview if you meant to edit an existing reservation."` |
| existing reservation already cancelled / not owned by user | `make-reservation` returns 4xx — surface verbatim with the existing confirmation number |
| `SLOT_LOCK_EXPIRED` on the new slot | Same as book: instruct caller to re-`find_slots` + re-`modify_preview` |

## Investigation results

Verified live 2026-05-21 (during the v0.9 capture-phase work) that:
- `/booking/details?confirmationNumber=<n>` returns the modify state via the same SSR pattern as new-booking
- `__INITIAL_STATE__` keys include `modifyReservation` (we don't need to parse it; the existing parser surfaces everything we need)
- `make-reservation` request body in the live UI's modify flow has `isModify: true` + `reservationId` plus all the standard fields

One thing to confirm in the live probe (Task: see plan): whether the make-reservation body needs any additional modify-only fields. The captured page's Apollo mutation cache showed only `isModify` and `reservationId` as additions, so the design assumes those are sufficient. If the live probe surfaces a 400, the same iterate-on-error pattern that pinned the Experience body in PR #22 will apply.

## Testing

### Unit (vitest, mocked `OpenTableClient`)

- `booking-token`:
  - Round-trip a modify-shaped token (with `existingReservationId/ConfirmationNumber/SecurityToken`) — payload preserved through encode/decode.
  - Legacy tokens missing those fields decode as book tokens (the discriminator is `existingReservationId === undefined`).
- `tools/reservations.ts`:
  - `modify_preview` Standard slot: builds URL with `confirmationNumber=<n>`, slot-locks via Standard op, returns `existing_reservation` block + `modify_token`.
  - `modify_preview` Experience slot: same as above plus `experienceVersion` + experience-flow URL params.
  - `modify_preview` same-day move excludes the existing reservation from the conflict check (mock conflicts contain the existing's confirmation_number; assert the handler doesn't throw).
  - `modify_preview` listing-only restaurant errors via the same `bookable` precheck contract (description-only, mirrors book_preview).
  - `modify` with a book token (no `existingReservationId`) refuses with the wrong-token error.
  - `modify` with a modify token: posts make-reservation with `isModify: true` + the right `reservationId`; result includes `was_modified: true`.
  - `modify` tamper checks fail when caller's confirmation_number diverges from the token's.

All 126 existing tests must continue to pass.

### Fixtures

- `tests/fixtures/booking-details-state-modify.json` — captured from a live `/booking/details?confirmationNumber=…` page during the live probe. May be a thin variant of the existing Experience fixture; only diffs from new-booking state get inline assertions in the test.

### Live probe

`scripts/probe-modify-experience.ts` — find_slots → book → list_reservations (record the confirmation) → find_slots for a new time → modify_preview → modify → list_reservations (verify the time changed) → cancel. Targets Pasqual's Community Table Dining (Experience, CC-required) so it exercises the full Experience+CC modify path. Mirrors `probe-book-cancel-experience.ts` structure.

## Files touched (estimated)

- `src/booking-token.ts` — extend `BookingTokenPayload` with optional `existingReservationId/ConfirmationNumber/SecurityToken`. No new exported type — modify uses the same payload, with the existing* fields populated.
- `src/tools/reservations.ts` — register `opentable_modify_preview` + `opentable_modify`. Share the slot-lock body construction with book where possible (the only difference vs book_preview is the `confirmationNumber` URL param + `excludeConfirmation` on the conflict check). Share the make-reservation body with book (only additions: `isModify: true` + `reservationId`).
- `tests/booking-token.test.ts` — modify-token round-trip + book-vs-modify discriminator tests.
- `tests/tools/reservations.test.ts` — modify_preview + modify scenarios (Standard + Experience + tamper check + wrong-token-type + same-day-exclusion).
- `tests/fixtures/booking-details-state-modify.json` — NEW.
- `scripts/probe-modify-experience.ts` — NEW.
- `SKILL.md` — new "Modifying a reservation" section explaining the preview→modify pattern + when to use modify vs cancel-then-book.
- `CLAUDE.md` — hot-spot on the `confirmationNumber` URL marker + the `excludeConfirmation` conflict-check gotcha.
- `manifest.json` — declare the two new tools so the count is 13.

## Follow-up specs

- **Notes-to-restaurant** on book and modify. Both endpoints accept a free-text field that some restaurants display on the receipt; needs a small capture session to confirm the field name + character limit.
- **REQUESTED-state modify** when true Request-to-Book ships. Likely cancels the open request and submits a new one rather than mutating in place.
