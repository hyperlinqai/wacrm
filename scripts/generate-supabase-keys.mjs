#!/usr/bin/env node
// Generate the shared JWT secret plus anon / service_role API keys for the
// self-hosted Supabase stack (supabase/self-host). Paste the output into
// supabase/self-host/.env and the app's .env.local.

import crypto from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const secret = crypto.randomBytes(32).toString('hex');

function sign(role) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ role, iss: 'supabase', iat, exp: iat + 10 * 365 * 24 * 3600 }),
  );
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

console.log(`JWT_SECRET=${secret}`);
console.log(`ANON_KEY=${sign('anon')}`);
console.log(`SERVICE_ROLE_KEY=${sign('service_role')}`);
console.log(`SECRET_KEY_BASE=${crypto.randomBytes(48).toString('hex')}`);
console.log(`SVC_PASSWORD=${crypto.randomBytes(16).toString('hex')}`);
