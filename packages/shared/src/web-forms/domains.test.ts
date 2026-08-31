import { describe, expect, it } from "vitest"

import { isOriginAllowed, normalizeDomain, parseAllowedDomains } from "./domains"

describe("normalizeDomain", () => {
  it("strips scheme, path, port and a leading www.", () => {
    expect(normalizeDomain("https://www.Example.com/contact?x=1")).toBe("example.com")
    expect(normalizeDomain("www.example.com")).toBe("example.com")
    expect(normalizeDomain("example.com:8080")).toBe("example.com")
    expect(normalizeDomain("  EXAMPLE.com  ")).toBe("example.com")
  })

  it("keeps non-www subdomains distinct", () => {
    expect(normalizeDomain("shop.example.com")).toBe("shop.example.com")
  })

  it("returns an empty string for blank input", () => {
    expect(normalizeDomain("")).toBe("")
    expect(normalizeDomain("   ")).toBe("")
  })
})

describe("parseAllowedDomains", () => {
  it("dedupes www/bare/URL spellings of the same site", () => {
    expect(
      parseAllowedDomains("example.com, https://www.example.com/, WWW.EXAMPLE.COM"),
    ).toEqual(["example.com"])
  })

  it("returns null when nothing usable was entered", () => {
    expect(parseAllowedDomains("")).toBeNull()
    expect(parseAllowedDomains(" , ,")).toBeNull()
  })
})

describe("isOriginAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(isOriginAllowed("https://anything.test", null)).toBe(true)
    expect(isOriginAllowed(null, [])).toBe(true)
  })

  // The production bug: the form listed "www.hyperlinq.in" but the site
  // is served from the bare apex, so every real lead was rejected.
  it("treats the bare apex and www. as the same site", () => {
    expect(isOriginAllowed("https://hyperlinq.in", ["www.hyperlinq.in"])).toBe(true)
    expect(isOriginAllowed("https://www.hyperlinq.in", ["hyperlinq.in"])).toBe(true)
  })

  it("still rejects other hosts, look-alikes and a missing Origin", () => {
    expect(isOriginAllowed("https://evil.test", ["hyperlinq.in"])).toBe(false)
    expect(isOriginAllowed("https://hyperlinq.in.evil.test", ["hyperlinq.in"])).toBe(false)
    expect(isOriginAllowed("https://notwww.hyperlinq.in", ["hyperlinq.in"])).toBe(false)
    expect(isOriginAllowed(null, ["hyperlinq.in"])).toBe(false)
  })
})
