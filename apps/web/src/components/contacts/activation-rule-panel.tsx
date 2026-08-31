'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Users, ListChecks, Tag as TagIcon, Save, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type {
  ContactActivationMode,
  ContactActivationRule,
  ContactList,
  Tag,
} from '@wacrm/shared/types';

interface ActivationRulePanelProps {
  tags: Tag[];
  lists: ContactList[];
  /** Admin-only writes (RLS enforces it too). */
  canEdit: boolean;
  /** Rule saved — parent should refetch contacts so the status column updates. */
  onSaved: () => void;
}

interface Draft {
  mode: ContactActivationMode;
  listIds: string[];
  tagIds: string[];
}

/**
 * "Active contacts" settings: choose whether every contact is active
 * (default), only members of selected lists, or only holders of
 * selected tags. Shows a live "N of M would be active" preview
 * (RPC preview_activation_rule) before saving; the DB triggers
 * (migration 049) recompute every contact's is_active on save.
 */
export function ActivationRulePanel({ tags, lists, canEdit, onSaved }: ActivationRulePanelProps) {
  const t = useTranslations('Contacts.activation');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Draft>({ mode: 'everyone', listIds: [], tagIds: [] });
  const [draft, setDraft] = useState<Draft>({ mode: 'everyone', listIds: [], tagIds: [] });
  const [preview, setPreview] = useState<{ total: number; active: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('contact_activation_rules')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const rule = data as ContactActivationRule | null;
      const next: Draft = rule
        ? { mode: rule.mode, listIds: rule.list_ids ?? [], tagIds: rule.tag_ids ?? [] }
        : { mode: 'everyone', listIds: [], tagIds: [] };
      setSaved(next);
      setDraft(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const fetchPreview = useCallback(async () => {
    setPreviewing(true);
    const { data, error } = await supabase.rpc('preview_activation_rule', {
      p_mode: draft.mode,
      p_list_ids: draft.listIds,
      p_tag_ids: draft.tagIds,
    });
    setPreviewing(false);
    if (error) {
      setPreview(null);
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { total_count: number; active_count: number }
      | undefined;
    if (row) setPreview({ total: Number(row.total_count), active: Number(row.active_count) });
  }, [supabase, draft]);

  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPreview();
  }, [fetchPreview, loading]);

  const dirty =
    draft.mode !== saved.mode ||
    draft.listIds.join(',') !== saved.listIds.join(',') ||
    draft.tagIds.join(',') !== saved.tagIds.join(',');

  const incomplete =
    (draft.mode === 'lists' && draft.listIds.length === 0) ||
    (draft.mode === 'tags' && draft.tagIds.length === 0);

  async function save() {
    if (!user || !accountId) return;
    setSaving(true);
    const { error } = await supabase.from('contact_activation_rules').upsert(
      {
        account_id: accountId,
        mode: draft.mode,
        list_ids: draft.mode === 'lists' ? draft.listIds : [],
        tag_ids: draft.mode === 'tags' ? draft.tagIds : [],
        updated_by: user.id,
      },
      { onConflict: 'organization_id' }
    );
    setSaving(false);
    if (error) {
      console.error('[activation] save failed:', error);
      toast.error(t('toastSaveFailed'));
      return;
    }
    const cleaned: Draft = {
      mode: draft.mode,
      listIds: draft.mode === 'lists' ? draft.listIds : [],
      tagIds: draft.mode === 'tags' ? draft.tagIds : [],
    };
    setSaved(cleaned);
    setDraft(cleaned);
    toast.success(t('toastSaved'));
    onSaved();
  }

  const modes: { mode: ContactActivationMode; icon: typeof Users; title: string; desc: string }[] = [
    { mode: 'everyone', icon: Users, title: t('modeEveryone'), desc: t('modeEveryoneDesc') },
    { mode: 'lists', icon: ListChecks, title: t('modeLists'), desc: t('modeListsDesc') },
    { mode: 'tags', icon: TagIcon, title: t('modeTags'), desc: t('modeTagsDesc') },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-lg border border-border bg-muted/30 p-3 flex gap-2.5 text-xs text-muted-foreground leading-relaxed">
        <Info className="size-4 shrink-0 mt-0.5 text-primary" />
        <p>{t('explainer')}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {modes.map(({ mode, icon: Icon, title, desc }) => (
          <button
            key={mode}
            type="button"
            disabled={!canEdit}
            onClick={() => setDraft((d) => ({ ...d, mode }))}
            className={cn(
              'rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed',
              draft.mode === mode
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/40'
            )}
          >
            <Icon className={cn('size-5', draft.mode === mode ? 'text-primary' : 'text-muted-foreground')} />
            <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
          </button>
        ))}
      </div>

      {draft.mode === 'lists' && (
        <PickList
          title={t('pickLists')}
          empty={t('noLists')}
          items={lists.map((l) => ({ id: l.id, name: l.name, color: l.color, square: true }))}
          selected={draft.listIds}
          disabled={!canEdit}
          onToggle={(id) =>
            setDraft((d) => ({
              ...d,
              listIds: d.listIds.includes(id) ? d.listIds.filter((x) => x !== id) : [...d.listIds, id],
            }))
          }
        />
      )}
      {draft.mode === 'tags' && (
        <PickList
          title={t('pickTags')}
          empty={t('noTags')}
          items={tags.map((x) => ({ id: x.id, name: x.name, color: x.color }))}
          selected={draft.tagIds}
          disabled={!canEdit}
          onToggle={(id) =>
            setDraft((d) => ({
              ...d,
              tagIds: d.tagIds.includes(id) ? d.tagIds.filter((x) => x !== id) : [...d.tagIds, id],
            }))
          }
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div className="text-sm">
          {previewing && !preview ? (
            <span className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> {t('previewLoading')}
            </span>
          ) : preview ? (
            <>
              <span className="font-semibold text-foreground">
                {t('previewCount', { active: preview.active, total: preview.total })}
              </span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                {t('previewHint', { inactive: Math.max(0, preview.total - preview.active) })}
              </span>
            </>
          ) : null}
        </div>
        <Button
          onClick={save}
          disabled={!canEdit || !dirty || incomplete || saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {t('saveBtn')}
        </Button>
      </div>
      {!canEdit && <p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
    </div>
  );
}

function PickList({
  title,
  empty,
  items,
  selected,
  disabled,
  onToggle,
}: {
  title: string;
  empty: string;
  items: { id: string; name: string; color: string; square?: boolean }[];
  selected: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <p className="px-4 py-2.5 text-sm font-medium text-foreground border-b border-border">{title}</p>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground text-center">{empty}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto py-1">
          {items.map((it) => (
            <label
              key={it.id}
              className={cn(
                'flex items-center gap-2.5 px-4 py-2 hover:bg-muted/40',
                disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
              )}
            >
              <Checkbox
                checked={selected.includes(it.id)}
                disabled={disabled}
                onCheckedChange={() => onToggle(it.id)}
                aria-label={it.name}
              />
              <span
                className={cn('size-2.5 shrink-0', it.square ? 'rounded-sm' : 'rounded-full')}
                style={{ backgroundColor: it.color }}
              />
              <span className="text-sm text-foreground truncate">{it.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
