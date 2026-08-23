"use client";

import { useMemo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Calendar,
  Car,
  Clock,
  GraduationCap,
  Headphones,
  HelpCircle,
  Home,
  Landmark,
  Link as LinkIcon,
  MessageSquare,
  PhoneCall,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  Utensils,
  X,
  Zap,
  Stethoscope,
  Inbox,
  Radio,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  filterCatalog,
  listCatalog,
  recommendedCatalog,
} from "@/lib/templates/catalog";
import type {
  CatalogEntry,
  CatalogIcon,
  TemplateGoal,
  TemplateTriggerFilter,
} from "@/lib/templates/catalog-types";
import { TEMPLATE_GOALS, TEMPLATE_TRIGGERS } from "@/lib/templates/catalog-types";

const ICONS: Record<CatalogIcon, typeof MessageSquare> = {
  MessageSquare,
  HelpCircle,
  UserPlus,
  Home,
  ShoppingBag,
  Calendar,
  GraduationCap,
  Utensils,
  Stethoscope,
  Car,
  Landmark,
  Link: LinkIcon,
  Star,
  Headphones,
  Clock,
  PhoneCall,
  Users,
};

const GOAL_ICONS: Record<Exclude<TemplateGoal, "all">, typeof Target> = {
  leads: UserPlus,
  support: Headphones,
  sales: TrendingUp,
  engage: Target,
  bookings: Calendar,
  ops: Inbox,
};

const TRIGGER_ICONS: Record<Exclude<TemplateTriggerFilter, "all">, typeof Inbox> = {
  keyword: MessageSquare,
  first_inbound: UserPlus,
  new_message: Radio,
};

interface TemplateLibraryProps {
  open?: boolean;
  onClose?: () => void;
  onUse: (entry: CatalogEntry) => void;
  onScratch: () => void;
  busy?: boolean;
  /** Full page under /templates. Modal overlays Flows / Automations. */
  variant?: "modal" | "page";
}

