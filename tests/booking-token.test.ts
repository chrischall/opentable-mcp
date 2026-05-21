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
  paymentCard: {
    id: 'card_xxx',
    last4: '4242',
    expiryMmYy: '1028',
    provider: 'spreedly',
  },
  ccRequired: true,
  issuedAt: '2026-04-21T00:00:00Z',
  bookingType: 'standard',
};

describe('booking-token', () => {
  it('round-trips a payload through encode → decode', () => {
    const token = encodeBookingToken(samplePayload);
    expect(token).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    expect(decodeBookingToken(token)).toEqual(samplePayload);
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

  it('round-trips a no-guarantee payload (paymentCard=null, ccRequired=false)', () => {
    const payload: BookingTokenPayload = { ...samplePayload, paymentCard: null, ccRequired: false };
    const token = encodeBookingToken(payload);
    expect(decodeBookingToken(token)).toEqual(payload);
  });
});

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
