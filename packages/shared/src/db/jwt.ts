// HS256 JWT sign/verify on WebCrypto — usable from both the proxy
// (edge-compatible) and Node route handlers. No external deps.

export interface SessionClaims {
  sub: string;
  email: string;
  role: 'authenticated';
  full_name?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str: string): Uint8Array {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

async function hmacKey(usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function signJwt(
  claims: Omit<SessionClaims, 'iat' | 'exp'>,
  maxAgeSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(
    encoder.encode(JSON.stringify({ ...claims, iat: now, exp: now + maxAgeSeconds })),
  );
  const key = await hmacKey('sign');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the verified claims, or null for a missing/invalid/expired token. */
export async function verifyJwt(token: string | undefined | null): Promise<SessionClaims | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const key = await hmacKey('verify');
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(parts[2]).buffer as ArrayBuffer,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'wacrm-session';
export const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 days
/** Re-issue (slide) the session when the token is older than this. */
export const SESSION_RENEW_AFTER = 24 * 3600;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE,
    // The deployment currently serves over plain http (IP:port); a
    // `secure` cookie would be silently dropped there. Enable it via env
    // once the app is behind TLS.
    secure: process.env.NEXT_PUBLIC_SITE_URL?.startsWith('https://') ?? false,
  };
}