export function TemplateLibrary({
  open = true,
  onClose,
  onUse,
  onScratch,
  busy = false,
  variant = "modal",
}: TemplateLibraryProps) {
  const t = useTranslations("TemplateLibrary");
  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState<TemplateGoal>("all");
  const [trigger, setTrigger] = useState<TemplateTriggerFilter>("all");
  const [mounted, setMounted] = useState(false);

  const catalog = useMemo(() => listCatalog(), []);
  const filtered = useMemo(
    () => filterCatalog(catalog, { query, goal, trigger }),
    [catalog, query, goal, trigger],
  );
  const recommended = useMemo(() => recommendedCatalog(filtered), [filtered]);
  const rest = useMemo(() => {
    const recIds = new Set(recommended.map((e) => e.id));
    return filtered.filter((e) => !recIds.has(e.id));
  }, [filtered, recommended]);

  useEffect(() => {
    // Deliberate: the standard post-mount flag for deferring
    // client-only rendering until after hydration — not an effect smell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  useEffect(() => {
    if (variant !== "modal" || !open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, variant]);

  if (variant === "modal" && !open) return null;

  const panel = (
    <div
      className={
        variant === "modal"
          ? "fixed inset-0 z-[80] flex flex-col bg-background"
          : "flex min-h-[calc(100dvh-3.5rem)] flex-col bg-background"
      }
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={onScratch}
            disabled={busy}
            className="hidden sm:inline-flex"
          >
            <Plus className="h-4 w-4" />
            {t("scratch")}
          </Button>
          {variant === "modal" && onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <div className="relative mx-auto max-w-3xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="h-10 w-full rounded-lg border border-border bg-card pr-3 pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border p-4 lg:block">
          <FilterGroup label={t("byGoal")}>
            <FilterRow
              active={goal === "all"}
              label={t("allTemplates")}
              icon={Sparkles}
              onClick={() => setGoal("all")}
            />
            {TEMPLATE_GOALS.filter((g) => g !== "all").map((g) => {
              const Icon = GOAL_ICONS[g];
              return (
                <FilterRow
                  key={g}
                  active={goal === g}
                  label={t(`goals.${g}`)}
                  icon={Icon}
                  onClick={() => setGoal(g)}
                />
              );
            })}
          </FilterGroup>
          <FilterGroup label={t("byTrigger")}>
            <FilterRow
              active={trigger === "all"}
              label={t("anyTrigger")}
              icon={Zap}
              onClick={() => setTrigger("all")}
            />
            {TEMPLATE_TRIGGERS.filter((x) => x !== "all").map((x) => {
              const Icon = TRIGGER_ICONS[x];
              return (
                <FilterRow
                  key={x}
                  active={trigger === x}
                  label={t(`triggers.${x}`)}
                  icon={Icon}
                  onClick={() => setTrigger(x)}
                />
              );
            })}
          </FilterGroup>
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap gap-2 lg:hidden">
            <select
              value={goal}
              onChange={(e) => setGoal(e.target.value as TemplateGoal)}
              className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
            >
              {TEMPLATE_GOALS.map((g) => (
                <option key={g} value={g}>
                  {g === "all" ? t("allTemplates") : t(`goals.${g}`)}
                </option>
              ))}
            </select>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as TemplateTriggerFilter)}
              className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
            >
              {TEMPLATE_TRIGGERS.map((x) => (
                <option key={x} value={x}>
                  {x === "all" ? t("anyTrigger") : t(`triggers.${x}`)}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={onScratch} disabled={busy}>
              <Plus className="h-4 w-4" />
              {t("scratch")}
            </Button>
          </div>

          {filtered.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <>
              {recommended.length > 0 && query === "" && goal === "all" && trigger === "all" ? (
                <section className="mb-8">
                  <h2 className="mb-3 text-sm font-semibold text-foreground">
                    {t("recommended")}
                  </h2>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {recommended.map((entry) => (
                      <TemplateCard
                        key={entry.id}
                        entry={entry}
                        onUse={onUse}
                        busy={busy}
                        t={t}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {(query || goal !== "all" || trigger !== "all" ? filtered : rest).length > 0 ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">
                    {query || goal !== "all" || trigger !== "all"
                      ? t("results", { count: filtered.length })
                      : t("discover")}
                  </h2>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {(query || goal !== "all" || trigger !== "all" ? filtered : rest).map(
                      (entry) => (
                        <TemplateCard
                          key={entry.id}
                          entry={entry}
                          onUse={onUse}
                          busy={busy}
                          t={t}
                        />
                      ),
                    )}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (variant === "page") return panel;
  if (!mounted) return null;
  return createPortal(panel, document.body);
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <p className="section-label mb-2 px-2">{label}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function FilterRow({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Target;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-foreground/80 hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {label}
    </button>
  );
}

function TemplateCard({
  entry,
  onUse,
  busy,
  t,
}: {
  entry: CatalogEntry;
  onUse: (entry: CatalogEntry) => void;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const Icon = ICONS[entry.icon] ?? MessageSquare;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onUse(entry)}
      className="flex flex-col rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-card-2 disabled:opacity-60"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {entry.badges.includes("ai") ? (
            <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 dark:text-violet-300">
              {t("badgeAi")}
            </span>
          ) : null}
          {entry.badges.includes("popular") ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-800 dark:text-amber-300">
              ★ {t("badgePopular")}
            </span>
          ) : null}
          {entry.badges.includes("new") ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-800 dark:text-emerald-300">
              {t("badgeNew")}
            </span>
          ) : null}
        </div>
      </div>
      <h3 className="text-sm font-semibold text-foreground">{entry.name}</h3>
      <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
        {entry.description}
      </p>
      {entry.industry ? (
        <p className="mt-2 text-[11px] font-medium text-foreground/70">{entry.industry}</p>
      ) : null}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-emerald-500" />
          WhatsApp
        </span>
        <span className="inline-flex items-center gap-1">
          <Zap className="size-3" />
          {entry.kind === "flow" ? t("kindFlow") : t("kindAutomation")}
        </span>
      </div>
    </button>
  );
}
