// ============================================================
// Contacts-page filter model.
//
// One plain object describes every filter the Contacts page can apply
// (search, active status, tags, lists, source, a custom-field rule and
// a created-date range). `toFilterContactsParams` maps it onto the
// `filter_contacts` RPC (migration 049) so the page, the URL and the
// filter bar all speak the same shape — and the mapping is testable
// without a browser.
// ============================================================

import type { ContactSource } from '@wacrm/shared/types';

export type ContactStatusFilter = 'all' | 'active' | 'inactive';

export type CustomFieldOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'is_set'
  | 'is_empty';

export const CUSTOM_FIELD_OPERATORS: CustomFieldOperator[] = [
  'is',
  'is_not',
  'contains',
  'is_set',
  'is_empty',
];

/** Operators that do not take a value. */
export function operatorNeedsValue(op: CustomFieldOperator): boolean {
  return op !== 'is_set' && op !== 'is_empty';
}

export type CreatedRangePreset = 'any' | '7d' | '30d' | '90d' | 'custom';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface ContactFilters {
  search: string;
  status: ContactStatusFilter;
  tagIds: string[];
  listIds: string[];
  sources: ContactSource[];
  customField: CustomFieldFilter | null;
  created: {
    preset: CreatedRangePreset;
    /** ISO dates (YYYY-MM-DD), only read when preset === 'custom'. */
    from?: string;
    to?: string;
  };
}

export const EMPTY_FILTERS: ContactFilters = {
  search: '',
  status: 'all',
  tagIds: [],
  listIds: [],
  sources: [],
  customField: null,
  created: { preset: 'any' },
};

/** True when the custom-field filter is complete enough to apply. */
export function isCustomFieldFilterActive(
  cf: CustomFieldFilter | null
): cf is CustomFieldFilter {
  if (!cf || !cf.fieldId) return false;
  if (!operatorNeedsValue(cf.operator)) return true;
  return cf.value.trim().length > 0;
}

/** Number of filter dimensions currently narrowing the list (search excluded). */
export function countActiveFilters(f: ContactFilters): number {
  let n = 0;
  if (f.status !== 'all') n++;
  if (f.tagIds.length > 0) n++;
  if (f.listIds.length > 0) n++;
  if (f.sources.length > 0) n++;
  if (isCustomFieldFilterActive(f.customField)) n++;
  if (createdRange(f.created) !== null) n++;
  return n;
}

export function hasAnyFilter(f: ContactFilters): boolean {
  return f.search.trim().length > 0 || countActiveFilters(f) > 0;
}

/**
 * Resolve the created-date filter to an inclusive-from / exclusive-to
 * pair of ISO timestamps, or null when it doesn't narrow anything.
 * `now` is injectable for tests.
 */
export function createdRange(
  created: ContactFilters['created'],
  now: Date = new Date()
): { from: string | null; to: string | null } | null {
  switch (created.preset) {
    case 'any':
      return null;
    case '7d':
    case '30d':
    case '90d': {
      const days = created.preset === '7d' ? 7 : created.preset === '30d' ? 30 : 90;
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      return { from: from.toISOString(), to: null };
    }
    case 'custom': {
      const from = created.from ? new Date(`${created.from}T00:00:00`) : null;
      // "to" is a calendar day — include the whole day by moving to the
      // next midnight and letting the RPC compare with `<`.
      const to = created.to ? new Date(`${created.to}T00:00:00`) : null;
      if (to) to.setDate(to.getDate() + 1);
      const fromOk = from && !Number.isNaN(from.getTime());
      const toOk = to && !Number.isNaN(to.getTime());
      if (!fromOk && !toOk) return null;
      return {
        from: fromOk ? from.toISOString() : null,
        to: toOk ? to.toISOString() : null,
      };
    }
  }
}

// A type alias (not an interface) so it satisfies supabase-js's
// Record<string, unknown> RPC-args constraint without a cast.
export type FilterContactsParams = {
  p_search: string | null;
  p_active: boolean | null;
  p_tag_ids: string[] | null;
  p_list_ids: string[] | null;
  p_sources: string[] | null;
  p_custom_field_id: string | null;
  p_custom_op: CustomFieldOperator;
  p_custom_value: string | null;
  p_created_from: string | null;
  p_created_to: string | null;
  p_limit: number;
  p_offset: number;
};

/** Map the UI filter object onto the `filter_contacts` RPC arguments. */
export function toFilterContactsParams(
  f: ContactFilters,
  page: { limit: number; offset: number },
  now: Date = new Date()
): FilterContactsParams {
  const term = f.search.trim();
  const range = createdRange(f.created, now);
  const cf = isCustomFieldFilterActive(f.customField) ? f.customField : null;
  return {
    p_search: term || null,
    p_active: f.status === 'all' ? null : f.status === 'active',
    p_tag_ids: f.tagIds.length > 0 ? f.tagIds : null,
    p_list_ids: f.listIds.length > 0 ? f.listIds : null,
    p_sources: f.sources.length > 0 ? f.sources : null,
    p_custom_field_id: cf ? cf.fieldId : null,
    p_custom_op: cf ? cf.operator : 'is',
    p_custom_value: cf && operatorNeedsValue(cf.operator) ? cf.value.trim() : null,
    p_created_from: range?.from ?? null,
    p_created_to: range?.to ?? null,
    p_limit: page.limit,
    p_offset: page.offset,
  };
}
