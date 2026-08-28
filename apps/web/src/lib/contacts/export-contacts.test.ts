import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

// XLSX.writeFile writes to disk under Node (no DOM to trigger a browser
// download). ESM module namespaces aren't configurable, so vi.spyOn can't
// redefine it directly — vi.mock's factory is the supported way to swap
// one export while keeping the rest real, for both static and the
// dynamic `import('xlsx')` exportContactsToExcel uses internally.
// vi.mock is hoisted above regular top-level code, so the mock fn it
// references must be declared through vi.hoisted, not a plain const.
const { writeFileMock } = vi.hoisted(() => ({ writeFileMock: vi.fn() }));
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<typeof XLSX>();
  return { ...actual, writeFile: writeFileMock };
});

import { buildContactExportRow, contactExportFilename, exportContactsToExcel } from './export-contacts';
import type { Contact } from '@/types';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1',
    user_id: 'u1',
    account_id: 'a1',
    phone: '+15551234567',
    name: 'Jane Doe',
    email: 'jane@example.com',
    company: 'Acme',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    is_active: true,
    source: 'manual',
    ...overrides,
  };
}

describe('buildContactExportRow', () => {
  it('maps a contact plus tag/list names onto Title-Case columns', () => {
    const row = buildContactExportRow(makeContact(), ['Lead', 'VIP'], ['Newsletter']);
    expect(row).toEqual({
      Name: 'Jane Doe',
      Phone: '+15551234567',
      Email: 'jane@example.com',
      Company: 'Acme',
      Status: 'active',
      Source: 'manual',
      Tags: 'Lead, VIP',
      Lists: 'Newsletter',
      'Created At': '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports inactive when is_active is false, and defaults missing fields to empty strings', () => {
    const row = buildContactExportRow(
      makeContact({ name: undefined, email: undefined, company: undefined, is_active: false, source: undefined }),
      [],
      []
    );
    expect(row.Status).toBe('inactive');
    expect(row.Source).toBe('manual');
    expect(row.Name).toBe('');
    expect(row.Email).toBe('');
    expect(row.Company).toBe('');
    expect(row.Tags).toBe('');
    expect(row.Lists).toBe('');
  });

  it('treats a missing is_active as active (matches the DB default)', () => {
    const row = buildContactExportRow(makeContact({ is_active: undefined }), [], []);
    expect(row.Status).toBe('active');
  });
});

describe('contactExportFilename', () => {
  it('produces a dated .xlsx filename', () => {
    expect(contactExportFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

describe('exportContactsToExcel', () => {
  it('writes a workbook whose header row matches what the import parser recognizes', async () => {
    writeFileMock.mockClear();

    const row = buildContactExportRow(makeContact(), ['Lead'], ['VIP List']);
    await exportContactsToExcel([row], 'contacts-2026-01-01.xlsx');

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [workbook, filename] = writeFileMock.mock.calls[0];
    expect(filename).toBe('contacts-2026-01-01.xlsx');

    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Contacts']);
    expect(parsed).toEqual([
      {
        Name: 'Jane Doe',
        Phone: '+15551234567',
        Email: 'jane@example.com',
        Company: 'Acme',
        Status: 'active',
        Source: 'manual',
        Tags: 'Lead',
        Lists: 'VIP List',
        'Created At': '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});
