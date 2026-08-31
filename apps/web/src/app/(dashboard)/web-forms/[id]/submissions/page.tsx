"use client"

import { use, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { LeadForm, LeadFormSubmission } from "@wacrm/shared/types"

const PAGE_SIZE = 50

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

export default function WebFormSubmissionsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("WebForms.submissions")
  const [form, setForm] = useState<LeadForm | null>(null)
  const [submissions, setSubmissions] = useState<LeadFormSubmission[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const formRes = await fetch(`/api/web-forms/${id}`)
      if (!formRes.ok) {
        if (!cancelled) setError(t("loadError"))
        return
      }
      const formBody = (await formRes.json()) as { form: LeadForm }

      const subsRes = await fetch(`/api/web-forms/${id}/submissions?page=0`)
      if (!subsRes.ok) {
        if (!cancelled) setError(t("loadError"))
        return
      }
      const subsBody = (await subsRes.json()) as { submissions: LeadFormSubmission[] }

      if (cancelled) return
      setForm(formBody.form)
      setSubmissions(subsBody.submissions)
      setHasMore(subsBody.submissions.length === PAGE_SIZE)
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [id])

  async function loadMore() {
    const nextPage = page + 1
    setLoadingMore(true)
    const res = await fetch(`/api/web-forms/${id}/submissions?page=${nextPage}`)
    setLoadingMore(false)
    if (!res.ok) return
    const body = (await res.json()) as { submissions: LeadFormSubmission[] }
    setSubmissions((prev) => [...prev, ...body.submissions])
    setPage(nextPage)
    setHasMore(body.submissions.length === PAGE_SIZE)
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => router.push("/web-forms")}>
          {t("back")}
        </Button>
      </div>
    )
  }

  if (loading || !form) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title", { name: form.name })}</h1>
      </div>

      {submissions.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {form.fields.map((field) => (
                  <TableHead key={field.id}>{field.label}</TableHead>
                ))}
                <TableHead>{t("receivedColumn")}</TableHead>
                <TableHead>{t("contactColumn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.map((submission) => (
                <TableRow key={submission.id}>
                  {form.fields.map((field) => (
                    <TableCell key={field.id}>{submission.payload[field.id] ?? "—"}</TableCell>
                  ))}
                  <TableCell>{formatDate(submission.created_at)}</TableCell>
                  <TableCell>
                    {submission.contact_id ? (
                      <Link
                        // No /contacts/[id] page exists; the contacts list
                        // opens the detail sheet for ?contact=<id>.
                        href={`/contacts?contact=${encodeURIComponent(submission.contact_id)}`}
                        className="text-primary hover:underline"
                      >
                        {t("viewContact")}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {hasMore && submissions.length > 0 && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}
