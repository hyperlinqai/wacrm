'use client';

import { Pin } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import type { Contact } from '@wacrm/shared/types';

/**
 * Active / Inactive pill for a contact. A pin icon marks a manual
 * override (the contact is not following the organization rule).
 */
export function ContactStatusBadge({
  contact,
  className,
}: {
  contact: Pick<Contact, 'is_active' | 'activation_override'>;
  className?: string;
}) {
  const t = useTranslations('Contacts.status');
  const active = contact.is_active !== false;
  const pinned = !!contact.activation_override;
  return (
    <span
      title={pinned ? t('pinnedHint') : t('ruleHint')}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
        active
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground',
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-muted-foreground/60')} />
      {active ? t('active') : t('inactive')}
      {pinned && <Pin className="size-2.5 opacity-70" />}
    </span>
  );
}
