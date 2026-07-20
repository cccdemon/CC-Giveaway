# CLAUDE.md

Guidance for Claude Code in this repo. These instructions OVERRIDE defaults.

# CC-Giveaway

## Zweck
Eigenständiges Multi-Channel-Community-Giveaway + Punktesystem. Aktive Zuschauer
sammeln über mehrere Streams (Kanäle streamen nicht gleichzeitig) viewtime-basierte
Punkte/Lose. Hervorgegangen aus der CC-StreamSuite, aber kein Fork mehr — es gibt
keine Abhängigkeit zu Spacefight, Alerts, HUD-Chat, Gamescenes, Stats oder Hauling.

## Mechanik (Spec)
- **Viewtime pro Zuschauer.** **Coin-Basis ist per-Team konfigurierbar** (Admin: „1 Coin = X Std Viewtime", Redis `cfgDrawMinSec`, Default 7200s = 2h, `SECS_PER_COIN` nur noch Fallback). Derselbe Wert ist auch die Lostopf-Schwelle: **im Lostopf ab ≥1 Coin**. `coinsFromSec(sec, baseSec)`, `getCoinBaseSec(teamId)`.
- **Chat = selber Pott wie Viewtime.** Jede sinnvolle Nachricht mit **>3 Wörtern** = **+2s** Viewtime (`CHAT_BONUS_SEC=2`, `CHAT_MIN_WORDS=4`), Cooldown gegen Spam. Viewtime-Multiplier gilt auch hier (×2 → +4s).
- **Viewtime-Multiplier:** Admin kann zeitlich begrenzt beschleunigen („nächste 15 min doppelte Viewtime", gilt auch für Chat) — time-boxed Faktor auf Tick + Chat-Bonus.
- **Teilnahme:** Folge ≥2 der teilnehmenden Kanäle (konfigurierbar) + Viewtime + sinnvoller Chat. Lurken allein = keine Lose. Ab ≥1 Ticket per Keyword im Chat opt-in (= Zustimmung Teilnahmebedingungen).
- **Ziehung:** Zufall gewichtet nach Ticketzahl. Gewinner 14 Tage Meldefrist, sonst Ersatz.
- **Follow-Check = Hybrid:** Streamerbot-Live-Gate (`follows` am Event) + Helix-Reconcile vor Ziehung. Follower werden **pro Kanal über den Self-OAuth-Token des Kanal-Owners** gelesen (Scope `moderator:read:followers`, Login auf team.raumdock.org → Tabelle `streamers`, self=broadcaster). Kanäle ohne eingeloggten Owner bleiben permissiv. Divergenz → Flag, Coins des Kanals raus.
- **Nachvollziehbarkeit:** jede Coin-Bewegung in `watchtime_events`, Per-Kanal-Stand in `campaign_participation`, jede Ziehung in `giveaway_draws` mit reproduzierbarem Snapshot + Follow-Audit.

> Multi-Channel-Campaign-Umbau (Kanal-Dimension, Ingest-Inversion, Login) ist in Arbeit — siehe Auto-Memory `team-giveaway-design`. Der Live-Code ist teils noch Single-Channel (Legacy-Session-Fallback).

## Services (`services/`)
| Service | Container | Port | Zweck |
|---|---|---|---|
| `bridge` | cc-bridge | 3000 | Streamerbot-Ingest → Redis Pub/Sub |
| `giveaway` | cc-giveaway | 3001 | Watchtime-Engine, Coin-Calc, Winner-Draw, WS-Admin, REST |
| `admin` | cc-admin | 3005 | Login + Benutzerverwaltung + Admin-Pages + Health |
| Caddy | cc-web | 80/443 | Reverse Proxy, Path-Routing |
| Redis | cc-redis | 6379 | Live-State (DB 0 prod, DB 1 tests) |
| PostgreSQL | cc-postgres | 5432 | Persistenz |
| Redis UI | cc-redis-ui | 8081 | Redis Commander (loopback) |
| Backup | cc-backup | – | täglich 03:00 |

## Event Flow
```
Streamerbot ──► bridge ──publish──► ch:giveaway ──► giveaway/server.js ──WS──► admin
                giveaway ──publish──► ch:chat_reply ──► bridge ──► Streamerbot (Chat)
```
Kanäle: `viewer_tick, chat_msg, time_cmd, stream_online` → `ch:giveaway`; `chat_reply` zurück.

## Key Files
- `services/bridge/server.js` — Streamerbot-Ingest + Redis-Router
- `services/giveaway/server.js` — Giveaway REST + WS + Ticker
- `services/giveaway/watchtime.js` — Coin/Ticket-Engine (testbar, ohne WS/HTTP)
- `services/giveaway/public/giveaway-shared.js` — Shared-Lib (`CC.validate`, Nav)
- `services/giveaway/public/giveaway-admin.js` — Admin-Panel-Logik
- `services/admin/server.js` — Health + statische Admin-Pages
- `services/admin/public/admin-shared.js` — `CC.validate`, Nav, Debug-Console
- `caddy/Caddyfile` (HTTP) · `caddy/Caddyfile.team` (prod, TLS DNS-01) · `caddy/Caddyfile.ssl`

## REST (`/giveaway/api/...`)
`GET participants` · `GET user/:u` · `GET sessions` · `GET leaderboard` · `GET draws` (`?session=`,`?full=1`,`?limit=`) · `GET ws/clients`

## Admin WS `gw_cmd` (`{event:'gw_cmd',cmd,...}`)
`gw_open`(+keyword) · `gw_close` · `gw_draw_winner` · `gw_set_keyword` · `gw_get_keyword` · `gw_add_ticket`(user,amount) · `gw_sub_ticket` · `gw_ban`/`gw_unban` · `gw_reset`

## Data
- **Redis:** open/closed, keyword, banned, watchsec/msgs pro User, session id, (geplant: per-channel keys, follow-cache, multiplier).
- **PostgreSQL:** `sessions`, `users`, `session_participants`, `watchtime_events`, `giveaway_draws` (voller Draw-Audit), `audit_log` (append-only: jede zustandsändernde Admin-/System-Aktion mit Actor, IP, Ziel, Vorher/Nachher; auch `denied`/`error`). Schema: `postgres/init.sql` (frisches Volume) + `ensureSchema()` beim Start (verlässlich).
- **Audit-Choke-Point:** `handleAdminCmd()` in `services/giveaway/server.js` — jedes neue `gw_cmd` läuft automatisch mit. Nur-Lese-Cmds in `AUDIT_SKIP` eintragen. Tokens gehören NIE ins `detail`.

## Streamerbot C# (`streamerbot/`) — inverted ingest client (Phase 6)
Streamerbot verbindet sich als **WebSocket-Client** zu `wss://team.raumdock.org/ingest`
und authentifiziert mit Per-Kanal-Token (`ingest_auth`). Kanal kommt serverseitig aus
dem Token (nie im Payload). Actions: `CC_IngestConnect` (Auth on connect), `CC_ChatReply`
(WS-Client-Message → Twitch-Chat), `GW_ViewerTick`, `GW_ChatMessage`, `GW_StatusCmd` (`!los`).
`CPH.WebsocketSend(payload, 0)`. Setup: `streamerbot/CAMPAIGN_SETUP.md`. Teilnehmer-/Rechtstexte:
`docs/ANLEITUNG-TEILNEHMER.md`, `docs/TEILNAHMEBEDINGUNGEN.md`.

## Deploy (prod)
Ziel **LXC 103 „streamer" = 10.10.10.99** (raumdock), Domain **team.raumdock.org**.
Zugang NUR: `ssh -i ~/.ssh/claude_deploy root@ve.raumdock.org "pct exec 103 -- sh -c '<cmd>'"` (nie direkt zu 10.10.10.99).
Edge: `team.raumdock.org:443` → LXC 101 nginx (L4 SNI-Passthrough) → `10.10.10.99:9444` → cc-web Caddy (TLS via Cloudflare DNS-01). 80/443 auf 103 belegt → `:9444`.
```
cd /opt/team-giveaway && git pull
docker compose -f docker-compose.yml -f docker-compose.team.yml -p team up -d --build
```
Details in Auto-Memory `deploy-target-team-giveaway`.

## Sicherheit
Stack hat noch **kein natives Auth** (WS-Cmds/REST offen). Interim: Caddy Basic-Auth über ganze Domain (`Caddyfile.team`). **In Arbeit:** echtes Login + Benutzerverwaltung (zentral via Caddy `forward_auth` → admin-Service, Session-Cookie) ersetzt den Stopgap.

## Konventionen
- Deutsche UI. Admin-Pages laden `admin-shared.js` zuerst. OBS-Overlays laden es NICHT.
- WS-Events `{event:'name',...}`; Admin-Cmds `{event:'gw_cmd',cmd}`. Neue Events/Cmds in `ALLOWED_EVENTS`/`ALLOWED_CMDS` (admin-shared.js + giveaway-shared.js).
- `CC.validate` für alle Input-Sanitization. `sanitizeUsername(s)` konsistent C# ↔ JS (lowercase, [a-z0-9_], max 25).
- `log(tag,...)`/`logErr(tag,...)` statt raw console.
- Redis DB 0 = prod, DB 1 = tests — nie DB 0 im Testcode.

## Dev
```bash
# services/<name>/
npm start · npm run dev (--watch) · npm test   # node --test, Redis DB 1
docker compose up -d [--build]
```

## Response Rules
- Terse. Kein Filler, keine „was ich geändert habe"-Zusammenfassung (Diff ist sichtbar).
- Keine bereits im Kontext gelesenen Files neu lesen. Grep vor kleinem Edit statt ganze Files.
- Edit vor Write bei bestehenden Files. Mehrere Edits in einer Message batchen.
