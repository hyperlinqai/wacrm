import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { parseContactCsv } from './parse-contact-csv';
import { isExcelFilename, parseContactXlsx } from './parse-contact-xlsx';

/** Build an .xlsx ArrayBuffer from a grid of cells, mirroring what a user's export would look like. */
function buildWorkbook(rows: unknown[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('parseContactXlsx', () => {
  it('parses phone/name/email/company/tags columns like the CSV path', async () => {
    const buf = buildWorkbook([
      ['phone', 'name', 'email', 'company', 'tags'],
      ['+15551234567', 'Jane Doe', 'jane@example.com', 'Acme', 'lead, vip'],
      ['+15557654321', 'John Smith', '', '', ''],
    ]);

    const result = await parseContactXlsx(buf);
    expect(result.hasTagsColumn).toBe(true);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.rows).toEqual([
      {
        phone: '+15551234567',
        name: 'Jane Doe',
        email: 'jane@example.com',
        company: 'Acme',
        tagNames: ['lead', 'vip'],
      },
      { phone: '+15557654321', name: 'John Smith', email: undefined, company: undefined, tagNames: [] },
    ]);
  });

  it('matches headers case-insensitively and skips rows with no phone', async () => {
    const buf = buildWorkbook([
      ['Phone', 'Name'],
      ['', 'No phone here'],
      ['+15550001111', 'Has phone'],
    ]);

    const result = await parseContactXlsx(buf);
    expect(result.rows).toEqual([{ phone: '+15550001111', name: 'Has phone', email: undefined, company: undefined, tagNames: [] }]);
  });

  it('returns no rows when the phone column is missing', async () => {
    const buf = buildWorkbook([
      ['name', 'email'],
      ['Jane Doe', 'jane@example.com'],
    ]);
    const result = await parseContactXlsx(buf);
    expect(result.rows).toEqual([]);
  });

  it('returns no rows for a header-only sheet', async () => {
    const buf = buildWorkbook([['phone', 'name']]);
    const result = await parseContactXlsx(buf);
    expect(result.rows).toEqual([]);
  });

  it('produces the same rows as parseContactCsv for equivalent input', async () => {
    const csv = 'phone,name,email,tags\n+15551234567,Jane Doe,jane@example.com,"lead;vip"';
    const buf = buildWorkbook([
      ['phone', 'name', 'email', 'tags'],
      ['+15551234567', 'Jane Doe', 'jane@example.com', 'lead;vip'],
    ]);

    const csvResult = parseContactCsv(csv);
    const xlsxResult = await parseContactXlsx(buf);
    expect(xlsxResult.rows).toEqual(csvResult.rows);
  });
});

describe('isExcelFilename', () => {
  it('matches .xlsx and .xls, case-insensitively', () => {
    expect(isExcelFilename('contacts.xlsx')).toBe(true);
    expect(isExcelFilename('Contacts.XLS')).toBe(true);
    expect(isExcelFilename('contacts.csv')).toBe(false);
    expect(isExcelFilename('contacts.xlsx.csv')).toBe(false);
  });
});
