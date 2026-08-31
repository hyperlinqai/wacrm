'use client';

import { useMemo, type ReactNode } from 'react';
import {
  Search,
  Filter,
  Tag as TagIcon,
  ListChecks,
  SlidersHorizontal,
  CalendarDays,
  Activity,
  ChevronDown,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  CUSTOM_FIELD_OPERATORS,
  EMPTY_FILTERS,
  countActiveFilters,
  isCustomFieldFilterActive,
  operatorNeedsValue,
  type ContactFilters,
  type ContactStatusFilter,
  type CreatedRangePreset,
  type CustomFieldOperator,
} from '@/lib/contacts/contact-filters';
import {
  CONTACT_SOURCES,
  type ContactList,
  type ContactSource,
  type CustomField,
  type Tag,
} from '@wacrm/shared/types';

interface ContactFilterBarProps {
  filters: ContactFilters;
  onChange: (next: ContactFilters) => void;
  tags: Tag[];
  lists: ContactList[];
  customFields: CustomField[];
}

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary';

/**
 * The filter strip above the contacts table: search + one popover per
 * dimension (status, source, tags, lists, custom field, created date),
 * followed by a chip row summarising what's applied. Purely
 * presentational — every change flows out through `onChange`.
 */
export function ContactFilterBar({
  filters,
  onChange,
  tags,
  lists,
  customFields,
}: ContactFilterBarProps) {
  const t = useTranslations('Contacts.filters');

  const tagById = useMemo(() => new Map(tags.map((x) => [x.id, x])), [tags]);
  const listById = useMemo(() => new Map(lists.map((x) => [x.id, x])), [lists]);
  const fieldById = useMemo(
    () => new Map(customFields.map((x) => [x.id, x])),
    [customFields]
  );

  const activeCount = countActiveFilters(filters);

  function patch(p: Partial<ContactFilters>) {
    onChange({ ...filters, ...p });
  }

  function toggleIn<T extends string>(arr: T[], id: T): T[] {
    return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
  }

  const sourceLabel = (s: ContactSource) => t(`sources.${s}`);
  const statusLabel = (s: ContactStatusFilter) => t(`status.${s}`);
  const operatorLabel = (op: CustomFieldOperator) => t(`operators.${op}`);
  const createdLabel = (p: CreatedRangePreset) => t(`created.${p}`);

  const cf = filters.customField;
  const cfActive = isCustomFieldFilterActive(cf);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative w-full sm:w-auto sm:min-w-[260px] sm:flex-1 sm:max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder={t('searchPlaceholder')}
            className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* Status */}
        <FilterPopover
          icon={<Activity className="size-4" />}
          label={filters.status === 'all' ? t('statusAll') : statusLabel(filters.status)}
          active={filters.status !== 'all'}
          width="w-52"
        >
          <div className="py-1">
            {(['all', 'active', 'inactive'] as ContactStatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => patch({ status: s })}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted/50',
                  filters.status === s ? 'text-foreground font-medium' : 'text-popover-foreground'
                )}
              >
                <span
                  className={cn(
                    'size-2 rounded-full',
                    s === 'active' && 'bg-emerald-500',
                    s === 'inactive' && 'bg-muted-foreground/50',
                    s === 'all' && 'bg-primary'
                  )}
                />
                {s === 'all' ? t('statusAll') : statusLabel(s)}
              </button>
            ))}
          </div>
          <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {t('statusHint')}
          </p>
        </FilterPopover>

        {/* Source / channel */}
        <FilterPopover
          icon={<Filter className="size-4" />}
          label={t('allSources')}
          count={filters.sources.length}
          active={filters.sources.length > 0}
          onClear={() => patch({ sources: [] })}
          title={t('sourceTitle')}
          width="w-56"
        >
          <div className="py-1">
            {CONTACT_SOURCES.map((s) => (
              <label
                key={s}
                className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
              >
                <Checkbox
                  checked={filters.sources.includes(s)}
                  onCheckedChange={() => patch({ sources: toggleIn(filters.sources, s) })}
                  aria-label={sourceLabel(s)}
                />
                <span className="text-sm text-popover-foreground">{sourceLabel(s)}</span>
              </label>
            ))}
          </div>
        </FilterPopover>

        {/* Tags */}
        <FilterPopover
          icon={<TagIcon className="size-4" />}
          label={t('tags')}
          count={filters.tagIds.length}
          active={filters.tagIds.length > 0}
          onClear={() => patch({ tagIds: [] })}
          title={t('tagsTitle')}
          width="w-64"
        >
          {tags.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground text-center">{t('noTags')}</p>
          ) : (
            <div className="max-h-64 overflow-y-auto py-1">
              {tags.map((tag) => (
                <label
                  key={tag.id}
                  className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    checked={filters.tagIds.includes(tag.id)}
                    onCheckedChange={() => patch({ tagIds: toggleIn(filters.tagIds, tag.id) })}
                    aria-label={`Filter by ${tag.name}`}
                  />
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="text-sm text-popover-foreground truncate">{tag.name}</span>
                </label>
              ))}
            </div>
          )}
        </FilterPopover>

        {/* Lists */}
        <FilterPopover
          icon={<ListChecks className="size-4" />}
          label={t('lists')}
          count={filters.listIds.length}
          active={filters.listIds.length > 0}
          onClear={() => patch({ listIds: [] })}
          title={t('listsTitle')}
          width="w-64"
        >
          {lists.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground text-center">{t('noLists')}</p>
          ) : (
            <div className="max-h-64 overflow-y-auto py-1">
              {lists.map((list) => (
                <label
                  key={list.id}
                  className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    checked={filters.listIds.includes(list.id)}
                    onCheckedChange={() => patch({ listIds: toggleIn(filters.listIds, list.id) })}
                    aria-label={`Filter by ${list.name}`}
                  />
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: list.color }} />
                  <span className="text-sm text-popover-foreground truncate">{list.name}</span>
                </label>
              ))}
            </div>
          )}
        </FilterPopover>

        {/* Custom field */}
        <FilterPopover
          icon={<SlidersHorizontal className="size-4" />}
          label={t('customField')}
          active={cfActive}
          onClear={() => patch({ customField: null })}
          title={t('customFieldTitle')}
          width="w-80"
        >
          {customFields.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground text-center">{t('noCustomFields')}</p>
          ) : (
            <div className="space-y-2 p-3">
              <select
                value={cf?.fieldId ?? ''}
                onChange={(e) =>
                  patch({
                    customField: {
                      fieldId: e.target.value,
                      operator: cf?.operator ?? 'is',
                      value: cf?.value ?? '',
                    },
                  })
                }
                className={SELECT_CLASS}
              >
                <option value="">{t('selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={cf?.operator ?? 'is'}
                onChange={(e) =>
                  patch({
                    customField: {
                      fieldId: cf?.fieldId ?? '',
                      operator: e.target.value as CustomFieldOperator,
                      value: cf?.value ?? '',
                    },
                  })
                }
                className={SELECT_CLASS}
              >
                {CUSTOM_FIELD_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {operatorLabel(op)}
                  </option>
                ))}
              </select>
              {operatorNeedsValue(cf?.operator ?? 'is') && (
                <Input
                  value={cf?.value ?? ''}
                  onChange={(e) =>
                    patch({
                      customField: {
                        fieldId: cf?.fieldId ?? '',
                        operator: cf?.operator ?? 'is',
                        value: e.target.value,
                      },
                    })
                  }
                  placeholder={t('valuePlaceholder')}
                  className="bg-muted border-border"
                />
              )}
            </div>
          )}
        </FilterPopover>

        {/* Created date */}
        <FilterPopover
          icon={<CalendarDays className="size-4" />}
          label={
            filters.created.preset === 'any' ? t('createdAny') : createdLabel(filters.created.preset)
          }
          active={filters.created.preset !== 'any'}
          onClear={() => patch({ created: { preset: 'any' } })}
          title={t('createdTitle')}
          width="w-64"
        >
          <div className="py-1">
            {(['any', '7d', '30d', '90d', 'custom'] as CreatedRangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => patch({ created: { ...filters.created, preset: p } })}
                className={cn(
                  'flex w-full px-3 py-1.5 text-sm text-left hover:bg-muted/50',
                  filters.created.preset === p ? 'text-foreground font-medium' : 'text-popover-foreground'
                )}
              >
                {p === 'any' ? t('createdAny') : createdLabel(p)}
              </button>
            ))}
          </div>
          {filters.created.preset === 'custom' && (
            <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
              <label className="space-y-1 text-[11px] text-muted-foreground">
                {t('from')}
                <Input
                  type="date"
                  value={filters.created.from ?? ''}
                  onChange={(e) => patch({ created: { ...filters.created, from: e.target.value } })}
                  className="bg-muted border-border text-foreground"
                />
              </label>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                {t('to')}
                <Input
                  type="date"
                  value={filters.created.to ?? ''}
                  onChange={(e) => patch({ created: { ...filters.created, to: e.target.value } })}
                  className="bg-muted border-border text-foreground"
                />
              </label>
            </div>
          )}
        </FilterPopover>

        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...EMPTY_FILTERS, search: filters.search })}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
            {t('clearAll')}
          </Button>
        )}
      </div>

      {/* Chip row */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.status !== 'all' && (
            <Chip
              onRemove={() => patch({ status: 'all' })}
              className={
                filters.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              }
            >
              {statusLabel(filters.status)}
            </Chip>
          )}
          {filters.sources.map((s) => (
            <Chip key={s} onRemove={() => patch({ sources: toggleIn(filters.sources, s) })}>
              {t('sourcePrefix')} {sourceLabel(s)}
            </Chip>
          ))}
          {filters.tagIds.map((id) => {
            const tag = tagById.get(id);
            if (!tag) return null;
            return (
              <Chip
                key={id}
                onRemove={() => patch({ tagIds: toggleIn(filters.tagIds, id) })}
                style={{ backgroundColor: tag.color + '20', color: tag.color }}
              >
                {tag.name}
              </Chip>
            );
          })}
          {filters.listIds.map((id) => {
            const list = listById.get(id);
            if (!list) return null;
            return (
              <Chip
                key={id}
                onRemove={() => patch({ listIds: toggleIn(filters.listIds, id) })}
                style={{ backgroundColor: list.color + '20', color: list.color }}
              >
                <ListChecks className="size-3" />
                {list.name}
              </Chip>
            );
          })}
          {cfActive && cf && (
            <Chip onRemove={() => patch({ customField: null })}>
              {fieldById.get(cf.fieldId)?.field_name ?? t('customField')}{' '}
              <span className="opacity-70">{operatorLabel(cf.operator).toLowerCase()}</span>
              {operatorNeedsValue(cf.operator) && ` “${cf.value.trim()}”`}
            </Chip>
          )}
          {filters.created.preset !== 'any' && (
            <Chip onRemove={() => patch({ created: { preset: 'any' } })}>
              <CalendarDays className="size-3" />
              {filters.created.preset === 'custom'
                ? `${filters.created.from || '…'} → ${filters.created.to || '…'}`
                : createdLabel(filters.created.preset)}
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}

function FilterPopover({
  icon,
  label,
  count,
  active,
  onClear,
  title,
  width,
  children,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClear?: () => void;
  title?: string;
  width: string;
  children: ReactNode;
}) {
  const t = useTranslations('Contacts.filters');
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className={cn(
              'border-border text-muted-foreground hover:bg-muted shrink-0',
              active && 'border-primary/50 text-foreground bg-primary/5'
            )}
          />
        }
      >
        {icon}
        {label}
        {count !== undefined && count > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {count}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('p-0', width)}>
        {(title || onClear) && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium text-popover-foreground">{title ?? label}</span>
            {onClear && active && (
              <button
                type="button"
                onClick={onClear}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('clear')}
              </button>
            )}
          </div>
        )}
        {children}
      </PopoverContent>
    </Popover>
  );
}

function Chip({
  children,
  onRemove,
  className,
  style,
}: {
  children: ReactNode;
  onRemove: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        !className && !style && 'bg-muted text-foreground',
        className
      )}
      style={style}
    >
      {children}
      <button type="button" onClick={onRemove} aria-label="Remove filter" className="hover:opacity-70">
        <X className="size-3" />
      </button>
    </span>
  );
}
