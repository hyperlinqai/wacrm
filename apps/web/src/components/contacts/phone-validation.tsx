'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Users,
  Wrench,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  auditPhones,
  type PhoneAuditRow,
  type PhoneRejection,
} from '@wacrm/shared/whatsapp/phone-clean';

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
}

/** Rows to pull per request; contacts tables can be long. */
const PAGE = 1000;
/** Contacts updated per batch when fixing. */
const FIX_BATCH = 25;

/** Plain-language explanation per rejection, and whether a human can fix it. */
const REJECTION_COPY: Record<PhoneRejection, { title: string; detail: string }> = {
  no_country_code: {
    title: 'No country code',
    detail:
      'The number has no country code and this account has no default country set. Choose one in Settings → Phone format and these become fixable.',
  },
  excel_scientific: {
    title: 'Destroyed by a spreadsheet',
    detail:
      'Excel rewrote these as 9.18319E+11 and discarded the low digits. The original number is gone — it has to be re-entered from the original source. Nothing can reconstruct it, and guessing would message a stranger.',
  },
  too_short: {
    title: 'Too short to be a number',
    detail: 'Only a few digits — a truncated import or a stray reference, not a phone number.',
  },
  not_a_valid_number: {
    title: 'Not a valid number',
    detail: 'The wrong length or an unassigned prefix for its country.',
  },
  empty: {
    title: 'Blank',
    detail: 'No digits at all.',
  },
};

