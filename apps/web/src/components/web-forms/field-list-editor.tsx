"use client"

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { LeadFormField, LeadFormFieldType } from "@/types"

const FIELD_TYPES: LeadFormFieldType[] = ["text", "email", "phone", "textarea", "select"]

export function blankField(): LeadFormField {
  return {
    id: `field_${crypto.randomUUID()}`,
    type: "text",
    label: "",
    required: false,
  }
}

export function FieldListEditor({
  fields,
  onChange,
}: {
  fields: LeadFormField[]
  onChange: (fields: LeadFormField[]) => void
}) {
  const t = useTranslations("WebForms.builder")

  function updateField(index: number, patch: Partial<LeadFormField>) {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  function removeField(index: number) {
    onChange(fields.filter((_, i) => i !== index))
  }

  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= fields.length) return
    const next = [...fields]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {fields.map((field, index) => (
        <div key={field.id} className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_1fr]">
            <Select
              value={field.type}
              onValueChange={(v) => v && updateField(index, { type: v as LeadFormFieldType })}
            >
              <SelectTrigger className="w-full bg-background">
                <SelectValue>{t(`fieldTypes.${field.type}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`fieldTypes.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={field.label}
              onChange={(e) => updateField(index, { label: e.target.value })}
              placeholder={t("fieldLabelPlaceholder")}
              className="bg-background"
            />
            <Input
              value={field.placeholder ?? ""}
              onChange={(e) => updateField(index, { placeholder: e.target.value })}
              placeholder={t("fieldPlaceholderPlaceholder")}
              className="bg-background"
            />
          </div>

          {field.type === "select" && (
            <Input
              className="mt-2 bg-background"
              value={(field.options ?? []).join(", ")}
              onChange={(e) =>
                updateField(index, {
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={t("fieldOptionsPlaceholder")}
            />
          )}

          <div className="mt-2 flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={!!field.required}
                onCheckedChange={(checked) => updateField(index, { required: checked === true })}
              />
              {t("fieldRequired")}
            </label>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={index === 0}
                aria-label={t("moveFieldUp")}
                onClick={() => moveField(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={index === fields.length - 1}
                aria-label={t("moveFieldDown")}
                onClick={() => moveField(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeField")}
                onClick={() => removeField(index)}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" onClick={() => onChange([...fields, blankField()])}>
        {t("addField")}
      </Button>
    </div>
  )
}
