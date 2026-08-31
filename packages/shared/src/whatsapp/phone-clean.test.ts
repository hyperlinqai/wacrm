import { describe, expect, it } from 'vitest';
import { auditPhones, cleanPhone } from './phone-clean';

// The fixtures are shapes taken from a real imported contact list, which
// is where the interesting cases come from — three quarters of it was
// bare national numbers, and two rows had been destroyed by Excel.
const IN = { defaultCountry: 'IN' };

describe('cleanPhone — numbers that are already fine', () => {
  it('accepts a full international number unchanged', () => {
    const r = cleanPhone('+919893009057', IN);
    expect(r).toMatchObject({ ok: true, e164: '+919893009057', msisdn: '919893009057' });
    expect(r.repairs).toEqual([]);
  });

  it('accepts a country code written without the plus', () => {
    // "919907275072" is not a valid 10-digit Indian national number, so
    // the national reading fails and the international one has to win.
    const r = cleanPhone('919907275072', IN);
    expect(r).toMatchObject({ ok: true, e164: '+919907275072' });
    expect(r.repairs).toEqual([]);
  });

  it('does not need a default country when the number carries one', () => {
    expect(cleanPhone('+919893009057')).toMatchObject({ ok: true, e164: '+919893009057' });
  });
});

describe('cleanPhone — repairs', () => {
  it('adds the account country to a bare national number', () => {
    const r = cleanPhone('9831023021', IN);
    expect(r).toMatchObject({ ok: true, e164: '+919831023021' });
    expect(r.repairs).toEqual(['country_code']);
  });

  it('strips spaces and reports it as formatting only', () => {
    const r = cleanPhone('+91 98674 50450', IN);
    expect(r).toMatchObject({ ok: true, e164: '+919867450450' });
    expect(r.repairs).toEqual(['formatting']);
  });

  it('strips dashes, brackets and dots', () => {
    expect(cleanPhone('+91 (98310)-23.021', IN)).toMatchObject({
      ok: true,
      e164: '+919831023021',
    });
  });

  it('converts a 00 international access prefix to +', () => {
    const r = cleanPhone('00919893009057', IN);
    expect(r).toMatchObject({ ok: true, e164: '+919893009057' });
    expect(r.repairs).toContain('international_prefix');
    // The country code came from the number, not from the account.
    expect(r.repairs).not.toContain('country_code');
  });

  it('converts an 011 access prefix to +', () => {
    expect(cleanPhone('011919893009057', IN)).toMatchObject({
      ok: true,
      e164: '+919893009057',
    });
  });

  it('drops a domestic trunk zero', () => {
    expect(cleanPhone('09893009057', IN)).toMatchObject({ ok: true, e164: '+919893009057' });
  });

  it('trusts the number over the account default', () => {
    // A UK number in an India-defaulted account stays a UK number.
    const r = cleanPhone('+442071838750', IN);
    expect(r).toMatchObject({ ok: true, e164: '+442071838750' });
    expect(r.repairs).not.toContain('country_code');
  });
});

describe('cleanPhone — rejections', () => {
  it('rejects a bare national number when no country is configured', () => {
    // The whole point of the setting: without it we must not guess.
    expect(cleanPhone('9831023021')).toMatchObject({
      ok: false,
      rejection: 'no_country_code',
    });
  });

  it('refuses to reconstruct a number Excel mangled', () => {
    // 9.18319E+11 rounded away the low digits. Expanding it would
    // fabricate a valid number belonging to somebody else.
    for (const bad of ['9.18319E+11', '9.18839E+11', '9.1832e+11']) {
      expect(cleanPhone(bad, IN)).toMatchObject({
        ok: false,
        rejection: 'excel_scientific',
      });
    }
  });

  it('rejects short codes and stray fragments', () => {
    for (const bad of ['329', '6284', '5443']) {
      expect(cleanPhone(bad, IN)).toMatchObject({ ok: false, rejection: 'too_short' });
    }
  });

  it('rejects a number that is the wrong length for its country', () => {
    expect(cleanPhone('942409015', IN)).toMatchObject({
      ok: false,
      rejection: 'not_a_valid_number',
    });
  });

  it('rejects blanks and punctuation', () => {
    for (const bad of ['', '   ', '--', null, undefined]) {
      expect(cleanPhone(bad, IN)).toMatchObject({ ok: false, rejection: 'empty' });
    }
  });

  it('ignores an unsupported default country rather than throwing', () => {
    expect(cleanPhone('9831023021', { defaultCountry: 'XX' })).toMatchObject({
      ok: false,
      rejection: 'no_country_code',
    });
  });
});

describe('auditPhones', () => {
  it('buckets a list the way the campaign preview needs it', () => {
    const audit = auditPhones(
      [
        { phone: '+919893009057', ref: 'a' }, // clean
        { phone: '9831023021', ref: 'b' }, // repaired: country code
        { phone: '+91 98674 50450', ref: 'c' }, // repaired: formatting
        { phone: '9.18319E+11', ref: 'd' }, // rejected
        { phone: '329', ref: 'e' }, // rejected
      ],
      IN,
    );

    expect(audit.clean.map((r) => r.ref)).toEqual(['a']);
    expect(audit.repaired.map((r) => r.ref)).toEqual(['b', 'c']);
    expect(audit.rejected.map((r) => r.ref)).toEqual(['d', 'e']);
    expect(audit.rejectionCounts.excel_scientific).toBe(1);
    expect(audit.rejectionCounts.too_short).toBe(1);
  });

  it('finds duplicates only visible after cleaning', () => {
    // The same person, written three ways. Without normalising first they
    // look like three recipients and get three messages.
    const audit = auditPhones(
      [
        { phone: '9893009057', ref: 'a' },
        { phone: '+91 98930 09057', ref: 'b' },
        { phone: '00919893009057', ref: 'c' },
      ],
      IN,
    );

    expect(audit.duplicates.map((r) => r.ref)).toEqual(['b', 'c']);
    expect(audit.clean.length + audit.repaired.length).toBe(1);
  });

  it('keeps every input in rows, in order, whatever the verdict', () => {
    const audit = auditPhones([{ phone: 'x' }, { phone: '9831023021' }], IN);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0].ok).toBe(false);
    expect(audit.rows[1].ok).toBe(true);
  });
});
