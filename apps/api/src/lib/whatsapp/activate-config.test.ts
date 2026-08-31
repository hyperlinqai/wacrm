import { describe, expect, it } from "vitest";
import { activateWhatsAppConfig } from "./activate-config";
import type { SupabaseClient } from "@wacrm/shared/db";

// PIN validation runs before any DB or Meta API call, so an untouched
// client stands in fine here — if either mock got called, `undefined`
// property access would throw and fail the test loudly.
const UNUSED_CLIENT = {} as SupabaseClient;

describe("activateWhatsAppConfig — PIN validation", () => {
  const baseArgs = {
    supabase: UNUSED_CLIENT,
    supabaseAdmin: UNUSED_CLIENT,
    accountId: "acct-1",
    userId: "user-1",
    phoneNumberId: "phone-1",
    wabaId: "waba-1",
    accessToken: "tok",
  };

  it("rejects a PIN that isn't exactly 6 digits, before touching the database", async () => {
    const result = await activateWhatsAppConfig({ ...baseArgs, pin: "12345" });
    expect(result).toEqual({
      ok: false,
      error: "PIN must be exactly 6 digits.",
      status: 400,
    });
  });

  it("rejects a non-numeric PIN", async () => {
    const result = await activateWhatsAppConfig({ ...baseArgs, pin: "abcdef" });
    expect(result.ok).toBe(false);
  });

  it("accepts undefined/null/empty PIN as 'no PIN supplied', not a validation error", async () => {
    // These reach the DB (claim-check) next, which the unused client
    // can't serve — assert we get PAST validation, not a specific
    // downstream shape, by checking the error is never the PIN message.
    for (const pin of [undefined, null, ""] as const) {
      await expect(
        activateWhatsAppConfig({ ...baseArgs, pin }),
      ).rejects.toThrow(); // UNUSED_CLIENT.from is undefined past this point
    }
  });
});
