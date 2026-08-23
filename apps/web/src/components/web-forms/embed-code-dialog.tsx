"use client"

import { Copy } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

// The embed snippet is always exactly this one script tag — no data
// attributes, no companion div. The widget script itself renders the
// form into the page at the point it's loaded from.
function embedSnippet(formId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  return `<script src="${origin}/api/public/lead-forms/${formId}/widget.js" async></script>`
}

export function EmbedCodeDialog({
  open,
  onOpenChange,
  formId,
  formName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formId: string
  formName: string
}) {
  const t = useTranslations("WebForms.embedDialog")
  const snippet = embedSnippet(formId)

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { name: formName })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-muted-foreground">{t("snippetLabel")}</Label>
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">
            <code>{snippet}</code>
          </pre>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
          <Button onClick={copy}>
            <Copy className="h-4 w-4" />
            {t("copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
