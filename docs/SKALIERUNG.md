# Skalierung: was heute schon offen bleibt

**Stand 10. August 2026.** Der Zielbetrieb ist und bleibt der Docker-Compose-Stack
auf einem Host. Dieses Dokument ist kein Umbauplan, sondern die Liste der
Entscheidungen, die verhindern, dass ein spaeterer Umbau teuer wird. Wer hier
etwas aufweicht, zahlt es spaeter als Refactoring.

Kurzfassung: **Kubernetes loest keinen einzigen der heutigen Engpaesse.** Die
Decke liegt in der Buchungsschleife und im Journal, nicht in der Anzahl der
Prozesse. Erst wenn beides steht, bringt Replikation ueberhaupt etwas.

---

## 1 Was heute Replikation verbietet

| Ort | Verhalten bei mehreren Instanzen |
|---|---|
| Ticker `setInterval(TICK_SEC)`, `services/giveaway/server.js` | N Instanzen = N-fache Coins je Zuschauer. Fairness kaputt. |
| Sofort-Fenster-Watcher (5 s), `server.js` | N-faches Schliessen, N-fache Chat-Ansage. |
| `runRetention` (taeglich), `server.js` | N-fache Anonymisierung. Harmlos, aber sinnlos. |
| `ch:giveaway` als Pub/Sub, `server.js` | Pub/Sub geht an ALLE Abonnenten: jede Instanz bucht jedes Ereignis noch einmal. |
| `clients`-Map + `broadcastTeam`, `server.js` | Panel-Ereignisse erreichen nur die Instanz, an der der Browser haengt. |
| Prozess-Caches (`aiCfgCache`, `boostAnnounced`, `ban-cache.js`) | Driften auseinander; ein Bann wirkt auf einer Instanz spaeter. |

Punkte 1 bis 3 sind ab sofort ueber `RUN_SCHEDULER` entschaerft, Punkt 4 ist
gekapselt, Punkt 5 ist erledigt (siehe Abschnitt 3).

## 2 Die eigentliche Decke: Buchung und Journal

`tickPresentUsers()` in `services/giveaway/watchtime.js` macht je Zuschauer und
Tick **nacheinander** `GET banned`, `GET present`, `GET follows`,
`INCRBYFLOAT` und danach `_logEvent()` als einzelnes `INSERT`.

Gerechnet auf 100.000 gleichzeitige Zuschauer bei `TICK_SEC=60`:

| Groesse | Wert | Folge |
|---|---|---|
| Redis-Kommandos je Tick | 400.000 bis 500.000, seriell | bei 0,2 ms Umlauf 80 bis 100 s fuer ein 60-s-Fenster: der Tick wird nie fertig |
| Postgres-Inserts | rund 1.700/s einzeln | saettigt die Primary lange vor der CPU |
| `watchtime_events` | rund 144 Mio. Zeilen/Tag, grob 20 GB/Tag mit Index | ohne Partitionierung in Wochen unbedienbar |

Das gilt fuer einen Prozess wie fuer hundert. Die Gegenmittel stehen in
Abschnitt 5 und sind bewusst noch nicht umgesetzt, weil sie den Schreibpfad des
Nachweises anfassen.

Zur Einordnung: 100.000 gleichzeitige Zuschauer sind grob 2.000 bis 5.000
laufende Kanaele. Der Ingest ist **je Kanal gebuendelt**, nicht je Zuschauer —
netzwerkseitig sind das ein paar tausend WS-Verbindungen und einige hundert
Nachrichten je Sekunde. Die Last steckt fast vollstaendig in Buchung und
Journal.

## 3 Was bereits offen gehalten ist

1. **`RUN_SCHEDULER`** (`docker-compose.yml`, Default `true`). Ticker,
   Sofort-Watcher und Retention laufen nur, wenn das Flag gesetzt ist. Bei
   Replikation bekommt genau eine Instanz `true`, alle weiteren `false`. Ohne
   dieses Flag waere die Trennung ein Eingriff mitten im HTTP/WS-Prozess.
2. **`broadcastTeam` ueber Redis** (`ch:panel`). Die Funktion veroeffentlicht,
   jede Instanz stellt an ihre eigenen Browser zu (`deliverToPanels`). Bei einem
   Container derselbe Weg mit einem Hop mehr; bei mehreren funktioniert es ohne
   Sticky Sessions, weil die Anmeldung ohnehin ein HMAC-Cookie ist.
   Fire-and-forget: das Panel frischt zyklisch nach, ein verlorener Hinweis ist
   kein Datenverlust.
