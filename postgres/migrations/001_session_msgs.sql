-- ════════════════════════════════════════════════════════
-- Migration 001: Session message counter
-- Ensures users.total_msgs and session_participants.msgs
-- exist for installs predating their inclusion in init.sql.
-- Idempotent — safe to run repeatedly.
-- ════════════════════════════════════════════════════════

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_msgs BIGINT NOT NULL DEFAULT 0;

ALTER TABLE session_participants
    ADD COLUMN IF NOT EXISTS msgs INTEGER NOT NULL DEFAULT 0;