'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Tag as TagIcon, X, Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';
import {
  INDUSTRY_PRESETS,
  getIndustryPreset,
  missingPresetTags,
  type IndustryId,
} from '@/lib/presets/industry-presets';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

/**
 * Tags card — colour-coded contact labels. Creation is an inline row
 * (name + colour swatch + Add); deletion goes through a confirmation
 * dialog since it detaches the tag from every contact.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[3].value);

  // Starter packs — industry presets the user can add in one click.
  // Names already present (case-insensitive) are never duplicated.
  const [packOpen, setPackOpen] = useState(false);
  const [packIndustry, setPackIndustry] = useState<IndustryId>('general');
  const [packPicked, setPackPicked] = useState<Set<string>>(new Set());
  const [addingPack, setAddingPack] = useState(false);

  const packTags = getIndustryPreset(packIndustry).tags;
  const packMissing = missingPresetTags(packTags, tags.map((t) => t.name));
  const packMissingKeys = new Set(packMissing.map((t) => t.name.toLowerCase()));
  const packSelected = packMissing.filter((t) => packPicked.has(t.name.toLowerCase()));

  function openPack(industry: IndustryId) {
    setPackIndustry(industry);
    const missing = missingPresetTags(getIndustryPreset(industry).tags, tags.map((t) => t.name));
    setPackPicked(new Set(missing.map((t) => t.name.toLowerCase())));
    setPackOpen(true);
  }

  function togglePackTag(name: string) {
    const k = name.toLowerCase();
    setPackPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function handleAddPack() {
    if (!user || !accountId || packSelected.length === 0) return;
    setAddingPack(true);
    try {
      const { error } = await supabase.from('tags').insert(
        packSelected.map((t) => ({
          user_id: user.id,
          account_id: accountId,
          name: t.name,
          color: t.color,
        }))
      );
      if (error) throw error;
      toast.success(t('packAdded', { count: packSelected.length }));
      setPackOpen(false);
      await fetchTags(user.id);
    } catch (err) {
      console.error('Starter pack error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setAddingPack(false);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchTags(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchTags(userId: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('tags')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setTags(data || []);
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error(t('failedToLoadTags'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newTagName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    try {
      setSaving(true);
      if (!user || !accountId) {
        toast.error(t('notAuthenticated'));
        return;
      }

      // account_id is mandatory on every account-scoped insert (NOT
      // NULL + RLS, no DB default).
      const { error } = await supabase.from('tags').insert({
        user_id: user.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: selectedColor,
      });

      if (error) throw error;

      toast.success(t('tagCreated'));
      setNewTagName('');
      setSelectedColor(PRESET_COLORS[3].value);
      await fetchTags(user.id);
    } catch (err) {
      console.error('Create error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(tag: Tag) {
    setTagToDelete(tag);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!tagToDelete) return;

    try {
      setDeleting(true);
      const { error } = await supabase
        .from('tags')
        .delete()
        .eq('id', tagToDelete.id);

      if (error) throw error;

      toast.success(t('tagDeleted'));
      setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));
      setDeleteDialogOpen(false);
      setTagToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(t('failedToDeleteTag'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TagIcon className="size-4 text-primary" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                      border: `1px solid ${tag.color}40`,
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => confirmDelete(tag)}
                      aria-label={t('deleteAria', { name: tag.name })}
                      className="ml-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('noTags')}
              </p>
            )}

            {/* Inline create row */}
            <div className="flex flex-wrap items-center gap-2.5">
              <Input
                placeholder={t('placeholder')}
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                disabled={saving}
                maxLength={40}
                className="min-w-[180px] flex-1"
              />
              <div className="flex gap-1.5">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setSelectedColor(color.value)}
                    aria-label={t('useColor', { color: t(`colors.${color.name}` as Parameters<typeof t>[0]) })}
                    aria-pressed={selectedColor === color.value}
                    className={cn(
                      'size-6 rounded-md transition-transform hover:scale-110',
                      selectedColor === color.value &&
                        'outline outline-2 outline-offset-2 outline-primary',
                    )}
                    style={{ backgroundColor: color.value }}
                    title={t(`colors.${color.name}` as Parameters<typeof t>[0])}
                  />
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreate}
                disabled={saving || !newTagName.trim()}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {t('addTag')}
              </Button>
            </div>

            {/* Starter packs */}
            <div className="rounded-lg border border-dashed border-border p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Sparkles className="size-4 text-primary" />
                {t('packTitle')}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('packDesc')}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {INDUSTRY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => openPack(p.id)}
                    className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>

      {/* Starter pack picker */}
      <Dialog open={packOpen} onOpenChange={setPackOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              {t('packDialogTitle')}
            </DialogTitle>
            <DialogDescription>{t('packDialogDesc')}</DialogDescription>
          </DialogHeader>
          <select
            value={packIndustry}
            onChange={(e) => openPack(e.target.value as IndustryId)}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            {INDUSTRY_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto py-1">
            {packTags.map((pt) => {
              const k = pt.name.toLowerCase();
              const exists = !packMissingKeys.has(k);
              const picked = packPicked.has(k);
              return (
                <button
                  key={pt.name}
                  type="button"
                  disabled={exists}
                  onClick={() => togglePackTag(pt.name)}
                  aria-pressed={picked}
                  title={exists ? t('packAlreadyHave') : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all',
                    exists && 'cursor-not-allowed opacity-40 line-through'
                  )}
                  style={{
                    backgroundColor: `${pt.color}${picked || exists ? '20' : '08'}`,
                    color: pt.color,
                    border: `1px solid ${pt.color}${picked ? '70' : '30'}`,
                  }}
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: pt.color }} />
                  {pt.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {packMissing.length === 0
              ? t('packAllPresent')
              : t('packSelectedCount', { count: packSelected.length, total: packMissing.length })}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPackOpen(false)} disabled={addingPack}>
              {t('cancel')}
            </Button>
            <Button onClick={handleAddPack} disabled={addingPack || packSelected.length === 0}>
              {addingPack ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t('packAddBtn', { count: packSelected.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTag')}</DialogTitle>
            <DialogDescription>
              {tagToDelete ? t('deleteConfirm', { name: tagToDelete.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTag')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