3. **`consumeIngest(handler)`** kapselt den Transport der Ingest-Ereignisse.
   Heute Redis Pub/Sub. Der Wechsel auf Redis Streams mit Consumer-Group ist
   damit ein Eingriff an einer Stelle statt einer Suche durch 3.800 Zeilen.
4. **`msg.evId` im bridge** (Kanal + Zeit + Zaehler). Heute Diagnose. Sobald die
   Zustellung "mindestens einmal" wird, ist Deduplizierung moeglich, ohne dass
   Buchungen doppelt laufen.

## 4 Regeln, die ab jetzt gelten

- **Kein neuer Zustand im Prozess ohne TTL und Invalidierung.** Wer einen Cache
  braucht, gibt ihm eine Verfallszeit und einen Weg, ihn zu verwerfen.
- **"Erster gewinnt" nie ueber die Reihenfolge in JavaScript.** Immer
  DB-Constraint oder `pg_advisory_xact_lock`. Gilt fuer den Los-Einsatz, fuer
  die Ziehung und fuer den geplanten Quiz-Punkt.
- **Redis-Schluessel eines Teams gehoeren zusammen.** Wird das Schluesselschema
  ohnehin einmal angefasst: `t:{team}:…` mit geschweiften Klammern. Fuer ein
  einzelnes Redis bedeutungslos, im Cluster die Voraussetzung dafuer, dass
  Team-Operationen im selben Slot landen. Nachtraeglich ist es eine Migration
  des Live-Zustands. **Entscheidung 10.8.26: bewusst noch nicht umgestellt.**
- **Die Engine bleibt frei von HTTP und WS.** `watchtime.js` kennt weder das
  eine noch das andere. Genau das macht einen spaeteren Schnitt in Worker und
  Gateway ueberhaupt moeglich.
- **Zeitgeber gehoeren hinter `RUN_SCHEDULER`.** Neue periodische Aufgabe? Dann
  in denselben Block, nicht als freies `setInterval` irgendwo im Modul.

## 5 Bewusst aufgeschoben

| Massnahme | Warum noch nicht |
|---|---|
| Redis-Pipelining in `tickPresentUsers` | reine Leistungsfrage, kein Verhalten; lohnt erst mit echter Last |
| Journal puffern (Mehrzeilen-`INSERT` statt `_logEvent` je Nutzer) | aendert die Schreibreihenfolge des Nachweises, braucht Tests |
| `watchtime_events` nach Monat partitionieren | zusammen mit dem Puffer, in einem Durchgang |
| Redis Streams mit Consumer-Group | erst noetig, wenn mehr als eine Instanz bucht |
| Redis Cluster, PG-Read-Replicas | erst noetig, wenn eine Maschine nicht mehr reicht |
| Aufteilung in ingest-gw / accrual-worker / ws-gw / api / scheduler | Betriebsaufwand ohne Gegenwert, solange ein Host genuegt |

## 6 Zielbild, falls es je gebraucht wird

```
Streamerbot ──► ingest-gw (N)  ──XADD──► Stream ev:<team>
                                              │ Consumer-Group
                                              ▼
                                     accrual-worker (N)  ──► Redis + PG
                                              │
                          ch:panel (Pub/Sub) ──► ws-gw (N) ──► Panel
                                     api (N, zustandslos)
                                     scheduler (1, Leader-Lease)
```

- Partitionsschluessel ist **die Team-Kennung**, weil alle Regeln team-weit
  sind: kein zweiter Worker fasst denselben Nutzer gleichzeitig an, die
  Reihenfolge je Nutzer bleibt erhalten.
- Der feste Ticker faellt ersatzlos weg. Statt "alle 60 s alle Zuschauer
  durchlaufen" rechnet der Worker die Zeit aus dem Ereignis
  (`delta = min(now - lastTick, cap)`). Damit gibt es keinen globalen Zeitgeber
  mehr und die Last verteilt sich ueber die Minute statt in einer Spitze.
- **Die Ziehung ist die heikle Stelle.** Der Snapshot muss einen konsistenten
  Stand sehen. Sauber: Giveaway kurz stillstellen, Worker bestaetigen Lag 0 fuer
  die Partition, dann zieht die Engine. Sonst landet ein unverarbeiteter Tick
  nach dem Snapshot und der Nachweis passt nicht zum Endstand.
- Skaliert wird auf **Stream-Lag**, nicht auf CPU.
