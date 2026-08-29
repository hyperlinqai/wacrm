import { describe, expect, it } from "vitest";
import { explainRegistrationError } from "./registration-error";

describe("explainRegistrationError", () => {
  it("recognizes Meta's (#133005) PIN mismatch by code", () => {
    const result = explainRegistrationError("(#133005) Two step verification pin mismatch");
    expect(result).not.toBeNull();
    expect(result!.summary).toMatch(/already has a 2-step verification PIN/i);
    expect(result!.action).toMatch(/Save Configuration/);
  });

  it("also recognizes the phrase without the numeric code", () => {
    const result = explainRegistrationError("Two Step Verification Pin Mismatch — try again");
    expect(result).not.toBeNull();
  });

  it("returns null for an unrecognized error, so the raw message is shown instead", () => {
    expect(explainRegistrationError("(#100) Invalid parameter")).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(explainRegistrationError(null)).toBeNull();
    expect(explainRegistrationError(undefined)).toBeNull();
    expect(explainRegistrationError("")).toBeNull();
  });
});
