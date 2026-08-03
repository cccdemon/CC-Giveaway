# Architektur: austauschbare Giveaway-Systeme („Cores")

Entwurf, Stand 3. August 2026. Noch nicht umgesetzt — dieses Dokument legt fest,
**was** gebaut wird und **in welcher Reihenfolge**, bevor Code entsteht.

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

### Dubletten, die vor dem Umbau weg müssen

Vier Stellen sind bereits heute doppelt gepflegt. Wer die Mechanik zerlegt, ohne
sie vorher zusammenzuführen, bekommt garantiert Abweichungen zwischen den
Kopien:

| Was | Wo |
|---|---|
| Die Coin-Formel | `watchtime.js:104-107` **und** `admin/public/giveaway-test.js:144-150` (dort zusätzlich eine eigene hartcodierte `SECS_PER_COIN = 7200` in :7) |
| `ALLOWED_EVENTS` / `ALLOWED_CMDS` | `giveaway-shared.js:95-115` ≙ `admin-shared.js:95-115` |
| `auditSummary()` | `giveaway-shared.js:186-224` ≙ `admin-shared.js:186-224` (in dieser Sitzung erst aus `giveaway-admin.js` herausgezogen, jetzt aber in beiden Libs) |
| Die C#-Actions | `streamerbot/*.cs` ≙ `services/admin/actions/*.cs`, byte-identisch |

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

## 5 Die drei Cores

### 5.1 CORE_WatchtimeChatActivity

Die heutige Mechanik, unverändert übernommen. Der Umbau darf ihr Verhalten
**nicht** ändern — das ist die Messlatte für Phase 1 (Abschnitt 8).

- `onViewerTick`: Zuschauzeit hochzählen, Multiplier anwenden.
- `onChatMessage`: >3 Wörter (oder KI-Urteil) → Bonussekunden, Cooldown.
- `buildPool`: alle mit ≥1 Coin, Keyword geschrieben, ≥`followMin` Kanälen
  folgend. Gewicht = Coins.

### 5.2 CORE_TicketBuy

Zuschauzeit erzeugt Guthaben wie gehabt. Neu ist, dass Guthaben **gezielt auf
einen Preis gesetzt** wird.

- Neue Entität **Preis** (`giveaway_prizes`): Titel, Beschreibung, Bild,
  Einsatz-Ende. Heute ist `prize` nur ein Freitextfeld an der Ziehung — das
  reicht nicht, wenn man darauf bieten können soll.
- Zuschauer setzen über eine Seite oder einen Chatbefehl Lose auf einen Preis.
  Ein Einsatz ist bis zum Einsatz-Ende zurücknehmbar, danach gebunden.
- `buildPool` läuft **je Preis**: Gewicht = gesetzte Lose auf diesen Preis.
- `afterDraw` bucht die Einsätze **aller** Teilnehmer dieses Preises ab, nicht
  nur die des Gewinners — sonst wäre Setzen risikolos und jeder setzt alles auf
  alles.

> **Rechtlich:** Es bleibt eine Verlosung, kein Verkauf. Eingesetzt wird
> ausschließlich erspielte Zuschauzeit; jeder Teilnehmer kann gewinnen, auch mit
> einem Los. Barwert, Umtausch und Übertragung von Guthaben bleiben
> ausgeschlossen. Guthaben ist kein Zahlungsmittel und darf nie käuflich sein.

Offen und vor dem Bau zu klären: verfällt ungenutztes Guthaben am Kampagnenende,
oder wandert es ins nächste Giveaway?

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
                                   Keyword-Defaults, Follow-Cache
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

Bestehende Sitzungen bekommen per Default den heutigen Core — sie laufen
unverändert weiter, ohne Datenmigration.

---

## 8 Umbau in Phasen

Jede Phase ist für sich lieferbar und lässt das System lauffähig.

### Phase 0 — Dubletten zusammenführen

Klein, aber Voraussetzung. Solange die Coin-Formel und die Kommando-Whitelists
doppelt gepflegt sind, driftet der Umbau zwangsläufig auseinander.

- Coin-Formel aus `giveaway-test.js` entfernen, stattdessen den echten Wert vom
  Server holen. Die dortige `SECS_PER_COIN = 7200` widerspricht heute schon der
  per Team konfigurierbaren Basis — die Test-Console rechnet also falsch, sobald
  ein Team etwas anderes eingestellt hat.
- `ALLOWED_EVENTS`/`ALLOWED_CMDS` und `auditSummary()` in **eine** Datei, von
  beiden Shared-Libs geladen.
- Die C#-Actions liegen byte-identisch in zwei Verzeichnissen. Eines wird zur
  Quelle, das andere entfällt oder wird beim Bauen kopiert.

**Abnahmekriterium:** jede dieser Definitionen existiert genau einmal im Repo.

### Phase 1 — Core-Vertrag, ohne Verhaltensänderung

Die heutige Mechanik wird als `CORE_WatchtimeChatActivity` hinter den Vertrag
aus Abschnitt 4 gezogen. Kein neues Verhalten, keine neuen Schlüssel, keine
Oberflächenänderung.

Reihenfolge innerhalb der Phase, vom Kern nach aussen:

