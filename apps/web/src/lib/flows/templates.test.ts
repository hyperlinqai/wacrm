import { describe, expect, it } from "vitest";
import { getFlowTemplate, listFlowTemplates } from "./templates";
import { filterCatalog, listCatalog } from "@/lib/templates/catalog";

describe("flow templates", () => {
  it("registers unique slugs including industry packs", () => {
    const list = listFlowTemplates();
    const slugs = list.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("welcome_menu");
    expect(slugs).toContain("property_inquiry");
    expect(slugs).toContain("booking_request");
    expect(slugs).toContain("support_ai_bot");
  });

  it("every template has a start node matching entry_node_id", () => {
    for (const t of listFlowTemplates()) {
      expect(t.nodes.some((n) => n.node_key === t.entry_node_id)).toBe(true);
      expect(getFlowTemplate(t.slug)?.slug).toBe(t.slug);
    }
  });
});

describe("template catalog", () => {
  it("merges flows and automations without id collisions", () => {
    const catalog = listCatalog();
    const ids = catalog.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalog.some((e) => e.kind === "flow")).toBe(true);
    expect(catalog.some((e) => e.kind === "automation")).toBe(true);
  });

  it("filters by goal and query", () => {
    const catalog = listCatalog();
    const leads = filterCatalog(catalog, {
      query: "",
      goal: "leads",
      trigger: "all",
    });
    expect(leads.every((e) => e.goals.includes("leads"))).toBe(true);
    const property = filterCatalog(catalog, {
      query: "property",
      goal: "all",
      trigger: "all",
    });
    expect(property.some((e) => e.slug === "property_inquiry")).toBe(true);
  });
});
