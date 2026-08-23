-- ============================================================
-- 045_organization_rpcs.sql — organization-scoped RPC signatures
-- (SaaS Phase 3, Step 3)
--
-- Two SECURITY DEFINER functions take a tenant id as an explicit
-- parameter and use it to filter a SELECT (migration 030) — since
-- they're SECURITY DEFINER, they bypass RLS entirely and rely solely
-- on the caller passing the right id (see that migration's own
-- comment: "bypasses RLS and only gates on the passed account_id").
-- The Step 2 RLS rewrite doesn't reach these, so they're moved onto
-- organization_id explicitly here.
--
-- `create_broadcast_with_recipients` (migration 038) was audited too
-- and deliberately NOT touched: it only ever INSERTs using
-- p_account_id (never a tenant-scoped SELECT), and migration 043's
-- trigger already derives organization_id from that account_id
-- automatically on insert — there is nothing for this migration to
-- fix there. Re-parameterizing it would be a no-op renaming exercise,
-- not a security-relevant change.
--
-- DROP + CREATE in place, same established pattern as
-- 034_fix_profiles_update_rls.sql (CREATE OR REPLACE can't rename a
-- parameter — Postgres error: "cannot change name of input parameter"
-- — even though the type signature is otherwise identical). Idempotent
-- (DROP FUNCTION IF EXISTS).
-- ============================================================

-- Postgres identifies overload identity by parameter TYPES only, but
-- CREATE OR REPLACE still refuses to rename a parameter in place
-- ("cannot change name of input parameter") — DROP first.
DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);

CREATE FUNCTION public.match_ai_knowledge_fts(
  p_organization_id uuid,
  p_query           text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.organization_id = p_organization_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);

CREATE FUNCTION public.match_ai_knowledge_semantic(
  p_organization_id uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.organization_id = p_organization_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- NOTE: Postgres identifies a function by name + parameter TYPES, not
-- parameter names — CREATE OR REPLACE with the same (uuid, text,
-- integer) signature above REPLACES the existing p_account_id version
-- in place; it does not add a second overload. Since this app's `db.rpc()`
-- calls these with named parameters (`{ p_account_id: ... }`), the two
-- TS call sites in src/lib/ai/knowledge.ts MUST be updated to
-- `p_organization_id` in the same deploy as this migration — an
-- unmodified old call site would fail with "function ... does not
-- exist" (wrong parameter name) the moment this migration lands.
-- Tracked together, not left as a dangling follow-up.

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;
