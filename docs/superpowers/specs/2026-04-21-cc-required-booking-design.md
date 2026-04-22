# CC-required booking flow — design

**Status:** approved, ready for plan
**Date:** 2026-04-21
**Author:** Claude (with Chris)

## Context

`opentable_book` today handles **Standard, no-guarantee** slots only. When the
user tries to book a slot that OpenTable flags as CC-required (prime-time
reservations at busy restaurants, tasting menus, special events), the call
fails opaquely or succeeds in a way the user didn't consent to.

The user wants:

- Support for CC-required bookings.
- A confirmation step that surfaces the cancellation policy, the card that
  would be held/charged, and any at-booking charges *before* anything commits.

## Non-goals (v1)

Tracked in §6 for v2:

- Experience / ticketed slots (prepaid events, tasting menus).
- POP (Priority Offered) slots.
- Deposit-required slots.
- Multiple saved cards / explicit card selection.
- Reservation modification.

v1 scope is **Standard type + cancellation-fee guarantee only**. Experience
and POP slots will be rejected with a clear "v2 item, book at opentable.com"
error.

## Tool surface

Two tools change; no others.

### `opentable_book_preview` — new, read-only

Runs the slot-lock step (necessary to even *see* the cancellation policy —
the policy lives in the lock response) and returns a structured preview.

**Inputs** — identical to `opentable_book` today:

```
restaurant_id      number
date               string (YYYY-MM-DD)
time               string (HH:MM, 24h)
party_size         number
reservation_token  string (from opentable_find_slots)
slot_hash          string (from opentable_find_slots)
dining_area_id     number (from opentable_get_restaurant → diningAreas[])
```

**Annotations:** `readOnlyHint: true`. The slot-lock is transient (~90s) and
has no user-visible side effect; the MCP client treats this as read-only for
confirmation-policy purposes.

**Output** (JSON in the `text` content block):

```jsonc
{
  "booking_token": "eyJ...base64...==",
  "restaurant": {
    "id": 1272781,
    "name": "State of Confusion",
    "dining_area": "Main Dining Room"
  },
  "reservation": {
    "date": "2026-05-01",
    "time": "19:00",
    "party_size": 2
  },
  "payment_method": {
    "brand": "Visa",
    "last4": "4242"
  },
  "cancellation_policy": {
    "type": "no_show_fee",          // "none" | "no_show_fee" | "late_cancel_fee"
    "amount_usd": 50,               // number or null
    "per_person": true,             // whether amount is per guest
    "free_cancel_until": "2026-05-01T16:00:00-04:00", // ISO-8601 or null
    "description": "Cancel by 4 PM same day for no charge. Late cancellations and no-shows charged $50 per guest.",
    "raw_text": "…verbatim policy string from OpenTable…"
  },
  "charges_at_booking": {
    "amount_usd": 0,
    "description": "Nothing charged now — card held only."
  }
}
```

For a Standard-no-guarantee slot the preview still succeeds:
`cancellation_policy.type = "none"`, `charges_at_booking.amount_usd = 0`,
`payment_method = null`. The `booking_token` is still issued — calling
`opentable_book` with it is valid and skips the re-lock.

### `opentable_book` — modified

**New optional input:** `booking_token` (string).

**Behavior matrix:**

| Slot type / policy        | `booking_token` present? | Behavior                                                                              |
|---------------------------|--------------------------|---------------------------------------------------------------------------------------|
| Standard, no guarantee    | no                       | Existing flow: lock → make-reservation. Unchanged.                                    |
| Standard, no guarantee    | yes                      | Decode token, skip re-lock, call make-reservation directly. Reject if args mismatch.  |
| Standard, CC guarantee    | no                       | **Error.** Point caller at `opentable_book_preview`.                                  |
| Standard, CC guarantee    | yes                      | Decode token, skip re-lock, call make-reservation with `payment_method_id`.           |
| Experience / POP          | any                      | **Error.** v2-deferred; book at opentable.com.                                        |

**CC-required detection** — we read flags on the slot-lock response. The exact
path is TBD (investigation step; see §4), but we expect a field like
`lockSlot.paymentRequirement` or `lockSlot.cancellationPolicy` to be present.

### `booking_token` — opaque, stateless

Base64-encoded JSON. Contents:

```
{
  "slotLockId": 12345,
  "restaurantId": 1272781,
  "diningAreaId": 48750,
  "partySize": 2,
  "date": "2026-05-01",
  "time": "19:00",
  "reservationToken": "...",
  "slotHash": "...",
  "paymentMethodId": "pm_...",    // null for no-guarantee
  "ccRequired": true,             // for clarity when decoding
  "issuedAt": "2026-04-21T00:00:00Z"
}
```

