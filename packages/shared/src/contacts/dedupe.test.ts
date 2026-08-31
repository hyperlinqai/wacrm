import { describe, expect, it } from "vitest";
import type { SupabaseClient } from '../db/index';
import {
  dedupeByPhone,
  findContactByEmail,
  findDuplicateContacts,
  findExistingContact,
  hasDuplicates,
  isExactMatch,
  isUniqueViolation,
  normalizeEmailKey,
  normalizeKey,
} from "./dedupe";

describe("normalizeKey", () => {
  it("strips every non-digit", () => {
    expect(normalizeKey("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizeKey("15551234567")).toBe("15551234567");
  });

  it("collapses different formats of the same number to one key", () => {
    expect(normalizeKey("+44 7911 123456")).toBe(normalizeKey("447911123456"));
  });
});

describe("isExactMatch", () => {
  it("treats different formatting of the same digits as exact", () => {
    expect(isExactMatch({ id: "1", phone: "+1 555-123-4567" }, "15551234567")).toBe(
      true,
    );
  });

  it("is false for a trunk-variant (fuzzy) match", () => {
    // last-8 match but not the same full number
    expect(isExactMatch({ id: "1", phone: "37063949836" }, "370063949836")).toBe(
      false,
    );
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
  it("is false for other errors / non-objects", () => {
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
  });
});

describe("dedupeByPhone", () => {
  it("keeps the first occurrence and counts in-file duplicates", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "+1 555-1111", name: "A" },
      { phone: "15551111", name: "B" }, // same digits as #1
      { phone: "+1 555-2222", name: "C" },
    ]);
    expect(unique.map((r) => r.name)).toEqual(["A", "C"]);
    expect(duplicates).toBe(1);
  });

  it("drops rows with no digits", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "   " },
      { phone: "+1 555-3333" },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("findExistingContact", () => {
  // Minimal SupabaseClient stub: resolves the .from().select().eq().like()
  // chain to a fixed candidate set.
  function stubDb(rows: Array<{ id: string; phone: string }>): SupabaseClient {
    const builder = {
      select: () => builder,
      eq: () => builder,
      like: () => Promise.resolve({ data: rows, error: null }),
    };
    return { from: () => builder } as unknown as SupabaseClient;
  }

  it("returns a trunk-variant match via phonesMatch", async () => {
    const db = stubDb([{ id: "c1", phone: "37063949836" }]);
    const hit = await findExistingContact(db, "acct", "+370 063 949 836");
    expect(hit?.id).toBe("c1");
  });

  it("returns null when no candidate matches", async () => {
    const db = stubDb([{ id: "c1", phone: "15559999999" }]);
    const hit = await findExistingContact(db, "acct", "+1 555-123-4567");
    expect(hit).toBeNull();
  });

  it("returns null for an empty phone without querying", async () => {
    const db = stubDb([{ id: "c1", phone: "15551234567" }]);
    expect(await findExistingContact(db, "acct", "   ")).toBeNull();
  });
});

describe("normalizeEmailKey", () => {
  it("trims and lowercases; blank → empty string", () => {
    expect(normalizeEmailKey("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(normalizeEmailKey(null)).toBe("");
    expect(normalizeEmailKey("   ")).toBe("");
  });
});

/** Stub that serves both the phone chain (.like) and the email chain
 *  (.ilike().limit()) from one candidate list. */
function stubBoth(
  rows: Array<{ id: string; phone: string; email?: string | null }>,
): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    like: () => Promise.resolve({ data: rows, error: null }),
    ilike: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("findContactByEmail", () => {
  it("matches case-insensitively", async () => {
    const db = stubBoth([{ id: "c1", phone: "1", email: "Jane@Example.com" }]);
    const hit = await findContactByEmail(db, "acct", "jane@example.COM");
    expect(hit?.id).toBe("c1");
  });

  it("skips the contact being edited", async () => {
    const db = stubBoth([{ id: "c1", phone: "1", email: "jane@example.com" }]);
    expect(await findContactByEmail(db, "acct", "jane@example.com", "c1")).toBeNull();
  });

  it("returns null for a blank email without querying", async () => {
    const db = stubBoth([{ id: "c1", phone: "1", email: "" }]);
    expect(await findContactByEmail(db, "acct", "  ")).toBeNull();
  });
});

describe("findDuplicateContacts / hasDuplicates", () => {
  it("reports an exact phone match and an email match independently", async () => {
    const db = stubBoth([
      { id: "c1", phone: "+1 555-123-4567", email: "other@example.com" },
    ]);
    const m = await findDuplicateContacts(db, "acct", {
      phone: "15551234567",
      email: "OTHER@example.com",
    });
    expect(m.phone?.id).toBe("c1");
    expect(m.phoneExact).toBe(true);
    expect(m.email?.id).toBe("c1");
    expect(hasDuplicates(m)).toBe(true);
  });

  it("flags a trunk-variant phone as a non-exact match", async () => {
    const db = stubBoth([{ id: "c1", phone: "37063949836", email: null }]);
    const m = await findDuplicateContacts(db, "acct", { phone: "+370 063 949 836" });
    expect(m.phone?.id).toBe("c1");
    expect(m.phoneExact).toBe(false);
    expect(m.email).toBeNull();
  });

  it("ignores the contact being edited on both qualifiers", async () => {
    const db = stubBoth([{ id: "c1", phone: "15551234567", email: "a@b.co" }]);
    const m = await findDuplicateContacts(
      db,
      "acct",
      { phone: "15551234567", email: "a@b.co" },
      "c1",
    );
    expect(m.phone).toBeNull();
    expect(m.email).toBeNull();
    expect(hasDuplicates(m)).toBe(false);
  });
});
