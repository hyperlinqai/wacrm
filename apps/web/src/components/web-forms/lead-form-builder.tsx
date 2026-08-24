"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { parseAllowedDomains } from "@/lib/web-forms/domains"
import type { LeadForm, LeadFormField, LeadFormStatus, LeadFormStyle } from "@/types"
import { EmbedCodeDialog } from "./embed-code-dialog"
import { FieldListEditor } from "./field-list-editor"

const FONT_OPTIONS = [
  { value: "system-ui, -apple-system, sans-serif", labelKey: "fontOptions.system" },
  { value: "Georgia, 'Times New Roman', serif", labelKey: "fontOptions.georgia" },
  { value: "'Inter', system-ui, -apple-system, sans-serif", labelKey: "fontOptions.inter" },
] as const

const STATUS_OPTIONS: LeadFormStatus[] = ["active", "paused", "archived"]

interface LeadFormBuilderProps {
  mode: "create" | "edit"
  /** Required in edit mode — the id being edited. */
  formId?: string
  /** Edit mode — the form as loaded from the API. */
  initial?: LeadForm
  /** Create mode — a starting name + field set from a `?template=` pick. */
  initialTemplate?: { name: string; fields: LeadFormField[] }
}

interface BuilderState {
  name: string
  status: LeadFormStatus
  fields: LeadFormField[]
  style: LeadFormStyle
  /** Raw comma-separated text; parsed into `allowed_domains` on save. */
  allowedDomainsText: string
}

function resolveInitial(props: LeadFormBuilderProps): BuilderState {
  if (props.initial) {
    return {
      name: props.initial.name,
      status: props.initial.status,
      fields: props.initial.fields,
      style: props.initial.style ?? {},
      allowedDomainsText: (props.initial.allowed_domains ?? []).join(", "),
    }
  }
  if (props.initialTemplate) {
    return {
      name: props.initialTemplate.name,
      status: "active",
      fields: props.initialTemplate.fields,
      style: {},
      allowedDomainsText: "",
    }
  }
  return { name: "", status: "active", fields: [], style: {}, allowedDomainsText: "" }
}

export function LeadFormBuilder(props: LeadFormBuilderProps) {
  const { mode, formId } = props
  const router = useRouter()
  const t = useTranslations("WebForms.builder")
  const isEditing = mode === "edit"

  const [state, setState] = useState<BuilderState>(() => resolveInitial(props))
  const [saving, setSaving] = useState(false)
  const [createdForm, setCreatedForm] = useState<LeadForm | null>(null)

  const hasPhoneField = useMemo(
    () => state.fields.some((f) => f.type === "phone"),
    [state.fields],
  )
  const canSave = state.name.trim().length > 0 && state.fields.length > 0 && hasPhoneField

  function patchStyle(patch: Partial<LeadFormStyle>) {
    setState((s) => ({ ...s, style: { ...s.style, ...patch } }))
  }

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        name: state.name.trim(),
        fields: state.fields,
        style: state.style,
        // Normalized hostnames only (no scheme/path/"www.") — the same
        // rule the submit route matches an Origin with.
        allowed_domains: parseAllowedDomains(state.allowedDomainsText),
      }
      if (isEditing) payload.status = state.status

      const res = isEditing
        ? await fetch(`/api/web-forms/${formId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/web-forms", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body?.error ?? t("toasts.saveFailed"))
        return
      }

      if (isEditing) {
        toast.success(t("toasts.saved"))
        router.push("/web-forms")
      } else {
        toast.success(t("toasts.created"))
        // Show the embed snippet right away instead of making the user
        // hunt for "Copy embed code" in the list afterward. Redirect
        // happens when they close this dialog.
        setCreatedForm(body.form as LeadForm)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/web-forms")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToWebForms")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-xl font-bold text-foreground">
          {isEditing ? t("editTitle") : t("createTitle")}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("nameSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lead-form-name">{t("nameLabel")}</Label>
            <Input
              id="lead-form-name"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              placeholder={t("namePlaceholder")}
            />
          </div>
          {isEditing && (
            <div className="space-y-1.5">
              <Label>{t("statusLabel")}</Label>
              <Select
                value={state.status}
                onValueChange={(v) => v && setState((s) => ({ ...s, status: v as LeadFormStatus }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{t(`statusOptions.${state.status}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`statusOptions.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("fieldsSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!hasPhoneField && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("phoneFieldRequiredTitle")}</AlertTitle>
              <AlertDescription>{t("phoneFieldRequiredDesc")}</AlertDescription>
            </Alert>
          )}
          <FieldListEditor
            fields={state.fields}
            onChange={(fields) => setState((s) => ({ ...s, fields }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("appearanceSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("primaryColorLabel")}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={state.style.primaryColor ?? "#2563eb"}
                onChange={(e) => patchStyle({ primaryColor: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-input bg-transparent p-0.5"
                aria-label={t("primaryColorLabel")}
              />
              <Input
                value={state.style.primaryColor ?? ""}
                onChange={(e) => patchStyle({ primaryColor: e.target.value })}
                placeholder="#2563eb"
                className="max-w-32 font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lead-form-button-text">{t("buttonTextLabel")}</Label>
            <Input
              id="lead-form-button-text"
              value={state.style.buttonText ?? ""}
              onChange={(e) => patchStyle({ buttonText: e.target.value })}
              placeholder={t("buttonTextPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("fontFamilyLabel")}</Label>
            <Select
              value={state.style.fontFamily ?? FONT_OPTIONS[0].value}
              onValueChange={(v) => v && patchStyle({ fontFamily: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {t(
                    FONT_OPTIONS.find((f) => f.value === (state.style.fontFamily ?? FONT_OPTIONS[0].value))
                      ?.labelKey ?? "fontOptions.system",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.map((font) => (
                  <SelectItem key={font.value} value={font.value}>
                    {t(font.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lead-form-success-message">{t("successMessageLabel")}</Label>
            <Textarea
              id="lead-form-success-message"
              value={state.style.successMessage ?? ""}
              onChange={(e) => patchStyle({ successMessage: e.target.value })}
              placeholder={t("successMessagePlaceholder")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("domainsSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={state.allowedDomainsText}
            onChange={(e) => setState((s) => ({ ...s, allowedDomainsText: e.target.value }))}
            placeholder="example.com, www.example.com"
            className="min-h-16"
          />
          <p className="text-xs text-muted-foreground">{t("allowedDomainsHint")}</p>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/web-forms")} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={handleSave} disabled={!canSave || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? t("saving") : t("save")}
        </Button>
      </div>

      {createdForm && (
        <EmbedCodeDialog
          open={!!createdForm}
          onOpenChange={(open) => {
            if (!open) {
              setCreatedForm(null)
              router.push("/web-forms")
            }
          }}
          formId={createdForm.id}
          formName={createdForm.name}
        />
      )}
    </div>
  )
}
