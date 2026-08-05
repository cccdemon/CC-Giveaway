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
- **KI-Bewertung (optional, per Team):** `services/giveaway/cores/chat-ai.js` ersetzt NUR die Wortzählung — Provider `anthropic|openai|gemini`, Modell + eigener API-Key pro Team (verschlüsselt in `app_secrets`, `encryptKey`/`decryptKey`). **fail-open**: Timeout (`TIMEOUT_MS=4000`) oder Fehler → zurück auf Wortregel, Chat blockiert nie. Antwort ist ein Wort (JA/NEIN), Cache pro (Provider, Modell, Nachricht). Keys nie loggen, nie exportieren, nie ins Audit.
- **Viewtime-Multiplier:** Admin kann zeitlich begrenzt beschleunigen („nächste 15 min doppelte Viewtime", gilt auch für Chat) — time-boxed Faktor auf Tick + Chat-Bonus.
- **Teilnahme:** Folge ≥2 der teilnehmenden Kanäle (konfigurierbar) + Viewtime + sinnvoller Chat. Lurken allein = keine Lose. Ab ≥1 Ticket per Keyword im Chat opt-in (= Zustimmung Teilnahmebedingungen).
- **Ziehung:** Zufall gewichtet nach Ticketzahl. Gewinner 14 Tage Meldefrist, sonst Ersatz.
- **Gewinnermeldung:** echte Ziehung legt einen `draw_claims`-Satz an (Frist `CLAIM_DEADLINE_DAYS=14`) und sagt den Gewinner im Chat an. Kontaktdaten (Name/E-Mail/Anschrift) trägt **nur der Gewinner selbst** auf `/giveaway/claim.html` ein — identifiziert über die Twitch-Session, nie per Fremdeingabe. Automatische Löschung der Kontaktfelder nach `CLAIM_RETENTION_DAYS=365`; der Ziehungsnachweis bleibt.
- **Follow-Check = Hybrid:** Streamerbot-Live-Gate (`follows` am Event) + Helix-Reconcile vor Ziehung. Follower werden **pro Kanal über den Self-OAuth-Token des Kanal-Owners** gelesen (Scope `moderator:read:followers`, Login auf team.raumdock.org → Tabelle `streamers`, self=broadcaster). Kanäle ohne eingeloggten Owner bleiben permissiv. Divergenz → Flag, Coins des Kanals raus.
- **Nachvollziehbarkeit:** jede Coin-Bewegung in `watchtime_events`, Per-Kanal-Stand in `campaign_participation`, jede Ziehung in `giveaway_draws` mit reproduzierbarem Snapshot + Follow-Audit.

## Cores: drei Mechaniken, parallel (umgesetzt, Phasen 0–5)
Die Mechanik ist in **austauschbare Cores** zerlegt (`services/giveaway/cores/`,
Registry `cores/index.js`). Ein Core entscheidet NUR, wie aus Ereignissen ein
Gewicht wird und wer berechtigt ist; Zufall/Snapshot/Persistenz/Audit/Recht
bleiben Engine. **Wer die Mechanik anfasst, liest `docs/ARCHITEKTUR-CORES.md`**
(Vertrag, Abgrenzung, Phasen-Stand).
- `CORE_WatchtimeChatActivity` — die Spec oben, unverändert (Primary/Kampagne).
- `CORE_CurrentViewers` — Sofortverlosung: Keyword **im offenen Anmeldefenster**
  und Präsenz aus `viewer_tick` (`chLastTick`, Chat allein reicht nicht),
  weight=1. Das Fenster ist NUR die Anmeldephase (`gWinEnd`, restart-sicher,
  **mehrfach öffenbar** via `gw_instant_window` — Teilnehmer akkumulieren);
  der Watcher (5 s) schließt abgelaufene Fenster nur mit Ansage. **Ziehung
  immer manuell** (★, auch Member); Anwesenheit zählt zum Ziehungszeitpunkt.
  Aufräumen beim Schließen der Instanz.
- `CORE_TicketBuy` — Los-Einsatz: Zuschauzeit → team-weites Guthaben
  (`credit_ledger`, append-only, **einzige Buchungsstelle
  `services/giveaway/credit.js`**, Typen erzwingen Vorzeichen; transfer/purchase
  existieren nicht). Preise (`giveaway_prizes`) + Einsätze (`prize_wagers`,
  Rücknahme = negative Zeile). Ziehung **je Preis** (Gewicht = Einsatz),
  afterDraw bindet Einsätze aller Setzer in der Ziehungs-TX. Setz-Befehl je
  Instanz konfigurierbar (`gWagerCmd`, Default `!setzen`); Web-Seite
  `/giveaway/wager.html`. Instanz-Close bucht `earn` und räumt ab
  („Guthaben wandert"). Verfall nach 12 Monaten Inaktivität (`runRetention`).
- `CORE_ScreenshotContest` — Community-Wettbewerb: Einsendungen (nur Follow +
  Mindest-Viewtime, 1/Person, `BYTEA` in PG, **Freigabe-Pflicht** durch den
  Owner), Voting 1–10 (`UNIQUE(entry, voter)`, Re-Vote überschreibt, eigene
  Einsendung tabu, Viewtime-Schwelle + Rate-Limit gegen Votebots).
  Voting-Steuerung `open/pause/resume/close` (`gVoteState`). Gewinner =
  höchste **Punktsumme**, deterministisch über die Engine-Ziehung
  (`buildPool` = nur Führende, weight 1; Gleichstand wird gelost). Ersetzen
  der eigenen Einsendung löscht deren Stimmen (Warn-Handshake
  `votes_would_be_lost` + `confirmReplace`). Seite `/giveaway/contest.html`.
- **Parallelbetrieb:** Accrual-Zustand je Giveaway unter `t:<team>:g:<sid>:*`
  (Lazy-Migration vom Legacy-Bestand, nur fürs Primary). Sekundär-Instanzen via
  `openGiveawayInstance` (eigenes Keyword/Kanalliste/Pause/Multiplier, strikt
  ohne Legacy-Fallback). Obergrenze `MAX_PARALLEL_GIVEAWAYS` (ENV, Default 4).
  Team-weit bleiben: Presence/LastTick, Follows, Bans, Index, Keyword, cfg:*.
  **Neu-Öffnen ohne Reset startet bei null** (beabsichtigt, im Changelog).
- **Gewinn ist Pflichtangabe je Giveaway** (`sessions.prize`, Server-Gate in
  `gw_open`/`gw_open_instance` — Ausnahme Los-Giveaway: dort je Preis,
  `giveaway_prizes.title/sponsor`), **Sponsor optional** (`sessions.sponsor`).
  Beides in der Eröffnungs-Ansage (`prizeLine()`) und als Default im
  Ziehungssatz (`gw_draw_winner` liest sessions/giveaway_prizes, wenn kein
  expliziter prize-Text kommt).
- **Panel-Konventionen:** Instanz-Start über das Modal (`iw-*`,
  Typ-Karten + Kanal-Chips), Instanz-Steuerung als Rail-Karten
  (`card-instant`/`card-ticketbuy`/`card-contest` — Sichtbarkeits-Matrix per
  `core-*`-Klassen am `.gw-app`), SCHLIESSEN wirkt kontextabhängig
  (`gwCloseSmart`). Fenster-Eingaben in Minuten (API bleibt `windowSec`).
  Keine `prompt()`/`alert()`-Dialoge für neue Features — Karten/Modal nutzen.

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
- `services/giveaway/server.js` — Giveaway REST + WS + Ticker + Sofort-Watcher
- `services/giveaway/watchtime.js` — Engine (testbar, ohne WS/HTTP): Redis/PG-Zugriff, Verteilung, Ziehung, Instanzen
- `services/giveaway/credit.js` — Guthaben-Journal (CreditLedger, einzige Buchungsstelle)
- `services/giveaway/cores/index.js` — Core-Registry (`sessions.core` → Modul, Fallback = Watchtime-Core)
- `services/giveaway/cores/watchtime-chat.js` — CORE_WatchtimeChatActivity: Regeln (Coins, Eligibility, Pool), Chat-Texte, config-Deklaration
- `services/giveaway/cores/current-viewers.js` — CORE_CurrentViewers (Sofortverlosung)
- `services/giveaway/cores/ticket-buy.js` — CORE_TicketBuy (Preise, parseWager, Pool je Preis)
- `services/giveaway/cores/chat-ai.js` — optionale KI-Chatbewertung + Key-Krypto (gehört zum Core)
- `services/giveaway/public/cc-defs.js` — **einzige Quelle** der WS-Event-/Cmd-Whitelists (beide Shared-Libs lesen `CC.defs` fail-closed; Seiten laden sie VOR der Shared-Lib)
- `services/giveaway/public/wager.html|js` — Zuschauer-Seite „Lose setzen" (Twitch-Session, hinter Auth)
- `services/giveaway/cores/screenshot-contest.js` — CORE_ScreenshotContest (Pool = Führende, Texte, Limits)
- `services/giveaway/public/contest.html|js` — Zuschauer-Seite Screenshot-Contest (Upload + Voting)
- `services/giveaway/helix.js` — Twitch-Helix-Follow-Reconcile, Follower/User-ID-Cache, Token-Refresh
- `services/admin/auth.js` — pure Auth-Helper (HMAC-signierte Cookie-Sessions, bcrypt), ohne express/pg/redis
- `services/giveaway/public/giveaway-shared.js` — Shared-Lib (`CC.validate`, `CC.audit.summary`, Nav)
- `services/giveaway/public/giveaway-admin.js` — Admin-Panel-Logik
- `services/giveaway/public/audit.html|js` — Audit-Seite (Filter, Verdichtung, tar.gz-Archiv)
- `services/giveaway/public/archive.html|js` — vergangene Giveaways, volles Dossier je Sitzung
- `services/giveaway/public/claim.html|js` — Gewinnermeldung (nur der Gewinner selbst)
- `services/giveaway/targz.js` — minimaler ustar-Writer für die Archive (getestet)
- `services/admin/server.js` — Login/OAuth, Teams, TOS-Gate, DSGVO, `PUB_DOCS`, Health
- `services/admin/public/admin-shared.js` — `CC.validate`, Nav, Debug-Console, TOS-Overlay
- `services/admin/public/teams.js` — Team-Verwaltung + Rechts-/Giveaway-Linkblock
- `services/admin/public/meine-daten.html` — DSGVO-Selbstauskunft/-Löschung
- `services/admin/public/status.html` — Zuschauer-Status (`/viewer/status`) inkl. Rechtslinks
- `services/admin/public/giveaway-test.js` + `public/tests/test-suite.js` — Browser-Test-Console (Sim-Events, hängt an `ALLOW_SIM`)
- `tools/make-og-preview.js` — OG-Preview-Bild generieren (Node-Script, kein Service)
- `services/admin/public-docs/*.md` — öffentliche Rechtstexte
- `caddy/Caddyfile` (HTTP) · `caddy/Caddyfile.team` (prod, TLS DNS-01) · `caddy/Caddyfile.ssl`

## REST (`/giveaway/api/...`)
`GET participants` · `GET user/:u` · `GET sessions` · `GET leaderboard` · `GET draws` (`?session=`,`?full=1`,`?limit=`) · `GET ws/clients`
`GET audit` (Filter + Verdichtung + `before`-Cursor) · `GET audit/stats` · `GET audit/archive` (tar.gz)
`GET archive` (Sitzungsliste) · `GET archive/:sid` (Dossier) · `GET archive/:sid/export` (tar.gz, Owner)
`GET claim/mine` · `POST claim` (nur der eingeloggte Gewinner)
`GET wager/state` · `POST wager` (nur der eingeloggte Zuschauer; auditiert `wager_set`/`wager_retract`)
`GET contest/state` · `POST contest/entry` (Base64, max 2 MB, auditiert) · `POST contest/vote` (Rate-Limit) · `GET contest/image/:id`

## Admin WS `gw_cmd` (`{event:'gw_cmd',cmd,...}`)
`gw_open`(+keyword) · `gw_close` · `gw_draw_winner`(+`giveawayId`,+`prizeId` bei TicketBuy) · `gw_set_keyword` · `gw_get_keyword` · `gw_add_ticket`(user,amount) · `gw_sub_ticket` · `gw_ban`/`gw_unban` · `gw_reset`
`gw_pause`/`gw_resume`/`gw_set_multiplier` (optional `giveawayId` → wirkt auf die Instanz)
`gw_open_instance`(keyword, channels, core, windowSec, wagerCmd) · `gw_close_instance` · `gw_list_giveaways`
`gw_add_prize`(giveawayId, title, wagerEndMinutes) · `gw_list_prizes` · `gw_set_wager_cmd`(giveawayId, command)
`gw_contest_voting`(giveawayId, action: open/pause/resume/close) · `gw_review_entry`(entryId, approve/reject) · `gw_list_entries`(giveawayId)

## Data
- **Redis:** team-weit `t:<team>:…` (open/paused, keyword, session id, banned, users, Presence/LastTick, Follows, chIndex, cfg:*, Abuse) + **je Giveaway** `t:<team>:g:<sid>:…` (watch/msgs/chat_ts je Kanal, registered, mult, open/paused/keyword/channels/core/win_end/wager_cmd der Instanz) + `t:<team>:giveaways` (Set aktiver Instanzen). Legacy-Keys werden beim ersten Zugriff ins Primary migriert (genau eine Quelle je Wert). `resetGiveaway`/`cleanupGiveawayInstance` räumen beide Namespaces.
- **PostgreSQL:** `sessions`, `users`, `session_participants`, `watchtime_events`, `campaign_participation`, `abuse_flags`, `teams`, `team_members`, `streamers`, `terms_versions` (Teilnahmebedingungen pro Team), `tos_acceptances` (Zustimmung Nutzungsbedingungen, append-only), `app_secrets` (verschlüsselt), `giveaway_draws` (voller Draw-Audit, + `core`/`prize_id`), `draw_claims` (Gewinnermeldung — **einzige Klardaten im System**: Name/E-Mail/Anschrift, 12 Monate), `audit_log` (append-only: jede zustandsändernde Admin-/System-Aktion mit Actor, IP, Ziel, Vorher/Nachher; auch `denied`/`error`), `credit_ledger` (Guthaben-Journal, append-only, nur Gegenbuchungen — nie DELETE; Verfall 12 Monate Inaktivität), `giveaway_prizes` + `prize_wagers` (Preise/Einsätze, append-only; personenbezogen → DSGVO-Pfade), `contest_entries` (Bild als BYTEA; Löschung entfernt das Bild) + `contest_votes` (bei Löschung pseudonymisiert), `sessions.core/core_config/status` (sessions = Giveaway-Instanz). Schema: **`ensureSchema()` beim Start ist die Quelle der Wahrheit.** `postgres/init.sql`
(nur bei frischem Volume) legt lediglich `users`, `sessions`, `session_participants`,
`watchtime_events`, `campaign_participation`, `debug_log`, `giveaway_draws` an — alles
Team-/Auth-/Compliance-bezogene (`teams`, `team_members`, `streamers`, `terms_versions`,
`tos_acceptances`, `app_secrets`, `audit_log`, `abuse_flags`) kommt ausschließlich aus
`ensureSchema()`. Neue Tabelle/Spalte also dort ergänzen, nicht in `init.sql`.
In prod stehen zusätzlich `admin_users` und `spacefight_results`/`spacefight_stats` —
Altbestand aus der CC-StreamSuite, von diesem Code nicht benutzt (`docs/PROJEKTHISTORIE.md`).
- **Audit-Choke-Point:** `handleAdminCmd()` in `services/giveaway/server.js` — jedes neue `gw_cmd` läuft automatisch mit. Nur-Lese-Cmds in `AUDIT_SKIP` eintragen. Tokens gehören NIE ins `detail`.
- **Das Audit-Log wird nie gelöscht.** `runRetention()` anonymisiert nach `protocolDays` nur noch (IP raus, `target` pseudonymisiert) — Vorgang, Zeitpunkt und Ergebnis bleiben. Gleiches gilt für `giveaway_draws`. Wer hier wieder ein `DELETE` einbaut, zerstört den Nachweis.
- **Ablehnungen von `AUDIT_SKIP`-Cmds sind gedrosselt** (`shouldLogDeny`, 5-min-Fenster je Team/Actor/Cmd). Ohne das flutet ein pollendes Panel den Log — genau so entstanden schon einmal 4,5 Mio Zeilen.
- **Zweiter zustandsändernder Pfad:** die Test-Console-Sim (`viewer_tick`/`chat_msg`/`time_cmd` über die Admin-WS) geht NICHT durch `handleAdminCmd`, erzeugt aber echte `watchtime_events`. Darum `ALLOW_SIM` (Default `false`, Prod also aus) + eigener `audit()`-Aufruf (`sim_*`, auch `denied`). Wer hier weitere Events ergänzt, muss beides mitnehmen.

## Streamerbot C# (`services/admin/actions/`) — inverted ingest client (Phase 6)
**Einzige Quelle für die C#-Actions ist `services/admin/actions/`** (der
admin-Container liefert sie über `GET /pub/actions` zum Kopieren aus).
`streamerbot/` enthält nur noch `CAMPAIGN_SETUP.md`.
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
Auth zentral über Caddy `forward_auth` → `admin:3005/auth/verify` (Session-Cookie).
Login per Twitch-OAuth, Selbstregistrierung beim ersten Login (Upsert in `streamers`).
Öffentlich erreichbare Pfade stehen in der `@needsauth not path`-Liste in
`caddy/Caddyfile.team` — **neue öffentliche Seite dort eintragen**, sonst verlangt
Caddy Login. Secrets (KI-API-Keys) verschlüsselt in `app_secrets`, nie in ENV/Repo.

## Recht & Compliance
- Plattformtexte: `services/admin/public-docs/` (`impressum`, `datenschutz`,
  `nutzungsbedingungen`, `haftungsausschluss`) → Whitelist `PUB_DOCS`, Auslieferung
  über `GET /admin/pub/doc/:name`, ohne Login.
- **Zustimmung ist versioniert und erzwungen:** Tabelle `tos_acceptances`,
  `requireTos()` (HTTP 451) im admin-Service, `ownerAcceptedTos(teamId)` vor
  `gw_open`/Auto-Open im giveaway-Service, blockierendes Overlay in `admin-shared.js`.
  **`TOS_VERSION` steht doppelt** (`services/admin/server.js` +
  `services/giveaway/server.js`) — bei Textänderung **beide** erhöhen.
- **DSGVO-Selbstbedienung:** `/admin/meine-daten.html`, `GET /api/me/data`,
  `POST /api/me/delete`. Benutzername kommt nur aus der Session. Ziehungsnachweise
  werden pseudonymisiert (`geloescht_<sha256[0:8]>`), nicht gelöscht
  (Art. 17 Abs. 3 lit. e DSGVO). Auch reine Zugriffe landen im `audit_log`, bewusst ohne IP.
  **Neue personenbezogene Spalte? Dann in `collectSubjectData()` UND `eraseSubject()`
  (`services/admin/server.js`) mitziehen** — sonst ist die Auskunft unvollständig
  und die Löschung wirkungslos.
- Details: `docs/RECHT-UND-DATENSCHUTZ.md`. Betrieb/DB-Eingriffe: `docs/BETRIEB.md`.
  Repo-Herkunft, Altbestände, Neuaufsetzen: `docs/PROJEKTHISTORIE.md`.

## Docs
`README.md` (Überblick/Stack) · `FEATURES.md` (was einstellbar ist, mit Defaults +
Wertebereichen — Referenz bei Config-Fragen) · `docs/BETRIEB.md` ·
`docs/RECHT-UND-DATENSCHUTZ.md` · `docs/PROJEKTHISTORIE.md` ·
`docs/ANLEITUNG-TEILNEHMER.md` · `docs/TEILNAHMEBEDINGUNGEN.md` ·
`docs/ARCHITEKTUR-CORES.md` (Entwurf austauschbarer Mechaniken) ·
`streamerbot/CAMPAIGN_SETUP.md`.
Öffentlich (ohne Login): `services/admin/public-docs/roadmap.md` +
`changelog.md` → `/admin/roadmap.html`, `/admin/changelog.html`. Nutzerrelevante
Änderung? Dann gehört sie ins `changelog.md`.

## Git / GitHub
**Immer `gh` statt `git` für alles, was GitHub berührt** (Push, PR, Issues, Releases,
API). Der SSH-Remote authentifiziert hier nicht — `origin` ist HTTPS und `gh auth
setup-git` liefert die Credentials. Lokales `git` bleibt für commit/diff/log.

## Konventionen
- **Streamermodus** (`giveaway-admin.js`): maskiert Zuschauernamen + Ingest-Tokens im
  Admin-Panel für Screenshare. Neue UI, die Namen oder Tokens zeigt, muss ihn beachten.
- Deutsche UI. Admin-Pages laden `admin-shared.js` zuerst. OBS-Overlays laden es NICHT.
- WS-Events `{event:'name',...}`; Admin-Cmds `{event:'gw_cmd',cmd}`. Neue Events/Cmds in `ALLOWED_EVENTS`/`ALLOWED_CMDS` (admin-shared.js + giveaway-shared.js).
- `CC.validate` für alle Input-Sanitization. `sanitizeUsername(s)` konsistent C# ↔ JS (lowercase, [a-z0-9_], max 25).
- `log(tag,...)`/`logErr(tag,...)` statt raw console.
- Redis DB 0 = prod (`REDIS_DB` in `docker-compose.yml`), DB 1 für alles, was gegen echtes
  Redis läuft — nie DB 0 im Testcode. Die `node --test`-Suites fassen Redis gar nicht an.

## Dev
```bash
cp .env.example .env                      # Twitch-Credentials
docker compose up -d [--build]            # lokal HTTP (caddy/Caddyfile)

# services/<name>/
npm start · npm run dev (--watch)
npm test                                  # node --test tests/*.test.js
node --test tests/watchtime.test.js       # einzelne Datei
node --test --test-name-pattern="coins"   # einzelner Test
```
Tests in `giveaway` (`watchtime`, `chat-ai`, `cores` — Gleichheit gegen eingefrorene Alt-Logik, `credit`, `targz`) und `admin` (`auth`) — `bridge` hat kein `test`-Script.
**Die Suites brauchen keine laufende Infrastruktur**: Redis/pg sind In-Memory-Mocks
(`makeRedis()` in `watchtime.test.js`), `fetch` ist gestubbt (`stubFetch()` in
`chat-ai.test.js`). Also kein `docker compose up` vor `npm test`. Neue Tests genauso
halten — was Redis/pg/Netz wirklich braucht, gehört nicht in `tests/`.

## Response Rules
- Terse. Kein Filler, keine „was ich geändert habe"-Zusammenfassung (Diff ist sichtbar).
- Keine bereits im Kontext gelesenen Files neu lesen. Grep vor kleinem Edit statt ganze Files.
- Edit vor Write bei bestehenden Files. Mehrere Edits in einer Message batchen.
