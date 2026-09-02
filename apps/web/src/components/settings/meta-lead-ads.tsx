'use client';

// ============================================================
// MetaLeadAdsSettings — Settings → Meta Lead Ads
//
// Connect Facebook Pages so Facebook / Instagram Lead Ads submissions
// land in Contacts automatically. Two ways in:
//   - "Connect with Facebook": Facebook Login (needs NEXT_PUBLIC_META_APP_ID
//     + the server-side META_APP_ID/META_APP_SECRET) → pick a Page.
//   - "Add manually": paste a Page id + Page access token.
// Any member can see the roster and recent leads; admin+ can connect,
// pause, sync and disconnect (RequireRole here, requireRole('admin')
// + RLS on the server).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Megaphone,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useCan } from '@/hooks/use-can';
import { META_LEADS_LOGIN_SCOPES } from '@wacrm/shared/meta/lead-ads-api';
import type { MetaLead, MetaLeadPage } from '@wacrm/shared/types';
import { facebookLoginForToken, loadFacebookSdk } from '@/lib/meta/facebook-sdk';
import { readJsonResponse } from '@/lib/http/read-json-response';
import { SettingsPanelHead } from './settings-panel-head';

interface SetupInfo {
  callback_url: string;
  app_configured: boolean;
  verify_token_configured: boolean;
}

interface DiscoveredPage {
  id: string;
  name: string;
  tasks: string[];
}

type LeadRow = MetaLead & { contacts?: { id: string; name: string | null; phone: string } | null };

