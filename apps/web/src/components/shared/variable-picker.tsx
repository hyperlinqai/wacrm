'use client'

import { Braces, ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { VariableGroup, VariableItem } from '@wacrm/shared/messaging/variables'

interface VariablePickerProps {
  groups: VariableGroup[]
  /** Called with the token to insert (e.g. "{{contact.name}}"). */
  onInsert: (token: string) => void
  /** Optional per-item preview of the resolved value (inbox composer). */
  preview?: (item: VariableItem) => string | undefined
  disabled?: boolean
  size?: 'sm' | 'xs'
  className?: string
}

/**
 * "Insert variable" dropdown shared by every text-drafting surface.
 * Purely presentational: the caller decides what the catalog contains
 * (see buildVariableCatalog) and where the token goes (insertAtSelection).
 */
export function VariablePicker({
  groups,
  onInsert,
  preview,
  disabled,
  size = 'xs',
  className,
}: VariablePickerProps) {
  const t = useTranslations('Variables')
  const nonEmpty = groups.filter((g) => g.items.length > 0)
  if (nonEmpty.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        title={t('insertVariableTitle')}
        className={`inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2 font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
          size === 'sm' ? 'h-8 text-xs' : 'h-7 text-[11px]'
        } ${className ?? ''}`}
      >
        <Braces className="size-3.5" />
        {t('insertVariable')}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto border-border bg-popover">
        {nonEmpty.map((group, gi) => (
          <DropdownMenuGroup key={group.id}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t(`groups.${group.id}`)}
            </DropdownMenuLabel>
            {group.items.map((item) => {
              const label = item.label ?? t(`items.${item.labelKey}`)
              const value = preview?.(item)
              return (
                <DropdownMenuItem
                  key={item.token}
                  onSelect={() => onInsert(item.token)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-sm text-foreground">{label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {value !== undefined && value !== '' ? value : item.token}
                  </span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
