'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { listCountries } from '@wacrm/shared/whatsapp/phone-clean';

/**
 * The country assumed for contact numbers saved without a country code.
 *
 * Most imported lists are national numbers, and WhatsApp will not take
 * them: it needs the country code. This is the one setting that lets the
 * app add it. "Not set" is a real, safe choice — such numbers are then
 * reported as unsendable rather than guessed at, because guessing wrong
 * delivers a real message to whoever owns that number elsewhere.
 *
 * Writes go straight to `accounts.default_country_code`; the
 * `accounts_update` RLS policy (017) already restricts that to admins+,
 * so non-admins see a disabled control.
 */
export function PhoneFormatSettings() {
  const supabase = createClient();
  const { accountId, defaultCountryCode, canEditSettings, profileLoading, refreshProfile } =
    useAuth();
  const t = useTranslations('Settings.phoneFormat');

  // The saved value is the source of truth; this only holds an unsaved
  // edit. Derived rather than mirrored into state by an effect, so the
  // control follows the account automatically once the profile resolves
  // and again after a save round-trips — no resync, no cascading render.
  const [edited, setEdited] = useState<string | null>(null);
  const saved = defaultCountryCode ?? '';
  const selected = edited ?? saved;
  const setSelected = setEdited;
  const [saving, setSaving] = useState(false);

  // 245 entries built from the parser's own metadata — sorting them on
  // every render would be wasteful and the list never changes.
  const countries = useMemo(() => listCountries(), []);

  const dirty = selected !== saved;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      // Empty select value means "not set", which is NULL in the column,
      // not an empty string — the CHECK constraint only allows two
      // uppercase letters or NULL.
      .update({ default_country_code: selected === '' ? null : selected })
      .eq('id', accountId);
    if (error) {
      toast.error(t('saveFailed'));
      setSaving(false);
      return;
    }
    // Drop the local edit so the control tracks the account again.
    setEdited(null);
    await refreshProfile();
    setSaving(false);
    toast.success(t('saveSuccess'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Phone className="size-4 text-primary" />
          {t('defaultCountry')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('defaultCountryDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:max-w-xs">
          <Label className="text-muted-foreground">{t('countryLabel')}</Label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!canEditSettings || profileLoading}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">{t('none')}</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.dialCode})
              </option>
            ))}
          </select>
        </div>

        {selected === '' && (
          <p className="text-xs text-muted-foreground">{t('noneHint')}</p>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving || !canEditSettings}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
          {!canEditSettings && (
            <span className="text-xs text-muted-foreground">{t('adminOnlyHint')}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
