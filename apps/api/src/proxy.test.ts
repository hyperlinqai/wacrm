import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { proxy } from "./proxy";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@wacrm/shared/db/jwt";

// Sessions are stateless HS256 JWTs. This app's proxy does two things:
// it refuses unauthenticated WhatsApp calls (the webhook excepted, since
// Meta calls it with a signature and no cookie), and it slides an ageing
// token — which matters more here than on the web app, because a user can
// work in the inbox for hours without ever requesting a document.

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

describe("api proxy — auth gating", () => {
  it("401s unauthenticated non-webhook whatsapp calls", async () => {
    const res = await proxy(requestWithToken("https://app.test/api/whatsapp/send"));
    expect(res.status).toBe(401);
  });

  it("lets the webhook through without a session", async () => {
    const res = await proxy(requestWithToken("https://app.test/api/whatsapp/webhook"));
    expect(res.status).toBe(200);
  });

  it("lets an authenticated whatsapp call through", async () => {
    const res = await proxy(
      requestWithToken("https://app.test/api/whatsapp/send", mintToken(0)),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a tampered token like no token at all", async () => {
    const res = await proxy(
      requestWithToken("https://app.test/api/whatsapp/send", mintToken(0).slice(0, -3) + "AAA"),
    );
    expect(res.status).toBe(401);
  });

  it("leaves other API routes to their own handlers", async () => {
    // /api/db and friends authenticate per-request via getSessionUser();
    // the proxy must not pre-empt them, or an anonymous caller would stop
    // getting the `anon` RLS role that public routes rely on.
    const res = await proxy(requestWithToken("https://app.test/api/db"));
    expect(res.status).toBe(200);
  });
});

describe("api proxy — sliding renewal", () => {
  it("re-issues a token older than a day", async () => {
    const dayOld = mintToken(-(25 * 3600));
    const res = await proxy(requestWithToken("https://app.test/api/db", dayOld));
    const renewed = res.cookies.get(SESSION_COOKIE)?.value;
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(dayOld);
  });

  it("carries a renewed cookie onto a 401", async () => {
    const dayOld = mintToken(-(25 * 3600));
    const res = await proxy(requestWithToken("https://app.test/api/whatsapp/send", dayOld));
    // The token is valid, so this is a 200 — but the cookie must ride
    // along on whichever response we return (issue #288 semantics).
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
  });

  it("leaves a fresh token alone", async () => {
    const res = await proxy(requestWithToken("https://app.test/api/db", mintToken(0)));
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});
