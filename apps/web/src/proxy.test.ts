import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { proxy } from "./proxy";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@wacrm/shared/db/jwt";

// Sessions are stateless HS256 JWTs; the proxy verifies them locally and
// slides (re-issues) tokens older than a day. These tests mint tokens with
// a controlled iat to exercise both paths, plus the page-routing rules the
// old Supabase middleware enforced (which must survive the migration).
//
// API-route gating is asserted in apps/api's own proxy.test.ts — /api/*
// no longer reaches this app.

const SECRET = "test-secret-for-proxy";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintToken(iatOffsetSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sub: "11111111-1111-4111-8111-111111111111",
        email: "demo@wacrm.local",
        role: "authenticated",
        iat: now + iatOffsetSeconds,
        exp: now + iatOffsetSeconds + SESSION_MAX_AGE,
      }),
    ),
  );
  const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function requestWithToken(url: string, token?: string): NextRequest {
  const headers = token ? { cookie: `${SESSION_COOKIE}=${token}` } : undefined;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

describe("proxy — session gating", () => {
  it("redirects an unauthenticated user off protected pages", async () => {
    const res = await proxy(requestWithToken("https://app.test/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects a signed-in user off /login to /dashboard", async () => {
    const res = await proxy(requestWithToken("https://app.test/login", mintToken(0)));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    const res = await proxy(
      requestWithToken("https://app.test/login?invite=abc123", mintToken(0)),
    );
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("rejects a tampered token", async () => {
    const res = await proxy(
      requestWithToken("https://app.test/dashboard", mintToken(0).slice(0, -3) + "AAA"),
    );
    expect(res.headers.get("location")).toContain("/login");
  });

});

describe("proxy — sliding renewal", () => {
  it("re-issues a token older than a day and carries it on redirects", async () => {
    const dayOld = mintToken(-(25 * 3600));
    const res = await proxy(requestWithToken("https://app.test/login", dayOld));
    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    // …with a renewed cookie riding along (issue #288 semantics).
    const renewed = res.cookies.get(SESSION_COOKIE)?.value;
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(dayOld);
  });

  it("leaves a fresh token alone", async () => {
    const res = await proxy(requestWithToken("https://app.test/dashboard", mintToken(0)));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});
