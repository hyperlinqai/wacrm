"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { LeadFormBuilder } from "@/components/web-forms/lead-form-builder"
import type { LeadForm } from "@/types"

export default function EditWebFormPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("WebForms.builder")
  const [form, setForm] = useState<LeadForm | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res = await fetch(`/api/web-forms/${id}`)
      if (!res.ok) {
        if (!cancelled) setError(t("loadError", { status: res.status }))
        return
      }
      const body = await res.json()
      if (!cancelled) setForm(body.form as LeadForm)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={() => router.push("/web-forms")}
          className="text-sm text-primary hover:text-primary/80"
        >
          {t("backToWebForms")}
        </button>
      </div>
    )
  }

  if (!form) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return <LeadFormBuilder mode="edit" formId={id} initial={form} />
}
