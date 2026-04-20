import { describe, it, expect } from 'vitest';
import { parseAvailabilityResponse } from '../src/parse-slots.js';

/** Synthetic fixture distilled from a real capture (2026-04-20 discovery). */
const sample = {
  data: {
    availability: [
      {
        restaurantId: 54232,
        restaurantAvailabilityToken: 'eyJ2abc',
        availabilityDays: [
          {
            dayOffset: 0,
            slots: [
              { isAvailable: false, __typename: 'UnavailableSlot' },
              { isAvailable: false, __typename: 'UnavailableSlot' },
              {
                isAvailable: true,
                timeOffsetMinutes: 0,
                slotHash: 'h-19',
                slotAvailabilityToken: 'tok-19',
                type: 'Standard',
                attributes: ['default'],
                pointsValue: 100,
                __typename: 'AvailableSlot',
              },
              {
                isAvailable: true,
                timeOffsetMinutes: 15,
                slotHash: 'h-1915',
                slotAvailabilityToken: 'tok-1915',
                type: 'Standard',
                attributes: ['default', 'bar'],
                pointsValue: 100,
                __typename: 'AvailableSlot',
              },
              {
                isAvailable: true,
                timeOffsetMinutes: 30,
                slotHash: 'h-1930',
                slotAvailabilityToken: 'tok-1930',
                type: 'Experience',
                attributes: ['default'],
                pointsValue: 100,
                __typename: 'AvailableSlot',
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('parseAvailabilityResponse', () => {
  it('expands timeOffsetMinutes into absolute HH:MM', () => {
    const slots = parseAvailabilityResponse(sample, '2026-05-01', '19:00', 2);
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({
      restaurant_id: 54232,
      reservation_token: 'tok-19',
      date: '2026-05-01',
      time: '19:00',
      party_size: 2,
      type: 'Standard',
      attributes: ['default'],
      points: 100,
      slot_hash: 'h-19',
    });
    expect(slots[1].time).toBe('19:15');
    expect(slots[2].time).toBe('19:30');
  });

  it('skips UnavailableSlot entries', () => {
    const slots = parseAvailabilityResponse(sample, '2026-05-01', '19:00', 2);
    // sample has 2 unavailable + 3 available → 3 returned
    expect(slots.map((s) => s.isAvailable)).not.toContain(false);
  });

  it('returns an empty array when availability[] has no slots', () => {
    const empty = { data: { availability: [{ restaurantId: 1, availabilityDays: [] }] } };
    expect(parseAvailabilityResponse(empty, '2026-05-01', '19:00', 2)).toEqual([]);
  });

  it('throws on non-data response (errors)', () => {
    expect(() =>
      parseAvailabilityResponse({ errors: [{ message: 'oops' }] }, '2026-05-01', '19:00', 2)
    ).toThrow(/availability response contained errors/);
  });

  it('throws on unrecognised response shape', () => {
    expect(() => parseAvailabilityResponse({}, '2026-05-01', '19:00', 2)).toThrow();
  });

  it('handles offset crossing midnight → next date', () => {
    const crossMidnight = {
      data: {
        availability: [
          {
            restaurantId: 1,
            availabilityDays: [
              {
                slots: [
                  {
                    isAvailable: true,
                    timeOffsetMinutes: 120,
                    slotAvailabilityToken: 't',
                    __typename: 'AvailableSlot',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const slots = parseAvailabilityResponse(crossMidnight, '2026-05-01', '23:00', 2);
    expect(slots[0].date).toBe('2026-05-02');
    expect(slots[0].time).toBe('01:00');
  });

  it('sorts slots by date then time', () => {
    const multi = {
      data: {
        availability: [
          {
            restaurantId: 1,
            availabilityDays: [
              {
                slots: [
                  { isAvailable: true, timeOffsetMinutes: 30, slotAvailabilityToken: 'c', __typename: 'AvailableSlot' },
                  { isAvailable: true, timeOffsetMinutes: 0, slotAvailabilityToken: 'a', __typename: 'AvailableSlot' },
                  { isAvailable: true, timeOffsetMinutes: 15, slotAvailabilityToken: 'b', __typename: 'AvailableSlot' },
                ],
              },
            ],
          },
        ],
      },
    };
    const slots = parseAvailabilityResponse(multi, '2026-05-01', '19:00', 2);
    expect(slots.map((s) => s.reservation_token)).toEqual(['a', 'b', 'c']);
  });
});
