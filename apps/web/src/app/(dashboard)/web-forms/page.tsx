"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Copy,
  FileText,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Table as TableIcon,
  Trash2,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { LeadForm } from "@wacrm/shared/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmbedCodeDialog } from "@/components/web-forms/embed-code-dialog"

export default function WebFormsPage() {
  const router = useRouter()
  const canCreate = useCan("edit-settings")
  const t = useTranslations("WebForms.list")
  const [forms, setForms] = useState<LeadForm[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LeadForm | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [embedTarget, setEmbedTarget] = useState<LeadForm | null>(null)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("lead_forms")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setForms((data ?? []) as LeadForm[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load web forms")
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(form: LeadForm, next: boolean) {
    const nextStatus = next ? "active" : "paused"
    // Optimistic flip so the switch feels instant.
    setForms((prev) =>
      prev?.map((f) => (f.id === form.id ? { ...f, status: nextStatus } : f)) ?? prev,
    )
    const res = await fetch(`/api/web-forms/${form.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    })
    if (!res.ok) {
      // Roll back on error.
      setForms((prev) =>
        prev?.map((f) => (f.id === form.id ? { ...f, status: form.status } : f)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(form: LeadForm) {
    const res = await fetch(`/api/web-forms/${form.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/web-forms/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (forms === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create web forms"
          onClick={() => router.push("/web-forms/new")}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t("create")}
        </GatedButton>
      </div>

      {forms.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <FileText className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyDesc")}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="outline"
              onClick={() => router.push("/web-forms/new?template=contact-us")}
            >
              {t("templateContactUs")}
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/web-forms/new?template=newsletter")}
            >
              {t("templateNewsletter")}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {forms.map((form) => (
            <WebFormCard
              key={form.id}
              form={form}
              onToggle={(next) => toggleActive(form, next)}
              onEdit={() => router.push(`/web-forms/${form.id}/edit`)}
              onDuplicate={() => duplicate(form)}
              onCopyEmbed={() => setEmbedTarget(form)}
              onSubmissions={() => router.push(`/web-forms/${form.id}/submissions`)}
              onDelete={() => setPendingDelete(form)}
              t={t}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {embedTarget && (
        <EmbedCodeDialog
          open={!!embedTarget}
          onOpenChange={(v) => !v && setEmbedTarget(null)}
          formId={embedTarget.id}
          formName={embedTarget.name}
        />
      )}
    </div>
  )
}

function WebFormCard({
  form,
  onToggle,
  onEdit,
  onDuplicate,
  onCopyEmbed,
  onSubmissions,
  onDelete,
  t,
}: {
  form: LeadForm
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onCopyEmbed: () => void
  onSubmissions: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <li className="rounded-xl border border-border bg-card transition-colors hover:border-border">
      <div className="flex items-center gap-4 p-4">
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10"
          aria-hidden
        >
          <FileText className="h-5 w-5 text-primary" />
        </div>

        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{form.name}</span>
            {form.status === "active" && (
              <span className="relative flex h-2 w-2" aria-label="active">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {form.submit_count === 1
                ? t("submissionCount", { count: form.submit_count })
                : t("submissionCountPlural", { count: form.submit_count })}
            </span>
            {form.status === "archived" && (
              <>
                <span aria-hidden>·</span>
                <span>{t("archivedLabel")}</span>
              </>
            )}
          </div>
        </button>

        <div className="flex items-center gap-3">
          <Switch
            checked={form.status === "active"}
            onCheckedChange={(v) => onToggle(!!v)}
            aria-label={form.status === "active" ? t("deactivate") : t("activate")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open menu"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyEmbed}>
                <FileText className="h-4 w-4" />
                {t("copyEmbed")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onSubmissions}>
                <TableIcon className="h-4 w-4" />
                {t("viewSubmissions")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
