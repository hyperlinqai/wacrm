import { NextResponse, type NextRequest } from 'next/server'
import {
  SESSION_COOKIE,
  SESSION_RENEW_AFTER,
  SESSION_MAX_AGE,
  sessionCookieOptions,
  signJwt,
  verifyJwt,
} from '@wacrm/shared/db/jwt'

// Session upkeep and coarse gating for the API app. The JWT is verified
// locally (WebCrypto, no network); the authoritative check — including
// global sign-out revocation — happens inside the route handlers via
// getSessionUser(). Sessions slide here exactly as they do on the web
// app's page navigations: a token older than SESSION_RENEW_AFTER is
// transparently re-issued, so a user who spends an hour in the inbox
// without a full page load never hits the 7-day expiry.
//
// Both apps are served from one origin (the reverse proxy routes /api/*
// here), so a cookie set on an API response is the same cookie the web
// app reads. If that ever changes, this renewal has to move behind a
// shared-domain cookie or be dropped in favour of the web app's.

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

  // WhatsApp routes need auth — except the webhook, which Meta calls
  // with no session and which authenticates by signature instead.
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
  matcher: ['/api/:path*'],
}
