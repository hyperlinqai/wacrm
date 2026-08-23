"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'

import {
  loadActivity,
  loadChannelBreakdown,
  loadContactSpark,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  CockpitChannels,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { KpiCard } from '@/components/dashboard/kpi-card'
import { ChannelCard } from '@/components/dashboard/channel-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useTranslations, useLocale } from 'next-intl'
import { useIsClient } from '@/hooks/use-is-client'

type RangeDays = 7 | 30 | 90

const CHANNEL_HREF = {
  whatsapp: '/inbox',
  inbox: '/inbox',
  broadcasts: '/broadcasts',
  automations: '/automations',
} as const

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const tRange = useTranslations('Dashboard.conversationsChart')
  const locale = useLocale()
  const isClient = useIsClient()
  const { defaultCurrency } = useAuth()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  const [range, setRange] = useState<RangeDays>(30)
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [contactSpark, setContactSpark] = useState<Record<RangeDays, number[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [channels, setChannels] = useState<Record<RangeDays, CockpitChannels | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  const loadAll = useCallback(() => {
    const db = createClient()

    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false))

    void Promise.all([
      loadConversationsSeries(db, 30),
      loadContactSpark(db, 30),
      loadChannelBreakdown(db, 30),
    ])
      .then(([s, spark, ch]) => {
        setSeries((prev) => ({ ...prev, 30: s }))
        setContactSpark((prev) => ({ ...prev, 30: spark }))
        setChannels((prev) => ({ ...prev, 30: ch }))
      })
      .catch((err) => console.error('[dashboard] series failed:', err))
      .finally(() => setSeriesLoading(false))

    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => console.error('[dashboard] pipeline failed:', err))
      .finally(() => setPipelineLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => console.error('[dashboard] response time failed:', err))
      .finally(() => setResponseTimeLoading(false))

    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null && contactSpark[r] !== null && channels[r] !== null) return
      setSeriesLoading(true)
      const db = createClient()
      Promise.all([
        loadConversationsSeries(db, r),
        loadContactSpark(db, r),
        loadChannelBreakdown(db, r),
      ])
        .then(([s, spark, ch]) => {
          setSeries((prev) => ({ ...prev, [r]: s }))
          setContactSpark((prev) => ({ ...prev, [r]: spark }))
          setChannels((prev) => ({ ...prev, [r]: ch }))
        })
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false))
    },
    [series, contactSpark, channels],
  )

  const attention = useMemo(() => {
    if (!metrics) return []
    const items: { href: string; label: string }[] = []
    if (!metrics.whatsappConnected) {
      items.push({ href: '/settings?tab=whatsapp', label: t('attentionWhatsapp') })
    }
    if (metrics.failedBroadcasts > 0) {
      items.push({
        href: '/broadcasts',
        label: t('attentionBroadcasts', { count: metrics.failedBroadcasts }),
      })
    }
    return items
  }, [metrics, t])

  const todayLabel = isClient
    ? new Date().toLocaleDateString(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : ''

  const contactGrowth =
    metrics && metrics.contactsPreviousWindow > 0
      ? ((metrics.totalContacts - metrics.contactsPreviousWindow) /
          metrics.contactsPreviousWindow) *
        100
      : metrics && metrics.totalContacts > 0
        ? 100
        : 0

  const messagesSpark = (series[range] ?? []).map((p) => p.outgoing)
  const messagesTotal = messagesSpark.reduce((s, n) => s + n, 0)
  const prevHalf = messagesSpark.slice(0, Math.floor(messagesSpark.length / 2))
  const nextHalf = messagesSpark.slice(Math.floor(messagesSpark.length / 2))
  const prevSum = prevHalf.reduce((s, n) => s + n, 0)
  const nextSum = nextHalf.reduce((s, n) => s + n, 0)
  const messagesGrowth = prevSum === 0 ? (nextSum > 0 ? 100 : 0) : ((nextSum - prevSum) / prevSum) * 100

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight text-foreground">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{todayLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-card p-1">
            {([7, 30, 90] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => handleRangeChange(r)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                  range === r
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tRange('days', { count: r })}
              </button>
            ))}
          </div>
          {attention.length > 0 ? (
            <Link
              href={attention[0].href}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-300/80 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
            >
              <AlertTriangle className="size-3.5" />
              {t('attentionBanner', { count: attention.length })}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <KpiCard
              title={t('totalContacts')}
              value={metrics.totalContacts.toLocaleString()}
              deltaPct={contactGrowth}
              spark={contactSpark[range] ?? undefined}
              sparkColor="#3b82f6"
            />
            <KpiCard
              title={t('messagesSent')}
              value={messagesTotal.toLocaleString()}
              deltaPct={messagesGrowth}
              spark={messagesSpark}
              sparkColor="var(--primary)"
            />
            <KpiCard
              title={t('activeAutomations')}
              value={`${metrics.automationsActive}/${metrics.automationsTotal}`}
              hint={t('workflows')}
              bar={{
                current: metrics.automationsActive,
                total: Math.max(metrics.automationsTotal, 1),
              }}
            />
            <KpiCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              hint={t('openDeals', { count: metrics.openDealsCount })}
              bar={{
                current: metrics.openDealsCount,
                total: Math.max(metrics.openDealsCount, 1),
                tone: 'violet',
              }}
            />
          </>
        )}
      </div>

      <QuickActions />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="h-full xl:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
            showRangeTabs={false}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:col-span-2 xl:grid-cols-1">
          {(channels[range]?.slices ?? []).map((slice) => (
            <ChannelCard key={slice.id} slice={slice} href={CHANNEL_HREF[slice.id]} />
          ))}
          {seriesLoading && !channels[range]
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            currency={defaultCurrency}
          />
        </div>
      </div>

      <ActivityFeed items={activity} loading={activityLoading} />
    </div>
  )
}
