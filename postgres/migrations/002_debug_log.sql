-- ════════════════════════════════════════════════════════
-- Migration 002: Debug log table
-- Stores stage-level debug events from Streamerbot actions
-- and services. Used to diagnose missing/dropped events.
-- Idempotent — safe to run repeatedly.
-- ════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS debug_log (
    id          BIGSERIAL PRIMARY KEY,
    source      TEXT        NOT NULL,
    stage       TEXT        NOT NULL,
    username    TEXT,
    info        TEXT,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_debug_ts     ON debug_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_debug_source ON debug_log(source);
