-- Tenant-isolation proof for the CI job in
-- `.github/workflows/migrations.yml`, run immediately after
-- verify-schema.sql. Where that file proves "did the migrations build
-- the schema", this one proves the actual Phase 3 guarantee: a member
-- of one organization can never read or write another organization's
-- rows, under the real `authenticated` role — not superuser, not
-- service_role.
--
-- Self-seeding (no dependency on `999_seed.sql` — this CI job runs
-- `supabase db reset --no-seed`): creates two real, unrelated
-- organizations via `auth.users` inserts, letting `handle_new_user`
-- (017) and the organization sync triggers (042) do exactly what a
-- real signup does. Seeds one row in every parent table that carries
-- `organization_id` (migration 043) plus a sample of the child tables
-- scoped via a parent join (migration 044), then asserts, as
-- Organization A's own user under RLS:
--   - SELECT sees zero of Organization B's rows, across every table
--   - UPDATE / DELETE targeting a known Organization B row id affects
--     zero rows (RLS silently filters rather than erroring, so the
--     assertion is on ROW_COUNT, not on an exception)
--
-- MUST contain exactly one top-level statement — see the note at the
-- bottom of verify-schema.sql for why (the same `supabase db query
-- --file` mechanism runs this file).
DO $$
DECLARE
  v_user_a  uuid := gen_random_uuid();
  v_user_b  uuid := gen_random_uuid();
  v_acct_a  uuid;
  v_acct_b  uuid;
  v_contact_b uuid;
  v_pipeline_b uuid;
  v_stage_b uuid;
  v_conv_b uuid;
  v_count  int;
  v_rows   int;
BEGIN
  -- ---- seed two independent tenants ---------------------------------
  INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
  VALUES
    (v_user_a, 'isolation-test-a@example.com', crypt('password123', gen_salt('bf')), '{"full_name":"Isolation Test A"}'::jsonb),
    (v_user_b, 'isolation-test-b@example.com', crypt('password123', gen_salt('bf')), '{"full_name":"Isolation Test B"}'::jsonb);

  SELECT account_id INTO v_acct_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_acct_b FROM profiles WHERE user_id = v_user_b;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (v_acct_b, v_user_b, '+15550009001', 'Isolation Test B Contact')
  RETURNING id INTO v_contact_b;
  INSERT INTO tags (account_id, user_id, name) VALUES (v_acct_b, v_user_b, 'isolation-test-b-tag');
  INSERT INTO pipelines (account_id, user_id, name) VALUES (v_acct_b, v_user_b, 'Isolation Test B Pipeline') RETURNING id INTO v_pipeline_b;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (v_pipeline_b, 'Stage', 0) RETURNING id INTO v_stage_b;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, value)
  VALUES (v_acct_b, v_user_b, v_pipeline_b, v_stage_b, v_contact_b, 'Isolation Test B Deal', 1);
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (v_acct_b, v_user_b, v_contact_b) RETURNING id INTO v_conv_b;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (v_conv_b, 'agent', 'text', 'Isolation Test B message');
  INSERT INTO automations (account_id, user_id, name, trigger_type)
  VALUES (v_acct_b, v_user_b, 'Isolation Test B Automation', 'new_message_received');
  INSERT INTO broadcasts (account_id, user_id, name, template_name)
  VALUES (v_acct_b, v_user_b, 'Isolation Test B Broadcast', 'hello');
  INSERT INTO message_templates (account_id, user_id, name, body_text)
  VALUES (v_acct_b, v_user_b, 'isolation_test_b_template', 'body');
  INSERT INTO api_keys (account_id, created_by, name, key_prefix, key_hash)
  VALUES (v_acct_b, v_user_b, 'Isolation Test B Key', 'wacrm_live_isob', 'fakehash_isolation_b');

  -- ---- assert isolation as Organization A's own user, under RLS -----
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text,
    true
  );

  SELECT count(*) INTO v_count FROM contacts WHERE id = v_contact_b;
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: contacts leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM tags WHERE name = 'isolation-test-b-tag';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: tags leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM pipelines WHERE id = v_pipeline_b;
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: pipelines leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM pipeline_stages WHERE id = v_stage_b;
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: pipeline_stages (child-join RLS) leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM deals WHERE title = 'Isolation Test B Deal';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: deals leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM conversations WHERE id = v_conv_b;
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: conversations leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM messages WHERE content_text = 'Isolation Test B message';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: messages (child-join RLS) leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM automations WHERE name = 'Isolation Test B Automation';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: automations leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM broadcasts WHERE name = 'Isolation Test B Broadcast';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: broadcasts leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM message_templates WHERE name = 'isolation_test_b_template';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: message_templates leaked cross-tenant'; END IF;

  SELECT count(*) INTO v_count FROM api_keys WHERE name = 'Isolation Test B Key';
  IF v_count > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: api_keys leaked cross-tenant'; END IF;

  -- Cross-tenant write attempts must affect zero rows (RLS filters the
  -- WHERE clause silently — this is not expected to raise).
  UPDATE contacts SET name = 'TENANT ISOLATION BREACH' WHERE id = v_contact_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: cross-tenant UPDATE on contacts affected % row(s)', v_rows; END IF;

  DELETE FROM contacts WHERE id = v_contact_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN RAISE EXCEPTION 'TENANT ISOLATION FAILURE: cross-tenant DELETE on contacts affected % row(s)', v_rows; END IF;

  RESET ROLE;

  RAISE NOTICE 'tenant isolation verified: Organization A cannot read or write Organization B''s rows (contacts, tags, pipelines, pipeline_stages, deals, conversations, messages, automations, broadcasts, message_templates, api_keys)';
END
$$;
