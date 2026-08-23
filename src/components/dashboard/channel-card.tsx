import Link from 'next/link'
import type { ChannelSlice } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { useTranslations } from 'next-intl'

const TONE: Record<
  ChannelSlice['id'],
  { ring: string; track: string }
> = {
  whatsapp: { ring: '#22c55e', track: 'color-mix(in oklab, #22c55e 18%, transparent)' },
  inbox: { ring: '#3b82f6', track: 'color-mix(in oklab, #3b82f6 18%, transparent)' },
  broadcasts: { ring: '#a855f7', track: 'color-mix(in oklab, #a855f7 18%, transparent)' },
  automations: { ring: '#f59e0b', track: 'color-mix(in oklab, #f59e0b 18%, transparent)' },
}

export function ChannelCard({
  slice,
  href,
}: {
  slice: ChannelSlice
  href: string
}) {
  const t = useTranslations('Dashboard.channels')
  const pct = slice.rate == null ? 0 : Math.round(slice.rate * 100)
  const tone = TONE[slice.id]

  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 shadow-sm transition-colors hover:bg-muted/40"
    >
      <Ring pct={pct} color={tone.ring} track={tone.track} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {t(slice.id)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('count', { count: slice.count })}
        </p>
      </div>
      <p
        className={cn(
          'text-sm font-bold tabular-nums',
          slice.rate == null ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {slice.rate == null ? '—' : `${pct}%`}
      </p>
    </Link>
  )
}

function Ring({
  pct,
  color,
  track,
}: {
  pct: number
  color: string
  track: string
}) {
  const r = 16
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <svg viewBox="0 0 40 40" className="size-11 shrink-0" aria-hidden>
      <circle cx="20" cy="20" r={r} fill="none" stroke={track} strokeWidth="5" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * c} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  )
}
