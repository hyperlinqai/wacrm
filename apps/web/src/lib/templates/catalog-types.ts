export const TEMPLATE_GOALS = [
  "all",
  "leads",
  "support",
  "sales",
  "engage",
  "bookings",
  "ops",
] as const;

export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

export const TEMPLATE_TRIGGERS = [
  "all",
  "keyword",
  "first_inbound",
  "new_message",
] as const;

export type TemplateTriggerFilter = (typeof TEMPLATE_TRIGGERS)[number];

export type TemplateKind = "flow" | "automation";

export type TemplateBadge = "popular" | "ai" | "new";

export type CatalogIcon =
  | "MessageSquare"
  | "HelpCircle"
  | "UserPlus"
  | "Home"
  | "ShoppingBag"
  | "Calendar"
  | "GraduationCap"
  | "Utensils"
  | "Stethoscope"
  | "Car"
  | "Landmark"
  | "Link"
  | "Star"
  | "Headphones"
  | "Clock"
  | "PhoneCall"
  | "Users";

export interface CatalogEntry {
  id: string;
  kind: TemplateKind;
  slug: string;
  name: string;
  description: string;
  icon: CatalogIcon;
  goals: Exclude<TemplateGoal, "all">[];
  trigger: Exclude<TemplateTriggerFilter, "all">;
  triggerLabel: string;
  badges: TemplateBadge[];
  recommended?: boolean;
  industry?: string;
}
