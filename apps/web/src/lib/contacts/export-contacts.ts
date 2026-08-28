// ============================================================
// Excel export for the Contacts page — the write-side counterpart to
// parse-contact-xlsx.ts's read side.
//
// Column names for the five re-importable fields (Phone/Name/Email/
// Company/Tags) deliberately match what parseContactCsv /
// parseContactXlsx already recognize (case-insensitively), so a file
// exported here, edited, and re-imported round-trips cleanly. Status/
// Source/Lists/Created At are extra informational columns the import
// parser simply ignores (it only looks up the columns it knows).
//
// `xlsx` is dynamically imported so it isn't part of the Contacts
// page's initial bundle — only loaded when an export actually runs.
// ============================================================

import type { Contact } from '@/types';

export interface ContactExportRow {
  Name: string;
  Phone: string;
  Email: string;
  Company: string;
  Status: 'active' | 'inactive';
  Source: string;
  Tags: string;
  Lists: string;
  'Created At': string;
}

/** Contact + hydrated tag/list names → one export row. Pure — easy to test. */
export function buildContactExportRow(
  contact: Contact,
  tagNames: string[],
  listNames: string[]
): ContactExportRow {
  return {
    Name: contact.name ?? '',
    Phone: contact.phone,
    Email: contact.email ?? '',
    Company: contact.company ?? '',
    Status: contact.is_active === false ? 'inactive' : 'active',
    Source: contact.source ?? 'manual',
    Tags: tagNames.join(', '),
    Lists: listNames.join(', '),
    'Created At': contact.created_at,
  };
}

/** Build the workbook and trigger a browser download. */
export async function exportContactsToExcel(
  rows: ContactExportRow[],
  filename: string
): Promise<void> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.json_to_sheet(rows);
  // Fixed column widths (character count) so phone numbers and emails
  // aren't clipped to Excel's narrow default column width.
  sheet['!cols'] = [
    { wch: 20 }, // Name
    { wch: 16 }, // Phone
    { wch: 26 }, // Email
    { wch: 18 }, // Company
    { wch: 10 }, // Status
    { wch: 12 }, // Source
    { wch: 28 }, // Tags
    { wch: 24 }, // Lists
    { wch: 20 }, // Created At
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
  XLSX.writeFile(workbook, filename);
}

/** `contacts-2026-08-28.xlsx` — today's date, so repeat exports don't collide. */
export function contactExportFilename(): string {
  return `contacts-${new Date().toISOString().slice(0, 10)}.xlsx`;
}
