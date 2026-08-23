import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { listFlowTemplates } from "@/lib/flows/templates";
import type { CatalogEntry, TemplateGoal, TemplateTriggerFilter } from "./catalog-types";

const TRIGGER_LABEL: Record<CatalogEntry["trigger"], string> = {
  keyword: "Keyword in chat",
  first_inbound: "First WhatsApp message",
  new_message: "Any inbound message",
};

function flowTrigger(kind: CatalogEntry["trigger"] | undefined, triggerType: string): CatalogEntry["trigger"] {
  if (kind) return kind;
  if (triggerType === "first_inbound_message") return "first_inbound";
  return "keyword";
}

export function listCatalog(): CatalogEntry[] {
  const flows: CatalogEntry[] = listFlowTemplates().map((t) => ({
    id: `flow:${t.slug}`,
    kind: "flow",
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    goals: t.goals ?? ["engage"],
    trigger: flowTrigger(t.triggerKind, t.trigger_type),
    triggerLabel: TRIGGER_LABEL[flowTrigger(t.triggerKind, t.trigger_type)],
    badges: t.badges ?? [],
    recommended: t.recommended,
    industry: t.industry,
  }));

  const automations: CatalogEntry[] = Object.values(AUTOMATION_TEMPLATES).map((t) => ({
    id: `automation:${t.slug}`,
    kind: "automation",
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    goals: t.goals,
    trigger: t.triggerKind,
    triggerLabel: TRIGGER_LABEL[t.triggerKind],
    badges: t.badges ?? [],
    recommended: t.recommended,
    industry: t.industry,
  }));

  return [...flows, ...automations];
}

export function filterCatalog(
  entries: CatalogEntry[],
  opts: {
    query: string;
    goal: TemplateGoal;
    trigger: TemplateTriggerFilter;
  },
): CatalogEntry[] {
  const q = opts.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.goal !== "all" && !e.goals.includes(opts.goal)) return false;
    if (opts.trigger !== "all" && e.trigger !== opts.trigger) return false;
    if (!q) return true;
    const hay = `${e.name} ${e.description} ${e.industry ?? ""} ${e.slug}`.toLowerCase();
    return hay.includes(q);
  });
}

export function recommendedCatalog(entries: CatalogEntry[]): CatalogEntry[] {
  const rec = entries.filter((e) => e.recommended);
  return rec.length > 0 ? rec : entries.slice(0, 6);
}
