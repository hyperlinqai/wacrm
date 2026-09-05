import { describe, it, expect } from 'vitest';
import { contactPhoneFromInput, contactPhoneFromWaId } from './store-phone';

describe('contactPhoneFromInput', () => {
  it('keeps an already-international number and adds nothing', () => {
    expect(contactPhoneFromInput('+918208103317', 'IN')).toEqual({
      ok: true,
      phone: '+918208103317',
    });
  });

  // The regression this module exists for: Meta Lead Ads hands over
  // "918208103317" (country code, no plus) and it was stored verbatim.
  it('adds the missing + to a country-coded number', () => {
    expect(contactPhoneFromInput('918208103317', 'IN')).toEqual({
      ok: true,
      phone: '+918208103317',
    });
  });

  it('prefixes the default country onto a bare national number', () => {
    expect(contactPhoneFromInput('8208103317', 'IN')).toEqual({
      ok: true,
      phone: '+918208103317',
    });
  });

  it('drops the trunk 0 before prefixing', () => {
    expect(contactPhoneFromInput('09876543210', 'IN')).toEqual({
      ok: true,
      phone: '+919876543210',
    });
  });

  it('strips the formatting a human types', () => {
    expect(contactPhoneFromInput('  98310-23021 ', 'IN')).toEqual({
      ok: true,
      phone: '+919831023021',
    });
  });

  it('refuses to guess a country when the account has no default', () => {
    expect(contactPhoneFromInput('9831023021', null)).toEqual({
      ok: false,
      rejection: 'no_country_code',
    });
  });

  it('rejects rather than repairs an Excel-mangled number', () => {
    const r = contactPhoneFromInput('9.18319E+11', 'IN');
    expect(r.ok).toBe(false);
  });

  it.each([['', 'empty'], ['12', 'too_short']])(
    'rejects %j',
    (input) => {
      expect(contactPhoneFromInput(input, 'IN').ok).toBe(false);
    },
  );
});

describe('contactPhoneFromWaId', () => {
  it('adds the + a wa_id never carries', () => {
    expect(contactPhoneFromWaId('918208103317')).toBe('+918208103317');
  });

  // The reason wa_ids must NOT go through contactPhoneFromInput: on an
  // IN-defaulted account this US number matches India's national pattern
  // and would be rewritten to +9114155550123 — a stranger's number.
  it('never reinterprets a foreign wa_id against a default country', () => {
    expect(contactPhoneFromWaId('14155550123')).toBe('+14155550123');
  });

  it('is idempotent on a value that already has a +', () => {
    expect(contactPhoneFromWaId('+918208103317')).toBe('+918208103317');
  });

  it('returns null for a fragment rather than making it look valid', () => {
    expect(contactPhoneFromWaId('123')).toBeNull();
    expect(contactPhoneFromWaId('')).toBeNull();
    expect(contactPhoneFromWaId(null)).toBeNull();
  });
});