export function PhoneValidation() {
  const supabase = createClient();
  const { accountId, defaultCountryCode, profileLoading } = useAuth();
  const canEdit = useCan('send-messages');

  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [fixedCount, setFixedCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFixedCount(null);
    const all: ContactRow[] = [];
    // Paged rather than one unbounded select: a long contacts table
    // should not become a single enormous response.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .not('phone', 'is', null)
        .order('created_at')
        .range(from, from + PAGE - 1);
      if (error) {
        toast.error('Could not load contacts');
        break;
      }
      const page = (data ?? []) as ContactRow[];
      all.push(...page);
      if (page.length < PAGE) break;
    }
    setContacts(all);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (!profileLoading) void load();
  }, [profileLoading, load]);

  const audit = useMemo(() => {
    if (!contacts) return null;
    return auditPhones(
      contacts.map((c) => ({ phone: c.phone, ref: c.id })),
      { defaultCountry: defaultCountryCode },
    );
  }, [contacts, defaultCountryCode]);

  const nameById = useMemo(
    () => new Map((contacts ?? []).map((c) => [c.id, c.name])),
    [contacts],
  );

  /**
   * Repairs split into what can actually be written and what cannot.
   *
   * `contacts.phone_normalized` is a generated column with a UNIQUE
   * index per account, so writing a cleaned number that another contact
   * already holds fails — and would fail the whole batch. Those rows are
   * one person stored twice; merging them is a judgement call about
   * which name, tags and history survive, so they are surfaced rather
   * than resolved here.
   */
  const { fixable, blocked } = useMemo(() => {
    const fixableRows: PhoneAuditRow[] = [];
    const blockedRows: { row: PhoneAuditRow; holder: string }[] = [];
    if (!audit || !contacts) return { fixable: fixableRows, blocked: blockedRows };

    // Every number currently in the table, by its digits.
    const holderByDigits = new Map<string, ContactRow>();
    for (const c of contacts) {
      holderByDigits.set(c.phone.replace(/\D/g, ''), c);
    }

    // "Fixable" is every sendable number whose STORED text is not already
    // the canonical +CC form — not just the ones that needed work to
    // parse. "919907275072" parses fine and reports no repairs, but it
    // is still stored without its "+", and the SQL and script versions of
    // this cleanup do rewrite it. Bucketing on `repairs.length` alone
    // made this page say "nothing to fix" about rows those would change.
    const needsRewrite = audit.rows.filter((r) => r.ok && r.input !== r.e164);

    for (const row of needsRewrite) {
      const holder = holderByDigits.get(row.msisdn!);
      if (holder && holder.id !== row.ref) {
        blockedRows.push({ row, holder: holder.name ?? holder.phone });
        continue;
      }
      // Claim it so two repairs in this run cannot both take one number.
      holderByDigits.set(row.msisdn!, {
        id: row.ref!,
        name: nameById.get(row.ref!) ?? null,
        phone: row.e164!,
      });
      fixableRows.push(row);
    }
    return { fixable: fixableRows, blocked: blockedRows };
  }, [audit, contacts, nameById]);

  async function handleFix() {
    if (!accountId || fixable.length === 0) return;
    setFixing(true);
    let done = 0;
    let failed = 0;

    for (let i = 0; i < fixable.length; i += FIX_BATCH) {
      const batch = fixable.slice(i, i + FIX_BATCH);
      const results = await Promise.all(
        batch.map((row) =>
          supabase.from('contacts').update({ phone: row.e164! }).eq('id', row.ref!),
        ),
      );
      for (const { error } of results) {
        if (error) failed++;
        else done++;
      }
    }

    setFixing(false);
    setFixedCount(done);
    if (failed > 0) {
      toast.error(`Fixed ${done}, but ${failed} could not be written`);
    } else {
      toast.success(`Fixed ${done} number${done === 1 ? '' : 's'}`);
    }
    await load();
  }

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!audit) return null;

  const total = audit.rows.length;
  const sendable = audit.rows.filter((r) => r.ok).length;
  const alreadyCanonical = audit.rows.filter((r) => r.ok && r.input === r.e164).length;

  return (
    <div className="space-y-6">
      {/* ── summary ─────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Users className="size-4 text-muted-foreground" />}
          label="Contacts with a number"
          value={total}
        />
        <StatCard
          icon={<CheckCircle2 className="size-4 text-emerald-500" />}
          label="Ready to message"
          value={alreadyCanonical}
        />
        <StatCard
          icon={<Wrench className="size-4 text-amber-500" />}
          label="Fixable"
          value={fixable.length}
          tone={fixable.length > 0 ? 'warn' : undefined}
        />
        <StatCard
          icon={<AlertTriangle className="size-4 text-destructive" />}
          label="Cannot be messaged"
          value={audit.rejected.length}
          tone={audit.rejected.length > 0 ? 'bad' : undefined}
        />
      </div>

      {!defaultCountryCode && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm text-foreground">
              <AlertTriangle className="size-4 text-amber-500" />
              No default country set
            </CardTitle>
            <CardDescription>
              Numbers saved without a country code cannot be resolved until this account
              picks a country. Set it in Settings → Phone format → Default country, then
              come back — most of them usually become fixable in one step. New
              contacts are cleaned automatically as they are added; this page is
              for the ones saved before that.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* ── fixable ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Wrench className="size-4 text-primary" />
              Fixable numbers
            </CardTitle>
            <CardDescription>
              {fixable.length === 0
                ? 'Nothing to fix — every number that can be resolved already is.'
                : `${fixable.length} number${fixable.length === 1 ? '' : 's'} can be rewritten into the international form WhatsApp needs. Nothing else about the contact changes.`}
            </CardDescription>
          </div>
          {fixable.length > 0 && (
            <GatedButton
              canAct={canEdit}
              gateReason="fix contact numbers"
              onClick={handleFix}
              disabled={fixing}
            >
              {fixing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ShieldCheck className="size-4" />
              )}
              Fix {fixable.length}
            </GatedButton>
          )}
        </CardHeader>
        {fixable.length > 0 && (
          <CardContent>
            <ChangeTable rows={fixable} nameById={nameById} />
          </CardContent>
        )}
        {fixedCount !== null && fixedCount > 0 && (
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
              {fixedCount} number{fixedCount === 1 ? '' : 's'} rewritten.
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── duplicates the cleaning revealed ────────────────────── */}
      {blocked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Users className="size-4 text-amber-500" />
              Same person, stored twice
            </CardTitle>
            <CardDescription>
              Cleaning these would produce a number another contact already holds — the
              same person written two ways. Merge them by hand so you choose which name,
              tags and conversation history survive.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <tbody>
                  {blocked.map(({ row, holder }) => (
                    <tr key={row.ref} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {row.input}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {nameById.get(row.ref!) ?? '—'}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        already held by <span className="text-foreground">{holder}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── unfixable, grouped by reason ────────────────────────── */}
      {audit.rejected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <AlertTriangle className="size-4 text-destructive" />
              Cannot be messaged
            </CardTitle>
            <CardDescription>
              These are excluded from every campaign. Each needs a person to look at it —
              the app will not invent the missing digits.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {(Object.keys(REJECTION_COPY) as PhoneRejection[])
              .filter((reason) => audit.rejectionCounts[reason] > 0)
              .map((reason) => (
                <div key={reason}>
                  <p className="text-sm font-medium text-foreground">
                    {REJECTION_COPY[reason].title}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {audit.rejectionCounts[reason]}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {REJECTION_COPY[reason].detail}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {audit.rejected
                      .filter((r) => r.rejection === reason)
                      .map((r) => (
                        <span
                          key={r.ref}
                          className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
                        >
                          <span className="font-mono">{r.input || '(blank)'}</span>
                          <span className="ml-1.5 text-muted-foreground">
                            {nameById.get(r.ref!) ?? '—'}
                          </span>
                        </span>
                      ))}
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          {sendable} of {total} contacts can currently be messaged.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading || fixing}>
          <RefreshCw className="size-3.5" />
          Re-check
        </Button>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'warn' | 'bad';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-4',
        tone === 'warn' && 'border-amber-500/40',
        tone === 'bad' && 'border-destructive/40',
      )}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function ChangeTable({
  rows,
  nameById,
}: {
  rows: PhoneAuditRow[];
  nameById: Map<string, string | null>;
}) {
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full min-w-[30rem] text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.ref} className="border-b border-border last:border-0">
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                {row.input}
              </td>
              <td className="py-2 pr-3">
                <ArrowRight className="size-3.5 text-muted-foreground" />
              </td>
              <td className="py-2 pr-4 font-mono text-xs text-foreground">{row.e164}</td>
              <td className="py-2 pr-4 text-muted-foreground">
                {nameById.get(row.ref!) ?? '—'}
              </td>
              <td className="py-2 text-right text-xs text-muted-foreground">
                {row.repairs.includes('country_code')
                  ? 'added country code'
                  : row.repairs.length > 0
                    ? 'reformatted'
                    : 'stored in international form'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
