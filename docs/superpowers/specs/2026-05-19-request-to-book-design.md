# Request-to-Book (non-instant) booking support — design

**Status:** approved, ready for plan (pending investigation results)
**Date:** 2026-05-19
**Author:** Claude (with Chris)

## Context

Many OpenTable restaurants — particularly boutique / fine-dining /
small independents — require a manual approval step before confirming
a reservation. Diners submit a "request to book," the restaurant
approves (or declines, or proposes an alternate time) within a window
of hours-to-days, and only then is the booking confirmed.

OpenTable's UI shows these slots with a **Request to Book** button
instead of the **Complete Reservation** button used on
instant-bookable slots. The underlying API endpoint is different from
`/dapi/booking/make-reservation`.

Today our MCP doesn't know about this distinction. `opentable_book`
calls `/dapi/booking/make-reservation` for any slot find_slots returns
— which fails opaquely on RTB restaurants. Agents have invented
workarounds ("if instant_bookable: false, direct user to opentable.com
or phone"), but the workaround relies on a field we don't actually
expose, and the failure mode is just "an error" with no help on what
to do next.

## Non-goals (deferred, see §6)

- **Polling for RTB outcomes.** The bridge architecture doesn't run
  when the user isn't actively driving an agent. Agents check status
  on demand via `opentable_list_reservations`.
- **Alternate-time proposals.** Some RTB restaurants respond with
  "we don't have 6 PM, but we have 6:30 PM — accept?" v1 surfaces the
  state as REQUESTED / DECLINED / TIME_PROPOSED but does not accept
  proposed times through the MCP. User goes to opentable.com.
- **Notes-to-restaurant** text on the request. Deferred unless
  investigation shows OpenTable requires it.

## Tool surface

### `opentable_find_slots` — extended output

Each slot in the response array gains a `booking_type` field:

```jsonc
{
  "restaurant_id": 1272781,
  "reservation_token": "…",
  "slot_hash": "…",
  "date": "2026-06-25",
  "time": "18:00",
  "party_size": 5,
  "type": "Standard",
  "attributes": ["default"],
  "points": 100,
  "booking_type": "instant"          // ← new: "instant" | "request" | "closed"
}
```

Agents that want to filter to instant-only restaurants can do so in
their planning step. The `type` (Standard | Experience | POP) field
stays — it describes the seating/experience tier, not the booking
mode, and the two dimensions are orthogonal (an Experience slot can
be either instant or request).

Per-slot is the right granularity if OpenTable carries it there; if
the signal is restaurant-level only, every slot in a given availability
day gets the same value.

### `opentable_get_restaurant` — extended output

A new top-level `booking_type` field on the formatted restaurant
object, plus phone + URL ready for fallback if `booking_type !==
"instant"`:

```jsonc
{
  // … existing fields …
  "phone": "(505) 983-9340",
  "url": "https://www.opentable.com/r/cafe-pasquals-santa-fe",
  "booking_type": "instant",
  "rtb_response_time_hours": null   // ← new; non-null only when booking_type === "request"
}
```

`rtb_response_time_hours` exposes the restaurant's stated SLA when
OpenTable surfaces one (varies by restaurant; some show "responds
within 2 hours," others nothing). When unknown, callers should set
expectations conservatively ("up to 24 hours").

### `opentable_book_preview` — extended output

Mirrors find_slots' new field. Preview already runs the slot-lock +
fetches `/booking/details` SSR state for CC + terms; the same SSR
state probably exposes the RTB signal (investigation will confirm),
so this is essentially free.

```jsonc
{
  "booking_token": "eyJ…",
  "booking_type": "request",         // ← new
  "rtb_response_time_hours": 24,     // ← new
  "reservation": { … },
  "payment_method": null,            // RTB restaurants typically don't hold CC
  "cancellation_policy": { … },      // may still apply when restaurant approves
  "terms": { … },
  "charges_at_booking": {
    "amount_usd": 0,
    "description": "No card held now. If the restaurant approves your request, your card may be held according to their policy."
  }
}
```

### `opentable_book` — auto-routes on booking_type

`booking_token` decoded; its `bookingType` field drives which endpoint
is called.

**Instant slot (unchanged):**

```jsonc
{
  "confirmation_number": 8675309,
  "reservation_id": 424242,
  "security_token": "01…",
  "restaurant_id": 1272781,
  "date": "2026-05-01", "time": "19:00", "party_size": 2,
  "status": "Pending",            // OpenTable's term for "confirmed pre-arrival"
  "booking_type": "instant",
  "cc_required": false
}
```

**Request slot:**

```jsonc
{
  "confirmation_number": 8675310,
  "reservation_id": null,         // may be null until restaurant approves
  "security_token": "01…",        // present so cancel works on the request
  "restaurant_id": 4711,
  "date": "2026-06-25", "time": "18:00", "party_size": 5,
  "status": "REQUESTED",          // ← new state
  "booking_type": "request",
  "expires_at": "2026-06-26T18:00:00Z",   // ← new: restaurant's response deadline
  "cc_required": false
}
```

The shape difference between the two return values is intentional and
loud — the `status: "REQUESTED"` + `booking_type: "request"` combo
tells the calling LLM "do not promise the user a confirmed booking;
this is async."

### `opentable_list_reservations` — extended status set

Today the formatted output uses status values like `Pending`,
`Cancelled`, `Confirmed`. v1 adds `REQUESTED` (and any RTB-related
states discovered during investigation — likely `DECLINED`,
`TIMEOUT_EXPIRED`, `TIME_PROPOSED`). The `expires_at` field appears
on entries with `status === "REQUESTED"`.

### `opentable_cancel` — branches on state if needed

Pending investigation: if OpenTable uses the same
`CancelReservation` GraphQL mutation for both confirmed reservations
and pending requests, no change. Otherwise the tool gains an internal
branch on the reservation's current state, looked up via the security
token, to route to the right endpoint.

## Data flow

### Preview

```
opentable_book_preview(slot args)
  │
  ├─ fetchProfile()                     # existing — dining-dashboard SSR
  ├─ fetch /booking/details              # existing
  ├─ parseBookingDetailsState            # existing + RTB extraction
  │   └─ extracts booking_type, rtb_response_time_hours
  ├─ if booking_type === "closed":
  │     throw "<restaurant> isn't accepting reservations right now"
  ├─ lockSlot()                          # existing; per investigation, may
  │                                      # or may not apply for RTB slots
  ├─ sameDayConflicts() check            # existing
  ├─ encode booking_token (now carries bookingType + paymentCard + rest)
  └─ return preview { booking_token, booking_type, rtb_response_time_hours,
                      cancellation_policy, payment_method, terms, … }
```

### Book — instant slot path (unchanged)

Decode token → tamper-check → make-reservation POST → return Pending
status with confirmation_number + security_token.

### Book — request slot path (new)

```
opentable_book(args, booking_token where bookingType === "request")
  │
  ├─ decode booking_token
  ├─ tamper-check (restaurant_id, date, time, party_size, dining_area_id)
  ├─ fetchProfile()                          # for diner name/email/phone
  ├─ POST <RTB endpoint>                     # TBD per investigation
  │     body: {
  │       restaurantId, reservationDateTime, partySize,
  │       slotHash, slotAvailabilityToken, slotLockId,
  │       firstName, lastName, email, phoneNumber,
  │       reservationType: "RequestToBook",  # TBD exact value
  │       // possibly other fields per investigation
  │     }
  ├─ map response: { confirmationNumber, securityToken, expiresAt?, … }
  └─ return formatted result with status: "REQUESTED"
```

## Error handling

All errors throw from the tool handler (surfaces as `isError: true`).

| Condition | Error |
|---|---|
| `book_preview` on a `booking_type: "closed"` restaurant | `"<restaurant> isn't accepting reservations right now. Reason: <verbatim message>. Phone: <number>."` |
| `book` on RTB slot without a `booking_token` | `"This slot is request-to-book. Call opentable_book_preview first to review the policy + expected response time, then pass the returned booking_token back here."` |
| RTB endpoint rejects the request (e.g. restaurant pausing, party-size out of range) | Pass through OpenTable's verbatim message + restaurant phone + URL so the agent can suggest manual booking. |
| RTB-equivalent of `PersistedQueryNotFound` | Surface verbatim; tracked as a known fail-mode that means OpenTable redeployed and we need to re-capture the persisted-query hash. |
| `cancel` on a REQUESTED reservation when API requires a different endpoint | Internal branch on state; surfaces the same `{ cancelled, state, raw }` shape as today's cancel. |

## Investigation step (prerequisite for implementation)

Single capture session against Cafe Pasqual's (the restaurant from
the conversation that motivated this spec). Driven via the
companion extension's capture logger.

1. **Restaurant id lookup** — call `opentable_search_restaurants`
   with `term: "Cafe Pasqual's"`. Grab the restaurant id and slug.
2. **Slots raw dump** — run `scripts/probe-find-slots-raw.ts`
   against the rid for an upcoming dinner date. Inspect each slot for
   any RTB-like marker (`bookable`, `requestOnly`, `reservationStyle`,
   `bookingMode`, `isInstantBookable`, etc.).
3. **`/r/<slug>` SSR** — capture `__INITIAL_STATE__`, grep for the
   same markers under `restaurant.features` / `restaurant.bookable` /
   `restaurant.reservationType`. Likely the canonical source.
4. **`/booking/details` SSR** — navigate to a slot's booking-details
   page, capture `__INITIAL_STATE__`. RTB-mode signal should be here
   in some form because the UI swaps button copy ("Complete
   Reservation" → "Request to Book"). Grep `messages.*`, `timeSlot.*`,
   `restaurant.features.*`.
5. **Submission POST capture** — click "Request to Book." Walk
   through to the page that actually submits. Capture:
   - URL of the POST.
   - Persisted-query sha256Hash (if GraphQL).
   - Full request body.
   - Full response — including the new state code and any
     `expires_at` / `responseDeadline` / `rtbExpiresAt` field.
6. **Dashboard re-fetch** — after submission, capture
   `/user/dining-dashboard` SSR. Find the new request in
   `userTransactions`; note its `reservationState` /
   `reservationStateId` and any RTB-specific fields.
7. **Cancel capture** — cancel the request via opentable.com. Capture
   the cancel POST URL + body + response. If it's the same
   `CancelReservation` mutation as confirmed bookings, our existing
   `opentable_cancel` works unchanged. If different, document the
   branching.

Findings codify in this spec's "Investigation results" section
(appended below) before the implementation plan opens any code task.

## Testing

### Unit (vitest, mocked `OpenTableClient`)

- `parse-slots` — slot with RTB marker exposed as
  `booking_type: "request"`. Instant slots still show `booking_type:
  "instant"`. Closed slots `booking_type: "closed"`.
- `parse-restaurant` — `booking_type` + `rtb_response_time_hours`
  exposed.
- `parse-booking-details-state` — `booking_type` extracted alongside
  `cc_required`, `policy`, `terms`, `conflicts`.
- `parse-dining-dashboard` — `REQUESTED` (and DECLINED, TIMEOUT,
  TIME_PROPOSED if seen in investigation) state codes mapped;
  `expires_at` extracted.
- `booking-token` — `BookingTokenPayload` gains
  `bookingType: "instant" | "request"`. Round-trip + tamper checks
  updated; null-safety preserved.
- `tools/reservations.ts`:
  - `book_preview` on RTB slot returns `booking_type: "request"` and a
    plausible `rtb_response_time_hours`.
  - `book_preview` on closed slot throws the "not accepting"
    error.
  - `book` with RTB token calls the RTB endpoint (mock asserts on
    path + body shape), returns `status: "REQUESTED"` and `expires_at`.
  - `book` without token on RTB slot throws the preview-first gating
    error.
  - `list_reservations` surfaces REQUESTED items distinguishably.
  - `cancel` works on REQUESTED reservation (mock the correct
    endpoint, branched per investigation finding).

All 111 existing tests must continue to pass unchanged.

### Live probe

`scripts/probe-book-request-cancel.ts` — find_slots → preview → book
(submits real request) → list_reservations (verify status REQUESTED)
→ cancel. Risk envelope is gentler than the CC probe because RTB
restaurants take wall-clock time to approve, so cancel almost
certainly lands while the request is still pending.

## Deferred / non-goals (tracked in `docs/superpowers/roadmap.md`)

- **Polling / push notifications for RTB outcomes.** The bridge
  doesn't run when the user isn't driving an agent. Agents call
  `list_reservations` on demand.
- **Alternate-time proposals.** Restaurants can propose alternate
  times ("we don't have 6 PM, but we have 6:30 PM"). v1 surfaces the
  state — `TIME_PROPOSED` if seen in investigation — but does not
  let the agent accept / decline through the MCP. User does it via
  opentable.com.
- **Notes-to-restaurant text.** Some RTB restaurants accept a free-
  text note ("celebrating an anniversary"). Add later if
  investigation shows the field is commonly present.

## Files touched (estimated)

- `src/parse-slots.ts` — extend with `booking_type`.
- `src/parse-restaurant.ts` — extend with `booking_type` and
  `rtb_response_time_hours`.
- `src/parse-booking-details-state.ts` — extend `BookingDetailsSummary`
  with `booking_type` + `rtb_response_time_hours`.
- `src/parse-dining-dashboard.ts` — extend with REQUESTED and any
  other RTB-related states.
- `src/booking-token.ts` — add `bookingType` field.
- `src/tools/reservations.ts` — RTB submission path in
  `opentable_book`; preview gains `booking_type` and
  `rtb_response_time_hours`; cancel branches if needed.
- `tests/parse-*.test.ts` — new tests per parser.
- `tests/booking-token.test.ts` — extend.
- `tests/tools/reservations.test.ts` — extend with RTB scenarios.
- `tests/fixtures/booking-details-state-rtb.json` — NEW from
  investigation.
- `tests/fixtures/dining-dashboard-rtb-requested.json` — NEW from
  investigation.
- `scripts/probe-book-request-cancel.ts` — NEW.
- `SKILL.md` — document the RTB flow; agents need to know the
  expectation-setting language ("submitted — not confirmed").
- `CLAUDE.md` — hot-spot note on RTB state lifecycle.
- `docs/superpowers/roadmap.md` — v2 items.

## Investigation results

_To be filled in after the capture session in §"Investigation step."_

Field-path findings:
- find_slots RTB marker: TBD
- restaurant SSR RTB marker: TBD
- booking-details SSR RTB marker: TBD
- RTB submission endpoint URL: TBD
- RTB submission persisted-query hash (if any): TBD
- RTB submission request body shape: TBD
- RTB submission response shape: TBD
- Dashboard `reservationState` value for RTB: TBD
- Cancel endpoint for RTB (same as confirmed or different): TBD