**No server-side state.** The MCP process never caches the token; each call
decodes it fresh. OpenTable's own slot-lock TTL (~90s) is the only expiry
mechanism — stale tokens surface as a `make-reservation` failure which we
map to a clear error.

**Tamper check:** `opentable_book` validates that `restaurant_id`, `date`,
`time`, `party_size`, `dining_area_id` in the token match the call's args.
Mismatch → error instructing the caller to re-preview. We don't sign the
token (no shared secret); the tamper check is purely against the caller's
own args to catch "user changed their mind, LLM forgot to re-preview".

## Data flow

### Preview

```
opentable_book_preview(args)
  │
  ├─ fetchProfile()             // existing; dining-dashboard SSR
  ├─ fetchDefaultPaymentMethod() // NEW; endpoint TBD per §4
  │   └─ if null: throw "add a default card …"
  ├─ lockSlot()                 // existing BookDetailsStandardSlotLock GraphQL
  │   │   response now parsed for:
  │   │     - lockSlot.slotLockId   (existing)
  │   │     - lockSlot.cancellationPolicy  (NEW — shape TBD)
  │   │     - lockSlot.paymentRequirement  (NEW — flag)
  │   └─ if slot type is Experience/POP (detected from lock response or
  │      find_slots response passed as arg): throw v2-deferred error
  ├─ parseCancellationPolicy(lockResp)
  ├─ encode booking_token
  └─ return { booking_token, restaurant, reservation, payment_method,
              cancellation_policy, charges_at_booking }
```

### Book (CC-required path)

```
opentable_book({ …, booking_token })
  │
  ├─ decode booking_token
  ├─ assert token fields match call args
  ├─ makeReservation({           // existing REST call
  │     …,
  │     slotLockId: token.slotLockId,
  │     paymentMethodId: token.paymentMethodId,
  │     // CC-required may add more fields — TBD per §4
  │   })
  └─ return { confirmation_number, security_token, … }
```

### Book (Standard, no-guarantee, no token — unchanged)

Exact existing code path. Zero regression risk.

## Error handling

All errors throw from the tool handler (surfaces as `isError: true` on the
MCP response). Messages are actionable, single-line, under 200 chars.

| Condition                                            | Message                                                                                                                                         |
|------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| Preview: no default payment method on account        | `"No default payment method on your OpenTable account. Add one at https://www.opentable.com/account/payment-methods and try again."`           |
| Preview: slot is Experience or POP                   | `"This slot requires prepayment/ticketing which v1 doesn't support. Book it at https://www.opentable.com/r/<slug> directly. Tracked as v2."`   |
| Book: CC-required slot, no `booking_token`           | `"This slot requires a credit-card guarantee. Call opentable_book_preview first to review the policy, then pass booking_token back here."`     |
| Book: `booking_token` fields don't match call args   | `"booking_token was issued for a different reservation (party_size 2 → 4). Call opentable_book_preview again."`                                |
| Book: slot-lock expired (>~90s since preview)        | `"Slot lock expired. Call opentable_find_slots for a fresh slot and re-preview."`                                                               |
| Make-reservation: payment decline                    | Pass through OpenTable's `errorCode` + `errorMessage` verbatim.                                                                                 |

## Investigation step (prerequisite for implementation)

We don't yet know OpenTable's exact data shape for CC-required bookings.
Captures needed:

1. **CC-required `find_slots` response** — does the slot object carry a flag
   (e.g. `paymentRequirement`, `requiresCardAuth`) we can detect before
   calling preview? If yes, preview can fail fast on Experience/POP without
   a slot-lock.
2. **CC-required `BookDetailsStandardSlotLock` response** — where in the
   response tree does the cancellation policy + payment requirement live?
3. **Payment methods endpoint** — GraphQL query or REST endpoint the
   opentable.com booking page uses to list saved cards. Probably a
   `UserPaymentMethods` Apollo query or similar.
4. **`make-reservation` payload for CC-required** — which additional fields
   are set (`paymentMethodId`, `cardHoldAmount`, etc.)?

**Capture procedure:** user loads a restaurant known to require a CC
guarantee (prime-time booking at a busy spot), walks the booking flow up to
(but not through) final confirmation. Run
`copy(JSON.stringify(window.__otMcpCaptures, null, 2))` in the extension's
MAIN-world console and paste the output. Then we codify the shapes.

If step 4 reveals a different persisted-query hash for CC-required lock
(e.g. `BookDetailsGuaranteedSlotLock`), we add it alongside the existing
`BookDetailsStandardSlotLock` constant and branch on the slot's policy flag.

## Testing

### Unit (vitest, mocked `OpenTableClient`)

- `parse-slot-lock.ts` (new) — given fixture responses, extracts policy +
  payment-requirement correctly for: no-guarantee, CC-guarantee,
  Experience, POP.
