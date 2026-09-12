// Integration: array-typed RPC arguments through the real compiler against a real
// Postgres. Runs only when DATABASE_URL points at a database with the migrations
// applied; otherwise it is skipped so unit-only runs stay green.
//
// Regression for the public-API broadcast path: `create_broadcast_with_recipients`
// takes per-recipient params as jsonb[]. A nested JS array reached Postgres as a
// multi-dimensional array literal and failed with "invalid input syntax for type
// json", so every broadcast sent through /api/v1 died with "Failed to create
// broadcast" — a path the dashboard never exercises.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool } from './pool';
import { makeAdminClient } from './server-client';

const DB = process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

d('rpc: jsonb[] arguments', () => {
  // Fresh ids per run so a failed cleanup can never collide with the next run.
  const suffix = Date.now().toString(16).padStart(12, '0').slice(-12);
  const userId = `00000000-0000-4000-8000-${suffix}`;
  const contactA = `00000000-0000-4000-8001-${suffix}`;
  const contactB = `00000000-0000-4000-8002-${suffix}`;
  let accountId = '';
  let orgId = '';

  beforeAll(async () => {
    const pool = getPool();
    // Creating the auth user fires WA CRM's own signup trigger, which provisions
    // the account and organization — reuse those rather than fighting the
    // one-account-per-owner constraint.
    await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, `rpc-${suffix}@example.com`]);
    let acc = await pool.query(`SELECT id FROM accounts WHERE owner_user_id = $1`, [userId]);
    if (acc.rows.length === 0) {
      acc = await pool.query(`INSERT INTO accounts (name, owner_user_id) VALUES ('RPC test', $1) RETURNING id`, [userId]);
    }
    accountId = acc.rows[0].id;
    let org = await pool.query(`SELECT id FROM organizations WHERE legacy_account_id = $1`, [accountId]);
    if (org.rows.length === 0) {
      org = await pool.query(`INSERT INTO organizations (name, slug, legacy_account_id) VALUES ('RPC test org', $1, $2) RETURNING id`, [`rpc-${suffix}`, accountId]);
    }
    orgId = org.rows[0].id;
    await pool.query(
      `INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES ($1, $3, $4, $5, 'Ravi'), ($2, $3, $4, $6, 'Amit')`,
      [contactA, contactB, userId, accountId, `+9198765${suffix.slice(-5)}`, `+9198766${suffix.slice(-5)}`],
    );
  });

  afterAll(async () => {
    const pool = getPool();
    // Best-effort, FK-safe order; this is a throwaway test database.
    for (const [sql, args] of [
      [`DELETE FROM broadcasts WHERE account_id = $1`, [accountId]],
      [`DELETE FROM contacts WHERE account_id = $1`, [accountId]],
      [`DELETE FROM organizations WHERE id = $1`, [orgId]],
      [`DELETE FROM accounts WHERE id = $1`, [accountId]],
      [`DELETE FROM auth.users WHERE id = $1`, [userId]],
    ] as [string, string[]][]) {
      try { await pool.query(sql, args); } catch { /* leave for the next run's fresh ids */ }
    }
    await pool.end();
  });

  it('passes per-recipient params as jsonb[] and stores them per row', async () => {
    const db = makeAdminClient();
    const { data, error } = await db.rpc('create_broadcast_with_recipients', {
      p_account_id: accountId,
      p_user_id: userId,
      p_name: 'jsonb[] regression',
      p_template_name: 'campaign_old_audience',
      p_template_language: 'en_US',
      p_total_recipients: 2,
      p_contact_ids: [contactA, contactB],
      p_template_params: [['Ravi'], ['Amit']],
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(2);

    const { rows } = await getPool().query(
      `SELECT r.contact_id, r.template_params FROM broadcast_recipients r
       JOIN broadcasts b ON b.id = r.broadcast_id WHERE b.account_id = $1 ORDER BY r.contact_id`,
      [accountId],
    );
    expect(rows.map((r) => r.template_params)).toEqual([['Ravi'], ['Amit']]);
  });

  it('accepts empty params (no template variables)', async () => {
    const db = makeAdminClient();
    const { error } = await db.rpc('create_broadcast_with_recipients', {
      p_account_id: accountId,
      p_user_id: userId,
      p_name: 'no params',
      p_template_name: 'plain',
      p_template_language: 'en',
      p_total_recipients: 2,
      p_contact_ids: [contactA, contactB],
      p_template_params: [[], []],
    });
    expect(error).toBeNull();
  });
});