/** Facebook "f" glyph — lucide dropped brand icons, so it's inlined. */
function FacebookGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M13.5 21v-7.2h2.4l.4-2.9h-2.8V9.1c0-.8.2-1.4 1.4-1.4h1.5V5.1c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.9h2.5V21h3z" />
    </svg>
  );
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MetaLeadAdsSettings() {
  const t = useTranslations('Settings.metaLeads');
  const canEdit = useCan('edit-settings');

  const [pages, setPages] = useState<MetaLeadPage[]>([]);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Connect-with-Facebook flow
  const [fbBusy, setFbBusy] = useState<'idle' | 'sdk' | 'login' | 'discover' | 'connect'>('idle');
  const [userToken, setUserToken] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredPage[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Manual connect
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPageId, setManualPageId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [manualBusy, setManualBusy] = useState(false);

  // Row actions
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<MetaLeadPage | null>(null);

  const fbAppId = process.env.NEXT_PUBLIC_META_APP_ID;
  const fbLoginAvailable = Boolean(fbAppId) && (setup?.app_configured ?? true);

  const load = useCallback(async () => {
    try {
      const [pagesRes, leadsRes] = await Promise.all([
        fetch('/api/meta/leads/pages', { cache: 'no-store' }),
        fetch('/api/meta/leads?limit=50', { cache: 'no-store' }),
      ]);
      const pagesJson = await readJsonResponse<{ pages?: MetaLeadPage[]; setup?: SetupInfo; error?: string }>(pagesRes);
      if (!pagesRes.ok) {
        toast.error(pagesJson.error || t('toasts.loadFailed'));
      } else {
        setPages(pagesJson.pages ?? []);
        setSetup(pagesJson.setup ?? null);
      }
      const leadsJson = await readJsonResponse<{ leads?: LeadRow[] }>(leadsRes);
      if (leadsRes.ok) setLeads(leadsJson.leads ?? []);
    } catch (err) {
      console.error('[MetaLeadAdsSettings] load error:', err);
      toast.error(err instanceof Error ? err.message : t('toasts.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const connectedIds = useMemo(() => new Set(pages.map((p) => p.page_id)), [pages]);

  // ── Connect with Facebook ─────────────────────────────────────────
  async function handleFacebookConnect() {
    if (!fbAppId) return;
    setFbBusy('sdk');
    try {
      await loadFacebookSdk(fbAppId);
    } catch (err) {
      console.error('[meta-leads] SDK load failed:', err);
      toast.error(t('toasts.sdkFailed'));
      setFbBusy('idle');
      return;
    }
    setFbBusy('login');
    const token = await facebookLoginForToken(META_LEADS_LOGIN_SCOPES);
    if (!token) {
      setFbBusy('idle');
      return; // closed the dialog — not worth a toast
    }
    setUserToken(token);
    setFbBusy('discover');
    try {
      const res = await fetch('/api/meta/leads/pages/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_access_token: token }),
      });
      const json = await readJsonResponse<{ pages?: DiscoveredPage[]; error?: string }>(res);
      if (!res.ok) {
        toast.error(json.error || t('toasts.connectFailed'));
        return;
      }
      setDiscovered(json.pages ?? []);
      setPickerOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.connectFailed'));
    } finally {
      setFbBusy('idle');
    }
  }

  async function connectPage(body: Record<string, string>, onDone?: () => void) {
    const res = await fetch('/api/meta/leads/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await readJsonResponse<{
      page?: MetaLeadPage;
      webhook_subscribed?: boolean;
      subscribe_error?: string | null;
      error?: string;
    }>(res);
    if (!res.ok || !json.page) {
      toast.error(json.error || t('toasts.connectFailed'));
      return false;
    }
    if (json.webhook_subscribed) {
      toast.success(t('toasts.connected', { name: json.page.page_name }));
    } else {
      toast.warning(t('toasts.connectedNoWebhook', { name: json.page.page_name }));
    }
    onDone?.();
    await load();
    return true;
  }

  async function handlePickPage(page: DiscoveredPage) {
    if (!userToken) return;
    setFbBusy('connect');
    try {
      await connectPage({ user_access_token: userToken, page_id: page.id }, () => {
        setPickerOpen(false);
        setDiscovered(null);
        setUserToken(null);
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.connectFailed'));
    } finally {
      setFbBusy('idle');
    }
  }

  async function handleManualConnect() {
    setManualBusy(true);
    try {
      await connectPage({ page_id: manualPageId.trim(), page_access_token: manualToken.trim() }, () => {
        setManualOpen(false);
        setManualPageId('');
        setManualToken('');
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.connectFailed'));
    } finally {
      setManualBusy(false);
    }
  }

  // ── Row actions ───────────────────────────────────────────────────
  async function patchPage(page: MetaLeadPage, body: Record<string, unknown>, okMessage?: string) {
    setBusyRow(page.id);
    try {
      const res = await fetch(`/api/meta/leads/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await readJsonResponse<{ page?: MetaLeadPage; subscribe_error?: string | null; error?: string }>(res);
      if (!res.ok || !json.page) {
        toast.error(json.error || t('toasts.updateFailed'));
        return;
      }
      setPages((prev) => prev.map((p) => (p.id === page.id ? json.page! : p)));
      if (json.subscribe_error) toast.error(t('toasts.resubscribeFailed', { message: json.subscribe_error }));
      else if (okMessage) toast.success(okMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.updateFailed'));
    } finally {
      setBusyRow(null);
    }
  }

  async function handleSync(page: MetaLeadPage) {
    setBusyRow(page.id);
    try {
      const res = await fetch(`/api/meta/leads/pages/${page.id}/sync`, { method: 'POST' });
      const json = await readJsonResponse<{
        summary?: { forms: number; fetched: number; created: number; matched: number; duplicates: number; unusable: number; errors: string[] };
        error?: string;
      }>(res);
      if (!res.ok || !json.summary) {
        toast.error(json.error || t('toasts.syncFailed'));
        return;
      }
      const s = json.summary;
      toast.success(t('toasts.syncDone', { created: s.created, matched: s.matched, skipped: s.duplicates + s.unusable }));
      if (s.errors.length) toast.warning(s.errors[0]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.syncFailed'));
    } finally {
      setBusyRow(null);
    }
  }

  async function handleDisconnect() {
    if (!pendingDisconnect) return;
    const page = pendingDisconnect;
    setBusyRow(page.id);
    try {
      const res = await fetch(`/api/meta/leads/pages/${page.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await readJsonResponse<{ error?: string }>(res).catch(() => ({ error: undefined }));
        toast.error(json.error || t('toasts.updateFailed'));
        return;
      }
      toast.success(t('toasts.disconnected', { name: page.page_name }));
      setPendingDisconnect(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toasts.updateFailed'));
    } finally {
      setBusyRow(null);
    }
  }

  async function copyCallback() {
    if (!setup?.callback_url) return;
    try {
      await navigator.clipboard.writeText(setup.callback_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('toasts.copyFailed'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const fbBusyLabel =
    fbBusy === 'sdk'
      ? t('fbStatus.sdk')
      : fbBusy === 'login'
        ? t('fbStatus.login')
        : fbBusy === 'discover'
          ? t('fbStatus.discover')
          : fbBusy === 'connect'
            ? t('fbStatus.connect')
            : t('connectFacebook');

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <div className="flex flex-wrap gap-2">
              {fbLoginAvailable ? (
                <Button type="button" onClick={handleFacebookConnect} disabled={fbBusy !== 'idle'}>
                  {fbBusy !== 'idle' ? <Loader2 className="size-4 animate-spin" /> : <FacebookGlyph className="size-4" />}
                  {fbBusyLabel}
                </Button>
              ) : null}
              <Button type="button" variant={fbLoginAvailable ? 'outline' : 'default'} onClick={() => setManualOpen(true)}>
                <Plus className="size-4" />
                {t('addManually')}
              </Button>
            </div>
          </RequireRole>
        }
      />

      {/* Setup */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-start gap-3">
            <Webhook className="text-primary mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">{t('setupTitle')}</div>
              <p className="mt-1 text-sm text-muted-foreground">{t('setupDesc')}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <Label className="text-muted-foreground">{t('callbackUrl')}</Label>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
                {setup?.callback_url ?? '—'}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={copyCallback} aria-label={t('copy')}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>

            <Label className="text-muted-foreground">{t('verifyToken')}</Label>
            <div className="text-sm">
              {setup?.verify_token_configured ? (
                <Badge variant="secondary">{t('verifyTokenOk')}</Badge>
              ) : (
                <span className="text-muted-foreground">{t('verifyTokenMissing')}</span>
              )}
            </div>

            <Label className="text-muted-foreground">{t('appCredentials')}</Label>
            <div className="text-sm">
              {setup?.app_configured ? (
                <Badge variant="secondary">{t('appCredentialsOk')}</Badge>
              ) : (
                <span className="text-muted-foreground">{t('appCredentialsMissing')}</span>
              )}
            </div>
          </div>

          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('step1')}</li>
            <li>{t('step2')}</li>
            <li>{t('step3')}</li>
            <li>{t('step4')}</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            {t('permissionsNote', { scopes: META_LEADS_LOGIN_SCOPES.join(', ') })}
          </p>
        </CardContent>
      </Card>

      {/* Connected pages */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('pagesTitle')}</h3>
        {pages.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Megaphone className="text-muted-foreground size-8" />
              <div className="font-medium text-foreground">{t('noPages')}</div>
              <p className="max-w-[48ch] text-sm text-muted-foreground">{t('noPagesDesc')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {pages.map((page) => {
              const busy = busyRow === page.id;
              return (
                <Card key={page.id}>
                  <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-foreground">{page.page_name}</span>
                        <Badge variant={page.status === 'active' ? 'default' : 'secondary'}>
                          {page.status === 'active' ? t('statusActive') : t('statusPaused')}
                        </Badge>
                        {page.webhook_subscribed ? (
                          <Badge variant="secondary">{t('webhookOn')}</Badge>
                        ) : (
                          <Badge variant="destructive">{t('webhookOff')}</Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('pageIdLabel', { id: page.page_id })} · {t('leadsCount', { count: page.lead_count })} ·{' '}
                        {t('lastLead', { when: page.last_lead_at ? fmtDateTime(page.last_lead_at) : t('never') })}
                      </div>
                    </div>

                    <RequireRole min="admin">
                      <div className="flex flex-wrap items-center gap-2">
                        {!page.webhook_subscribed ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => patchPage(page, { resubscribe: true }, t('toasts.resubscribed'))}
                          >
                            <Webhook className="size-4" />
                            {t('resubscribe')}
                          </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => handleSync(page)}>
                          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                          {t('sync')}
                        </Button>
                        <div className="flex items-center gap-2 px-1">
                          <Switch
                            checked={page.status === 'active'}
                            disabled={busy || !canEdit}
                            onCheckedChange={(next) =>
                              patchPage(page, { status: next ? 'active' : 'paused' }, next ? t('toasts.resumed') : t('toasts.paused'))
                            }
                            aria-label={page.status === 'active' ? t('pause') : t('resume')}
                          />
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setPendingDisconnect(page)}
                          aria-label={t('disconnect')}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </RequireRole>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent leads */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('leadsTitle')}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{t('leadsDesc')}</p>
        <Card>
          <CardContent className="p-0">
            {leads.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('noLeads')}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">{t('colName')}</th>
                      <th className="px-4 py-2 font-medium">{t('colPhone')}</th>
                      <th className="px-4 py-2 font-medium">{t('colSource')}</th>
                      <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                      <th className="px-4 py-2 font-medium">{t('colReceived')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => {
                      const name = lead.contacts?.name || lead.full_name || '—';
                      const phone = lead.contacts?.phone || lead.phone || '—';
                      const source = [lead.campaign_name, lead.ad_name, lead.form_name].filter(Boolean).join(' · ') || lead.form_id || '—';
                      return (
                        <tr key={lead.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-2">
                            {lead.contact_id ? (
                              <Link
                                href={`/contacts?contact=${encodeURIComponent(lead.contact_id)}`}
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                {name}
                                <ExternalLink className="size-3" />
                              </Link>
                            ) : (
                              <span className="text-foreground">{name}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-foreground">{phone}</td>
                          <td className="max-w-[28ch] truncate px-4 py-2 text-muted-foreground" title={source}>
                            {source}
                            {lead.platform ? <span className="ml-1 uppercase">· {lead.platform}</span> : null}
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant={lead.status === 'processed' ? 'secondary' : 'destructive'} title={lead.error ?? undefined}>
                              {t(`leadStatus.${lead.status}`)}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                            {fmtDateTime(lead.lead_created_at ?? lead.created_at)}
                            <span className="ml-1 text-xs">({t(`via.${lead.received_via}`)})</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Page picker (after Facebook Login) */}
      <Dialog
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPickerOpen(false);
            setDiscovered(null);
            setUserToken(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pickPageTitle')}</DialogTitle>
            <DialogDescription>{t('pickPageDesc')}</DialogDescription>
          </DialogHeader>
          {discovered && discovered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPagesFound')}</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {(discovered ?? []).map((p) => {
                const already = connectedIds.has(p.id);
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.id}</div>
                    </div>
                    <Button type="button" size="sm" disabled={fbBusy === 'connect'} onClick={() => handlePickPage(p)}>
                      {fbBusy === 'connect' ? <Loader2 className="size-4 animate-spin" /> : null}
                      {already ? t('reconnect') : t('connect')}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Manual connect */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('manualTitle')}</DialogTitle>
            <DialogDescription>{t('manualDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="meta-page-id">{t('pageId')}</Label>
              <Input
                id="meta-page-id"
                inputMode="numeric"
                placeholder="1234567890"
                value={manualPageId}
                onChange={(e) => setManualPageId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meta-page-token">{t('pageToken')}</Label>
              <Input
                id="meta-page-token"
                type="password"
                autoComplete="off"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('pageTokenHelp')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setManualOpen(false)} disabled={manualBusy}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              onClick={handleManualConnect}
              disabled={manualBusy || !/^\d{3,32}$/.test(manualPageId.trim()) || manualToken.trim().length < 20}
            >
              {manualBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('connect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect confirm */}
      <Dialog open={!!pendingDisconnect} onOpenChange={(open) => !open && setPendingDisconnect(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('disconnectTitle')}</DialogTitle>
            <DialogDescription>
              {t('disconnectDesc', { name: pendingDisconnect?.page_name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDisconnect(null)}>
              {t('cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={handleDisconnect} disabled={busyRow === pendingDisconnect?.id}>
              {busyRow === pendingDisconnect?.id ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('confirmDisconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
