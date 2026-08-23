-- ============================================================
-- 044_organization_rls.sql — RLS cutover to the organization layer
-- (SaaS Phase 3, Step 2)
--
-- Rewrites every `is_account_member(account_id, role)` policy (and
-- every parent-join equivalent) to `is_organization_member(organization_id,
-- role)`, across the 24 tables with a direct organization_id column
-- (migration 043) and the 9 child tables scoped via a parent join.
-- Role thresholds map 1:1: 'admin' -> 'organization_admin', 'agent'
-- stays 'agent' (organization_role_enum has no 'viewer'-vs-'agent'
-- naming clash to worry about — both enums use the same literal for
-- that rank).
--
-- Behavior-preserving by construction: organization_id has been a
-- NOT NULL, trigger-maintained mirror of account_id since migration
-- 043, so every membership check below evaluates to the exact same
-- boolean it did under is_account_member — this migration moves
-- *where* the boundary is declared, not what it allows. Verified via
-- supabase/ci/verify-tenant-isolation.sql (two real orgs, cross-tenant
-- read/write attempts asserted rejected) — see that file for the
-- actual proof, not just this migration's comments.
--
-- NOT touched, deliberately
--   - accounts, profiles, account_invitations — no organization_id
--     column (Phase 2 excluded them: they're the identity/membership
--     layer itself, already bridged via organizations.legacy_account_id).
--     Their RLS stays is_account_member-based.
--   - notifications — already identity-based (auth.uid() = user_id),
--     never used is_account_member for its own policies to begin with.
--   - organizations / organization_members / organization_settings —
--     already is_organization_member-based since migration 042.
--   - automation_pending_executions — no client-facing policies exist
--     today (service-role only, Phase 0 finding); nothing to rewrite.
--
-- Prerequisite: migration 043 (organization_id columns).
--
-- Idempotent — DROP POLICY IF EXISTS before every CREATE POLICY,
-- matching this repo's established pattern (017/026/028/etc.).
-- ============================================================

-- ---- ai_configs --------------------------------------------------
DROP POLICY IF EXISTS ai_configs_select ON ai_configs;
CREATE POLICY ai_configs_select ON ai_configs FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS ai_configs_insert ON ai_configs;
CREATE POLICY ai_configs_insert ON ai_configs FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_configs_update ON ai_configs;
CREATE POLICY ai_configs_update ON ai_configs FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_configs_delete ON ai_configs;
CREATE POLICY ai_configs_delete ON ai_configs FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- ai_knowledge_documents ---------------------------------------
DROP POLICY IF EXISTS ai_knowledge_documents_select ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_select ON ai_knowledge_documents FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS ai_knowledge_documents_insert ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_insert ON ai_knowledge_documents FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_knowledge_documents_update ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_update ON ai_knowledge_documents FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_knowledge_documents_delete ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_delete ON ai_knowledge_documents FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- ai_knowledge_chunks -------------------------------------------
DROP POLICY IF EXISTS ai_knowledge_chunks_select ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_insert ON ai_knowledge_chunks FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_knowledge_chunks_update ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_update ON ai_knowledge_chunks FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_delete ON ai_knowledge_chunks FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- ai_usage_log (admin-only read, per Phase 0) -------------------
DROP POLICY IF EXISTS ai_usage_log_select ON ai_usage_log;
CREATE POLICY ai_usage_log_select ON ai_usage_log FOR SELECT
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- api_keys (settings-class) -------------------------------------
DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS api_keys_insert ON api_keys;
CREATE POLICY api_keys_insert ON api_keys FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS api_keys_update ON api_keys;
CREATE POLICY api_keys_update ON api_keys FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS api_keys_delete ON api_keys;
CREATE POLICY api_keys_delete ON api_keys FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- automation_logs (read-only via RLS; service role inserts) ----
DROP POLICY IF EXISTS automation_logs_select ON automation_logs;
CREATE POLICY automation_logs_select ON automation_logs FOR SELECT
  USING (is_organization_member(organization_id));

-- ---- automations ----------------------------------------------------
DROP POLICY IF EXISTS automations_select ON automations;
CREATE POLICY automations_select ON automations FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS automations_insert ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS automations_update ON automations;
CREATE POLICY automations_update ON automations FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_delete ON automations FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- automation_steps (child of automations) ------------------------
DROP POLICY IF EXISTS automation_steps_select ON automation_steps;
CREATE POLICY automation_steps_select ON automation_steps FOR SELECT USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_organization_member(a.organization_id))
);
DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_organization_member(a.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_organization_member(a.organization_id, 'agent'))
);

-- ---- broadcasts -------------------------------------------------------
DROP POLICY IF EXISTS broadcasts_select ON broadcasts;
CREATE POLICY broadcasts_select ON broadcasts FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- broadcast_recipients (child of broadcasts) ------------------------
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
CREATE POLICY broadcast_recipients_select ON broadcast_recipients FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_organization_member(b.organization_id))
);
DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_organization_member(b.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_organization_member(b.organization_id, 'agent'))
);

-- ---- contact_notes -----------------------------------------------------
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS contact_notes_insert ON contact_notes;
CREATE POLICY contact_notes_insert ON contact_notes FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- contacts -----------------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS contacts_insert ON contacts;
CREATE POLICY contacts_insert ON contacts FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contacts_update ON contacts;
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- contact_tags (child of contacts) --------------------------------
DROP POLICY IF EXISTS contact_tags_select ON contact_tags;
CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_organization_member(c.organization_id))
);
DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_organization_member(c.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_organization_member(c.organization_id, 'agent'))
);

