"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"

import { LeadFormBuilder } from "@/components/web-forms/lead-form-builder"
import type { LeadFormField } from "@wacrm/shared/types"

type TemplateSlug = "contact-us" | "newsletter"

function templateFor(slug: TemplateSlug | null): { name: string; fields: LeadFormField[] } | undefined {
  if (slug === "contact-us") {
    return {
      name: "Contact Us",
      fields: [
        { id: "name", type: "text", label: "Name", required: false },
        { id: "phone", type: "phone", label: "Phone", required: true },
        { id: "email", type: "email", label: "Email", required: false },
        { id: "message", type: "textarea", label: "Message", required: false },
      ],
    }
  }
  if (slug === "newsletter") {
    return {
      name: "Newsletter Signup",
      fields: [
        { id: "name", type: "text", label: "Name", required: false },
        { id: "email", type: "email", label: "Email", required: true },
      ],
    }
  }
  return undefined
}

// `useSearchParams` requires a Suspense boundary or the production build
// bails to CSR and errors out. Thin wrapper supplies it; the inner
// component reads the `?template=` query string.
export default function NewWebFormPage() {
  return (
    <Suspense fallback={null}>
      <NewWebFormPageInner />
    </Suspense>
  )
}

function NewWebFormPageInner() {
  const params = useSearchParams()
  const template = params.get("template") as TemplateSlug | null
  const initialTemplate = useMemo(() => templateFor(template), [template])

  return <LeadFormBuilder mode="create" initialTemplate={initialTemplate} />
}
