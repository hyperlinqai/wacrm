/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the header row includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the header row includes a `company` column. */
  hasCompanyColumn: boolean;
}

/**
 * Shared row-mapping core for both the CSV and Excel import paths — each
 * format only differs in how it turns raw file bytes into a header row
 * plus a grid of string cells; column detection (phone required; name,
 * email, company, tags optional, matched case-insensitively) and tag-cell
 * splitting are identical either way, so this is the single source of
 * truth for "what counts as a valid contact row."
 */
export function mapHeaderedRowsToContacts(
  headerRow: string[],
  dataRows: string[][]
): ParseContactCsvResult {
  const headers = headerRow.map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  const clean = (v: string | undefined) => v?.replace(/["']/g, '').trim();

  const rows: ParsedContactRow[] = [];
  for (const values of dataRows) {
    const phone = clean(values[phoneIdx]);
    if (!phone) continue;

    rows.push({
      phone,
      name: nameIdx >= 0 ? clean(values[nameIdx]) || undefined : undefined,
      email: emailIdx >= 0 ? clean(values[emailIdx]) || undefined : undefined,
      company: companyIdx >= 0 ? clean(values[companyIdx]) || undefined : undefined,
      tagNames: tagsIdx >= 0 ? parseTagCell(clean(values[tagsIdx])) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const dataRows = lines.slice(1).filter((l) => l.trim()).map(parseCsvLine);
  return mapHeaderedRowsToContacts(parseCsvLine(lines[0]), dataRows);
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
