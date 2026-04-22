# opentable-mcp roadmap

## v2 — CC / payment-flow extensions

Tracked from the CC-required booking spec (2026-04-21). Each bullet is
a separate plan when we're ready to build. v1 (shipped in 0.5.x) covers
**Standard slots with a hold-on-card cancellation fee**; everything
below is out of scope for v1 and returns a clear error pointing the
user at opentable.com.

- **Experience / ticketed slots.** Full prepayment at booking (tasting
  menus, NYE, themed dinners). `timeSlot.reservationType = "Experience"`,
  plus `experiences[]` / `experienceTotals` in the booking-details SSR
  state. Different persisted-query hash for slot-lock is likely; the
  `make-reservation` shape differs (prices, addons, tip). Live probe
  needs either a pay-and-refund cycle or a willing test restaurant.
- **POP (Priority Offered) slots.** OpenTable's paid-priority slots.
  `type = "POP"` in `find_slots`. Same pattern as Experience —
  surfaces fee + card + charge-at-booking in preview. Probably shares
  most of the Experience pipeline once that's built.
- **Deposit-required slots.** Partial charge at booking, remainder at
  meal. Preview's `charges_at_booking` would go non-zero and the
  response shape needs a distinct "deposit" section separate from
  "cancellation fee". Relevant `__INITIAL_STATE__` keys:
  `calculateDepositTotal`, `timeSlot.creditCardDeposit`,
  `timeSlot.creditCardPolicyType === "Deposit"`.
- **Explicit `payment_method_id` on `opentable_book_preview`.** Today
  we use whatever the user's default saved card is on opentable.com.
  A `payment_method_id` override lets the caller pick a non-default
  card. `wallet.savedCards[]` already exposes the full list.
- **Reservation modification.** Change date/time/party/dining-area on
  an existing confirmation. Likely a third tool (`opentable_modify`)
  with its own preview step. The `modifyReservation` / `modifyAvailability`
  slices of booking-details SSR have what we need. Preview would
  surface any change-related fee plus the new reservation summary.

## Deferred engineering items

- **Fee amount parsing beyond `$NN per person`.** Today
  `parse-booking-details-state.ts` best-efforts a dollar figure via
  regex. For policies like "25% of the menu price" or "equal to the
  set-menu price", `amount_usd` stays `null` and callers fall back to
  `raw_text`. That's fine for v1; revisit if/when deposits land.
- **Auth sync for concierge accounts.** Concierge gpid mapping exists
  in `state.concierge` but no tool consumes it. A future concierge
  flow would let admins book for others.

## Completed

- **v1 (0.5.x): Standard slots with hold-on-card cancellation fee.**
  `opentable_book_preview` + `booking_token` flow, implemented
  2026-04-21. See `docs/superpowers/specs/2026-04-21-cc-required-booking-design.md`
  and `docs/superpowers/plans/2026-04-21-cc-required-booking.md`.
