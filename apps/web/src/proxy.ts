import { NextResponse, type NextRequest } from 'next/server'
import {
  SESSION_COOKIE,
  SESSION_RENEW_AFTER,
  SESSION_MAX_AGE,
  sessionCookieOptions,
  signJwt,
  verifyJwt,
} from '@/lib/db/jwt'

// Route gating for the direct-Postgres auth layer. The JWT is verified
// locally (WebCrypto, no network) — the authoritative check including
// global sign-out revocation happens in the data endpoints; here we only
// gate navigation. Sessions slide: tokens older than SESSION_RENEW_AFTER
// are transparently re-issued so active users never hit the 7-day expiry.

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const claims = await verifyJwt(token)

  const response = NextResponse.next({ request })

  if (claims && claims.iat + SESSION_RENEW_AFTER < Math.floor(Date.now() / 1000)) {
    const renewed = await signJwt(
      { sub: claims.sub, email: claims.email, role: 'authenticated', full_name: claims.full_name },
      SESSION_MAX_AGE,
    )
    response.cookies.set(SESSION_COOKIE, renewed, sessionCookieOptions())
  }

  // Carry any renewed cookie onto whichever response we return (see the
  // old middleware's issue #288 for why this must not be dropped).
  const withCookies = <T extends NextResponse>(res: T): T => {
    response.cookies.getAll().forEach((cookie) => {
      res.cookies.set(cookie)
    })
    return res
  }

  // Auth pages — bounce signed-in users to the dashboard, or to the
  // invite-accept page when an invite token is in the query string.
  if (
    claims &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' || request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withCookies(NextResponse.redirect(url))
  }

  // Protected pages — redirect to login if not authenticated.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!claims && protectedPaths.some((path) => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks).
  if (
    !claims &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withCookies(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
