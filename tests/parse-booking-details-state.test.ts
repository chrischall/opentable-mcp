import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseBookingDetailsState,
  sameDayConflicts,
} from '../src/parse-booking-details-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('parseBookingDetailsState', () => {
  it('extracts CC policy + saved default card from a CC-required slot', () => {
    const state = fixture('booking-details-state-cc.json');
    const r = parseBookingDetailsState(state);
    expect(r.cc_required).toBe(true);
    expect(r.policy_type).toBe('hold');
    expect(r.policy.type).toBe('no_show_fee');
    expect(r.policy.amount_usd).toBe(50);
    expect(r.policy.per_person).toBe(true);
    expect(r.policy.free_cancel_days).toBe(1);
    expect(r.policy.description).toMatch(/\$50 per person/);
    expect(r.policy.raw_text).toContain('No-shows or cancellations');
    expect(r.default_card).not.toBeNull();
    expect(r.default_card!.last4).toBe('4242');
    expect(r.default_card!.brand).toBe('Mastercard');
    expect(r.default_card!.id).toBe('card_REDACTED_DEFAULT');
  });

  it('returns cc_required=false and policy.type=none for a standard slot', () => {
    const state = fixture('booking-details-state-no-cc.json');
    const r = parseBookingDetailsState(state);
    expect(r.cc_required).toBe(false);
    expect(r.policy.type).toBe('none');
    expect(r.policy.amount_usd).toBeNull();
    expect(r.policy.raw_text).toBe('');
    // Saved cards still surfaced — caller can ignore if CC not required
    expect(r.default_card).not.toBeNull();
  });

  it('returns default_card=null when wallet has no saved cards', () => {
    const state = {
      ...fixture('booking-details-state-cc.json'),
      wallet: { savedCards: [], selectedPaymentCardId: null },
    };
    const r = parseBookingDetailsState(state);
    expect(r.default_card).toBeNull();
  });

  it('prefers selectedPaymentCardId over the first card when both are populated', () => {
    const state = {
      ...fixture('booking-details-state-cc.json'),
      wallet: {
        savedCards: [
          { cardId: 'card_a', last4: '1111', type: 'Visa', default: false, active: true, expiryMonth: 5, expiryYear: 2030, expired: false },
          { cardId: 'card_b', last4: '2222', type: 'Amex', default: false, active: true, expiryMonth: 6, expiryYear: 2030, expired: false },
        ],
        selectedPaymentCardId: 'card_b',
      },
    };
    const r = parseBookingDetailsState(state);
    expect(r.default_card!.id).toBe('card_b');
    expect(r.default_card!.last4).toBe('2222');
  });

  it('parses a "$NN total" fee where the message omits "per person"', () => {
    const state = {
      ...fixture('booking-details-state-cc.json'),
      messages: {
        cancellationPolicyMessage: {
          cancellationMessage: {
            message:
              'A credit card is required to hold this reservation. No-shows or late cancellations will incur a $100 fee.',
            language: { code: 'en' },
          },
        },
        creditCardDayMessage: [],
      },
    };
    const r = parseBookingDetailsState(state);
    expect(r.policy.amount_usd).toBe(100);
    expect(r.policy.per_person).toBe(false);
  });

  it('extracts upcomingReservationConflicts into a typed conflicts array', () => {
    const state = {
      ...fixture('booking-details-state-cc.json'),
      upcomingReservationConflicts: [
        {
          dateTime: '2026-05-01T20:00',
          confirmationNumber: 2110515622,
          partySize: 5,
          restaurant: { restaurantId: 2827, name: 'Rowes Wharf Sea Grille' },
        },
        // Malformed entries should be dropped, not crash.
        { dateTime: '2026-05-01T20:00' },
        { confirmationNumber: 12345 },
      ],
    };
    const r = parseBookingDetailsState(state);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toEqual({
      date_time: '2026-05-01T20:00',
      confirmation_number: 2110515622,
      restaurant_id: 2827,
      restaurant_name: 'Rowes Wharf Sea Grille',
      party_size: 5,
    });
  });

  it('defaults conflicts to [] when the field is absent', () => {
    const state = {
      ...fixture('booking-details-state-no-cc.json'),
    };
    delete (state as { upcomingReservationConflicts?: unknown }).upcomingReservationConflicts;
    const r = parseBookingDetailsState(state);
    expect(r.conflicts).toEqual([]);
  });

  it('leaves amount_usd null when the message has no dollar amount', () => {
    const state = {
      ...fixture('booking-details-state-cc.json'),
      messages: {
        cancellationPolicyMessage: {
          cancellationMessage: {
            message: 'A credit card is required to hold this reservation. Cancellation terms apply.',
            language: { code: 'en' },
          },
        },
        creditCardDayMessage: [],
      },
    };
    const r = parseBookingDetailsState(state);
    expect(r.policy.amount_usd).toBeNull();
    expect(r.policy.description).toContain('credit card is required');
  });
});

describe('sameDayConflicts', () => {
  const conflicts = [
    {
      date_time: '2026-05-01T20:00',
      confirmation_number: 111,
      restaurant_id: 2827,
      restaurant_name: 'Rowes Wharf',
      party_size: 5,
    },
    {
      date_time: '2026-05-02T19:00',
      confirmation_number: 222,
      restaurant_id: 16759,
      restaurant_name: 'Fleet Landing',
      party_size: 2,
    },
  ];

  it('returns only conflicts whose local date matches the target date', () => {
    expect(sameDayConflicts(conflicts, '2026-05-01')).toHaveLength(1);
    expect(sameDayConflicts(conflicts, '2026-05-01')[0].confirmation_number).toBe(111);
  });

  it('returns [] when no conflicts match the date', () => {
    expect(sameDayConflicts(conflicts, '2026-06-15')).toEqual([]);
  });

  it('excludes the specified confirmation (modify-flow support)', () => {
    expect(sameDayConflicts(conflicts, '2026-05-01', 111)).toEqual([]);
  });
});
