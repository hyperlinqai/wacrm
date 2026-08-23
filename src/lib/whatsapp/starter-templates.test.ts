import { describe, expect, it } from "vitest";
import { TEMPLATE_LIMITS } from "./template-validators";
import {
  STARTER_INDUSTRIES,
  STARTER_TEMPLATES,
} from "./starter-templates";

describe("starter WhatsApp templates", () => {
  it("has unique ids and Meta-safe names", () => {
    const ids = STARTER_TEMPLATES.map((t) => t.id);
    const names = STARTER_TEMPLATES.map((t) => t.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const t of STARTER_TEMPLATES) {
      expect(t.name).toMatch(TEMPLATE_LIMITS.nameRegex);
      expect(STARTER_INDUSTRIES.includes(t.industry)).toBe(true);
      expect(t.body_text.length).toBeGreaterThan(0);
      expect(t.body_text.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.bodyMaxLength);
      for (const btn of t.buttons) {
        expect(btn.text.length).toBeGreaterThan(0);
        expect(btn.text.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.buttonTextMaxLength);
      }
    }
  });

  it("covers every industry with agency and automation packs", () => {
    for (const industry of STARTER_INDUSTRIES) {
      expect(STARTER_TEMPLATES.filter((t) => t.industry === industry).length).toBeGreaterThanOrEqual(
        3,
      );
    }
    expect(STARTER_TEMPLATES.some((t) => t.name === "whatsapp_crm_pitch")).toBe(true);
    expect(STARTER_TEMPLATES.some((t) => t.name === "marketing_audit_offer")).toBe(true);
  });
});
