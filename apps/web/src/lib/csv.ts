// CSV export shared by the report pages (broadcast delivery, automation
// runs). Extracted from the broadcast page when the automation report
// became the second caller.

/**
 * RFC 4180 serialization. Every field is quoted so commas, newlines and
 * quotes inside a value round-trip cleanly into a spreadsheet.
 */
export function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
  return rows.map((r) => r.map(escape).join(',')).join('\n')
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** "SPX · Stage 01" -> "spx-stage-01", safe for a download filename. */
export function slugForFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
}
