-- ════════════════════════════════════════════════════════
-- Migration 003: Giveaway draw audit trail
-- Jede Winner-Ziehung wird vollständig protokolliert:
--   eligible_snapshot (geordnete username+coins-Liste),
--   total_coins und rand_value erlauben die Reproduktion
--   der gewichteten Ziehung — volle Nachvollziehbarkeit.
-- Idempotent — safe to run repeatedly.
-- (Wird zusätzlich beim Service-Start via ensureSchema() garantiert.)
-- ════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS giveaway_draws (
    id                BIGSERIAL PRIMARY KEY,
    session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    winner            TEXT NOT NULL,
    winner_coins      NUMERIC(10,4) NOT NULL DEFAULT 0,
    winner_watch_sec  BIGINT NOT NULL DEFAULT 0,
    total_coins       NUMERIC(10,4) NOT NULL DEFAULT 0,
    eligible_count    INTEGER NOT NULL DEFAULT 0,
    rand_value        NUMERIC(20,10) NOT NULL DEFAULT 0,
    draw_index        INTEGER NOT NULL DEFAULT 1,
    is_test           BOOLEAN NOT NULL DEFAULT FALSE,
    eligible_snapshot JSONB,
    drawn_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draws_session ON giveaway_draws(session_id);
CREATE INDEX IF NOT EXISTS idx_draws_winner  ON giveaway_draws(winner);
CREATE INDEX IF NOT EXISTS idx_draws_ts      ON giveaway_draws(drawn_at DESC);
