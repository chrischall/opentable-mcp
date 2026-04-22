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
