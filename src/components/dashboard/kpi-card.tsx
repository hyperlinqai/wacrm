import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface KpiCardProps {
  title: string
  value: string
  hint?: string
  deltaPct?: number | null
  spark?: number[]
  sparkColor?: string
  bar?: { current: number; total: number; tone?: 'lime' | 'violet' }
}

export function KpiCard({
  title,
  value,
  hint,
  deltaPct,
  spark,
  sparkColor = 'var(--chart-2)',
  bar,
}: KpiCardProps) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-[32px] leading-none font-extrabold tracking-tight tabular-nums text-foreground">
          {value}
        </p>
        {spark && spark.length > 1 ? (
          <Sparkline values={spark} color={sparkColor} />
        ) : null}
      </div>
      {typeof deltaPct === 'number' && Number.isFinite(deltaPct) ? (
        <DeltaPct value={deltaPct} />
      ) : hint ? (
        <p className="mt-3 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      {bar ? (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                bar.tone === 'violet' ? 'bg-chart-3' : 'bg-primary',
              )}
              style={{
                width: `${bar.total === 0 ? 0 : Math.min(100, (bar.current / bar.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DeltaPct({ value }: { value: number }) {
  const up = value >= 0
  const Arrow = up ? ArrowUp : ArrowDown
  return (
    <p
      className={cn(
        'mt-3 flex items-center gap-1 text-sm font-semibold tabular-nums',
        up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
      )}
    >
      <Arrow className="size-3.5" aria-hidden />
      {up ? '+' : ''}
      {value.toFixed(1)}%
    </p>
  )
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1)
  const w = 88
  const h = 36
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => {
    const x = i * step
    const y = h - (v / max) * (h - 4) - 2
    return `${x},${y}`
  })
  const line = `M${pts.join(' L')}`
  const area = `${line} L${w},${h} L0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-[88px] shrink-0" aria-hidden>
      <path d={area} fill={color} opacity={0.18} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
