-- ════════════════════════════════════════════════════════
-- CHAOS CREW v5 – PostgreSQL Schema
-- Persistente Langzeit-Daten (Sessions, Watchtime, Gewinner)
-- Redis bleibt für Live-State (gw_open, aktive User)
-- ════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── User Profile ──────────────────────────────────────────
-- Kumulierte Lifetime-Statistiken pro Viewer
CREATE TABLE IF NOT EXISTS users (
    username        TEXT PRIMARY KEY,          -- twitch login (lowercase)
    display         TEXT NOT NULL,             -- Anzeigename
    total_watch_sec BIGINT  NOT NULL DEFAULT 0,
    total_msgs      BIGINT  NOT NULL DEFAULT 0,
    times_won       INTEGER NOT NULL DEFAULT 0,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Giveaway Sessions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,          -- z.B. sess_1234567890
    keyword         TEXT NOT NULL DEFAULT '',
    channels        JSONB,                     -- teilnehmende Kanäle der Kampagne
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    winner          TEXT,                      -- FK users.username, nullable
    winner_watch_sec BIGINT,
    winner_coins    NUMERIC(10,4),
    total_participants INTEGER NOT NULL DEFAULT 0,
    total_coins     NUMERIC(10,4) NOT NULL DEFAULT 0
);

-- ── Session Participants Snapshot ─────────────────────────
-- Snapshot beim Schließen der Session gespeichert
CREATE TABLE IF NOT EXISTS session_participants (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    username        TEXT NOT NULL,
    display         TEXT NOT NULL,
    watch_sec       BIGINT  NOT NULL DEFAULT 0,
    msgs            INTEGER NOT NULL DEFAULT 0,
    coins           NUMERIC(10,4) NOT NULL DEFAULT 0,
    banned          BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (session_id, username)
);

-- ── Watchtime Event Log ───────────────────────────────────
-- Jedes Viewer-Tick- und Chat-Bonus-Event
-- Wichtig: Primäre Quelle der Wahrheit für Watchtime
CREATE TABLE IF NOT EXISTS watchtime_events (
    id          BIGSERIAL PRIMARY KEY,
    username    TEXT NOT NULL,
    event_type  TEXT NOT NULL CHECK (event_type IN ('tick','chat_bonus','admin_add','admin_sub')),
    delta_sec   INTEGER NOT NULL,
    session_id  TEXT,
    channel     TEXT,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wt_username ON watchtime_events(username);
CREATE INDEX IF NOT EXISTS idx_wt_session  ON watchtime_events(session_id);
CREATE INDEX IF NOT EXISTS idx_wt_ts       ON watchtime_events(ts);

-- ── Campaign Participation (per user × channel, Snapshot bei close) ──
CREATE TABLE IF NOT EXISTS campaign_participation (
    session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    channel     TEXT NOT NULL,
    watch_sec   BIGINT NOT NULL DEFAULT 0,
    msgs        INTEGER NOT NULL DEFAULT 0,
    coins       NUMERIC(10,4) NOT NULL DEFAULT 0,
    follows     BOOLEAN NOT NULL DEFAULT FALSE,
    valid       BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (session_id, username, channel)
);
CREATE INDEX IF NOT EXISTS idx_cp_session ON campaign_participation(session_id);
CREATE INDEX IF NOT EXISTS idx_cp_user    ON campaign_participation(username);

-- ── Debug Log ─────────────────────────────────────────────
-- Stage-level events from Streamerbot actions / services.
-- Used to diagnose missing/dropped events.
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

-- ── Giveaway Draw Audit Trail ─────────────────────────────
-- Jede Winner-Ziehung vollständig protokolliert (Nachvollziehbarkeit).
-- eligible_snapshot + total_coins + rand_value = reproduzierbare Ziehung.
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
    prize             TEXT,
    eligible_snapshot JSONB,
    drawn_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draws_session ON giveaway_draws(session_id);
CREATE INDEX IF NOT EXISTS idx_draws_winner  ON giveaway_draws(winner);
CREATE INDEX IF NOT EXISTS idx_draws_ts      ON giveaway_draws(drawn_at DESC);

-- ── Winner History ────────────────────────────────────────
CREATE VIEW winner_history AS
    SELECT s.id AS session_id, s.keyword, s.opened_at, s.closed_at,
           s.winner, s.winner_watch_sec, s.winner_coins,
           s.total_participants, s.total_coins
    FROM sessions s
    WHERE s.winner IS NOT NULL
    ORDER BY s.closed_at DESC;
