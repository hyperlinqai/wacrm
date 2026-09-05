"use client"

import { use, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Filter,
  Loader2,
  RefreshCw,
  Send,
  Users,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { Automation } from "@wacrm/shared/types"
import type {
  AutomationReport,
  ReportRun,
  RunOutcome,
} from "@wacrm/shared/automations/report"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { toCsv, downloadCsv, slugForFilename } from "@/lib/csv"
import { formatRelative, triggerMeta } from "@/lib/automations/trigger-meta"

// The automation counterpart to the broadcast delivery report: which
// numbers this automation ran on, what it sent them, and what broke.
//
// Lives at the old /logs URL so the "View logs" menu item keeps working.

interface ReportResponse extends AutomationReport {
  automation: Automation
  runsTruncated: boolean
  runsLimit: number
}

const OUTCOMES: readonly RunOutcome[] = ["completed", "waiting", "failed"]

const OUTCOME_CLASSES: Record<RunOutcome, string> = {
  completed: "border-primary/30 bg-primary/10 text-primary",
  waiting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-300",
}

export default function AutomationReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("Automations.logs")

  const [data, setData] = useState<ReportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [outcomeFilter, setOutcomeFilter] = useState<RunOutcome | "all">("all")
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/automations/${id}/report`)
      const payload = await res.json().catch(() => null)
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`)
      setData(payload as ReportResponse)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadError"))
    } finally {
      setRefreshing(false)
    }
  }, [id, t])

  useEffect(() => {
    load()
  }, [load])

  const filteredRuns = useMemo(() => {
    if (!data) return []
    return outcomeFilter === "all"
      ? data.runs
      : data.runs.filter((r) => r.outcome === outcomeFilter)
  }, [data, outcomeFilter])

  function handleExport() {
    if (!data) return
    const header = [
      t("table.contact"),
      t("table.phone"),
      t("table.outcome"),
      t("table.trigger"),
      t("table.messages"),
      t("table.when"),
      t("table.nextRun"),
      t("table.error"),
    ]
    const rows = data.runs.map((r) => [
      r.contact?.name ?? "",
      r.contact?.phone ?? "",
      r.outcome,
      r.trigger_event,
      String(r.messagesSent),
      r.created_at,
      r.nextRunAt ?? "",
      r.steps.find((s) => s.status === "failed")?.detail ?? r.error_message ?? "",
    ])
    downloadCsv(
      `automation-${slugForFilename(data.automation.name)}-${id.slice(0, 8)}.csv`,
      toCsv([header, ...rows]),
    )
  }

  if (error && !data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => router.push("/automations")}>
          {t("back")}
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  const { automation, stats } = data
  const trigger = triggerMeta(automation.trigger_type)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push("/automations")}
            className="border-border"
            aria-label={t("backAria")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">
                {automation.name}
              </h1>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                  automation.is_active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-slate-500/30 bg-slate-500/10 text-muted-foreground",
                )}
              >
                {automation.is_active ? t("active") : t("paused")}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{t("title")}</span>
              <span aria-hidden>·</span>
              <span>{t("trigger", { name: trigger.label })}</span>
              <span aria-hidden>·</span>
              <span>
                {stats.lastRunAt
                  ? t("lastRun", { when: formatRelative(stats.lastRunAt) })
                  : t("neverRun")}
              </span>
            </div>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={refreshing}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          {t("refresh")}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t("stats.totalRuns")}
          value={stats.totalRuns}
          icon={<Activity className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t("stats.completed")}
          value={stats.completed}
          total={stats.totalRuns}
          icon={<CheckCircle2 className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t("stats.waiting")}
          value={stats.waiting}
          total={stats.totalRuns}
          icon={<Clock className="h-4 w-4" />}
          color="bg-amber-500/10 text-amber-400"
        />
        <StatCard
          label={t("stats.failed")}
          value={stats.failed}
          total={stats.totalRuns}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
        <StatCard
          label={t("stats.contactsReached")}
          value={stats.contactsReached}
          icon={<Users className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t("stats.messagesSent")}
          value={stats.messagesSent}
          icon={<Send className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
      </div>

      {/* Success rate + what is still in flight. A drip parked at a Wait
          step is the normal state, not a half-failure — say so plainly
          rather than leaving "waiting" to read as a warning. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("stats.successRate")}</p>
          <p className="mt-1 text-3xl font-bold text-foreground">
            {stats.successRate}%
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${stats.successRate}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {stats.waiting > 0 && stats.nextRunAt
              ? t("waitingHint", {
                  count: stats.waiting,
                  when: formatRelative(stats.nextRunAt),
                })
              : t("waitingHintNone")}
          </p>
        </div>

        <ErrorsPanel report={data} t={t} />
        <StepsPanel report={data} t={t} />
      </div>

      {data.daily.length > 1 && <ActivityChart daily={data.daily} t={t} />}

      {/* Runs */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {outcomeFilter === "all"
              ? t("runsTitle", { total: data.runs.length })
              : t("runsFiltered", {
                  filtered: filteredRuns.length,
                  total: data.runs.length,
                })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {outcomeFilter === "all"
                  ? t("allOutcomes")
                  : t(`outcome.${outcomeFilter}`)}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setOutcomeFilter("all")}
                  className={
                    outcomeFilter === "all"
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  {t("allOutcomes")}
                </DropdownMenuItem>
                {OUTCOMES.map((o) => (
                  <DropdownMenuItem
                    key={o}
                    onClick={() => setOutcomeFilter(o)}
                    className={
                      outcomeFilter === o
                        ? "text-primary"
                        : "text-popover-foreground"
                    }
                  >
                    {t(`outcome.${o}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={data.runs.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t("exportCsv")}
            </Button>
          </div>
        </div>

        {data.runsTruncated && (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            {t("truncated", { limit: data.runsLimit })}
          </p>
        )}

        {filteredRuns.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1">
            <p className="text-sm text-foreground">
              {data.runs.length === 0 ? t("noRuns") : t("noRunsFilter")}
            </p>
            {data.runs.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("noRunsDesc")}</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-8" />
                  <TableHead className="text-muted-foreground">
                    {t("table.contact")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.phone")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.outcome")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.messages")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.when")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.nextRun")}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t("table.error")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRuns.map((run) => (
                  <RunRows
                    key={run.id}
                    run={run}
                    open={openRunId === run.id}
                    onToggle={() =>
                      setOpenRunId(openRunId === run.id ? null : run.id)
                    }
                    t={t}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

type T = ReturnType<typeof useTranslations>

function StatCard({
  label,
  value,
  total,
  icon,
  color,
}: {
  label: string
  value: number
  /** Omit to hide the percentage — meaningless on a distinct-count card. */
  total?: number
  icon: React.ReactNode
  color: string
}) {
  const pct = total && total > 0 ? Math.round((value / total) * 100) : null
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", color)}>
          {icon}
        </div>
        {pct !== null && (
          <span className="text-xs text-muted-foreground">{pct}%</span>
        )}
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

/** The actionable half of the report: what is breaking, and how often. */
function ErrorsPanel({ report, t }: { report: AutomationReport; t: T }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground">{t("errorsTitle")}</h3>
      {report.topErrors.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("errorsEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {report.topErrors.map((e) => (
            <li key={e.message} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="mt-px shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 font-medium text-red-300">
                  {t("errorsCount", { count: e.count })}
                </span>
                <span className="min-w-0 flex-1 break-words text-muted-foreground">
                  {e.message}
                </span>
              </div>
              <p className="mt-0.5 pl-9 text-[11px] text-muted-foreground/70">
                {t("errorsLastSeen", { when: formatRelative(e.lastSeenAt) })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Per-step-type outcomes — makes one consistently failing step obvious. */
function StepsPanel({ report, t }: { report: AutomationReport; t: T }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground">{t("stepsTitle")}</h3>
      {report.stepBreakdown.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("stepsEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {report.stepBreakdown.slice(0, 6).map((s) => (
            <li key={s.stepType} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {s.stepType}
              </span>
              <span className="shrink-0 text-primary">
                {t("stepsOk", { count: s.success })}
              </span>
              {s.failed > 0 && (
                <span className="shrink-0 text-red-400">
                  {t("stepsFailed", { count: s.failed })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Runs per day. Plain CSS bars — same approach as the broadcast funnel. */
function ActivityChart({
  daily,
  t,
}: {
  daily: AutomationReport["daily"]
  t: T
}) {
  const max = Math.max(...daily.map((d) => d.total), 1)
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">
        {t("activityTitle")}
      </h3>
      <div className="flex h-28 items-end gap-1 overflow-x-auto">
        {daily.map((d) => {
          const okHeight = Math.round(((d.total - d.failed) / max) * 100)
          const failHeight = Math.round((d.failed / max) * 100)
          return (
            <div
              key={d.date}
              className="flex min-w-[10px] flex-1 flex-col justify-end gap-px"
              title={`${d.date}: ${d.total} (${d.failed} failed)`}
            >
              {failHeight > 0 && (
                <div
                  className="rounded-t bg-red-500/70"
                  style={{ height: `${failHeight}%` }}
                />
              )}
              <div
                className={cn("bg-primary/70", failHeight === 0 && "rounded-t")}
                style={{ height: `${okHeight}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </div>
  )
}

function RunRows({
  run,
  open,
  onToggle,
  t,
}: {
  run: ReportRun
  open: boolean
  onToggle: () => void
  t: T
}) {
  const reason =
    run.steps.find((s) => s.status === "failed")?.detail ?? run.error_message

  return (
    <>
      <TableRow
        className="cursor-pointer border-border"
        onClick={onToggle}
        aria-expanded={open}
      >
        <TableCell className="text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </TableCell>
        <TableCell className="font-medium text-foreground">
          {run.contact?.name ?? t("unknownContact")}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {run.contact?.phone ?? "-"}
        </TableCell>
        <TableCell>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
              OUTCOME_CLASSES[run.outcome],
            )}
            title={t(`outcomeHelp.${run.outcome}`)}
          >
            {t(`outcome.${run.outcome}`)}
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground">{run.messagesSent}</TableCell>
        <TableCell className="text-muted-foreground">
          {new Date(run.created_at).toLocaleString()}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {run.nextRunAt ? formatRelative(run.nextRunAt) : "-"}
        </TableCell>
        <TableCell className="max-w-xs truncate text-xs text-red-400">
          {run.outcome === "failed" ? (reason ?? "-") : "-"}
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="border-border hover:bg-transparent">
          <TableCell colSpan={8} className="bg-muted/30 px-6 py-3">
            {run.error_message && (
              <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {run.error_message}
              </p>
            )}
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              {run.trigger_event}
            </p>
            {run.steps.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noSteps")}</p>
            ) : (
              <ul className="space-y-1.5">
                {run.steps.map((s, i) => {
                  const ok = s.status === "success"
                  return (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                          ok
                            ? "bg-primary/20 text-primary"
                            : s.status === "skipped"
                              ? "bg-muted text-muted-foreground"
                              : "bg-red-500/20 text-red-400",
                        )}
                        aria-hidden
                      >
                        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      </span>
                      <span className="text-foreground">{s.step_type}</span>
                      {s.detail && (
                        <span className="min-w-0 break-words text-muted-foreground">
                          — {s.detail}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