-- ---- contact_custom_values (child of contacts) -----------------------
DROP POLICY IF EXISTS contact_custom_values_select ON contact_custom_values;
CREATE POLICY contact_custom_values_select ON contact_custom_values FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id AND is_organization_member(c.organization_id))
);
DROP POLICY IF EXISTS contact_custom_values_modify ON contact_custom_values;
CREATE POLICY contact_custom_values_modify ON contact_custom_values FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id AND is_organization_member(c.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id AND is_organization_member(c.organization_id, 'agent'))
);

-- ---- conversations --------------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- messages (child of conversations) -------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_organization_member(c.organization_id))
);
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_organization_member(c.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_organization_member(c.organization_id, 'agent'))
);

-- ---- message_reactions (child of messages -> conversations) ---------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id AND is_organization_member(c.organization_id)
  )
);
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id AND is_organization_member(c.organization_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id AND is_organization_member(c.organization_id, 'agent')
  )
);

-- ---- custom_fields (settings-class) ----------------------------------
DROP POLICY IF EXISTS custom_fields_select ON custom_fields;
CREATE POLICY custom_fields_select ON custom_fields FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS custom_fields_insert ON custom_fields;
CREATE POLICY custom_fields_insert ON custom_fields FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS custom_fields_update ON custom_fields;
CREATE POLICY custom_fields_update ON custom_fields FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS custom_fields_delete ON custom_fields;
CREATE POLICY custom_fields_delete ON custom_fields FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- deals --------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS deals_insert ON deals;
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS deals_update ON deals;
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- flows ----------------------------------------------------------------
DROP POLICY IF EXISTS flows_select ON flows;
CREATE POLICY flows_select ON flows FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS flows_insert ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS flows_update ON flows;
CREATE POLICY flows_update ON flows FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_delete ON flows FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- flow_nodes (child of flows) -------------------------------------
DROP POLICY IF EXISTS flow_nodes_select ON flow_nodes;
CREATE POLICY flow_nodes_select ON flow_nodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_organization_member(f.organization_id))
);
DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_organization_member(f.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_organization_member(f.organization_id, 'agent'))
);

-- ---- flow_runs (read-only via RLS; service role drives writes) --------
DROP POLICY IF EXISTS flow_runs_select ON flow_runs;
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT
  USING (is_organization_member(organization_id));

-- ---- flow_run_events (child of flow_runs) ------------------------------
DROP POLICY IF EXISTS flow_run_events_select ON flow_run_events;
CREATE POLICY flow_run_events_select ON flow_run_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = flow_run_events.flow_run_id AND is_organization_member(r.organization_id))
);

-- ---- member_presence ------------------------------------------------------
DROP POLICY IF EXISTS member_presence_select ON member_presence;
CREATE POLICY member_presence_select ON member_presence FOR SELECT
  USING (is_organization_member(organization_id));

-- ---- message_templates (settings-class) -----------------------------
DROP POLICY IF EXISTS message_templates_select ON message_templates;
CREATE POLICY message_templates_select ON message_templates FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS message_templates_insert ON message_templates;
CREATE POLICY message_templates_insert ON message_templates FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS message_templates_update ON message_templates;
CREATE POLICY message_templates_update ON message_templates FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS message_templates_delete ON message_templates;
CREATE POLICY message_templates_delete ON message_templates FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- pipelines (settings-class) --------------------------------------
DROP POLICY IF EXISTS pipelines_select ON pipelines;
CREATE POLICY pipelines_select ON pipelines FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS pipelines_insert ON pipelines;
CREATE POLICY pipelines_insert ON pipelines FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS pipelines_update ON pipelines;
CREATE POLICY pipelines_update ON pipelines FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS pipelines_delete ON pipelines;
CREATE POLICY pipelines_delete ON pipelines FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- pipeline_stages (child of pipelines) ----------------------------
DROP POLICY IF EXISTS pipeline_stages_select ON pipeline_stages;
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id AND is_organization_member(p.organization_id))
);
DROP POLICY IF EXISTS pipeline_stages_modify ON pipeline_stages;
CREATE POLICY pipeline_stages_modify ON pipeline_stages FOR ALL USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id AND is_organization_member(p.organization_id, 'organization_admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id AND is_organization_member(p.organization_id, 'organization_admin'))
);

-- ---- quick_replies --------------------------------------------------------
DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
CREATE POLICY quick_replies_select ON quick_replies FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;
CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ---- tags (settings-class) --------------------------------------------
DROP POLICY IF EXISTS tags_select ON tags;
CREATE POLICY tags_select ON tags FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS tags_insert ON tags;
CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS tags_update ON tags;
CREATE POLICY tags_update ON tags FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS tags_delete ON tags;
CREATE POLICY tags_delete ON tags FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- webhook_endpoints (settings-class) -------------------------------
DROP POLICY IF EXISTS webhook_endpoints_select ON webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS webhook_endpoints_insert ON webhook_endpoints;
CREATE POLICY webhook_endpoints_insert ON webhook_endpoints FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS webhook_endpoints_update ON webhook_endpoints;
CREATE POLICY webhook_endpoints_update ON webhook_endpoints FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS webhook_endpoints_delete ON webhook_endpoints;
CREATE POLICY webhook_endpoints_delete ON webhook_endpoints FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ---- whatsapp_config (settings-class) ----------------------------------
DROP POLICY IF EXISTS whatsapp_config_select ON whatsapp_config;
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;
CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));