- `tools/reservations.ts` (existing file extended):
  - Preview on Standard no-guarantee → `$0` charges, `"none"` policy, token.
  - Preview on Standard CC-guarantee → full policy + card last4 + token.
  - Preview on Experience → throws v2-deferred error.
  - Preview with no payment methods → throws "add a card" error.
  - Book with valid booking_token → commits (mock make-reservation).
  - Book without booking_token on CC-required slot → throws preview-first error.
  - Book with tampered booking_token (party_size mismatch) → throws mismatch error.
  - Book with expired slot-lock (mock 410/400) → throws slot-lock-expired error.

Existing 72 tests continue to pass unchanged.

### Live probe

`scripts/probe-book-cc-cancel.ts` — books a CC-required slot and
*immediately* cancels. Same shape as existing `probe-book-cancel.ts` but
uses preview → book. Header comment flags the financial risk: a bug that
skips the cancel step would leave a real card hold in place.

The probe runs against a known CC-required restaurant (picked at probe
time, not hard-coded, since which restaurants guarantee shifts with
demand). Probe exits non-zero if it can't find a CC-required slot within
the first few candidates, so we don't silently test on a no-guarantee slot
and miss the whole point.

## Deferred to v2 (tracked in `docs/superpowers/roadmap.md`)

- Experience / ticketed slots (prepayment).
- POP (Priority Offered) slots.
- Deposit-required slots (partial upfront charge).
- Optional `payment_method_id` override on `opentable_book_preview` (pick a
  non-default card).
- Booking modification (change date/time/party_size on existing reservation).

## Files touched

- `src/tools/reservations.ts` — extend with preview tool, modify book tool.
- `src/parse-slot-lock.ts` — NEW. Pure function extracting policy + payment
  requirement from a slot-lock response.
- `src/parse-payment-methods.ts` — NEW (or inline helper). Extracts default
  card brand + last4 from wherever OpenTable exposes it.
- `tests/parse-slot-lock.test.ts` — NEW.
- `tests/tools/reservations.test.ts` — extend.
- `scripts/probe-book-cc-cancel.ts` — NEW.
- `SKILL.md` — document the preview → book flow.
- `CLAUDE.md` — hot-spots section gains the booking_token opacity note.
- `docs/superpowers/roadmap.md` — NEW; seeds the v2 list.

No changes to: `src/ws-server.ts`, `src/client.ts`, `extension/*` (the
capture logger already exists and is what we'll use for investigation).

---

## Investigation results (2026-04-22)

Captured from Rowes Wharf Sea Grille (rid 2827) — a real CC-required
restaurant with a "$50 per person" no-show fee — via the extension's
XHR logger plus `__INITIAL_STATE__` of the `/booking/details` page.

**Where the CC-required flag lives:** not in the `BookDetailsStandardSlotLock`
response (which is identical to a no-guarantee slot-lock and carries
only `slotLockId`). The flag lives in the SSR `__INITIAL_STATE__` of
the `/booking/details` page at:

```
state.timeSlot.creditCardRequired          (boolean)
state.timeSlot.creditCardPolicyType        ("Hold" | "Deposit" | …)
state.timeSlot.creditCardPolicyId          (string; policy reference)
state.timeSlot.creditCardDeposit           (object or null)
```

**Where the cancellation policy text lives:**

```
state.messages.cancellationPolicyMessage.cancellationMessage.message
state.messages.creditCardDayMessage[0].message   (duplicate in many cases)
state.restaurant.features.creditCardCancellationDayLimit   (number of days)
```

Verbatim sample text:
> "This restaurant requires a credit card to secure this reservation. …
> No-shows or cancellations less than 24 hours in advance will be
> subject to a charge of $50 per person."

The dollar amount + "per person" vs "total" is only in the free-text
message. We surface `raw_text` verbatim and best-effort-parse the
amount via regex; when parsing fails we still return the raw text so
the LLM / user can read it.

**Where saved cards live:**

```
state.wallet.savedCards          (array; each has cardId, last4, type, default)
state.wallet.selectedPaymentCardId  (id of the card OpenTable will use)
```

No separate payment-methods endpoint needed — the page ships the cards
as part of the SSR state.

**Preview request shape (revised):**

```
GET /booking/details?rid=<id>&datetime=<ISO>&covers=<N>&seating=default&dtp=1&...
  → HTML (SSR) → extractInitialState → parseBookingDetailsState
```

The slot-lock step is still needed (it reserves the slot for ~90s and
returns the `slotLockId` we need for `make-reservation`). It is called
separately from the booking-details SSR fetch.

**`make-reservation` additions for CC-required** (to be verified by
running the live probe once Task 13 is built): likely requires at least
`paymentMethodId` / `savedCardId` pointing at `wallet.selectedPaymentCardId`.
Commit the live probe's discovered payload shape when it's known.
