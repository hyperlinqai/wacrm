/**
 * One-off repair for contact numbers that predate phone cleaning.
 *
 * Most imported lists are national numbers ("9831023021"), which
 * WhatsApp cannot deliver to — it needs the country code. This rewrites
 * those to E.164 using each account's `default_country_code`, and
 * reports the ones no rule can fix.
 *
 * It is a DRY RUN unless you pass --apply. Nothing is written without it.
 *
 *   node --experimental-strip-types scripts/clean-contact-phones.ts
 *   node --experimental-strip-types scripts/clean-contact-phones.ts --apply
 *   node --experimental-strip-types scripts/clean-contact-phones.ts --country=IN
 *
 * `--country` supplies a fallback for accounts that have not set one
 * yet, so you can see the report before running migration 051.
 *
 * Collisions are the reason this is not a single UPDATE statement.
 * `contacts.phone_normalized` is a generated column (digits of `phone`)
 * with a UNIQUE index per account, so rewriting "9831023021" to
 * "+919831023021" fails if that account already holds the same person in
 * international form. Those rows are found first and skipped with a
 * note, rather than aborting the run half-applied — merging two contact
 * records is a judgement call about which name, tags and history to
 * keep, and belongs in the UI, not in a migration script.
 */
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPhone } from '../packages/shared/src/whatsapp/phone-clean.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FALLBACK_COUNTRY = args.find((a) => a.startsWith('--country='))?.split('=')[1] ?? null;

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ['apps/api/.env.local', 'apps/web/.env.local']) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const line = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is not set and was not found in apps/*/.env.local');
}

interface Row {
  id: string;
  account_id: string;
  name: string | null;
  phone: string;
  phone_normalized: string;
}

const client = new Client({ connectionString: loadDatabaseUrl() });
await client.connect();
await client.query('SET ROLE service_role');

// The column only exists after migration 051; fall back so the report
// can be produced before migrating.
const hasCountryColumn =
  (
    await client.query(
      `select 1 from information_schema.columns
        where table_name = 'accounts' and column_name = 'default_country_code'`,
    )
  ).rowCount === 1;

const countryByAccount = new Map<string, string | null>();
if (hasCountryColumn) {
  const { rows } = await client.query<{ id: string; default_country_code: string | null }>(
    'select id, default_country_code from accounts',
  );
  for (const a of rows) countryByAccount.set(a.id, a.default_country_code);
}

const { rows } = await client.query<Row>(
  `select id, account_id, name, phone, phone_normalized
     from contacts
    where phone is not null
    order by account_id, created_at`,
);

// Every normalized number currently held, per account — the set the
// unique index enforces against.
const takenByAccount = new Map<string, Map<string, Row>>();
for (const r of rows) {
  if (!takenByAccount.has(r.account_id)) takenByAccount.set(r.account_id, new Map());
  if (r.phone_normalized) takenByAccount.get(r.account_id)!.set(r.phone_normalized, r);
}

const updates: { row: Row; to: string }[] = [];
const collisions: { row: Row; to: string; with: Row }[] = [];
const unfixable: { row: Row; reason: string }[] = [];
let alreadyClean = 0;

for (const r of rows) {
  const country = countryByAccount.get(r.account_id) ?? FALLBACK_COUNTRY;
  const cleaned = cleanPhone(r.phone, { defaultCountry: country });

  if (!cleaned.ok) {
    unfixable.push({ row: r, reason: cleaned.rejection! });
    continue;
  }
  if (cleaned.e164 === r.phone) {
    alreadyClean++;
    continue;
  }

  const taken = takenByAccount.get(r.account_id)!;
  const holder = taken.get(cleaned.msisdn!);
  if (holder && holder.id !== r.id) {
    collisions.push({ row: r, to: cleaned.e164!, with: holder });
    continue;
  }

  // Claim the new value so two rows in this run cannot both take it.
  taken.delete(r.phone_normalized);
  taken.set(cleaned.msisdn!, r);
  updates.push({ row: r, to: cleaned.e164! });
}

const label = (r: Row) => `${JSON.stringify(r.phone).padEnd(20)} ${r.name ?? '(no name)'}`;

console.log(`\ncontacts with a phone: ${rows.length}`);
if (!hasCountryColumn) {
  console.log(
    `accounts.default_country_code does not exist yet (migration 051) — using --country=${FALLBACK_COUNTRY ?? 'none'}`,
  );
}
console.log(`\n  already correct : ${alreadyClean}`);
console.log(`  to rewrite      : ${updates.length}`);
console.log(`  collisions      : ${collisions.length}   (a duplicate already holds the cleaned number)`);
console.log(`  cannot fix      : ${unfixable.length}`);

if (updates.length) {
  console.log('\n--- will rewrite ---');
  for (const u of updates) console.log(`  ${label(u.row)} -> ${u.to}`);
}
if (collisions.length) {
  console.log('\n--- skipped: cleaning would collide with an existing contact ---');
  for (const c of collisions) {
    console.log(`  ${label(c.row)} -> ${c.to}  already held by "${c.with.name ?? '(no name)'}"`);
  }
  console.log('  Merge these in the UI; the script will not choose which record survives.');
}
if (unfixable.length) {
  console.log('\n--- cannot fix automatically ---');
  for (const u of unfixable) console.log(`  ${label(u.row)} ${u.reason}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing was written. Re-run with --apply to rewrite ${updates.length} numbers.\n`);
  await client.end();
  process.exit(0);
}

// One transaction: either every rewrite lands or none does, so a failure
// halfway cannot leave the table half-cleaned.
await client.query('BEGIN');
try {
  for (const u of updates) {
    await client.query('update contacts set phone = $1 where id = $2', [u.to, u.row.id]);
  }
  await client.query('COMMIT');
  console.log(`\nAPPLIED — rewrote ${updates.length} numbers.\n`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nFAILED — rolled back, nothing was written:', (err as Error).message, '\n');
  process.exitCode = 1;
}
await client.end();
