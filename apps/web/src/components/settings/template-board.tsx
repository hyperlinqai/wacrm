"use client";

import { useState } from "react";
import { BookOpen, ExternalLink, LayoutGrid, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { MessageTemplate, TemplateButton } from "@wacrm/shared/types";
import { templateStatusConfig } from "@/lib/template-status";
import {
  STARTER_INDUSTRIES,
  startersByIndustry,
  type StarterIndustryId,
  type StarterTemplate,
} from "@/lib/whatsapp/starter-templates";

export type TemplateBoardTab = "library" | "active" | "deleted";

const COLUMN_DOT: Record<
  StarterIndustryId | "Marketing" | "Utility" | "Authentication",
  string
> = {
  marketing_agency: "bg-violet-500",
  automation: "bg-emerald-500",
  real_estate: "bg-sky-500",
  service_business: "bg-amber-500",
  restaurant: "bg-orange-500",
  ecommerce: "bg-pink-500",
  clinic: "bg-teal-500",
  Marketing: "bg-emerald-500",
  Utility: "bg-sky-500",
  Authentication: "bg-amber-500",
};

function highlightBody(text: string) {
  const parts = text.split(/(\{\{\d+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{\d+\}\}$/.test(part) ? (
      <span key={i} className="font-semibold text-emerald-700 dark:text-emerald-300">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ButtonChip({ button }: { button: TemplateButton }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
      {button.type === "URL" ? <ExternalLink className="size-3 shrink-0" /> : null}
      <span className="truncate">{button.text || button.type}</span>
    </span>
  );
}

function TemplatePreviewCard({
  title,
  body,
  buttons,
  slug,
  badge,
  onClick,
  onDelete,
  deleting,
}: {
  title: string;
  body: string;
  buttons?: TemplateButton[] | null;
  slug: string;
  badge: string;
  onClick: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  return (
    <div className="group relative flex w-full flex-col rounded-xl border border-border bg-card p-3.5 shadow-sm transition-colors hover:border-primary/40 hover:bg-card-2">
      <button type="button" onClick={onClick} className="w-full flex flex-col text-left">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="mt-0.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground">
            →
          </span>
        </div>
        <p className="line-clamp-4 text-[13px] leading-5 text-muted-foreground">
          {highlightBody(body)}
        </p>
        {buttons && buttons.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {buttons.map((b, i) => (
              <ButtonChip key={`${b.type}-${i}`} button={b} />
            ))}
          </div>
        ) : null}
        <div className="mt-3 flex items-end justify-between gap-2">
          <span className="truncate font-mono text-[10px] text-muted-foreground/80">
            {slug}
          </span>
          <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:text-emerald-200">
            {badge}
          </span>
        </div>
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          className="absolute top-2 right-8 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
          aria-label="Delete template"
        >
          {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </button>
      ) : null}
    </div>
  );
}

function BoardColumn({
  label,
  dotClass,
  count,
  children,
  className,
}: {
  label: string;
  dotClass: string;
  count: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-[260px] flex-1 flex-col gap-3", className)}>
      <div className="flex items-center gap-2 px-0.5">
        <span className={cn("size-2 rounded-full", dotClass)} />
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {label}
        </h2>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function TemplateBoard({
  tab,
  onTabChange,
  templates,
  loading,
  onUseStarter,
  onOpenTemplate,
  onDeleteTemplate,
  deletingId,
}: {
  tab: TemplateBoardTab;
  onTabChange: (tab: TemplateBoardTab) => void;
  templates: MessageTemplate[];
  loading: boolean;
  onUseStarter: (starter: StarterTemplate) => void;
  onOpenTemplate: (template: MessageTemplate) => void;
  onDeleteTemplate?: (template: MessageTemplate) => void;
  deletingId?: string | null;
}) {
  const t = useTranslations("Settings.templates");
  const [industryFilter, setIndustryFilter] = useState<StarterIndustryId | "all">(
    "all",
  );

  const visibleIndustries =
    industryFilter === "all" ? STARTER_INDUSTRIES : [industryFilter];

  const active = templates.filter(
    (row) => row.status !== "PENDING_DELETION" && row.status !== "DISABLED",
  );
  const deleted = templates.filter(
    (row) => row.status === "PENDING_DELETION" || row.status === "DISABLED",
  );

  const tabs: { id: TemplateBoardTab; label: string; icon: typeof BookOpen; count?: number }[] =
    [
      { id: "library", label: t("tabLibrary"), icon: BookOpen },
      { id: "active", label: t("tabActive"), icon: LayoutGrid, count: active.length },
      { id: "deleted", label: t("tabDeleted"), icon: Trash2, count: deleted.length },
    ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {tabs.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors",
                selected
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {item.label}
              {item.count != null ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                    selected
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {tab === "library" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("libraryHint")}</p>
          <div className="flex flex-wrap gap-1.5">
            <IndustryChip
              active={industryFilter === "all"}
              label={t("industryAll")}
              onClick={() => setIndustryFilter("all")}
            />
            {STARTER_INDUSTRIES.map((industry) => (
              <IndustryChip
                key={industry}
                active={industryFilter === industry}
                label={t(`columns.${industry}`)}
                onClick={() => setIndustryFilter(industry)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tab === "library" ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {visibleIndustries.map((industry) => {
            const items = startersByIndustry(industry);
            return (
              <BoardColumn
                key={industry}
                label={t(`columns.${industry}`)}
                dotClass={COLUMN_DOT[industry]}
                count={items.length}
                className={visibleIndustries.length === 1 ? "max-w-xl" : undefined}
              >
                {items.map((starter) => (
                  <TemplatePreviewCard
                    key={starter.id}
                    title={starter.title}
                    body={starter.body_text}
                    buttons={starter.buttons}
                    slug={starter.name}
                    badge={`# ${starter.version}`}
                    onClick={() => onUseStarter(starter)}
                  />
                ))}
              </BoardColumn>
            );
          })}
        </div>
      ) : tab === "active" ? (
        active.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("activeEmpty")}</p>
        ) : (
          <ActiveBoard
            templates={active}
            onOpen={onOpenTemplate}
            onDelete={onDeleteTemplate}
            deletingId={deletingId}
            t={t}
          />
        )
      ) : deleted.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t("deletedEmpty")}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {deleted.map((row) => (
            <TemplatePreviewCard
              key={row.id}
              title={displayTitle(row.name)}
              body={row.body_text}
              buttons={row.buttons}
              slug={row.name}
              badge={templateStatusConfig[row.status ?? "DISABLED"].label}
              onClick={() => onOpenTemplate(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveBoard({
  templates,
  onOpen,
  onDelete,
  deletingId,
  t,
}: {
  templates: MessageTemplate[];
  onOpen: (template: MessageTemplate) => void;
  onDelete?: (template: MessageTemplate) => void;
  deletingId?: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const groups: MessageTemplate["category"][] = ["Utility", "Marketing", "Authentication"];
  const used = groups.filter((g) => templates.some((row) => row.category === g));
  const columns = used.length > 0 ? used : groups;

  return (
    <div className="space-y-6">
      {columns.map((category) => {
        const items = templates.filter((row) => row.category === category);
        return (
          <div key={category} className="space-y-3">
            <div className="flex items-center gap-2 px-0.5">
              <span className={cn("size-2 rounded-full", COLUMN_DOT[category])} />
              <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t(`metaColumns.${category}`)}
              </h2>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.map((row) => (
                <TemplatePreviewCard
                  key={row.id}
                  title={displayTitle(row.name)}
                  body={row.body_text}
                  buttons={row.buttons}
                  slug={row.name}
                  badge={templateStatusConfig[row.status ?? "DRAFT"].label}
                  onClick={() => onOpen(row)}
                  onDelete={onDelete ? () => onDelete(row) : undefined}
                  deleting={deletingId === row.id}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}


function IndustryChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function displayTitle(name: string) {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
