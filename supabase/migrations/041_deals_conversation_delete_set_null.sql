-- ============================================================
-- Allow contact deletion when the contact has a pipeline deal.
--
-- Migration 004 SET NULL'd deals.contact_id so deleting a contact
-- would not wipe the deal. That was not enough: conversations.contact_id
-- is ON DELETE CASCADE, so deleting the contact still tries to delete
-- the conversation. deals.conversation_id was declared
-- REFERENCES conversations(id) with no ON DELETE action (Postgres
-- defaults to NO ACTION), so the cascade failed with:
--
--   ERROR 23503: update or delete on table "conversations" violates
--   foreign key constraint "deals_conversation_id_fkey"
--
-- The Contacts page surfaces that as "Failed to delete contact(s)".
--
-- SET NULL is the right fix — same rationale as 004: the deal row
-- survives as history (contact and thread both become "Unknown").
-- CASCADE would silently delete pipeline deals.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_conversation_id_fkey'
      AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      DROP CONSTRAINT deals_conversation_id_fkey;
  END IF;
END $$;

ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE SET NULL;
