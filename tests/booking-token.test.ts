import { describe, expect, it } from 'vitest';
import {
  BOOKING_TOKEN_TTL_MS,
  encodeBookingToken,
  decodeBookingToken,
  type BookingTokenPayload,
} from '../src/booking-token.js';

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
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // base64url body . base64url HMAC
    expect(decodeBookingToken(token)).toEqual(samplePayload);
  });

  it('throws on a garbage token', () => {
    const junk = Buffer.from('not json', 'utf8').toString('base64');
    expect(() => decodeBookingToken(junk)).toThrow(/booking_token/i);
  });

  it('throws when a required field is missing', () => {
    const { slotLockId: _drop, ...rest } = samplePayload;
    const token = encodeBookingToken(rest as unknown as BookingTokenPayload);
    expect(() => decodeBookingToken(token)).toThrow(/missing required field: slotLockId/);
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

  it('round-trips an experience token including experienceId + experienceVersion', () => {
    const before = {
      slotLockId: 111, restaurantId: 222, diningAreaId: 333,
      partySize: 2, date: '2026-06-25', time: '18:00',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: true,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'experience' as const,
      experienceId: 514735,
      experienceVersion: 7,
    };
    const after = decodeBookingToken(encodeBookingToken(before));
    expect(after.bookingType).toBe('experience');
    expect(after.experienceId).toBe(514735);
    // Required for the make-reservation REST body — missing version → 400.
    expect(after.experienceVersion).toBe(7);
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
    const encoded = encodeBookingToken(legacy as unknown as BookingTokenPayload);
    const decoded = decodeBookingToken(encoded);
    expect(decoded.bookingType).toBe('standard');
    expect(decoded.experienceId).toBeUndefined();
  });
});

describe('booking-token — modify-token shape', () => {
  it('round-trips a modify token with the existing-reservation identity pair', () => {
    const before = {
      slotLockId: 111, restaurantId: 278896, diningAreaId: 21881,
      partySize: 5, date: '2026-06-25', time: '19:15',
      reservationToken: 'tok', slotHash: 'h',
      paymentCard: null, ccRequired: true,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'experience' as const,
      experienceId: 514735, experienceVersion: 7,
      existingConfirmationNumber: 10001,
      existingSecurityToken: 'st_FIXTURE_REDACTED',
    };
    const after = decodeBookingToken(encodeBookingToken(before));
    expect(after.existingConfirmationNumber).toBe(10001);
    expect(after.existingSecurityToken).toBe(before.existingSecurityToken);
  });

  it('a token with only one existing-* field fails decode (partial-modify token)', () => {
    // existingConfirmationNumber set without the matching securityToken
    const malformed = {
      slotLockId: 1, restaurantId: 1, diningAreaId: 1,
      partySize: 1, date: '2026-06-25', time: '18:00',
      reservationToken: 't', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'standard' as const,
      existingConfirmationNumber: 10001,
    };
    const encoded = encodeBookingToken(malformed as unknown as BookingTokenPayload);
    expect(() => decodeBookingToken(encoded)).toThrow(/partial-modify tokens are rejected/);
  });

  it('book tokens (no existing-* fields) decode unchanged', () => {
    const bookToken = {
      slotLockId: 1, restaurantId: 1, diningAreaId: 1,
      partySize: 1, date: '2026-06-25', time: '18:00',
      reservationToken: 't', slotHash: 'h',
      paymentCard: null, ccRequired: false,
      issuedAt: '2026-05-20T00:00:00.000Z',
      bookingType: 'standard' as const,
    };
    const after = decodeBookingToken(encodeBookingToken(bookToken));
    expect(after.existingConfirmationNumber).toBeUndefined();
    expect(after.existingSecurityToken).toBeUndefined();
  });
});

describe('booking-token — signed and short-lived (fleet-audit #636)', () => {
  it('rejects an unsigned base64-JSON token an agent built itself', () => {
    const forged = Buffer.from(JSON.stringify(samplePayload), 'utf8').toString('base64');
    expect(() => decodeBookingToken(forged)).toThrow(/not issued by this server|altered/i);
  });

  it('rejects a token whose payload was edited after signing (e.g. tcAccepted flipped)', () => {
    const [body, sig] = encodeBookingToken(samplePayload).split('.');
    const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    envelope.p.tcAccepted = true;
    envelope.p.ccRequired = false;
    const edited = `${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}.${sig}`;
    expect(() => decodeBookingToken(edited)).toThrow(/not issued by this server|altered/i);
  });

  it('rejects a token past its lifetime', () => {
    const issued = Date.parse('2026-05-01T12:00:00Z');
    const token = encodeBookingToken(samplePayload, { now: issued });
    expect(decodeBookingToken(token, { now: issued + 60_000 }).slotLockId).toBe(12345);
    expect(() => decodeBookingToken(token, { now: issued + BOOKING_TOKEN_TTL_MS + 1 })).toThrow(/expired/i);
  });
});
