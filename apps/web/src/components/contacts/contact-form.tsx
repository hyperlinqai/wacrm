'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@wacrm/shared/types';
import {
  findContactByEmail,
  findDuplicateContacts,
  findExistingContact,
  hasDuplicates,
  isExactMatch,
  isUniqueViolation,
  type DuplicateMatches,
  type ExistingContact,
} from '@wacrm/shared/contacts/dedupe';
import { cleanPhone } from '@wacrm/shared/whatsapp/phone-clean';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle, Mail, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number/email. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const t = useTranslations('Contacts.form');
  const supabase = createClient();
  const { accountId, defaultCountryCode } = useAuth();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);

  // Inline heads-up under the phone / email inputs (runs on blur so we
  // don't query on every keystroke). `exact` phone matches are what the
  // DB unique index (migration 022) will reject; fuzzy trunk-variants
  // and email matches only warn.
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);
  const [emailMatch, setEmailMatch] = useState<ExistingContact | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);

  // The blocking "possible duplicate" prompt shown on submit. Both
  // qualifiers are checked there regardless of whether the user blurred
  // the inputs, so pasting + hitting Enter can't skip the alert.
  const [dupPrompt, setDupPrompt] = useState<DuplicateMatches | null>(null);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      setDupMatch(null);
      setEmailMatch(null);
      setDupPrompt(null);
      fetchTags();
    }
  }, [open, contact]);

  /** The number as it will be stored. The database resolves a bare
   *  national number against the account's default country on insert
   *  (migration 053); doing the same here means the duplicate checks
   *  compare like with like — "9831023021" and "+919831023021" are
   *  one person — and the conflict prompt names the right record.
   *  Anything that cannot be resolved is sent exactly as typed, and
   *  the Validation page picks it up. */
  function resolvedPhone(): string {
    const value = phone.trim();
    const cleaned = cleanPhone(value, { defaultCountry: defaultCountryCode });
    return cleaned.ok && cleaned.e164 ? cleaned.e164 : value;
  }

  async function checkDuplicatePhone() {
    if (!accountId) return;
    const value = resolvedPhone();
    if (!value) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(supabase, accountId, value);
      setDupMatch(
        existing && existing.id !== contact?.id
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null,
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function checkDuplicateEmail() {
    if (!accountId) return;
    const value = email.trim();
    if (!value) {
      setEmailMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      setEmailMatch(await findContactByEmail(supabase, accountId, value, contact?.id));
    } finally {
      setCheckingDup(false);
    }
  }

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase
      .from('tags')
      .select('*')
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  /** Add the selected tags to `contactId`, removing deselected ones
   *  only when editing that same contact (`existingTagIds`). */
  async function syncTags(contactId: string, existingTagIds: Set<string>) {
    const desiredTagIds = new Set(selectedTagIds);
    const toRemove = [...existingTagIds].filter((id) => !desiredTagIds.has(id));
    const toAdd = [...desiredTagIds].filter((id) => !existingTagIds.has(id));
    for (const tagId of toRemove) await deleteContactTag(contactId, tagId);
    for (const tagId of toAdd) await addContactTag(contactId, tagId);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!phone.trim()) {
      toast.error(t('phoneRequired'));
      return;
    }
    if (!accountId) {
      toast.error('Your profile is not linked to an account.');
      return;
    }

    // Always re-check both qualifiers at submit time and stop to ask
    // before touching the database.
    setCheckingDup(true);
    let matches: DuplicateMatches;
    try {
      matches = await findDuplicateContacts(
        supabase,
        accountId,
        { phone: resolvedPhone(), email: email.trim() },
        contact?.id,
      );
    } finally {
      setCheckingDup(false);
    }
    if (hasDuplicates(matches)) {
      setDupPrompt(matches);
      return;
    }

    await persist();
  }

  /** Write the form as a new contact (or the edited one). */
  async function persist() {
    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      let contactId = contact?.id;

      if (isEdit && contactId) {
        const { error } = await supabase
          .from('contacts')
          .update({
            name: name.trim() || null,
            phone: resolvedPhone(),
            email: email.trim() || null,
            company: company.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: name.trim() || null,
            phone: resolvedPhone(),
            email: email.trim() || null,
            company: company.trim() || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        contactId = data.id;
      }

      if (contactId) {
        await syncTags(contactId, new Set(contactTags.map((tag) => tag.tag_id)));
      }

      toast.success(isEdit ? t('toastSuccessEdit') : t('toastSuccessAdd'));
      setDupPrompt(null);
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The unique index (migration 022) rejects a duplicate phone that
      // slipped past the check (race, or a format that normalizes
      // equal). Surface it as the friendly duplicate notice and point
      // the user at the existing record.
      if (isUniqueViolation(err)) {
        toast.error(t('toastConflict'));
        if (accountId) {
          const existing = await findExistingContact(supabase, accountId, resolvedPhone());
          if (existing) {
            setDupPrompt({ phone: existing, phoneExact: true, email: null });
          }
        }
        return;
      }
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  /** "Update existing contact": fold what was typed into the matched
   *  contact instead of creating a second one. Only fills fields the
   *  existing contact is missing, so a richer record is never
   *  overwritten by a sparser entry; tags are added, never removed. */
  async function mergeIntoExisting(target: ExistingContact) {
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      const typedName = name.trim();
      const typedEmail = email.trim();
      const typedCompany = company.trim();
      if (typedName && !target.name) patch.name = typedName;
      if (typedEmail && !target.email) patch.email = typedEmail;
      if (typedCompany && !target.company) patch.company = typedCompany;

      if (Object.keys(patch).length > 0) {
        const { error } = await supabase
          .from('contacts')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', target.id);
        if (error) throw error;
      }

      // Tags: add-only — we don't know the target's current tags here
      // and must not strip any; addContactTag is a no-op on duplicates.
      for (const tagId of selectedTagIds) await addContactTag(target.id, tagId);

      toast.success(t('toastMergedExisting'));
      setDupPrompt(null);
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  function viewExisting(id: string) {
    setDupPrompt(null);
    onOpenChange(false);
    onViewExisting?.(id);
  }

  // Which contact "update existing" targets: the phone owner wins (the
  // number is the WhatsApp identity), else the email owner.
  const mergeTarget = dupPrompt?.phone ?? dupPrompt?.email ?? null;
  // A second contact can never take an exact phone twice (unique index).
  const canProceedAnyway = !!dupPrompt && !dupPrompt.phoneExact;

  function displayName(c: ExistingContact) {
    return (c.name as string | null) || c.phone || t('dupUnnamed');
  }

  /** One row per distinct existing contact, with every reason it matched
   *  (the same record can own both the phone and the email). */
  function matchedRows(m: DuplicateMatches) {
    type Reason = { icon: typeof Phone; label: string };
    const rows = new Map<string, { contact: ExistingContact; reasons: Reason[] }>();
    const add = (c: ExistingContact | null, reason: Reason) => {
      if (!c) return;
      const row = rows.get(c.id) ?? { contact: c, reasons: [] };
      row.reasons.push(reason);
      rows.set(c.id, row);
    };
    add(m.phone, {
      icon: Phone,
      label: m.phoneExact ? t('dupMatchedPhone') : t('dupMatchedSimilarPhone'),
    });
    add(m.email, { icon: Mail, label: t('dupMatchedEmail') });
    return [...rows.values()];
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {isEdit ? t('editTitle') : t('addTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {isEdit
                ? t('editDesc')
                : t('addDesc')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cf-name" className="text-muted-foreground">
                {t('nameLabel')}
              </Label>
              <Input
                id="cf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-phone" className="text-muted-foreground">
                {t('phoneLabel')} <span className="text-red-400">*</span>
              </Label>
              <Input
                id="cf-phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (dupMatch) setDupMatch(null);
                }}
                onBlur={checkDuplicatePhone}
                placeholder={t('phonePlaceholder')}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              {dupMatch ? (
                <div
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                    dupMatch.exact
                      ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <div className="space-y-1">
                    <p>
                      {dupMatch.exact
                        ? t('dupExact')
                        : t('dupSimilar')}
                    </p>
                    {onViewExisting && (
                      <button
                        type="button"
                        onClick={() => viewExisting(dupMatch.contact.id)}
                        className="font-medium underline underline-offset-2 hover:no-underline"
                      >
                        {t('viewExisting', { name: displayName(dupMatch.contact) })}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('phoneHint')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="cf-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailMatch) setEmailMatch(null);
                }}
                onBlur={checkDuplicateEmail}
                placeholder={t('emailPlaceholder')}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              {emailMatch && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <div className="space-y-1">
                    <p>{t('dupEmail')}</p>
                    {onViewExisting && (
                      <button
                        type="button"
                        onClick={() => viewExisting(emailMatch.id)}
                        className="font-medium underline underline-offset-2 hover:no-underline"
                      >
                        {t('viewExisting', { name: displayName(emailMatch) })}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-company" className="text-muted-foreground">
                {t('companyLabel')}
              </Label>
              <Input
                id="cf-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder={t('companyPlaceholder')}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('tagsLabel')}</Label>
              {loadingTags ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-3 animate-spin" />
                  {t('loadingTags')}
                </div>
              ) : tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('noTagsAvailable')}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => {
                    const selected = selectedTagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggleTag(tag.id)}
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                          selected
                            ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                            : 'opacity-60 hover:opacity-100'
                        }`}
                        style={{
                          backgroundColor: tag.color + '20',
                          color: tag.color,
                          borderColor: tag.color,
                        }}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={saving || checkingDup}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {(saving || checkingDup) && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? t('update') : t('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Duplicate prompt — shown on submit whenever the phone or email
          matches an existing contact; nothing is written until the user
          picks an action. */}
      <Dialog open={!!dupPrompt} onOpenChange={(o) => !o && !saving && setDupPrompt(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('dupDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('dupDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          {dupPrompt && (
            <div className="space-y-2">
              {matchedRows(dupPrompt).map(({ contact: c, reasons }) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {displayName(c)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.phone}
                      {c.email ? ` · ${c.email as string}` : ''}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {reasons.map(({ icon: Icon, label }) => (
                        <Badge key={label} variant="outline" className="gap-1 text-[11px]">
                          <Icon className="size-3" />
                          {label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {onViewExisting && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => viewExisting(c.id)}
                    >
                      {t('dupActionView')}
                    </Button>
                  )}
                </div>
              ))}

              {dupPrompt.phoneExact && !isEdit && (
                <p className="text-xs text-muted-foreground">{t('dupPhoneBlocked')}</p>
              )}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            {!isEdit && mergeTarget && (
              <div className="w-full">
                <Button
                  type="button"
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                  disabled={saving}
                  onClick={() => mergeIntoExisting(mergeTarget)}
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {t('dupActionUpdate')}
                </Button>
                <p className="mt-1 text-center text-[11px] text-muted-foreground">
                  {t('dupActionUpdateHint')}
                </p>
              </div>
            )}
            {canProceedAnyway && (
              <Button
                type="button"
                variant="outline"
                className="w-full border-border"
                disabled={saving}
                onClick={persist}
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? t('dupActionSaveAnyway') : t('dupActionCreateAnyway')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="w-full text-muted-foreground"
              disabled={saving}
              onClick={() => setDupPrompt(null)}
            >
              {t('dupActionBack')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
