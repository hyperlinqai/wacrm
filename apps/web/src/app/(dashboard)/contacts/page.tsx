'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type {
  Contact,
  ContactActivationOverride,
  ContactList,
  ContactTag,
  CustomField,
  Tag,
} from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import {
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ListChecks,
  ListX,
  Activity,
  ChevronDown,
  Pin,
  PinOff,
  Settings2,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { ContactFilterBar } from '@/components/contacts/contact-filter-bar';
import { ContactStatusBadge } from '@/components/contacts/contact-status-badge';
import { ListManager } from '@/components/contacts/list-manager';
import { ActivationRulePanel } from '@/components/contacts/activation-rule-panel';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { deleteContacts } from '@/lib/contacts/delete-contacts';
import {
  EMPTY_FILTERS,
  hasAnyFilter,
  toFilterContactsParams,
  type ContactFilters,
} from '@/lib/contacts/contact-filters';
import {
  addContactsToList,
  createList,
  fetchListsWithCounts,
  removeContactsFromList,
  setActivationOverride,
  type ContactListWithCount,
} from '@/lib/contacts/lists-api';

const PAGE_SIZE = 25;

type View = 'contacts' | 'lists' | 'activation';

interface ContactRow extends Contact {
  tags?: Tag[];
  lists?: ContactList[];
}

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const tv = useTranslations('Contacts.views');
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [view, setView] = useState<View>('contacts');

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<ContactFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [activeCount, setActiveCount] = useState<number | null>(null);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [newListName, setNewListName] = useState('');

  // Reference data
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  const [lists, setLists] = useState<ContactListWithCount[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [listsVersion, setListsVersion] = useState(0);

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  useEffect(() => {
    // Deliberate: seeding state from the URL is a browser-only read
    // (window.location doesn't exist during SSR), so it has to happen
    // post-mount — not an effect smell.
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const list = params.get('list');
    if (q || list) {
      setFilters((f) => ({
        ...f,
        search: q ?? f.search,
        listIds: list ? [list] : f.listIds,
      }));
    }
    // ?contact=<id> deep-links straight into a contact's detail sheet —
    // there is no /contacts/[id] page, so this is how other screens
    // (e.g. a web-form submission row) hand off to a specific contact.
    const contactId = params.get('contact');
    if (contactId) {
      setDetailContactId(contactId);
      setDetailOpen(true);
    }
    const v = params.get('view');
    if (v === 'lists' || v === 'activation') setView(v);
  }, []);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setFilters((prev) => {
        const pruned = prev.tagIds.filter((id) => map[id]);
        return pruned.length === prev.tagIds.length ? prev : { ...prev, tagIds: pruned };
      });
    }
  }, [supabase]);

  const fetchLists = useCallback(async () => {
    try {
      const rows = await fetchListsWithCounts(supabase);
      setLists(rows);
      const ids = new Set(rows.map((l) => l.id));
      setFilters((prev) => {
        const pruned = prev.listIds.filter((id) => ids.has(id));
        return pruned.length === prev.listIds.length ? prev : { ...prev, listIds: pruned };
      });
    } catch (err) {
      console.error('[contacts] lists load failed:', err);
    }
  }, [supabase]);

  const fetchCustomFields = useCallback(async () => {
    const { data } = await supabase.from('custom_fields').select('*').order('field_name');
    setCustomFields(data ?? []);
  }, [supabase]);

  const fetchActiveCount = useCallback(async () => {
    const { count } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);
    setActiveCount(count ?? 0);
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/filter results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    // Every filter is resolved server-side in one query (join + distinct +
    // windowed total count + pagination) so a tag/list covering many
    // contacts can't silently truncate the result or overflow an IN
    // clause. See migrations 025 and 049.
    const { data, error } = await supabase.rpc(
      'filter_contacts',
      toFilterContactsParams(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE })
    );
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch
    if (error) {
      console.error('[contacts] filter_contacts failed:', error);
      toast.error(t('toastFailedLoad'));
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as { contact: Contact; total_count: number }[];
    const contactRows = rows.map((r) => r.contact);
    const count = rows.length > 0 ? Number(rows[0].total_count) : 0;

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Hydrate tags + lists for just this page of contacts.
    const contactIds = contactRows.map((c) => c.id);
    const [{ data: contactTags }, { data: members }] = await Promise.all([
      supabase.from('contact_tags').select('contact_id, tag_id').in('contact_id', contactIds),
      supabase.from('contact_list_members').select('contact_id, list_id').in('contact_id', contactIds),
    ]);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      (tagsByContact[ct.contact_id] ??= []).push(ct.tag_id);
    });
    const listsByContact: Record<string, string[]> = {};
    members?.forEach((m) => {
      (listsByContact[m.contact_id] ??= []).push(m.list_id);
    });
    const listById = new Map(lists.map((l) => [l.id, l]));

    const enriched: ContactRow[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? []).map((tid) => tagsMap[tid]).filter(Boolean),
      lists: (listsByContact[c.id] ?? []).map((lid) => listById.get(lid)).filter((l): l is ContactListWithCount => !!l),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, filters, tagsMap, lists, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    fetchTags();
    fetchLists();
    fetchCustomFields();
    fetchActiveCount();
  }, [fetchTags, fetchLists, fetchCustomFields, fetchActiveCount]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  /** Everything that can change a contact's status, tags or lists funnels here. */
  const refreshAll = useCallback(() => {
    fetchContacts();
    fetchLists();
    fetchActiveCount();
    setListsVersion((v) => v + 1);
  }, [fetchContacts, fetchLists, fetchActiveCount]);

  function updateFilters(next: ContactFilters) {
    setFilters(next);
    // Reset pagination when the query changes — the result set
    // shrinks/grows, page N may no longer be valid.
    setPage(0);
  }

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await deleteContacts(supabase, [deleteTarget.id]);

    if (error) {
      console.error('[contacts] delete failed:', error);
      toast.error(error.message || t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      refreshAll();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await deleteContacts(supabase, ids);

    if (error) {
      console.error('[contacts] bulk delete failed:', error);
      toast.error(error.message || t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      refreshAll();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  async function applyOverride(ids: string[], override: ContactActivationOverride | null) {
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await setActivationOverride(supabase, ids, override);
      toast.success(
        override === 'active'
          ? t('toastMarkedActive', { count: ids.length })
          : override === 'inactive'
            ? t('toastMarkedInactive', { count: ids.length })
            : t('toastFollowRule', { count: ids.length })
      );
      refreshAll();
    } catch (err) {
      console.error('[contacts] status update failed:', err);
      toast.error(t('toastStatusFailed'));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkAddToList(listId: string) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await addContactsToList(supabase, listId, ids);
      const name = lists.find((l) => l.id === listId)?.name ?? '';
      toast.success(t('toastAddedToList', { count: ids.length, name }));
      refreshAll();
    } catch (err) {
      console.error('[contacts] add to list failed:', err);
      toast.error(t('toastListFailed'));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkCreateListAndAdd() {
    const name = newListName.trim();
    if (!name || !user || !accountId) return;
    setBulkBusy(true);
    try {
      const list = await createList(supabase, { userId: user.id, accountId, name });
      setNewListName('');
      await addContactsToList(supabase, list.id, [...selected]);
      toast.success(t('toastAddedToList', { count: selected.size, name: list.name }));
      refreshAll();
    } catch (err) {
      console.error('[contacts] create list failed:', err);
      toast.error(t('toastListFailed'));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkRemoveFromList(listId: string) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await removeContactsFromList(supabase, listId, ids);
      const name = lists.find((l) => l.id === listId)?.name ?? '';
      toast.success(t('toastRemovedFromList', { count: ids.length, name }));
      refreshAll();
    } catch (err) {
      console.error('[contacts] remove from list failed:', err);
      toast.error(t('toastListFailed'));
    } finally {
      setBulkBusy(false);
    }
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  const allTags = useMemo(
    () => Object.values(tagsMap).sort((a, b) => a.name.localeCompare(b.name)),
    [tagsMap]
  );
  const filtersActive = hasAnyFilter(filters);

  // Lists the current selection could be removed from (any list that at
  // least one selected row belongs to).
  const removableLists = useMemo(() => {
    const ids = new Set<string>();
    contacts.forEach((c) => {
      if (selected.has(c.id)) c.lists?.forEach((l) => ids.add(l.id));
    });
    return lists.filter((l) => ids.has(l.id));
  }, [contacts, selected, lists]);

  const views: { id: View; label: string; icon: typeof Users }[] = [
    { id: 'contacts', label: tv('contacts'), icon: Users },
    { id: 'lists', label: tv('lists'), icon: ListChecks },
    { id: 'activation', label: tv('activation'), icon: Settings2 },
  ];

  return (
    <div className="space-y-6">
      {/* View switcher */}
      <div className="flex items-center gap-1 border-b border-border">
        {views.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              view === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-4" />
            {label}
            {id === 'lists' && lists.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
                {lists.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {view === 'lists' && (
        <>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{tv('listsTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{tv('listsSubtitle')}</p>
          </div>
          <ListManager
            refreshKey={listsVersion}
            onChanged={() => {
              fetchLists();
              fetchContacts();
            }}
            onViewContacts={(listId) => {
              updateFilters({ ...EMPTY_FILTERS, listIds: [listId] });
              setView('contacts');
            }}
          />
        </>
      )}

      {view === 'activation' && (
        <>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{tv('activationTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{tv('activationSubtitle')}</p>
          </div>
          <ActivationRulePanel
            tags={allTags}
            lists={lists}
            canEdit={canEditSettings}
            onSaved={refreshAll}
          />
        </>
      )}

      {view === 'contacts' && (
        <>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
                {t('title')}
                {totalCount > 0 && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {t('countPill', { count: totalCount })}
                  </span>
                )}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {activeCount !== null && !filtersActive
                  ? t('subtitleActive', { active: activeCount, total: totalCount })
                  : totalCount > 0
                    ? t('subtitle', { count: totalCount })
                    : t('subtitleZero')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canEditSettings && (
                <Button
                  variant="outline"
                  onClick={() => setCustomFieldsOpen(true)}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  <SlidersHorizontal className="size-4" />
                  {t('customFieldsBtn')}
                </Button>
              )}
              <GatedButton
                variant="outline"
                canAct={canEdit}
                gateReason="add or import contacts"
                onClick={() => setImportOpen(true)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Upload className="size-4" />
                {t('importBtn')}
              </GatedButton>
              <GatedButton
                canAct={canEdit}
                gateReason="add or import contacts"
                onClick={openAddForm}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Plus className="size-4" />
                {t('addContactBtn')}
              </GatedButton>
            </div>
          </div>

          {/* Filters */}
          <ContactFilterBar
            filters={filters}
            onChange={updateFilters}
            tags={allTags}
            lists={lists}
            customFields={customFields}
          />

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-2">
              <p className="text-sm text-foreground">
                {t('selectedCount', { count: selected.size })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t('clearSelection')}
                </Button>

                {/* Status */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || bulkBusy}
                        className="border-border"
                      />
                    }
                  >
                    {bulkBusy ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
                    {t('bulkStatus')}
                    <ChevronDown className="size-3.5 opacity-60" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-popover border-border">
                    <DropdownMenuItem onClick={() => applyOverride([...selected], 'active')}>
                      <Pin className="size-4 text-emerald-500" />
                      {t('markActive')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => applyOverride([...selected], 'inactive')}>
                      <Pin className="size-4 text-muted-foreground" />
                      {t('markInactive')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-border" />
                    <DropdownMenuItem onClick={() => applyOverride([...selected], null)}>
                      <PinOff className="size-4" />
                      {t('followRule')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Add to list */}
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || bulkBusy}
                        className="border-border"
                      />
                    }
                  >
                    <ListChecks className="size-4" />
                    {t('addToList')}
                    <ChevronDown className="size-3.5 opacity-60" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-0">
                    <div className="px-3 py-2 border-b border-border text-sm font-medium text-popover-foreground">
                      {t('addToList')}
                    </div>
                    {lists.length > 0 && (
                      <div className="max-h-56 overflow-y-auto py-1">
                        {lists.map((l) => (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => bulkAddToList(l.id)}
                            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-sm text-left text-popover-foreground hover:bg-muted/50"
                          >
                            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: l.color }} />
                            <span className="truncate flex-1">{l.name}</span>
                            <span className="text-[10px] text-muted-foreground">{l.member_count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 border-t border-border p-2">
                      <Input
                        value={newListName}
                        onChange={(e) => setNewListName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') bulkCreateListAndAdd();
                        }}
                        placeholder={t('newListPlaceholder')}
                        className="h-8 bg-muted border-border text-sm"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!newListName.trim() || bulkBusy}
                        onClick={bulkCreateListAndAdd}
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Remove from list */}
                {removableLists.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canEdit || bulkBusy}
                          className="border-border"
                        />
                      }
                    >
                      <ListX className="size-4" />
                      {t('removeFromList')}
                      <ChevronDown className="size-3.5 opacity-60" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-popover border-border">
                      {removableLists.map((l) => (
                        <DropdownMenuItem key={l.id} onClick={() => bulkRemoveFromList(l.id)}>
                          <span className="size-2.5 rounded-sm" style={{ backgroundColor: l.color }} />
                          {l.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <GatedButton
                  variant="destructive"
                  size="sm"
                  canAct={canEdit}
                  gateReason="delete contacts"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                  {t('deleteSelected')}
                </GatedButton>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allOnPageSelected}
                      indeterminate={!allOnPageSelected && someOnPageSelected}
                      onCheckedChange={toggleSelectAll}
                      disabled={contacts.length === 0}
                      aria-label="Select all contacts on this page"
                    />
                  </TableHead>
                  <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('tableColumns.phone')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('tableColumns.status')}</TableHead>
                  <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.tags')}</TableHead>
                  <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.lists')}</TableHead>
                  <TableHead className="text-muted-foreground hidden xl:table-cell">{t('tableColumns.email')}</TableHead>
                  <TableHead className="text-muted-foreground hidden xl:table-cell">{t('tableColumns.company')}</TableHead>
                  <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.source')}</TableHead>
                  <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.createdAt')}</TableHead>
                  <TableHead className="text-muted-foreground w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={11} className="text-center py-12">
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="size-6 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">{t('loading')}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : contacts.length === 0 ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={11} className="text-center py-12">
                      <div className="flex flex-col items-center gap-2">
                        <Users className="size-8 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                          {filtersActive ? t('noContactsMatch') : t('noContactsYet')}
                        </p>
                        {!filtersActive && (
                          <GatedButton
                            canAct={canEdit}
                            gateReason="add or import contacts"
                            variant="outline"
                            size="sm"
                            onClick={openAddForm}
                            className="mt-2 border-border text-muted-foreground hover:bg-muted"
                          >
                            <Plus className="size-3.5" />
                            {t('addFirstContact')}
                          </GatedButton>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  contacts.map((contact) => (
                    <TableRow
                      key={contact.id}
                      className={cn(
                        'border-border hover:bg-muted/50 cursor-pointer',
                        contact.is_active === false && 'opacity-70'
                      )}
                      onClick={() => openDetail(contact.id)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(contact.id)}
                          onCheckedChange={() => toggleSelect(contact.id)}
                          aria-label={`Select ${contact.name || contact.phone}`}
                        />
                      </TableCell>
                      <TableCell className="text-foreground font-medium">
                        {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {contact.phone}
                      </TableCell>
                      <TableCell>
                        <ContactStatusBadge contact={contact} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {contact.tags && contact.tags.length > 0 ? (
                            contact.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag.id}
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor: tag.color + '20',
                                  color: tag.color,
                                }}
                              >
                                {tag.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                          {contact.tags && contact.tags.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{contact.tags.length - 3}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {contact.lists && contact.lists.length > 0 ? (
                            contact.lists.slice(0, 2).map((l) => (
                              <span
                                key={l.id}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                                style={{ backgroundColor: l.color + '20', color: l.color }}
                              >
                                <span className="size-1.5 rounded-sm" style={{ backgroundColor: l.color }} />
                                {l.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                          {contact.lists && contact.lists.length > 2 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{contact.lists.length - 2}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden xl:table-cell text-sm">
                        {contact.email || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden xl:table-cell text-sm">
                        {contact.company || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden lg:table-cell text-xs">
                        {t(`sources.${contact.source ?? 'manual'}`)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs hidden lg:table-cell">
                        {new Date(contact.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={(e) => e.stopPropagation()}
                              />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="bg-popover border-border"
                          >
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditForm(contact);
                              }}
                              className="text-popover-foreground focus:bg-muted focus:text-foreground"
                            >
                              <Pencil className="size-4" />
                              {t('editAction')}
                            </DropdownMenuItem>
                            {canEdit && (
                              <>
                                <DropdownMenuSeparator className="bg-border" />
                                {contact.is_active === false ? (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      applyOverride([contact.id], 'active');
                                    }}
                                  >
                                    <Pin className="size-4 text-emerald-500" />
                                    {t('markActiveOne')}
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      applyOverride([contact.id], 'inactive');
                                    }}
                                  >
                                    <Pin className="size-4 text-muted-foreground" />
                                    {t('markInactiveOne')}
                                  </DropdownMenuItem>
                                )}
                                {contact.activation_override && (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      applyOverride([contact.id], null);
                                    }}
                                  >
                                    <PinOff className="size-4" />
                                    {t('followRule')}
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                            <DropdownMenuSeparator className="bg-border" />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmDelete(contact);
                              }}
                            >
                              <Trash2 className="size-4" />
                              {t('deleteAction')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {t('showingPagination', {
                  start: page * PAGE_SIZE + 1,
                  end: Math.min((page + 1) * PAGE_SIZE, totalCount),
                  total: totalCount
                })}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!hasPrev}
                  onClick={() => setPage((p) => p - 1)}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-xs text-muted-foreground px-2">
                  {t('pageCount', { page: page + 1, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!hasNext}
                  onClick={() => setPage((p) => p + 1)}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          refreshAll();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={refreshAll}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={refreshAll}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={(o) => {
            setCustomFieldsOpen(o);
            if (!o) fetchCustomFields();
          }}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