1. `coinsFromSec`, `countWords`, `getUserAggregate` und die zwölf
   Konfigurations-Methoden in den Core verschieben. `getUserAggregate` ist der
   Dreh- und Angelpunkt — sie definiert in `watchtime.js:414`, was `eligible`
   bedeutet, und wird von Panel, `!los`, Statusseite und Ziehung gelesen.
2. `drawWinner` aufteilen: Pool-Bildung (Filter + Gewicht) geht in den Core,
   Zufall, Snapshot und Persistenz bleiben in der Engine.
3. `tickPresentUsers` und `handleChatMessage` auf `delta`-Rückgaben umstellen,
   das Schreiben von `watchtime_events` zentralisieren.
4. `chat-ai.js` dem Core zuordnen.
5. Die hartcodierten Regeltexte für `!los` und `!giveaway` in `statusText`/
   `infoText` des Cores verschieben.

**Abnahmekriterium:** die bestehenden 45 Tests laufen unverändert durch, und ein
neuer Test spielt dieselbe Ereignisfolge gegen alte und neue Implementierung und
vergleicht Coins, Berechtigung und Pool-Gewichte auf exakte Gleichheit.

Das ist die risikoärmste und wichtigste Phase: ist sie sauber, sind alle
folgenden Cores additiv. Sie ändert für Zuschauer und Veranstalter **nichts**
und gehört deshalb nicht ins Änderungsprotokoll.

### Phase 2 — Giveaway-Dimension

Schlüssel um `g:<giveawayId>` erweitern, Ingest-Verteilung auf n Empfänger,
Giveaway-Auswahl im Panel. Altbestand über Fallback auf die alten Schlüssel,
damit ein laufendes Giveaway den Deploy übersteht.

Betroffen sind nur die zehn mechanikbezogenen Schlüssel; die neunzehn
generischen bleiben team-weit. Streamerbot bleibt unangetastet, weil die
Zuordnung Ereignis → Giveaway serverseitig aus der Kanalliste entsteht.

**Abnahmekriterium:** zwei Giveaways desselben Teams laufen gleichzeitig mit
getrennten Ständen; ein `viewer_tick` erhöht beide. Ein vor dem Deploy
geöffnetes Giveaway läuft ohne Datenverlust weiter.

### Phase 3 — CORE_CurrentViewers

Der einfachste neue Core: kein Guthaben, kein Preis-Modell, gleiches Gewicht für
alle. Guter erster Beweis, dass der Vertrag trägt — und der erste, der die
Parallelität aus Phase 2 wirklich braucht.

### Phase 4 — CORE_TicketBuy

Preis-Entität, Einsatz-Oberfläche, Abbuchung. Der aufwendigste Core, weil er als
einziger neue Zuschauer-Interaktion braucht.

### Phase 5 — Recht und Texte je Core

Teilnahmebedingungen und Datenschutzerklärung nennen die Mechanik. Jeder Core
braucht seinen Textbaustein — insbesondere `CORE_TicketBuy` (Einsatz verfällt)
und `CORE_CurrentViewers` (keine Vorleistung, reine Anwesenheit).
`TOS_VERSION` an beiden Stellen erhöhen.

---

## 9 Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Der Umbau ändert unbemerkt das Verhalten der laufenden Kampagne. | Phase 1 mit Gleichheitstest gegen den Ist-Zustand, kein Deploy während einer laufenden Ziehung. |
| Ein Core schreibt an der Protokollierung vorbei. | Cores bekommen keinen Schreibzugriff auf Postgres. Ereignisse werden beschrieben, geschrieben wird in der Engine. |
| Redis-Last vervielfacht sich mit der Zahl paralleler Giveaways. | Ereignisse einmal lesen, an alle Cores verteilen. Obergrenze für gleichzeitige Giveaways je Team. |
| Zuschauer verstehen nicht mehr, an welchem Giveaway sie teilnehmen. | Jede Chat-Ansage nennt das Giveaway; `!los` zeigt alle laufenden mit eigenem Stand. |
| `CORE_TicketBuy` wird als Verkauf gelesen. | Einsatz ausschließlich aus erspielter Zeit, Gewinn per gewichtetem Zufall, kein Höchstgebot. Ausdrücklich in den Teilnahmebedingungen. |
| Sofortverlosung zieht leer, weil der Ingest hängt. | Core prüft, ob überhaupt Anwesenheitsmeldungen ankommen, und bricht mit klarer Meldung ab. |
| Das Admin-Panel bleibt auf Coins verdrahtet und passt zu keinem neuen Core. | Ein Core liefert seine Anzeigespalten und Konfigurationsfelder aus `config` und `getParticipant().detail` mit; das Panel rendert generisch, statt Coin-Spalten hartzucodieren. |
| Die Zerlegung wird währenddessen von neuen Funktionen überholt. | Phasen 0 und 1 ändern kein Verhalten und sind in Tagen, nicht Wochen fertig. Erst danach neue Cores. |

---

## 10 Offene Punkte

Vor Beginn von Phase 4 zu entscheiden:

1. Verfällt ungenutztes Guthaben bei `CORE_TicketBuy` am Kampagnenende?
2. Obergrenze für gleichzeitig laufende Giveaways je Team?
3. Setzen bei `CORE_TicketBuy` über eine Webseite, über Chatbefehl, oder beides?
4. Darf ein Zuschauer bei mehreren parallelen Giveaways desselben Teams
   gleichzeitig gewinnen, oder schließt ein Gewinn die anderen aus?
