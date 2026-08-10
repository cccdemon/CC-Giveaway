# Architektur: austauschbare Giveaway-Systeme („Cores")

**Umgesetzt — Stand 7. August 2026, `main`.** Alle Phasen 0–6 sind
implementiert, dazu der **CORE-UI-Vertrag** (`display` mit
css/icon/unit/winnerStat/drawKind/emptyPool/columns/tiles/panelCard):
Panel-Spalten, Statistik-Kacheln (STAT_TILES-Registry), Rail-Karten,
Ziehungs-Payloads, Historie, Claim-Seite und Archiv lesen ihre
CORE-Semantik aus dieser Deklaration. Das Dokument bleibt die verbindliche
Referenz für den Core-Vertrag (Abschnitt 4), die Abgrenzung Engine/Core
(Abschnitt 3) und die getroffenen Entscheidungen (Abschnitt 10). Die
Abschnitte 2 und 6–7 beschreiben Ausgangslage und Zielbild des Umbaus; wo
der Ist-Zustand abweicht, steht es in den Stand-Blöcken.

**Ehrliche Erweiterungsgrenze:** Ein NEUER Core braucht neben dem
Core-Modul (inkl. `display`) weiterhin Handarbeit an den Stellen, die echte
Funktionalität statt Anzeige sind — Server-Aggregation (`sendTeamData`,
`/api/my-status`, Archiv-Dossier-Queries), eine eigene Rail-Karte samt
Loader-Registry-Eintrag, ggf. eigene Zuschauer-Seite. „Nur Manifest
ausfüllen" gilt für Beschriftung/Semantik, nicht für neue Datenpfade.

Noch offen (Kür, nicht Teil der Phasen): `!los` nennt bei parallelen
Giveaways nur die Kampagne, Redis-Aufräumen für manuell geschlossene
Nicht-TicketBuy-Instanzen (Ziehung nach Close braucht deren Stand —
Cleanup erst nach der Ziehung).

---

## 1 Ziel

Heute gibt es genau eine Mechanik: Zuschauzeit und Chataktivität ergeben Coins,
ab einem Coin ist man im Lostopf, gezogen wird gewichtet nach Coins. Diese
Mechanik ist über die gesamte Codebasis verteilt fest verdrahtet.

Künftig soll beim Anlegen eines Giveaways ausgewählt werden, nach welchem System
es läuft:

| Core | Kurzbeschreibung |
|---|---|
| `CORE_WatchtimeChatActivity` | Zuschauzeit + Chat → Coins → gewichtete Ziehung. Das heutige Verhalten, unverändert. |
| `CORE_TicketBuy` | Zuschauzeit ergibt Guthaben. Guthaben wird auf einen konkreten Preis gesetzt. Gezogen wird **gewichtet nach Einsatz** — Lotterie, keine Auktion. Einsatz ist nach der Ziehung verbraucht. |
| `CORE_CurrentViewers` | Sofortverlosung unter allen, die **gerade zuschauen**. Anwesenheit = Keyword im Zeitfenster **und** gemeldete Präsenz. Kein Vorlauf, kein gesammelter Stand. |

Zusätzlich sollen **mehrere Giveaways eines Teams gleichzeitig** laufen können —
etwa eine wochenlange Zuschauzeit-Kampagne und parallel eine Sofortverlosung.

---

## 2 Ist-Zustand: wo die Mechanik heute steckt

Ergebnis einer vollständigen Durchsicht. Das ist die Arbeitsgrundlage — ohne
diese Karte wäre jede Aufwandsschätzung geraten.

### Gute Nachricht zuerst

**Die Ingest-Schicht ist bereits mechanikfrei.** Die C#-Actions
(`streamerbot/*.cs`) senden ausschließlich Rohereignisse — `viewer_tick`,
`chat_msg`, `time_cmd`, `stream_online/offline` — und kennen weder Coins noch
Berechtigung. Nur Kommentare nennen die Mechanik, kein Code. **Streamerbot muss
für den gesamten Umbau nicht angefasst werden.** Das nimmt dem Vorhaben das
grösste Betriebsrisiko, weil kein Zuschauer und kein Kanal etwas neu einrichten
muss.

Ebenfalls bereits neutral und unverändert übernehmbar: Session-Lebenszyklus
(`openGiveaway`, `closeGiveaway`, `isOpen`, `isPaused`, `setPaused`),
Kanalverwaltung (`getChannels`, `resolveChannel`), Nutzer-Index
(`_touchUser`, `getUserTeams`), Ban-Flag, Keyword-Opt-in (`matchesKeyword`) und
die komplette Missbrauchserkennung (`flagUser`, `_detectAbuse`, `getFlagsMap`,
Tabelle `abuse_flags`).

### Was zerlegt werden muss

