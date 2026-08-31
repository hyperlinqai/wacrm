'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, ListChecks, Pencil, Trash2, Filter, Check, X, Radio } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  createList,
  fetchListsWithCounts,
  type ContactListWithCount,
} from '@/lib/contacts/lists-api';

export const LIST_COLORS = [
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#f97316',
  '#ef4444',
  '#ec4899',
];

interface ListManagerProps {
  /** Bumped by the parent whenever memberships changed elsewhere. */
  refreshKey?: number;
  /** "Show contacts in this list" — hands the id back to the page filter. */
  onViewContacts: (listId: string) => void;
  /** Lists were created/renamed/deleted — parent should reload its copy. */
  onChanged: () => void;
}

/**
 * The Lists tab: a card per list with its member count, plus inline
 * create, rename and delete. Membership itself is managed from the
 * contacts table (bulk bar) and the import modal, not here.
 */
export function ListManager({ refreshKey = 0, onViewContacts, onChanged }: ListManagerProps) {
  const t = useTranslations('Contacts.lists');
  const router = useRouter();
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canEdit = useCan('send-messages');

  const [lists, setLists] = useState<ContactListWithCount[]>([]);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(LIST_COLORS[0]);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ContactListWithCount | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLists(await fetchListsWithCounts(supabase));
    } catch (err) {
      console.error('[lists] load failed:', err);
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || !user || !accountId) return;
    setCreating(true);
    try {
      await createList(supabase, { userId: user.id, accountId, name, color: newColor });
      toast.success(t('toastCreated', { name }));
      setNewName('');
      await load();
      onChanged();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      toast.error(code === '23505' ? t('toastDuplicate', { name }) : t('toastCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(list: ContactListWithCount) {
    setEditingId(list.id);
    setEditName(list.name);
  }

  async function saveEdit() {
    const name = editName.trim();
    if (!editingId || !name) return;
    setSavingEdit(true);
    const { error } = await supabase
      .from('contact_lists')
      .update({ name })
      .eq('id', editingId);
    setSavingEdit(false);
    if (error) {
      toast.error(error.code === '23505' ? t('toastDuplicate', { name }) : t('toastUpdateFailed'));
      return;
    }
    setEditingId(null);
    await load();
    onChanged();
  }

  async function setColor(list: ContactListWithCount, color: string) {
    const { error } = await supabase.from('contact_lists').update({ color }).eq('id', list.id);
    if (error) {
      toast.error(t('toastUpdateFailed'));
      return;
    }
    setLists((prev) => prev.map((l) => (l.id === list.id ? { ...l, color } : l)));
    onChanged();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from('contact_lists').delete().eq('id', deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast.error(t('toastDeleteFailed'));
      return;
    }
    toast.success(t('toastDeleted', { name: deleteTarget.name }));
    setDeleteTarget(null);
    await load();
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium text-foreground">{t('createTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{t('createDesc')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
            placeholder={t('namePlaceholder')}
            maxLength={60}
            disabled={creating || !canEdit}
            className="min-w-[200px] flex-1 bg-background border-border"
          />
          <div className="flex gap-1.5">
            {LIST_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={newColor === c}
                onClick={() => setNewColor(c)}
                className={cn(
                  'size-6 rounded-md transition-transform hover:scale-110',
                  newColor === c && 'outline outline-2 outline-offset-2 outline-primary'
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <GatedButton
            canAct={canEdit}
            gateReason="manage contact lists"
            variant="outline"
            size="sm"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('createBtn')}
          </GatedButton>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : lists.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <ListChecks className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((list) => (
            <div
              key={list.id}
              className="group rounded-lg border border-border bg-card p-4 flex flex-col gap-3"
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: list.color }}
                />
                <div className="min-w-0 flex-1">
                  {editingId === list.id ? (
                    <div className="flex items-center gap-1">
                      <Input
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="h-8 bg-background border-border"
                      />
                      <Button size="icon-sm" variant="ghost" onClick={saveEdit} disabled={savingEdit}>
                        {savingEdit ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <p className="truncate text-sm font-medium text-foreground">{list.name}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('memberCount', { count: list.member_count })}
                  </p>
                </div>
              </div>

              {/* Wraps rather than spilling out of the card. Every Button is
                  `shrink-0 whitespace-nowrap`, and the eight swatches are
                  fixed-size — so on a three-column grid this row wanted
                  ~436px inside a ~339px card and simply overflowed. The
                  swatches are invisible until hover but still occupy their
                  ~140px, which made the actions look like they escaped for
                  no reason. `mt-auto` also pins the row to the bottom so
                  footers line up across cards with different name lengths. */}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
                <div className="flex gap-1">
                  {LIST_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setColor(list, c)}
                      aria-label={`Set colour ${c}`}
                      className={cn(
                        'size-3.5 rounded-sm opacity-0 transition-opacity group-hover:opacity-100 disabled:hidden',
                        list.color === c && 'opacity-100 outline outline-1 outline-offset-1 outline-primary'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onViewContacts(list.id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Filter className="size-3.5" />
                    {t('viewContacts')}
                  </Button>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={list.member_count === 0}
                      title={list.member_count === 0 ? t('runCampaignEmpty') : undefined}
                      onClick={() => router.push(`/broadcasts/new?listId=${list.id}`)}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      <Radio className="size-3.5" />
                      {t('runCampaign')}
                    </Button>
                  )}
                  {canEdit && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startEdit(list)}
                        aria-label={t('rename')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeleteTarget(list)}
                        aria-label={t('delete')}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {deleteTarget
                ? t('deleteDesc', { name: deleteTarget.name, count: deleteTarget.member_count })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
