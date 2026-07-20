-- ════════════════════════════════════════════════════════
-- Migration 004: Preis je Ziehung (Gewinner-Historie)
-- Speichert, WAS gewonnen wurde, zusätzlich zu wer/wann/wie viele.
-- Idempotent — safe to run repeatedly.
-- (Wird zusätzlich beim Service-Start via ensureSchema() garantiert.)
-- ════════════════════════════════════════════════════════

ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS prize TEXT;