| Ort | Umfang |
|---|---|
| [watchtime.js](../services/giveaway/watchtime.js) | Herzstück. `coinsFromSec` (:104), `tickPresentUsers` (:256), `handleChatMessage` ab (:312), `getUserAggregate` (:390 — **die zentrale Regelfunktion**, definiert `eligible` in :414), `drawWinner` (:518), dazu 12 Konfigurations-Methoden für Coin-Basis, Follow-Minimum, Chat-Bonus und Multiplier. |
| [server.js](../services/giveaway/server.js) | ~20 Stellen. Die Regeltexte für `!los` und `!giveaway` (:317, :940-965) sind vollständig hartcodiert, ebenso `gw_add_ticket`/`gw_sub_ticket` (:779-798), `gw_set_stream_settings` (:669-687) und die Ziehungsfelder (:878-896). |
| [giveaway-admin.js](../services/giveaway/public/giveaway-admin.js) + `.html` | Das Panel ist durchgehend coin-geprägt: Spalten, Statistik-Kacheln, Konfigurationsfelder, Gewinneranimation, Export. |
| Redis-Schlüssel (`K` in watchtime.js:34-64) | 19 generisch, 10 mechanikbezogen — darunter `chWatch` (die eigentliche Währung), `cfgDrawMinSec`, `cfgChatBonus/Words/Cool`, `gwMult`, `chFollows`. |
| Datenbank | `watchtime_events` ist als reines Viewtime-Journal gebaut (`delta_sec`, `event_type`). `campaign_participation` und `giveaway_draws` tragen `coins`/`watch_sec` fest im Schema. |
| `chat-ai.js` | Existiert ausschließlich wegen des Chat-Bonus. Gehört damit fachlich zu `CORE_WatchtimeChatActivity`, nicht in die Engine. |
| **DSGVO-Pfade** ([admin/server.js](../services/admin/server.js)) | `collectSubjectData()` (:572) und `eraseSubject()` (:607) lesen `campaign_participation` (`watch_sec`, `msgs`, `coins`, `follows`) und `giveaway_draws.winner_coins`; die Feld-Labels stehen in [meine-daten.html:88-92](../services/admin/public/meine-daten.html). Jede neue core-eigene personenbezogene Spalte (z.B. `prize_wagers`) muss hier mitgezogen werden, sonst ist die Auskunft unvollständig und die Löschung wirkungslos. |
| **Anzeigepfade ausserhalb des Panels** | [claim.js:57](../services/giveaway/public/claim.js) (`winner_coins` als „Punkte"), [archive.js](../services/giveaway/public/archive.js) (Dossier + tar.gz-Export mit `total_coins`/`winner_coins`/`watch_sec`/`msgs`/`follows`-Spalten), [status.html:164](../services/admin/public/status.html) (Zuschauer-Status rechnet mit `drawMinSec`/`watchSec`), [giveaway-shared.js:191](../services/giveaway/public/giveaway-shared.js) (`auditSummary()` formuliert `coinsAtBan`). |
| **Test-Console-Sim** ([giveaway-test.js](../services/admin/public/giveaway-test.js) + `public/tests/test-suite.js`) | Zweiter zustandsändernder Pfad **an `handleAdminCmd` vorbei**, erzeugt echte `watchtime_events` (`ALLOW_SIM` + eigener `audit()`). Muss künftig wissen, an welches Giveaway ein Sim-Event geht, und durch dieselbe Verteilfunktion laufen wie der echte Ingest. |
| **Redis-Backup** (`exportTeam`/`importTeam` in watchtime.js) | Sichert die mechanikbezogenen Schlüssel (`chWatch`, `chMsgs`, `chFollows`) direkt und muss die Giveaway-Dimension sowie core-eigene Schlüssel mitnehmen — sonst stellt ein Restore nur das Kampagnen-Giveaway wieder her. |

### Dubletten, die vor dem Umbau weg müssen

Vier Stellen sind bereits heute doppelt gepflegt. Wer die Mechanik zerlegt, ohne
sie vorher zusammenzuführen, bekommt garantiert Abweichungen zwischen den
Kopien:

| Was | Wo |
|---|---|
| Die Coin-Formel | `watchtime.js:104-107` **und** `admin/public/giveaway-test.js:144-150` (dort zusätzlich eine eigene hartcodierte `SECS_PER_COIN = 7200` in :7) |
| `ALLOWED_EVENTS` / `ALLOWED_CMDS` | ~~`giveaway-shared.js` ≙ `admin-shared.js`~~ **zusammengeführt** in `services/giveaway/public/cc-defs.js` (Phase 0) |
| `auditSummary()` | Korrektur nach Code-Prüfung: liegt **nur** in `giveaway-shared.js` — war nie dupliziert, kein Handlungsbedarf |
| Die C#-Actions | ~~`streamerbot/*.cs` ≙ `services/admin/actions/*.cs`~~ **einzige Quelle jetzt `services/admin/actions/`** (Phase 0; der admin-Container liefert sie über `/pub/actions` aus) |

---

## 3 Abgrenzung: was ein Core NICHT entscheidet

Das ist die wichtigste Festlegung des Entwurfs. Alles, was die **Fairness und
die Nachweisbarkeit** einer Ziehung betrifft, bleibt in der gemeinsamen Engine
und wird **nicht** pro Core neu implementiert:

- **Der Ziehungsvorgang selbst.** Zufallswert, gewichtete Auswahl, Snapshot aller
  Berechtigten, Schreiben nach `giveaway_draws`, Draw-Index. Ein Core liefert
  nur die Liste `[{username, weight, meta}]` — wie daraus ein Gewinner wird,
  entscheidet die Engine. Damit gibt es genau **eine** Stelle, die reproduzierbar
  ziehen muss, und genau eine, die dabei falsch sein kann.
- **Das Protokoll.** `audit_log`, Anonymisierung, Archiv, `.tar.gz`-Export.
- **Die Rechts-Gates.** Zustimmung zu den Nutzungsbedingungen und hinterlegtes
  Impressum vor dem Öffnen; Teilnahmebedingungen je Team.
- **Die Gewinnermeldung.** `draw_claims`, Meldefrist, 12-Monats-Löschung.
- **Missbrauchserkennung.** `abuse_flags`, Spam-Erkennung, Follow-Abgleich über
  Helix.
- **Die Verbote.** Keine Zahlung als Voraussetzung, keine Zahlung als Vorteil.
  Ein Core, der Bits, Subs oder Geld in Gewichtung umrechnet, wird nicht gebaut
  und ist über die Engine auch nicht möglich: Gewicht darf ausschließlich aus
  erspielter Zuschauzeit und Aktivität entstehen.

**Klärung zum Follow-Check** (löst den scheinbaren Widerspruch zu `followMin`
in der Core-Konfiguration): die Engine **beschafft** die Follow-Fakten —
Streamerbot-Live-Gate, Helix-Reconcile vor der Ziehung, `chFollows`-Cache.
Der Core **wertet** sie: `followMin` ist Core-Konfiguration und fließt nur in
`getParticipant().eligible` und `buildPool()` ein. Der Reconcile läuft vor
`buildPool`; der Core sieht ausschließlich das Ergebnis im Kontext und spricht
nie selbst mit Helix.

Ein Core entscheidet ausschließlich: **wie aus Ereignissen ein Gewicht wird und
wer teilnahmeberechtigt ist.**

---

## 4 Der Core-Vertrag

Ein Core ist ein Modul unter `services/giveaway/cores/<id>.js` mit einem festen
Satz Methoden. Alle Methoden sind `async` und bekommen einen Kontext statt
direkter Redis-/PG-Handles, damit ein Core nicht an Schlüsselnamen hängt.

```js
// services/giveaway/cores/watchtime-chat.js
module.exports = {
  id:    'CORE_WatchtimeChatActivity',
  label: 'Zuschauzeit & Chat',
  // Beschreibt die Einstellungen für die Oberfläche UND für die Validierung.
  // Eine Quelle, damit Panel und Server nicht auseinanderlaufen.
  config: {
    coinBaseSec: { type:'int',  min:60, max:360000, def:7200, label:'1 Coin = X Sekunden Zuschauzeit' },
    followMin:   { type:'int',  min:0,  max:10,     def:2,    label:'Mindestzahl gefolgter Kanäle' },
    chatBonusSec:{ type:'int',  min:0,  max:60,     def:2,    label:'Bonus je sinnvoller Nachricht' },
  },

  // ── Lebenszyklus ────────────────────────────────────────
  async onOpen(ctx)   {},
  async onClose(ctx)  {},
  async onPause(ctx)  {},
  async onResume(ctx) {},

  // ── Ereignisse aus dem Ingest ───────────────────────────
  // Rückgabe ist beschreibend, nicht ausführend: die Engine schreibt
  // watchtime_events und sendet wt_update. Ein Core, der selbst nach Postgres
  // schreibt, umgeht das Protokoll — deshalb tut er es nicht.
  async onViewerTick (ctx, { channel, username, follows, seconds }) { return { delta: [] }; },
  async onChatMessage(ctx, { channel, username, message, follows }) { return { delta: [], reply: null }; },
  async onStreamOnline (ctx, { channel }) {},
  async onStreamOffline(ctx, { channel }) {},

  // ── Abfrage ─────────────────────────────────────────────
  // Ein Teilnehmer hat immer: Gewicht, Berechtigung und — wichtig für die
  // Oberfläche und für !los — den Grund, warum er (noch) nicht drin ist.
  async getParticipant (ctx, username) {
    return { username, weight: 0, eligible: false, missing: ['…'], detail: {} };
  },
  async getAllParticipants(ctx) { return []; },

  // ── Ziehung ─────────────────────────────────────────────
  // Nur die Liste. Zufall, Snapshot und Protokoll macht die Engine.
  async buildPool(ctx) { return [{ username, weight, meta }]; },
  // Nachbereitung, z.B. Einsatz verbrauchen. Läuft in derselben Transaktion
  // wie das Schreiben der Ziehung.
  async afterDraw(ctx, result, tx) {},

  // ── Texte für den Chat ──────────────────────────────────
  async statusText(ctx, username) { return '…'; },   // !los
  async infoText  (ctx)           { return '…'; },   // !giveaway

  // ── Oberfläche ──────────────────────────────────────────
  // Das Panel rendert generisch: Spalten und Statistik-Kacheln kommen vom
  // Core statt hartcodierter Coin-Spalten. Felder mit Zuschauernamen tragen
  // mask:true — der Streamermodus maskiert sie, ohne den Core zu kennen.
  display: {
    columns: [ { key:'coins', label:'Coins', mask:false } ],
    tiles:   [ 'totalWeight', 'eligibleCount' ],
  },

  // ── Core-eigene Kommandos ───────────────────────────────
  // Von der Engine unter gw_cmd registriert → laufen automatisch durch
  // handleAdminCmd() und damit durchs Audit-Log. Nur-Lese-Kommandos
  // deklariert der Core als readonly:true (→ AUDIT_SKIP, Deny-Drossel).
  // Die Whitelist ALLOWED_CMDS/ALLOWED_EVENTS wird aus diesen Deklarationen
  // erzeugt, nicht mehr von Hand gepflegt (setzt Phase 0 voraus).
  commands: {
    // 'wager_set': { readonly:false, handler: async (ctx, msg) => ({ … }) },
  },

  // ── Audit-Texte ─────────────────────────────────────────
  // auditSummary() in den Shared-Libs formuliert heute coin-spezifisch
  // („gebannt, hatte X Coins"). Core-eigene Audit-Einträge liefern ihre
  // Kurzform selbst; die generische Fallback-Darstellung bleibt Engine.
  auditText(entry) { return null; },
};
```

### Kontext

```js
ctx = {
  teamId, giveawayId,     // giveawayId ist neu — siehe Abschnitt 6
  channels,               // Kanäle DIESES Giveaways
  cfg,                    // validierte Core-Konfiguration
  kv,                     // gekapselter Redis-Zugriff, automatisch auf das
                          // Giveaway begrenzt: kv.get('watchsec:user')
  pg,                     // nur lesend; Schreiben läuft über die Engine
  now,                    // injizierbar, damit Tests ohne echte Uhr laufen
  log, audit,
};
```

`kv` ist der Punkt, an dem der Parallelbetrieb hängt: der Core kennt keine
Schlüsselpräfixe, die Kapselung setzt `t:<team>:g:<giveaway>:` davor. Ein Core
kann damit gar nicht versehentlich in ein fremdes Giveaway schreiben.

---

## 5 Die Cores

### 5.1 CORE_WatchtimeChatActivity

Die heutige Mechanik, unverändert übernommen. Der Umbau darf ihr Verhalten
**nicht** ändern — das ist die Messlatte für Phase 1 (Abschnitt 8).

- `onViewerTick`: Zuschauzeit hochzählen, Multiplier anwenden.
- `onChatMessage`: Mindestwortzahl (konfigurierbar, Default >3 Wörter; oder KI-Urteil) → Bonussekunden, Cooldown.
- `buildPool`: alle mit ≥1 Coin, Keyword geschrieben, ≥`followMin` Kanälen
  folgend. Gewicht = Coins.

### 5.2 CORE_TicketBuy — BETA

> **BETA (10.8.2026):** umgesetzt und getestet, aber im Livebetrieb noch kaum
> gelaufen. Die Oberflaeche kennzeichnet das (`display.beta`).

Zuschauzeit erzeugt Guthaben wie gehabt. Neu ist, dass Guthaben **gezielt auf
einen Preis gesetzt** wird.

- Neue Entität **Preis** (`giveaway_prizes`): Titel, Beschreibung, Bild,
  Einsatz-Ende. Heute ist `prize` nur ein Freitextfeld an der Ziehung — das
  reicht nicht, wenn man darauf bieten können soll.
- Zuschauer setzen über eine Seite oder einen Chatbefehl Lose auf einen Preis.
  Ein Einsatz ist bis zum Einsatz-Ende zurücknehmbar, danach gebunden.
- **Ein Giveaway = ein Preis** (Betreiber-Entscheidung 9.8.2026): eine
  TicketBuy-Instanz hat höchstens einen offenen Preis (`addPrize` →
  `prize_exists`). Wer mehrere Preise verlosen will, startet mehrere
  Los-Giveaways parallel — `duplicate_core` gilt nur noch für den Contest.
  Preisnummern sind team-weit eindeutig; welche Instanz gemeint ist, sagt
  `giveaway_prizes.session_id` (nicht die Reihenfolge der Instanzliste), auch
  wenn zwei Instanzen denselben Setz-Befehl tragen.
- `buildPool` läuft **je Preis**: Gewicht = gesetzte Lose auf diesen Preis.
- `afterDraw` bucht die Einsätze **aller** Teilnehmer dieses Preises ab, nicht
  nur die des Gewinners — sonst wäre Setzen risikolos und jeder setzt alles auf
  alles.

> **Rechtlich:** Es bleibt eine Verlosung, kein Verkauf. Eingesetzt wird
> ausschließlich erspielte Zuschauzeit; jeder Teilnehmer kann gewinnen, auch mit
> einem Los. Barwert, Umtausch und Übertragung von Guthaben bleiben
> ausgeschlossen. Guthaben ist kein Zahlungsmittel und darf nie käuflich sein.

**Entschieden (4. August 2026): Guthaben wandert ins nächste Giveaway.**
Das hat eine Architekturfolge: Guthaben ist damit **keine Giveaway-Größe,
sondern eine Team-Größe** — es lebt ausserhalb der `g:<id>`-Kapselung und
überlebt das Schließen eines Giveaways. Konsequenzen:

- Neue append-only Tabelle `credit_ledger` (Abschnitt 7): jede Bewegung
  (Verdienen, Setzen, Rücknahme, Abbuchung, Verfall) als Ereignis, Kontostand
  ist die Summe. Persistenz in Postgres, nicht nur Redis — Guthaben, das
  Kampagnen überlebt, darf keinen Volume-Verlust sterben.
- Der Core verdient Guthaben (aus Zuschauzeit), aber **die Engine führt das
  Konto** — wie beim Ziehen: eine Stelle, die buchen kann, eine, die falsch
  sein kann.
- **Rechtliche Leitplanken gegen Währungscharakter**, ausdrücklich in den
  Teilnahmebedingungen: kein Kauf, kein Barwert, kein Umtausch, keine
  Übertragung zwischen Zuschauern. Zusätzlich **Verfall nach 12 Monaten ohne
  Aktivität** (Datenminimierung + verhindert unbegrenzt wachsende Konten)
  und Altvermögen-Deckel je Preis-Ziehung erwägen (siehe Risiken).
- `credit_ledger` ist personenbezogen → `collectSubjectData()`,
  `eraseSubject()`, `meine-daten.html`, `runRetention()` von Tag eins.

Setzen läuft über **beide Wege** (entschieden, siehe Abschnitt 10): Web-Seite
nach `claim.html`-Muster (Twitch-Session, Preisliste, Rücknahme-Button) und
Chatbefehl (`!setzen <preis> <anzahl>` mit Bestätigungsantwort). Der
Chat-Pfad ist verkraftbar, weil Einsätze bis zum Einsatz-Ende ohnehin
zurücknehmbar sind — eine Fehleingabe bindet nichts endgültig. Beide Wege
laufen durch dieselbe Engine-Buchung und dasselbe Audit.

### 5.3 CORE_CurrentViewers

Sofortverlosung, Laufzeit Minuten statt Wochen.

- Moderator startet die Verlosung mit Keyword und Fensterdauer (z.B. 60 s).
- Teilnahmeberechtigt ist, wer **beide** Bedingungen erfüllt: das Keyword im
  Fenster geschrieben **und** im selben Zeitraum als anwesender Zuschauer
  gemeldet worden. Das schließt Chat-Bots und Leute aus, die nur den Chat offen
  haben.
- Gewicht ist für alle gleich (`weight = 1`). Keine gesammelte Zuschauzeit, kein
  Coin-Konto.
- Nach Fensterende zieht die Engine automatisch.

Risiko, das im Bau adressiert werden muss: hängt die Anwesenheitsmeldung
(Streamerbot-Ingest), ist niemand berechtigt. Der Core muss diesen Fall
erkennen und die Verlosung mit klarer Meldung abbrechen statt still leer zu
ziehen.

---

### 5.4 CORE_ScreenshotContest — BETA

> **BETA (10.8.2026):** umgesetzt und getestet, aber im Livebetrieb noch kaum
> gelaufen. Die Oberflaeche kennzeichnet das (`display.beta`).

Wettbewerb statt Verlosung: die Community sendet Screenshots ein und bewertet
sie; die höchste **Punktsumme** gewinnt (Entscheidung §10.5).

- **Einsenden** darf nur, wer nachweislich Zuschauer des ausrichtenden Kanals
  ist: bestätigter **Follow** UND **Mindest-Zuschauzeit** (konfigurierbar,
  gemessen am Kampagnen-Viewtime-Stand des Teams). **Eine Einsendung pro
  Person**; erneutes Einsenden ersetzt die eigene (bis zum Einsende-Ende) und
  setzt den Status zurück.
- **Freigabe-Pflicht:** jede Einsendung ist `pending`, bis der Veranstalter sie
  freigibt (`approved`) oder ablehnt (`rejected`) — nichts wird ungeprüft
  sichtbar (Inhalte-/Rechteverantwortung des Veranstalters, auditiert).
- **Voten** darf nur, wer per Twitch eingeloggt ist UND die konfigurierbare
  Mindest-Zuschauzeit erreicht (Anti-Votebot: Wegwerf-Accounts haben keine
  Viewtime). Skala **1–10**, **genau eine Stimme je (Voter, Screenshot)** —
  per `UNIQUE`-Constraint erzwungen; erneutes Voten **überschreibt** die eigene
  Stimme statt sie zu addieren. Damit gilt strukturell: n angemeldete Voter →
  maximal n Votes je Screenshot. Dazu Rate-Limit auf dem Vote-Endpunkt.
- **Der Gewinner ist deterministisch** — trotzdem läuft die Ermittlung über die
  normale Engine-Ziehung: `buildPool` liefert **nur die Führenden** (höchste
  Punktsumme, `approved`, ≥1 Stimme) mit `weight = 1`. Bei eindeutigem Führenden
  ist der „Zufallszug" über einen Kandidaten deterministisch; **bei
  Punktgleichstand lost die Engine fair aus**. Snapshot = das komplette Ranking
  (Nachweis), Draw-Audit/Claim/Ansage kommen gratis aus der Engine.
- Kein Watchtime-Accrual über die Instanz (`accrual:'none'`); die
  Viewtime-Schwellen lesen den Team-/Kampagnenstand.
- Bilder liegen als `BYTEA` in Postgres (max. 7 MB, `png/jpeg`) — kein
  neues Volume, der Backup-Container sichert sie mit. Auslieferung nur hinter
  Login; sichtbar sind `approved` (alle), `pending/rejected` nur Einsender und
  Veranstalter.
- **DSGVO:** Einsendungen (inkl. Bild) und Votes sind personenbezogen →
  Auskunft; Löschung: eigene Einsendung wird hart gelöscht (Bild weg), Votes
  werden pseudonymisiert (Score bleibt — Teil des Ergebnisnachweises).

> **Stand 5. August 2026: umgesetzt** (`cores/screenshot-contest.js`,
> Tabellen `contest_entries`/`contest_votes`, Engine-Methoden submit/review/
> vote/standings, Voting-Steuerung `open/pause/resume/close` mit
> Chat-Ansagen, Warn-Handshake beim Ersetzen (`votes_would_be_lost` →
> `confirmReplace`), REST + `/giveaway/contest.html`, Panel-Typ 4 mit 🖼/🗳,
> Rechtstexte § 4d + Nutzungsbedingungen § 5-Zusatz, DSGVO komplett,
> 6 Engine-Tests).

### 5.5 CORE_Quiz — Rätsel (geplant)

Wettbewerb auf Wissen und Tempo statt auf Zuschauzeit: der Veranstalter legt
Fragen an, die erste **richtige Antwort im Chat** bekommt einen Punkt. Wer am
Ende die meisten Punkte hat, gewinnt. Die Ziehung bleibt wie beim Contest ein
Klick des Streamers — gewonnen hat, wer vorne steht, gelost wird nur bei
Gleichstand.

**Warum das ein eigener Core ist:** die Punkte entstehen weder aus Zeit
(Kampagne) noch aus Einsatz (Los) noch aus Fremdbewertung (Contest), sondern
aus einem Ereignis mit genau einem Gewinner je Frage. Die Auswertung passiert
im Chat-Pfad, in der Reihenfolge des Eintreffens.

#### Ablauf

```
Frage anlegen  ──►  Frage öffnen  ──►  Antworten im Chat  ──►  erste richtige
   (Panel)          (Ansage)            (Engine prüft)         Antwort = 1 Punkt
                                                                     │
                          weitere Fragen jederzeit ◄─────────────────┘
                                                                     │
                        Giveaway schließen ──► ★ ziehen ──► aufräumen
```

- **Langläufer.** Ein Rätsel-Giveaway kann über Wochen laufen; Fragen kommen
  laufend dazu. Es gibt kein festes Ende und keine feste Fragenzahl.
- **Die Fragenzahl ist nicht öffentlich.** Weder Chat-Ansagen noch die
  Zuschauer-Seite nennen, wie viele Fragen es gibt oder noch kommen — sonst
  könnte man ausrechnen, ob sich Mitmachen noch lohnt. Öffentlich sind nur:
  laufende Frage, eigener Punktestand, Rangliste.
- **Genau eine Frage ist gleichzeitig offen.** Das hält die Zuordnung
  Antwort → Frage eindeutig und die Chat-Auswertung billig.

#### Regeln

- **Ein Punkt je Frage**, an die **erste** richtige Antwort. Die Engine
  entscheidet in Eintreffreihenfolge; die Frage wird in derselben Transaktion
  geschlossen, in der der Punkt gebucht wird (kein zweiter Gewinner bei
  gleichzeitigen Nachrichten).
- **Teilnahmebedingung wie bei der Kampagne:** Follow auf einem Instanz-Kanal
  und Mindest-Zuschauzeit (konfigurierbar, Vorgabe wie Contest 10 Minuten).
  Ohne diese Hürde gewinnt der schnellste Wegwerf-Account.
- **Antwortprüfung** normalisiert beide Seiten: klein schreiben, Satzzeichen
  und Mehrfach-Leerzeichen weg, Umlaute wahlweise entfalten (ae/oe/ue/ss).
  Je Frage sind **mehrere gültige Antworten** hinterlegbar (Synonyme,
  Schreibweisen). Optional: Tippfehler-Toleranz über Levenshtein-Abstand ≤1 ab
  einer Mindestlänge — abschaltbar, weil sie bei kurzen Antworten schadet.
- **Wer schon einen Punkt auf diese Frage hat, kann sie nicht nochmal gewinnen**
  (trivial, da die Frage sofort schließt) — aber ein Zuschauer kann über die
  Laufzeit beliebig viele Fragen gewinnen.
- **Antworten zählen nicht als Chat-Bonus.** Wie der Setz-Befehl beim
  Los-Giveaway ist eine Antwort ein Kommando, keine Unterhaltung.
- **Gleichstand am Ende** löst die Engine wie beim Contest: `buildPool`
  liefert nur die Führenden mit `weight = 1`, der Zufall entscheidet unter
  ihnen. Ein eindeutiger Führender gewinnt deterministisch.

#### Was der Veranstalter steuert

| Aktion | Wirkung |
|---|---|
| Frage anlegen | Text + Antwortliste + optionaler Hinweis; landet als `draft` |
| Frage öffnen | genau eine offene Frage; Ansage im Chat (ohne Fragenzahl) |
| Frage schließen ohne Gewinner | niemand hat es geraten — Punkt verfällt, Ansage optional mit Auflösung |
| Frage korrigieren | nur solange sie nicht gewonnen wurde |
| Frage löschen | nur `draft`; gewonnene Fragen bleiben (Nachweis) |
| Punkt zurücknehmen | Korrektur mit Grund, auditiert (z. B. Antwort war doch falsch) |
| Rangliste ansagen | Top 5 in den Chat, ohne Restfragen zu verraten |

#### Chat

| Ereignis | Ansage |
|---|---|
| Frage offen | „🧩 Rätsel: `<Frage>` — erste richtige Antwort im Chat bekommt einen Punkt." |
| Treffer | „🧩 @name hat es: `<Antwort>` — 1 Punkt (Stand: `<n>`)." |
| Frage zu, ungelöst | „🧩 Keiner drauf gekommen. Die Antwort war `<Antwort>`." |
| `!raetsel` | laufende Frage + eigener Punktestand + Bedingungen. Nie die Fragenzahl. |

#### Datenmodell

```sql
quiz_questions (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  session_id TEXT NOT NULL,          -- die Instanz
  prompt TEXT NOT NULL,              -- Frage
  answers JSONB NOT NULL,            -- ["antwort", "synonym", ...] normalisiert
  hint TEXT,
  status TEXT NOT NULL,              -- draft | open | solved | closed
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  winner TEXT,                       -- wer den Punkt bekam
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

quiz_points (                        -- append-only, wie das Guthaben-Journal
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  question_id BIGINT REFERENCES quiz_questions(id),
  username TEXT NOT NULL,
  points INT NOT NULL,               -- +1, Korrektur = -1 mit Grund
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Redis je Instanz: `t:<team>:g:<sid>:quiz:open` (ID der offenen Frage) und
`t:<team>:g:<sid>:quiz:answers` (normalisierte Antwortliste als JSON) — damit
die Chat-Auswertung ohne Datenbankzugriff entscheidet, ob eine Nachricht
überhaupt in Frage kommt. Punkt buchen und Frage schließen laufen danach in
einer Transaktion.

**Antwortliste nie an den Client.** Weder `gw_data` noch die Zuschauer-Seite
liefern `answers` aus; das Panel zeigt sie nur dem Team über einen eigenen
Befehl. Sonst steht die Lösung im Netzwerk-Tab.

#### Core-Vertrag

| Feld | Wert |
|---|---|
| `id` / `label` | `CORE_Quiz` / „Rätsel" |
| `accrual` | `'none'` — Zeit spielt keine Rolle, die Schwellen lesen den Kampagnenstand |
| `config` | `minWatchSec` (Vorgabe 600), `answerCmd` (leer = jede Nachricht zählt als Antwortversuch), `typoTolerance` (an/aus), `announceSolution` (an/aus) |
| `aggregate` | `{username, points, questionsWon, eligible}` — `eligible` = Follow + Mindest-Viewtime |
| `buildPool` | nur die Führenden, `weight = 1` (Gleichstand wird gelost) |
| `display.drawKind` | `'score'` wie der Contest |
| `display.unit` | `'Punkte'` |
| `display.columns` | Punkte · gewonnene Fragen · Berechtigt |
| `display.tiles` | Fragen offen/gelöst (nur intern), Teilnehmer mit Punkten, Führender |
| `display.panelCard` | `'quiz'` — neue Rail-Karte: Fragenliste, Frage öffnen/schließen, Rangliste |
| `display.emptyPool` | „Noch niemand hat eine Frage richtig beantwortet." |
| `display.beta` | `true` bis zum ersten echten Durchlauf |

#### Engine-Berührungspunkte

1. `handleChatMessage` bekommt vor dem Keyword-Zweig einen Quiz-Zweig — analog
   zum Setz-Befehl: gibt es eine offene Frage für eine Instanz dieses Kanals,
   wird die Nachricht normalisiert und gegen die Antwortliste geprüft. Treffer
   → `awardQuizPoint()`, Antwort im Chat, **Ende** (kein Chat-Bonus).
2. Neue Engine-Methoden: `addQuizQuestion`, `openQuizQuestion`,
   `closeQuizQuestion`, `editQuizQuestion`, `deleteQuizQuestion`,
   `awardQuizPoint`, `revokeQuizPoint`, `getQuizStandings`,
   `getQuizParticipants`.
3. `cleanupGiveawayInstance` räumt die beiden Redis-Schlüssel mit ab; die
   Tabellen bleiben (Nachweis).
4. DSGVO: `quiz_points` und `quiz_questions.winner` sind personenbezogen →
   `collectSubjectData()` und `eraseSubject()` (pseudonymisieren, nicht
   löschen — der Punktestand ist Teil des Ergebnisnachweises).

#### Offene Punkte

- **Wettlauf bei gleichzeitigen Nachrichten:** die Engine verarbeitet
  Chat-Ereignisse sequenziell je Prozess. Sobald mehrere Instanzen des
  giveaway-Dienstes laufen, braucht der Punkt eine Sperre
  (`pg_advisory_xact_lock` auf die Frage-ID) — bis dahin reicht die
  Transaktion mit `UPDATE … WHERE status='open'`.
- **Antwort im Chat sichtbar:** wer schnell liest, sieht die richtige Antwort
  eines anderen. Das ist bei einem Chat-Rätsel systemimmanent; die Frage
  schließt ja sofort. Falls das stört, wäre eine stille Variante über die
  Zuschauer-Seite denkbar — dann aber ohne Chat-Charme.
- **Moderation:** Antworten stehen im öffentlichen Chat; das System speichert
  nur den Treffer, nicht die Fehlversuche.

## 6 Parallelbetrieb: die Giveaway-Dimension

Das ist der eigentliche Umbau. Heute gibt es je Team **einen** Zustand:
`t:<team>:gw_open`, `t:<team>:ch:<kanal>:watchsec:<user>` und so weiter. Ein
zweites gleichzeitiges Giveaway hat darin keinen Platz.

**Neu:** jedes Giveaway bekommt eine ID, und alle mechanikbezogenen Schlüssel
wandern darunter:

```
t:<team>:g:<giveawayId>:...      ← Zustand eines Giveaways (Core-eigen)
t:<team>:giveaways               ← Set der aktiven Giveaway-IDs
t:<team>:...                     ← bleibt team-weit: Kanäle, Ingest-Tokens,
                                   Keyword-Defaults, Follow-Cache,
                                   Guthaben-Cache (Quelle: credit_ledger in PG)
```

Team-weit bleibt bewusst alles, was **nicht** zur Mechanik gehört. Der
Follow-Cache etwa ist eine Eigenschaft des Zuschauers, nicht des Giveaways —
ihn zu duplizieren würde die Helix-Abfragen vervielfachen.

### Ingest-Verteilung

Der Punkt, an dem es kippt: ein `viewer_tick` für Kanal X geht heute an genau
einen Empfänger. Künftig muss er an **jedes aktive Giveaway des Teams gehen,
dessen Kanalliste X enthält**. Ein Zuschauer sammelt dann gleichzeitig
Kampagnen-Zuschauzeit und ist im Fenster der Sofortverlosung — das ist gewollt.

Aufwandstreiber: der Ticker läuft heute einmal je Team. Er muss künftig je
(Team × aktives Giveaway) laufen, ohne dass die Redis-Last mit der Zahl der
Giveaways multipliziert wird. Gegenmaßnahme: Ereignisse einmal einlesen und an
die Cores verteilen, statt je Core neu zu lesen.

### Team-weite Reste, die je Giveaway werden müssen

Bei der Durchsicht gefunden, im ersten Entwurf nicht genannt:

- **Der Multiplier.** `gwMult` liegt heute team-weit (`t:<team>:gw:mult`,
  watchtime.js:43). „Doppelte Viewtime für 15 Minuten" muss künftig ein
  Giveaway meinen, nicht das Team — sonst boostet die Sofortverlosung die
  Kampagne mit.
- **Das Aufräumen.** `resetGiveaway()`/`closeGiveaway()` löschen heute die
  team-weiten Schlüssel en bloc. Künftig räumt das Schließen eines Giveaways
  genau `t:<team>:g:<id>:*` — vollständig, sonst überleben Stände
  geschlossener Giveaways als Redis-Leichen und tauchen im nächsten mit
  gleicher ID wieder auf.
- **Der Alt-Schlüssel `cfgDrawMinSec`.** Er ist heute zugleich Coin-Basis und
  Lostopf-Schwelle und heißt schon jetzt nur aus Abwärtskompatibilität so
  (watchtime.js:163). Die Migration nach `core_config` muss den alten
  Redis-Wert **lesen und übernehmen** — sonst kippen alle Teams mit
  angepasster Basis kommentarlos auf den Default 7200.
- **Die Test-Console.** Sim-Events brauchen eine Giveaway-Auswahl und laufen
  durch dieselbe Verteilfunktion wie der echte Ingest (siehe Ist-Zustand,
  Abschnitt 2).
- **Das Redis-Backup.** `exportTeam()`/`importTeam()` müssen die
  `g:<id>`-Ebene mitsichern.

### Abgrenzung nach aussen

- `!los` muss sagen, **welches** Giveaway gemeint ist, sobald mehr als eines
  läuft. Vorschlag: Standard ist die laufende Sammel-Kampagne; Sofortverlosungen
  melden sich von selbst im Chat.
- Chat-Ansagen (Öffnen/Boost/Ziehung) müssen das Giveaway benennen, sonst ist im
  Chat nicht unterscheidbar, worauf sich „Boost für 15 Minuten" bezieht.
- Das Admin-Panel braucht eine Giveaway-Auswahl neben der Team-Auswahl.

---

## 7 Datenmodell

| Tabelle | Änderung |
|---|---|
| `sessions` | wird zur Giveaway-Instanz. Neu: `core TEXT NOT NULL DEFAULT 'CORE_WatchtimeChatActivity'`, `core_config JSONB`, `status TEXT` (`open`/`paused`/`closed`). |
| `watchtime_events` | `session_id` ist bereits da — künftig Pflichtfeld, damit Ereignisse eindeutig einem Giveaway gehören. Die Tabelle ist als reines Viewtime-Journal gebaut (`delta_sec`, `event_type`); für core-neutrale Ereignisse kommt `amount NUMERIC` + `unit TEXT` dazu. Die `event_type`-CHECK-Bedingung wurde bereits entfernt, neue Typen sind also möglich. |
| `campaign_participation` | bleibt, ist bereits `session_id`-basiert. `coins`/`watch_sec` werden core-abhängig interpretiert; ergänzend `weight NUMERIC` als core-neutrale Spalte. |
| `giveaway_draws` | neu `prize_id BIGINT NULL` (für `CORE_TicketBuy`), `core TEXT` zur Nachvollziehbarkeit, welche Mechanik gezogen hat. |
| `giveaway_prizes` | **neu**, nur für `CORE_TicketBuy`: Titel, Beschreibung, Einsatz-Ende, Status. |
| `prize_wagers` | **neu**: wer wie viele Lose auf welchen Preis gesetzt hat, mit Zeitpunkt. Append-only, damit Rücknahmen nachvollziehbar bleiben. |
| `credit_ledger` | **neu**, team-weit (überlebt Giveaways — Entscheidung Abschnitt 10): append-only Bewegungsjournal des Guthabens (`earn`/`wager`/`refund`/`debit`/`expire`), Kontostand = Summe. Von der Engine geführt, nie vom Core direkt beschrieben. Personenbezogen → DSGVO-Pfade. |

Bestehende Sitzungen bekommen per Default den heutigen Core — sie laufen
unverändert weiter, ohne Datenmigration.

Verbindliche Regeln für alle Schemaänderungen dieses Umbaus:

- **Neue Tabellen/Spalten ausschließlich in `ensureSchema()`** (giveaway
  server.js), nicht in `postgres/init.sql` — die läuft nur bei frischem Volume.
- **`prize_wagers` ist personenbezogen.** Die Tabelle muss von Tag eins in
  `collectSubjectData()` **und** `eraseSubject()` (admin/server.js) auftauchen,
  Labels in `meine-daten.html`, und `runRetention()` braucht eine Regel dafür
  (Vorschlag: wie `campaign_participation` nach `participationDays` löschen,
  gebundene Einsätze gezogener Preise bleiben als Teil des
  Ziehungs-Snapshots pseudonymisiert erhalten).
- `giveaway_prizes` ist unkritisch (keine Personendaten), `sessions.core_config`
  darf **nie** Secrets enthalten — KI-Keys bleiben in `app_secrets`.

---

## 8 Umbau in Phasen

Jede Phase ist für sich lieferbar und lässt das System lauffähig.

### Phase 0 — Dubletten zusammenführen

Klein, aber Voraussetzung. Solange die Coin-Formel und die Kommando-Whitelists
doppelt gepflegt sind, driftet der Umbau zwangsläufig auseinander.

- ~~Coin-Formel aus `giveaway-test.js` entfernen, stattdessen den echten Wert
  vom Server holen.~~ **Erledigt** (Commit `7f31cfb`).
- ~~`ALLOWED_EVENTS`/`ALLOWED_CMDS` in **eine** Datei, von beiden Shared-Libs
  geladen.~~ **Erledigt:** `services/giveaway/public/cc-defs.js` (über Caddy
  `/giveaway/cc-defs.js`), beide Shared-Libs lesen `CC.defs` **fail-closed** —
  ohne geladene Defs blockiert `validateWsPayload()` alles. `auditSummary()`
  war entgegen dem ersten Entwurf nie dupliziert (nur `giveaway-shared.js`).
- ~~Die C#-Actions liegen byte-identisch in zwei Verzeichnissen.~~ **Erledigt:**
  Quelle ist `services/admin/actions/` (Laufzeit-Quelle für `/pub/actions`;
  der Build-Context des admin-Containers endet an `services/admin/`, darum
  nicht `streamerbot/`). `streamerbot/` enthält nur noch das Setup-Dokument.

**Abnahmekriterium:** jede dieser Definitionen existiert genau einmal im Repo.
**Phase 0 ist damit abgeschlossen.**

### Phase 1 — Core-Vertrag, ohne Verhaltensänderung

Die heutige Mechanik wird als `CORE_WatchtimeChatActivity` hinter den Vertrag
aus Abschnitt 4 gezogen. Kein neues Verhalten, keine neuen Schlüssel, keine
Oberflächenänderung.

Reihenfolge innerhalb der Phase, vom Kern nach aussen:

1. ✅ `coinsFromSec`, `countWords` und die Regel-Logik von `getUserAggregate`
   (`CORE.aggregate` — definiert `eligible`) in den Core. Die zwölf
   Konfigurations-Accessoren bleiben als Redis-Zugriffe in der Engine,
   beziehen aber Defaults und Grenzen aus `CORE.config` (eine Quelle);
   sie wandern erst mit `ctx.kv` in Phase 2 vollständig.
2. ✅ `drawWinner` aufgeteilt: Pool-Bildung (`CORE.buildPool`) im Core,
   Zufall, Snapshot und Persistenz in der Engine.
3. ✅ (Teil) Die Delta-Formeln (`CORE.tickDelta`/`chatDelta`, Multiplier) und
   das Chat-Urteil (`CORE.chatMeaningful`) liegen im Core; das Schreiben von
   `watchtime_events` war bereits zentral (`_logEvent`). Die volle
   beschreibende Rückgabe (Engine wendet Deltas an) folgt mit der
   Ingest-Verteilung in Phase 2, wo sie gebraucht wird.
4. ✅ `chat-ai.js` → `cores/chat-ai.js`.
5. ✅ Regeltexte `!los`/`!giveaway`/Anmelde-Antwort in `statusText`/
   `infoText`/`joinReply` des Cores (inkl. `fmtDur`/`kw2`); server.js
   sammelt nur noch Daten.

Die Anzeigepfade ausserhalb des Panels (`claim.js`, `archive.js`,
`status.html`, `auditSummary()`) bleiben in Phase 1 bewusst unverändert
coin-geprägt — sie wandern erst mit der generischen Anzeige (Phase 2/3) auf
`display`/`auditText`. Sie hier schon anzufassen, verletzte das
„keine Verhaltensänderung"-Kriterium.

**Abnahmekriterium:** die bestehenden 45 Tests laufen unverändert durch, und ein
neuer Test spielt dieselbe Ereignisfolge gegen alte und neue Implementierung und
vergleicht Coins, Berechtigung und Pool-Gewichte auf exakte Gleichheit.

Das ist die risikoärmste und wichtigste Phase: ist sie sauber, sind alle
folgenden Cores additiv. Sie ändert für Zuschauer und Veranstalter **nichts**
und gehört deshalb nicht ins Änderungsprotokoll.

### Phase 2 — Giveaway-Dimension

> **Stand 4. August 2026:** Schritte (a)–(c) umgesetzt: Datenmodell
> (`sessions.core/core_config/status`, `giveaway_draws.core/prize_id`,
> Core-Registry), Accrual-Zustand je Giveaway unter `t:<team>:g:<sid>:*`
> mit Lazy-Migration des Altbestands, und die Ingest-Verteilung
> (`_activeGiveaways`, Sekundär-Instanzen via `openGiveawayInstance` mit
> eigenem Keyword/Kanalliste/Pause/Multiplier; Tick und Chat verteilen an
> alle aktiven Giveaways, Ziehung zieht je Giveaway). Server-Anbindung (2d):
> `gw_open_instance`/`gw_close_instance`/`gw_list_giveaways` (mit Rechts-Gates
> und Obergrenze `MAX_PARALLEL_GIVEAWAYS`, ENV, Default 4 = 3+1);
> `gw_pause`/`gw_resume`/`gw_set_multiplier`/`gw_draw_winner` nehmen optional
> `giveawayId`. `core_config`-Snapshot beim Öffnen übernimmt die Team-Werte
> inkl. Alt-Key `cfgDrawMinSec`. Die **Test-Console-Sim braucht keine eigene
> Giveaway-Auswahl**: Sim-Events laufen durch dieselbe Pipeline und werden
> serverseitig an alle aktiven Giveaways verteilt. **Offen:** Panel-UI
> (Giveaway-Auswahl im Dashboard), Sekundär-Anzeige (`wt_update` je Instanz),
> Laufzeit-Config aus `core_config` statt Redis-Team-Keys.

Schlüssel um `g:<giveawayId>` erweitern, Ingest-Verteilung auf n Empfänger,
Giveaway-Auswahl im Panel. Altbestand über Fallback auf die alten Schlüssel,
damit ein laufendes Giveaway den Deploy übersteht.

Betroffen sind nur die zehn mechanikbezogenen Schlüssel; die neunzehn
generischen bleiben team-weit. Streamerbot bleibt unangetastet, weil die
Zuordnung Ereignis → Giveaway serverseitig aus der Kanalliste entsteht.

Gehört ebenfalls in diese Phase (siehe „Team-weite Reste", Abschnitt 6):
Multiplier unter `g:<id>`, Aufräumen je Giveaway bei Close/Reset,
Alt-Schlüssel-Migration `cfgDrawMinSec` → `core_config`, Giveaway-Auswahl in
der Test-Console-Sim, `exportTeam()`/`importTeam()` giveaway-fähig.

**Abnahmekriterium:** zwei Giveaways desselben Teams laufen gleichzeitig mit
getrennten Ständen; ein `viewer_tick` erhöht beide. Ein vor dem Deploy
geöffnetes Giveaway läuft ohne Datenverlust weiter — inklusive der vom Team
angepassten Coin-Basis. Nach dem Schließen eines Giveaways existiert kein
`t:<team>:g:<id>:*`-Schlüssel mehr.

### Phase 3 — CORE_CurrentViewers

Der einfachste neue Core: kein Guthaben, kein Preis-Modell, gleiches Gewicht für
alle. Guter erster Beweis, dass der Vertrag trägt — und der erste, der die
Parallelität aus Phase 2 wirklich braucht.

> **Stand 4. August 2026: umgesetzt.** `cores/current-viewers.js`
> (`accrual:'none'` — Tick/Chat-Bonus lassen solche Instanzen aus),
> Präsenz ausschließlich aus `viewer_tick` (`chLastTick`, Chat allein
> reicht nicht — schließt Chat-Bots aus), Berechtigung = Keyword-Opt-in
> (`gReg`) UND Präsenz auf einem Instanz-Kanal.
> **Geändert am 5. August (Betreiber-Entscheidung):** das Zeitfenster ist
> NUR die Anmeldephase — das Keyword zählt ausschließlich bei offenem
> Fenster (`gWinEnd`, restart-sicher), Fenster sind **mehrfach öffenbar**
> (`gw_instant_window`, auch für Member — Teilnehmer akkumulieren). Der
> Watcher (5s) schließt abgelaufene Fenster nur noch mit Ansage
> (`instant_window_closed`, auditiert). **Die Ziehung macht der Streamer
> manuell** (★, `gw_draw_winner` auch für Member); Anwesenheit zählt zum
> Ziehungszeitpunkt. Aufgeräumt wird beim Schließen der Instanz.

### Phase 4 — CORE_TicketBuy

Preis-Entität, Einsatz-Oberfläche, Abbuchung. Der aufwendigste Core, weil er als
einziger neue Zuschauer-Interaktion braucht.

> **Stand 4. August 2026 — Teilschritt 4a (Guthaben-Fundament) umgesetzt:**
> `credit_ledger` (append-only, team-weit, `ensureSchema()`),
> `services/giveaway/credit.js` als einzige Buchungsstelle (Vorzeichen aus dem
> Typ erzwungen; `transfer`/`purchase` existieren als Typen bewusst nicht —
> §10.1-Leitplanken), Verfall nach 12 Monaten Inaktivität in `runRetention()`
> (Gegenbuchung, kein DELETE), DSGVO komplett: Auskunft
> (`collectSubjectData` + Abschnitt in `meine-daten.html`) und Löschung
> (`eraseSubject`: Restsaldo ausbuchen + pseudonymisieren — dokumentierte
> Ausnahme vom Engine-bucht-Prinzip).
>
> **Teilschritt 4b umgesetzt:** `giveaway_prizes` + `prize_wagers`
> (append-only, Rücknahme = negative Zeile, DSGVO-Pfade mitgezogen),
> `cores/ticket-buy.js` (accrual 'watchtime', `parseWager`, `buildPool` je
> Preis, Texte), Engine: `placeWager`/`prizeStake`/`getPrizeStakes`/
> `availableCredit` (Ledger + Live-Anteil laufender Instanzen),
> `settleTicketBuyInstance` (Close → earn ins Ledger → Instanz abräumen,
> „Guthaben wandert"). Ziehung je Preis über den normalen Engine-Pfad
> (`drawWinner` + `prizeId`, Core-/Preis-Stempel in `giveaway_draws`);
> danach setzt `status='drawn'` **in derselben Transaktion** — Einsätze
> aller Setzer sind gebunden (afterDraw, §5.2). Setz-Befehl je Instanz
> **per WebUI konfigurierbar** (Panel-Feld beim Start + `gw_set_wager_cmd`,
> Redis `gWagerCmd`, Default `!setzen`); Chat: `<cmd> <preis> <anzahl>`,
> `<cmd> <preis> 0` = Rücknahme, `<cmd>` = Hilfe mit Preisliste. Panel:
> Instanz-Typauswahl (Kampagne/Sofort/Los), 🎁 Preis anlegen, ⌨ Befehl
> ändern.
>
> **Teilschritt 4c umgesetzt:** Setz-/Guthaben-Seite
> `/giveaway/wager.html` (Guthaben je Team, Preise mit eigenem Einsatz,
> Setzen/Rücknahme, Chat-Befehl-Hinweis, Rechtstext-Fussnote) + REST
> `GET /api/wager/state` und `POST /api/wager` — Identität ausschließlich
> aus der Twitch-Session (X-Auth-User), Buchungen auditiert
> (`wager_set`/`wager_retract`). Caddy: **bewusst KEIN**
> `@needsauth not path`-Eintrag — die Seite braucht den Login (Identität),
> Zuschauer registrieren sich beim ersten Twitch-Login selbst; das ist das
> claim.html-Muster, die frühere Whitelist-Notiz ist damit hinfällig.
> Nav-Link „Lose setzen" in beiden Shared-Libs. **Offen:** Preisbild,
> `!los`-Integration (nennt Guthaben/Einsätze).

Pflichtpunkte über den Core hinaus:

- **DSGVO:** `prize_wagers` **und** `credit_ledger` in `collectSubjectData()`,
  `eraseSubject()`, `meine-daten.html` und `runRetention()` (Abschnitt 7).
  Abnahme: die Selbstauskunft eines Setzers enthält Einsätze und
  Guthabenbewegungen, die Löschung entfernt beides.
- **Caddy:** die öffentliche Einsatz-Seite in die `@needsauth not path`-Liste
  in `caddy/Caddyfile.team` — sonst verlangt sie Login. (Die Einsatz-Aktion
  selbst bleibt hinter der Twitch-Session, wie `claim.html`.)
- **Whitelist/Audit:** Einsatz setzen/zurücknehmen als Core-Kommandos über die
  `commands`-Deklaration (Abschnitt 4) — damit automatisch `handleAdminCmd`,
  Audit-Log und Deny-Drossel.

### Phase 5 — Recht und Texte je Core

> **Stand 4. August 2026: umgesetzt.** Nutzungsbedingungen Fassung 2
> (§ 4 Abs. 8: plattforminternes Los-Guthaben ist kein Zahlungsmittel;
> Sofortverlosung ohne Vorleistung), `TOS_VERSION = 2` in **beiden**
> server.js — bestehende Veranstalter müssen vor dem nächsten Öffnen neu
> zustimmen. Teilnahmebedingungen (Doc **und** `terms-template.md`):
> neue § 4b Sofortverlosung / § 4c Los-Giveaway. Datenschutzerklärung:
> Guthaben-Journal, Einsätze, Anwesenheit als Datenkategorien +
> Speicherfristen. FEATURES.md: Mechanik-Tabelle; ANLEITUNG-TEILNEHMER:
> Abschnitte ⚡/🎟.

Teilnahmebedingungen und Datenschutzerklärung nennen die Mechanik. Jeder Core
braucht seinen Textbaustein — insbesondere `CORE_TicketBuy` (Einsatz verfällt)
und `CORE_CurrentViewers` (keine Vorleistung, reine Anwesenheit).
`TOS_VERSION` an beiden Stellen erhöhen.

Ausserdem: `FEATURES.md` bekommt je Core einen Abschnitt (Defaults +
Wertebereiche aus der `config`-Deklaration), nutzerrelevante Schritte gehören
ins öffentliche `changelog.md`, `docs/ANLEITUNG-TEILNEHMER.md` erklärt die
neuen Mechaniken aus Zuschauersicht.

---

## 9 Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Der Umbau ändert unbemerkt das Verhalten der laufenden Kampagne. | Phase 1 mit Gleichheitstest gegen den Ist-Zustand, kein Deploy während einer laufenden Ziehung. |
| Ein Core schreibt an der Protokollierung vorbei. | Cores bekommen keinen Schreibzugriff auf Postgres. Ereignisse werden beschrieben, geschrieben wird in der Engine. |
| Redis-Last vervielfacht sich mit der Zahl paralleler Giveaways. | Ereignisse einmal lesen, an alle Cores verteilen. Obergrenze für gleichzeitige Giveaways je Team. |
| Zuschauer verstehen nicht mehr, an welchem Giveaway sie teilnehmen. | Jede Chat-Ansage nennt das Giveaway; `!los` zeigt alle laufenden mit eigenem Stand. |
| `CORE_TicketBuy` wird als Verkauf gelesen. | Einsatz ausschließlich aus erspielter Zeit, Gewinn per gewichtetem Zufall, kein Höchstgebot. Ausdrücklich in den Teilnahmebedingungen. |
| Übertragbares Guthaben bekommt Währungscharakter und wächst unbegrenzt. | Kein Kauf/Barwert/Umtausch/Übertragung (Teilnahmebedingungen), Verfall nach 12 Monaten Inaktivität, Konto ausschließlich von der Engine geführt (`credit_ledger`). Altvermögen-Deckel je Preis-Ziehung prüfen, falls frühe Konten spätere Pools dominieren. |
| Sofortverlosung zieht leer, weil der Ingest hängt. | Core prüft, ob überhaupt Anwesenheitsmeldungen ankommen, und bricht mit klarer Meldung ab. |
| Das Admin-Panel bleibt auf Coins verdrahtet und passt zu keinem neuen Core. | Ein Core liefert seine Anzeigespalten und Konfigurationsfelder aus `config` und `getParticipant().detail` mit; das Panel rendert generisch, statt Coin-Spalten hartzucodieren. |
| Die Zerlegung wird währenddessen von neuen Funktionen überholt. | Phasen 0 und 1 ändern kein Verhalten und sind in Tagen, nicht Wochen fertig. Erst danach neue Cores. |
| Neue personenbezogene Daten (`prize_wagers`) fehlen in Auskunft und Löschung. | Pflichtpunkt in Phase 4 mit eigenem Abnahmekriterium; Regel in Abschnitt 7. |
| Die Test-Console-Sim umgeht die neue Ingest-Verteilung und schreibt am Giveaway vorbei. | Sim-Events tragen die Giveaway-ID und laufen durch dieselbe Verteilfunktion wie der echte Ingest; `ALLOW_SIM` + `sim_*`-Audit bleiben. |
| Geschlossene Giveaways hinterlassen Redis-Leichen unter `g:<id>`. | Close/Reset räumt `t:<team>:g:<id>:*` vollständig; Abnahmekriterium in Phase 2. |
| Bei der Migration der Coin-Basis fällt ein Team still auf den Default 7200 zurück. | Alt-Schlüssel `cfgDrawMinSec` wird beim Anlegen der `core_config` gelesen und übernommen; Abnahmekriterium in Phase 2. |

---

## 10 Entschiedene Punkte

Am 4. August 2026 entschieden:

1. **Guthaben bei `CORE_TicketBuy` wandert ins nächste Giveaway.** Guthaben
   wird damit team-weit statt giveaway-gebunden — Konsequenzen (Tabelle
   `credit_ledger`, Engine führt das Konto, rechtliche Leitplanken, Verfall
   nach 12 Monaten Inaktivität) in Abschnitt 5.2 und 7.
2. **Obergrenze: 3 langlaufende Giveaways + 1 Sofortverlosung je Team.**
   Konstante im Code, per ENV überschreibbar, bewusst nicht im Admin-Panel
   einstellbar. Begründung: Redis-/Ticker-Last wächst je Giveaway, `!los`
   muss alle laufenden nennen (Twitch-Limit 500 Zeichen), und mehr als ein
   gleichzeitiges Keyword-Fenster im selben Chat ist nicht unterscheidbar.
3. **Setzen über beide Wege:** Web-Seite (`claim.html`-Muster, Twitch-Session,
   Rücknahme-Button) **und** Chatbefehl (`!setzen <preis> <anzahl>` mit
   Bestätigungsantwort). Vertretbar, weil Einsätze bis zum Einsatz-Ende
   zurücknehmbar sind. Beide Wege buchen über die Engine, beide im Audit.
4. **Mehrfachgewinn über parallele Giveaways ist erlaubt.** Die Mechaniken
   sind unabhängig; die Ersatzziehung innerhalb eines Giveaways schließt
   dessen Gewinner weiterhin aus. Optional später als Engine-Feature:
   „Gewinner der letzten X Tage ausschließen" je Giveaway, Default aus —
   kein Phase-4-Blocker.

Am 5. August 2026 entschieden (CORE_ScreenshotContest, §5.4):

5. **Wertung = Punktsumme** der Votes (1–10). Die Max-Votes-Deckelung
   (eine Stimme je Voter und Screenshot) begrenzt sie natürlich.
6. **Einsenden nur für nachgewiesene Zuschauer** (Follow + Mindest-Viewtime),
   eine Einsendung pro Person, Ersetzen erlaubt.
7. **Vote-Schwelle konfigurierbar** (Mindest-Viewtime, 0 = aus) — zusätzlich
   zu Twitch-Session, UNIQUE-Constraint und Rate-Limit.
