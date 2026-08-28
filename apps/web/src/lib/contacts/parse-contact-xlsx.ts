// ============================================================
// Excel (.xlsx / .xls) parsing for the contacts import modal — the
// Excel counterpart to parse-contact-csv.ts. Same column rules (a
// required `phone` header; optional name/email/company/tags), applied
// through the shared `mapHeaderedRowsToContacts` core so the two
// formats can never drift apart in what counts as a valid row.
//
// `xlsx` (SheetJS) is dynamically imported so it only loads once the
// import modal actually opens, not as part of the Contacts page's
// initial bundle — see import-modal.tsx.
// ============================================================

import type { ParseContactCsvResult } from './parse-contact-csv';
import { mapHeaderedRowsToContacts } from './parse-contact-csv';

export async function parseContactXlsx(
  data: ArrayBuffer
): Promise<ParseContactCsvResult> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(data, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };

  const sheet = workbook.Sheets[sheetName];
  // header: 1 → array-of-arrays (raw cells), not object-per-row keyed by
  // header text — mapHeaderedRowsToContacts already does that matching,
  // case-insensitively, the same way the CSV path does.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });
  if (grid.length < 2) return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };

  const asStrings = (row: unknown[]) => row.map((cell) => (cell == null ? '' : String(cell)));
  const [headerRow, ...dataRows] = grid;
  return mapHeaderedRowsToContacts(asStrings(headerRow), dataRows.map(asStrings));
}

/** True for a filename this parser should handle instead of CSV. */
export function isExcelFilename(filename: string): boolean {
  return /\.xlsx?$/i.test(filename);
}
