# CLAUDE.md

Guidance for Claude Code in this repo. These instructions OVERRIDE defaults.

# CC-Giveaway

## Zweck
Eigenständiges Multi-Channel-Community-Giveaway + Punktesystem. Aktive Zuschauer
sammeln über mehrere Streams (Kanäle streamen nicht gleichzeitig) viewtime-basierte
Punkte/Lose. Hervorgegangen aus der CC-StreamSuite, aber kein Fork mehr — es gibt
keine Abhängigkeit zu Spacefight, Alerts, HUD-Chat, Gamescenes, Stats oder Hauling.

## Mechanik (Spec)
- **Viewtime pro Zuschauer.** **Regeln (Coin-Basis, Follow-Min, Chat-Bonus) gelten PRO GIVEAWAY**: Team-Keys (`cfgDrawMinSec` etc.) sind nur noch die **Vorgaben** — beim Öffnen kopiert `copyCfgToInstance()` sie in `t:<team>:g:<sid>:cfg:*` (nur Accrual-Cores). Die Regeln-Karte bearbeitet das laufende gewählte Giveaway (live, nur dieses), bei geschlossenem die Vorgaben (`gw_get/set_stream_settings` + `giveawayId`, Ack-Feld `scope`). Getter: `getCoinBaseSec(teamId, gid)`, `getFollowMin(teamId, gid)`, `getChatConfig(teamId, gid)` — per-gid-Key vor Team-Fallback. Coin-Basis = auch Lostopf-Schwelle (≥1 Coin). KI-Bewertung + Auto-Pause/Resume bleiben team-weit.
- **Chat = selber Pott wie Viewtime, als BONUS.** Jede sinnvolle Nachricht ab der konfigurierten Mindestlänge (Default >3 Wörter, `CHAT_MIN_WORDS=4`) gibt den konfigurierten Viewtime-Bonus (Default +2s, `CHAT_BONUS_SEC=2`), Cooldown gegen Spam. Chat ist NICHT Pflicht — reine Zuschauzeit zählt nach den konfigurierten Regeln voll (Coins = watchSec/coinBase). Viewtime-Multiplier gilt auch für den Bonus (×2 → +4s).
- **KI-Bewertung (optional, per Team):** `services/giveaway/cores/chat-ai.js` ersetzt NUR die Wortzählung — Provider `anthropic|openai|gemini`, Modell + eigener API-Key pro Team (verschlüsselt in `app_secrets`, `encryptKey`/`decryptKey`). **fail-open**: Timeout (`TIMEOUT_MS=4000`) oder Fehler → zurück auf Wortregel, Chat blockiert nie. Antwort ist ein Wort (JA/NEIN), Cache pro (Provider, Modell, Nachricht). Keys nie loggen, nie exportieren, nie ins Audit.
- **Viewtime-Multiplier:** Admin kann zeitlich begrenzt beschleunigen („nächste 15 min doppelte Viewtime", gilt auch für Chat) — time-boxed Faktor auf Tick + Chat-Bonus.
- **Teilnahme (Kampagne):** Keyword im Chat registriert (= Zustimmung Teilnahmebedingungen) — das kann jeder. **Berechtigung (`eligible`) ist eine separate Prüfung:** registered + Follows ≥ followMin (konfigurierbar, Default 2) + ≥1 Coin. Lurken MIT Follow sammelt Coins und erhöht die Chance; Chat gibt nur den Zusatzbonus.
- **Ziehung je Mechanik:** Kampagne = Zufall gewichtet nach Coins; Sofortverlosung = Gewicht 1 für alle Berechtigten; TicketBuy = je Preis, gewichtet nach Einsatz; Contest = höchste Punktsumme, Zufall NUR bei Gleichstand. Gewinner 14 Tage Meldefrist, sonst kontrollierte Ersatzziehung (`rerollOf`, nie automatisch).
- **Gewinnermeldung:** echte Ziehung legt einen `draw_claims`-Satz an (Frist `CLAIM_DEADLINE_DAYS=14`) und sagt den Gewinner im Chat an. Kontaktdaten (Name/E-Mail/Anschrift) trägt **nur der Gewinner selbst** auf `/giveaway/claim.html` ein — identifiziert über die Twitch-Session, nie per Fremdeingabe. Automatische Löschung der Kontaktfelder nach `CLAIM_RETENTION_DAYS=365`; der Ziehungsnachweis bleibt.
- **Follow-Check = Hybrid:** Streamerbot-Live-Gate (`follows` am Event) + Helix-Reconcile vor Ziehung. Follower werden **pro Kanal über den Self-OAuth-Token des Kanal-Owners** gelesen (Scope `moderator:read:followers`, Login auf team.raumdock.org → Tabelle `streamers`, self=broadcaster). Kanäle ohne eingeloggten Owner bleiben permissiv. Divergenz → Flag, Coins des Kanals raus.
- **Anwesenheit haengt an `viewer_tick`** (Streamerbot `GW_ViewerTick`, Trigger
  *Twitch → General → Present Viewers*, sendet nur bei laufendem OBS-Stream).
  Chat setzt `chPresent`, aber NICHT `chLastTick` — ohne Ticks ist bei der
  Sofortverlosung niemand im Topf und die Ziehung liefert `no_winner`. Darum
  Kanal-Puls `t:<team>:gw:ch:<ch>:pulse` (`getIngestPulse`) + sichtbare Warnung
  im Panel (Streifen ueber der Aktionsleiste, Ack von `gw_instant_window`,
  `instant_window_closed`, `no_winner` mit angemeldet/anwesend). Live-Ausfall
  9.8.26: 36 Anmeldungen, 0 anwesend, ★ ohne Wirkung.
- **Nachvollziehbarkeit:** jede Coin-Bewegung in `watchtime_events`, Per-Kanal-Stand in `campaign_participation`, jede Ziehung in `giveaway_draws` mit reproduzierbarem Snapshot + Follow-Audit.

## Cores: vier Mechaniken, parallel (umgesetzt, Phasen 0–6 + CORE-UI-Vertrag)
Die Mechanik ist in **austauschbare Cores** zerlegt (`services/giveaway/cores/`,
Registry `cores/index.js`). Ein Core entscheidet NUR, wie aus Ereignissen ein
Gewicht wird und wer berechtigt ist; Zufall/Snapshot/Persistenz/Audit/Recht
bleiben Engine. **Wer die Mechanik anfasst, liest `docs/ARCHITEKTUR-CORES.md`**
(Vertrag, Abgrenzung, Phasen-Stand).
- `CORE_WatchtimeChatActivity` — die Spec oben, unverändert (Primary/Kampagne).
- `CORE_CurrentViewers` — Sofortverlosung: **Keyword im offenen Anmeldefenster
  ist der Anwesenheitsnachweis** (Betreiber 9.8.26; `viewer_tick` ist nur noch
  Anzeige). Dazu zwei Schwellen aus dem Kampagnenstand des Teams: bestätigter
  Follow auf einem Instanz-Kanal + Mindest-Zuschauzeit (`gMinWatch`, Default
  600 s, im Start-Modal einstellbar; ohne laufende Kampagne 0 setzen, sonst ist
  der Topf leer). weight=1. Das Fenster ist NUR die Anmeldephase (`gWinEnd`, restart-sicher,
  **mehrfach öffenbar** via `gw_instant_window` — Teilnehmer akkumulieren);
  der Watcher (5 s) schließt abgelaufene Fenster nur mit Ansage. **Ziehung
  immer manuell** (★, auch Member); Anwesenheit zählt zum Ziehungszeitpunkt.
  Aufräumen beim Schließen der Instanz.
- `CORE_TicketBuy` — Los-Einsatz: Zuschauzeit → team-weites Guthaben
  (`credit_ledger`, append-only, **einzige Buchungsstelle
  `services/giveaway/credit.js`**, Typen erzwingen Vorzeichen; transfer/purchase
  existieren nicht). Preise (`giveaway_prizes`) + Einsätze (`prize_wagers`,
  Rücknahme = negative Zeile). **Ein Giveaway = ein Preis** (Betreiber,
  9.8.26): `addPrize` wirft `prize_exists`, solange die Instanz einen offenen
  Preis hat — mehr verlosen heißt mehrere Los-Giveaways parallel starten.
  Preisnummern bleiben team-weit eindeutig, die Instanz hängt an
  `giveaway_prizes.session_id` (`prizeGiveawayId`, `listPrizes({gid})`).
  Ziehung **je Preis** (Gewicht = Einsatz),
  afterDraw bindet Einsätze aller Setzer in der Ziehungs-TX. Setz-Befehl je
  Instanz konfigurierbar (`gWagerCmd`, Default `!setzen`); Web-Seite
  `/giveaway/wager.html`. Instanz-Close bucht `earn` und räumt ab
  („Guthaben wandert") — **blockiert, solange ungezogene Preise offen sind**
  (`openPrizeCount`, erst ziehen oder stornieren; Sammeln stoppen = Pause).
  Preise korrigierbar (`editPrize`, nur offene) und stornierbar
  (`cancelPrize` = Gegenzeilen in `prize_wagers` + `refund` im Ledger, dann
  `status='cancelled'`). Verfall nach 12 Monaten Inaktivität (`runRetention`).
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
  ohne Legacy-Fallback). Obergrenze `MAX_PARALLEL_GIVEAWAYS` (ENV, Default 4);
  **max. 1 Contest-Instanz je Team** (Engine wirft `duplicate_core` — die
  Contest-Seite findet ihre Instanz übers Team); Los-Giveaways dürfen parallel
  laufen, die Setz-Seite listet sie einzeln (`/api/wager/state` = ein Block je
  Instanz, Kenntnisnahme-Haken je Giveaway).
  Team-weit bleiben: Presence/LastTick, Follows, Bans, Index, Keyword, cfg:*.
  **Neu-Öffnen ohne Reset startet bei null** (beabsichtigt, im Changelog).
- **Reihenfolge für ALLE Mechaniken (Betreiber 9.8.26): schließen → ziehen →
  aufräumen.** `gw_close_instance` beendet nur Sammeln/Anmelden
  (`closeGiveawayInstance`: `gOpen=false`, Fenster zu, Instanz bleibt in
  `t:<team>:giveaways` und in `gw_list_giveaways` mit `closed:true`), der Topf
  bleibt lesbar und ziehbar. Ein zweiter `gw_close_instance` räumt ab
  (`cleanupGiveawayInstance`, Ack `instance_cleaned`; TicketBuy erst ohne
  offene Preise). Panel: Knopf wechselt SCHLIESSEN ↔ AUFRÄUMEN, ★ bleibt
  aktiv. Kampagne analog: `gw_close` lässt `gwSessionId` stehen, `gw_reset`
  räumt.
- **Gewinn ist Pflichtangabe je Giveaway** (`sessions.prize`, Server-Gate in
  `gw_open`/`gw_open_instance` — Ausnahme Los-Giveaway: dort je Preis,
  `giveaway_prizes.title/sponsor`), **Sponsor optional** (`sessions.sponsor`).
  Beides in der Eröffnungs-Ansage (`prizeLine()`) und als Default im
  Ziehungssatz (`gw_draw_winner` liest sessions/giveaway_prizes, wenn kein
  expliziter prize-Text kommt).
- **CORE-UI-Vertrag (`display`):** jeder Core deklariert
  `{css, icon, unit, winnerStat, drawKind, emptyPool, columns, tiles, panelCard}`.
  Gemeinsame Oberflächen lesen NUR daraus: Panel (`gw_data.coreMeta`,
  `gw_list_giveaways` → `coreLabel/coreIcon/coreCss/coreUnit/drawKind/corePanelCard`),
  Ziehungs-Payload (`winner_drawn` mit `unit/drawKind/votes`,
  `no_winner.message`), `GET draws`/`claim/mine` (unit/drawKind je Zeile),
  Archiv (`coreMeta` im Dossier). Statistik-Kacheln: `display.tiles` = IDs aus
  der Registry `STAT_TILES` (giveaway-admin.js, Berechnung genau einmal dort);
  Rail-Karten: `display.panelCard` → `PANEL_CARD_LOADERS` + CSS-Matrix über
  `display.css`. Neuer Core = display ausfüllen; nur eine NEUE Kachel/Karte
  braucht je einen Registry-Eintrag (+ HTML/CSS der Karte).
  **Ehrliche Grenze (kein reines Manifest):** je Core bleiben Server-Datenpfade
  (`sendTeamData`-Teilnehmerlisten, `/api/my-status`, Archiv-Dossier-Queries),
  `IW_TYPES` im Start-Modal, Spezialseiten/-Karten (wager/contest, Preis-/
  Moderations-Karte) und die Einheiten-Map in `CC.audit.summary`; Client-Maps
  (CORE_CSS/LABEL/ICON/PANEL_CARD_FALLBACK) sind nur Fallback für alte
  Server-Payloads. Details im Kopf von docs/ARCHITEKTUR-CORES.md.
- **Teilnehmer-Vorschau:** `gw_preflight` (read-only, AUDIT_SKIP/MEMBER_CMDS)
  → Engine `previewEligible(teamId, {core, channels, minWatchSec})`: Kampagne
  = Follows+≥1 Coin, CV = Präsenz jetzt, TicketBuy = Ledger-Saldo>0, Contest
  = Follow+minWatch. Anzeige im Start-Modal (`iw-preflight`).
- **Panel-Startzustand = Übersicht** (`updateMainView`, Klasse `ov-mode` an
  `.gw-app`): ohne Auswahl zeigt die Hauptfläche Kacheln je laufendem Giveaway
  (`renderOverview` aus `gw_list_giveaways`, inkl. `prize/sponsor/startedAt/
  participants`), die Rail nur `#card-new` (＋ GIVEAWAY STARTEN), Aktionsleiste
  und Statistik-Kacheln sind aus. Dropdown: leer = Übersicht,
  `__campaign__` = laufende Kampagne (`campaignDrill`), sonst die Instanz.
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
- `services/giveaway/public/claims.html|js` — Gewinn-Abwicklung/Inbox (nur Owner: Fristen, Stand kontaktiert/versendet/erledigt, Kontaktdaten-Löschung; `draw_claims.handling/handled_at/handled_by`)
- `services/giveaway/targz.js` — minimaler ustar-Writer für die Archive (getestet)
- `services/admin/server.js` — Login/OAuth, Teams, TOS-Gate, DSGVO, `PUB_DOCS`, Health
- `services/admin/public/admin-shared.js` — `CC.validate`, Nav, Debug-Console, TOS-Overlay
- `services/admin/public/teams.js` — Team-Verwaltung + Rechts-/Giveaway-Linkblock
- `services/admin/public/betrieb.html|js` — Betrieb & Diagnose (nur Superadmin: Dienste-Health,
  Ingest-Puls je Kanal, Kennzahlen, Fehler/Ablehnungen aus dem Audit, Rückmeldungen, debug_log)
- `services/admin/public/feedback.html|js` — „Fehler melden & Idee schicken“ (jede eingeloggte Person;
  Tabelle `feedback` + Discord-Webhook `DISCORD_FEEDBACK_WEBHOOK`, fail-safe: ohne Webhook nur speichern)
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
`GET claim/mine` · `POST claim` (nur der eingeloggte Gewinner; Korrektur nur solange `handling IS NULL`, Fassung = `sessions.terms_version`)
`POST participation/withdraw` (Kampagne/Sofortverlosung: Opt-in selbst zurückziehen; TicketBuy/Contest haben eigene Rücknahme-Pfade)
`GET my-status` (CORE-übergreifend: Kampagnen-Stand + aktive Instanzen + Los-Guthaben/Journal + Contest-Historie — Seite „Meine Teilnahmen")
`GET claims` (`?team=`, nur Owner — Inbox mit Kontaktdaten, Zugriff auditiert) · `POST claims/handling` (contacted/shipped/done) · `POST claims/external` (Owner erfasst Meldung außerhalb der Plattform — `claim_source='external'`, keine Kontaktdaten) · `POST claims/purge` (Kontaktfelder sofort löschen, Nachweis bleibt)
`POST contest/withdraw` (Einsender zieht eigene Einsendung zurück — Bild weg, Stimmen CASCADE; nur solange Instanz offen)
`GET wager/state` · `POST wager` (nur der eingeloggte Zuschauer; auditiert `wager_set`/`wager_retract`)
`POST prize/image` (Team-Mitglied, nur offene Preise, PNG/JPG max 7 MB, leer = entfernen; auditiert) · `GET prize/image/:token` (eingeloggt)
`GET contest/state` · `POST contest/entry` (Base64, PNG/JPG max 7 MB, auditiert) · `POST contest/vote` (Rate-Limit) · `GET contest/image/:token`

## Admin WS `gw_cmd` (`{event:'gw_cmd',cmd,...}`)
`gw_open`(+keyword) · `gw_close` · `gw_draw_winner`(+`giveawayId`,+`prizeId` bei TicketBuy; Ersatzziehung: +`rerollOf`,`reason`,`excludeWinner` → verknüpft via `giveaway_draws.reroll_of/reroll_reason`, alter Claim wird `replaced`) · `gw_set_keyword` · `gw_get_keyword` · `gw_add_ticket`(user,amount) · `gw_sub_ticket` · `gw_ban`/`gw_unban` · `gw_reset`
`gw_pause`/`gw_resume`/`gw_set_multiplier` (optional `giveawayId` → wirkt auf die Instanz)
`gw_open_instance`(keyword, channels, core, windowSec, wagerCmd, announce) · `gw_close_instance` · `gw_list_giveaways` · `gw_set_announce`(giveawayId, on — CV-Chat-Ansagen stumm/laut, Gewinner-Ansage bleibt immer)
`gw_add_prize`(giveawayId, title, wagerEndMinutes) · `gw_list_prizes` · `gw_set_wager_cmd`(giveawayId, command) · `gw_edit_prize`(prizeId, title/sponsor/description/wagerEndMinutes — nur offene) · `gw_cancel_prize`(prizeId — storniert + bucht alle Einsätze zurück)
`gw_contest_voting`(giveawayId, action: open/pause/resume/close) · `gw_review_entry`(entryId, approve/reject — auch Korrektur bereits entschiedener) · `gw_delete_entry`(entryId — Owner, ENDGÜLTIG: Bild weg, Stimmen CASCADE; jederzeit, für Inhalte die nicht gespeichert bleiben dürfen) · `gw_list_entries`(giveawayId) · `gw_announce_page`(giveawayId — sagt `/viewer/wager` bzw. `/viewer/contest` im Chat an)

## Data
- **Redis:** team-weit `t:<team>:…` (open/paused, keyword, session id, banned, users, Presence/LastTick, Follows, chIndex, cfg:* = **Vorgaben**, Abuse) + **je Giveaway** `t:<team>:g:<sid>:…` (watch/msgs/chat_ts je Kanal, registered, mult, open/paused/keyword/channels/core/win_end/wager_cmd/name/announce der Instanz + `cfg:*`-Kopie der Regeln, Copy-on-Open) + `t:<team>:giveaways` (Set aktiver Instanzen). Legacy-Keys werden beim ersten Zugriff ins Primary migriert (genau eine Quelle je Wert). `resetGiveaway`/`cleanupGiveawayInstance` räumen beide Namespaces.
- **PostgreSQL:** `sessions`, `users`, `session_participants`, `watchtime_events`, `campaign_participation`, `abuse_flags`, `teams`, `team_members`, `streamers`, `terms_versions` (Teilnahmebedingungen pro Team), `tos_acceptances` (Zustimmung Nutzungsbedingungen, append-only), `app_secrets` (verschlüsselt), `giveaway_draws` (voller Draw-Audit, + `core`/`prize_id`), `draw_claims` (Gewinnermeldung — **einzige Klardaten im System**: Name/E-Mail/Anschrift, 12 Monate), `audit_log` (append-only: jede zustandsändernde Admin-/System-Aktion mit Actor, IP, Ziel, Vorher/Nachher; auch `denied`/`error`), `credit_ledger` (Guthaben-Journal, append-only, nur Gegenbuchungen — nie DELETE; Verfall 12 Monate Inaktivität), `giveaway_prizes` + `prize_wagers` (Preise/Einsätze, append-only; personenbezogen → DSGVO-Pfade), `contest_entries` (Bild als BYTEA; Löschung entfernt das Bild) + `contest_votes` (bei Löschung pseudonymisiert), `sessions.core/core_config/status/terms_version` (sessions = Giveaway-Instanz; `terms_version` = beim Start eingefrorene Bedingungen-Fassung, 0 = Vorlage ohne Snapshot — `snapshotTermsVersion()` legt beim ersten Start eines Teams v1 über den admin-Service an), `participation_consents` (append-only Kenntnisnahme je (Session, Nutzer, Aktion): register/wager/contest_entry/contest_vote mit Fassung + Quelle; Engine `recordConsent()`, DSGVO-Pfade pseudonymisieren), `platform_warnings` (Verwarnungen der Plattform-Verwaltung, Ack-Status mutierbar; DSGVO-Pfade pseudonymisieren) + `streamers.banned_at/banned_reason` (Plattform-Sperre = Login-Block, Cache `ban-cache.js`, Durchsetzung in `/auth/verify` + OAuth-Callback). Schema: **`ensureSchema()` beim Start ist die Quelle der Wahrheit.** `postgres/init.sql`
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

## Team-Lebenszyklus (admin `/admin/api/teams/...`)
`POST :id/leave` (Member; Owner muss erst übertragen) · `PUT :id/name` · `POST :id/transfer`
(Ziel braucht aktuelle TOS-Zustimmung) · `POST :id/invites` (pausieren/aktivieren) ·
`PUT :id/channel` (nur selbst, nur ohne laufendes Giveaway, alter Token wird widerrufen) ·
`POST :id/deactivate` (Name-Bestätigung; Flag `teams.deactivated_at`, KEIN DELETE — Nachweise
bleiben) · `POST :id/reactivate`. Alles auditiert (`auditTeam`, ohne IP). Live-State-Wipe/
Token-Widerruf läuft über `POST giveaway:/internal/team/cleanup` — Shared-Secret
`INTERNAL_API_KEY` (ENV in BEIDEN Services, leer = Endpunkt tot, Wipe wird übersprungen).
`gw_open`/`gw_open_instance`/Auto-Open prüfen `teamActive()` (deaktivierte Teams öffnen nichts).

## Admin-Bereich (nur Superadmin)
Eigener Menüpunkt **ADMIN** in beiden Shared-Libs (`ADMIN_MENU`, Dropdown mit
`gwnav-adminonly`, sichtbar erst wenn `/auth/me` die Rolle `superadmin` meldet):
Plattform-Verwaltung, Betrieb & Diagnose, Benutzer, Betroffenenrechte, Test
Console, Test Suite. Superadmin = `streamers.is_platform_admin` (Bootstrap
`PLATFORM_ADMINS`), durchgesetzt in Caddy (`@superadmin` →
`/auth/verify-superadmin`) UND je Endpunkt (`requireSuperadmin`). **Neue
Superadmin-Seite? Dann in die `@superadmin path`-Liste in
`caddy/Caddyfile.team` eintragen** — sonst reicht ein normaler Login.
APIs der Betriebsseite: `GET /admin/api/platform/activity|errors|ingest|debuglog|feedback`;
der Ingest-Puls kommt über `GET giveaway:/internal/ingest-pulse` (Shared-Secret
`INTERNAL_API_KEY`), weil der admin-Service kein Redis hat.

## Sicherheit
- **Rollen-Entscheidung (Betreiber, 6.8.26):** `MEMBER_CMDS` bleiben wie sie sind —
  jedes Team-Mitglied (= Kanalstreamer) darf ziehen und steuern. Kein Rollenmodell,
  bewusst gegen die ChatGPT-Review-Empfehlung #2/#3.
- Härtung (ChatGPT-Review Aug 2026): `placeWager`/`cancelPrize` atomar
  (`pg_advisory_xact_lock` je Konto + `FOR UPDATE` je Preis; Draw-TX prüft die
  Einsatzsumme gegen den Pool). Bild-URLs über `image_token` (unerratbar, rotiert
  beim Ersetzen; Routen nehmen NUR Tokens). Magic-Bytes-Prüfung (`sniffImage`) für
  alle Bild-Uploads. WS: `maxPayload` + Nachrichten-Drossel (bridge 128 KiB/500 je
  10 s + Unauth-Verbindungs-Cap; giveaway 256 KiB/300 je 10 s). admin: Login-Bremse
  (5 Fehlversuche → 15 min, Dummy-bcrypt gegen Timing-Oracle), Join-Bremse 20/h je
  IP, OAuth-`next` nur interne Pfade. giveaway: `rateLimit()` (Redis NX+EX) auf
  claim/wager/contest-entry/export/import/archiv. Ingest-Anomalie: ≥3×-Sprung der
  Zuschauer je Kanal/Minute → `abuse_flags` (`ingest_anomaly`) + Audit. Caddy: kein
  `Access-Control-Allow-Origin *` mehr; CSP (script/style 'self'+inline, Avatare
  von static-cdn.jtvnw.net), nosniff, Referrer-/Permissions-Policy.

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
`docs/SOFTWARE-ARCHITEKTUR.md` (Klassen/Funktionen/Schnittstellen, Ablauf- und
Architekturdiagramme — Nachschlagewerk) ·
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
- Deutsche UI. Admin-Pages laden `admin-shared.js` zuerst.
- **Keine OBS-Overlays mehr** (10.8.26, Betreiber): Gewinner-Overlay und
  Join-Animation sind ersatzlos raus — Seiten, WS-Events (`overlay_subscribe`,
  `gw_overlay`, `gw_join`), `/overlay-ws`, OBS-Menü und die öffentlichen
  Caddy-Pfade. `teams.overlay_key` bleibt als unbenutzte Spalte stehen.
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
