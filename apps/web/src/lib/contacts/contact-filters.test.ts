import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTERS,
  countActiveFilters,
  createdRange,
  hasAnyFilter,
  isCustomFieldFilterActive,
  toFilterContactsParams,
  type ContactFilters,
} from './contact-filters';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const PAGE = { limit: 25, offset: 50 };

describe('toFilterContactsParams', () => {
  it('maps empty filters to all-null dimensions', () => {
    expect(toFilterContactsParams(EMPTY_FILTERS, PAGE, NOW)).toEqual({
      p_search: null,
      p_active: null,
      p_tag_ids: null,
      p_list_ids: null,
      p_sources: null,
      p_custom_field_id: null,
      p_custom_op: 'is',
      p_custom_value: null,
      p_created_from: null,
      p_created_to: null,
      p_limit: 25,
      p_offset: 50,
    });
  });

  it('trims search and maps status to a boolean', () => {
    const f: ContactFilters = { ...EMPTY_FILTERS, search: '  jane ', status: 'inactive' };
    const p = toFilterContactsParams(f, PAGE, NOW);
    expect(p.p_search).toBe('jane');
    expect(p.p_active).toBe(false);
    expect(toFilterContactsParams({ ...f, status: 'active' }, PAGE, NOW).p_active).toBe(true);
  });

  it('passes tag / list / source arrays only when non-empty', () => {
    const f: ContactFilters = {
      ...EMPTY_FILTERS,
      tagIds: ['t1'],
      listIds: ['l1', 'l2'],
      sources: ['import'],
    };
    const p = toFilterContactsParams(f, PAGE, NOW);
    expect(p.p_tag_ids).toEqual(['t1']);
    expect(p.p_list_ids).toEqual(['l1', 'l2']);
    expect(p.p_sources).toEqual(['import']);
  });

  it('ignores an incomplete custom-field filter', () => {
    const f: ContactFilters = {
      ...EMPTY_FILTERS,
      customField: { fieldId: 'cf', operator: 'is', value: '   ' },
    };
    const p = toFilterContactsParams(f, PAGE, NOW);
    expect(p.p_custom_field_id).toBeNull();
    expect(isCustomFieldFilterActive(f.customField)).toBe(false);
  });

  it('sends value-less operators without a value', () => {
    const f: ContactFilters = {
      ...EMPTY_FILTERS,
      customField: { fieldId: 'cf', operator: 'is_set', value: 'ignored' },
    };
    const p = toFilterContactsParams(f, PAGE, NOW);
    expect(p.p_custom_field_id).toBe('cf');
    expect(p.p_custom_op).toBe('is_set');
    expect(p.p_custom_value).toBeNull();
  });

  it('resolves relative created presets against now', () => {
    const f: ContactFilters = { ...EMPTY_FILTERS, created: { preset: '7d' } };
    const p = toFilterContactsParams(f, PAGE, NOW);
    expect(p.p_created_from).toBe('2026-08-18T12:00:00.000Z');
    expect(p.p_created_to).toBeNull();
  });
});

describe('createdRange', () => {
  it('returns null for "any" and for an empty custom range', () => {
    expect(createdRange({ preset: 'any' }, NOW)).toBeNull();
    expect(createdRange({ preset: 'custom' }, NOW)).toBeNull();
    expect(createdRange({ preset: 'custom', from: 'nope' }, NOW)).toBeNull();
  });

  it('makes the custom "to" day inclusive by bumping to the next midnight', () => {
    const r = createdRange({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }, NOW);
    expect(r).not.toBeNull();
    const from = new Date(r!.from!);
    const to = new Date(r!.to!);
    expect(from.getDate()).toBe(1);
    expect(to.getMonth()).toBe(1); // Feb 1 local
    expect(to.getDate()).toBe(1);
  });
});

describe('countActiveFilters / hasAnyFilter', () => {
  it('counts each narrowing dimension once and excludes search', () => {
    const f: ContactFilters = {
      search: 'x',
      status: 'active',
      tagIds: ['a', 'b'],
      listIds: [],
      sources: ['api'],
      customField: { fieldId: 'cf', operator: 'contains', value: 'v' },
      created: { preset: '30d' },
    };
    expect(countActiveFilters(f)).toBe(5);
    expect(hasAnyFilter(f)).toBe(true);
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, search: ' q ' })).toBe(true);
  });
});
