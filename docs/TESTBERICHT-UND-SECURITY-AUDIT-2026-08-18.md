# Testbericht und Security-Audit

Datum: 18. August 2026  
Repository: `CC-Giveaway`  
Pruefstand: aktueller lokaler Working Tree

## 1. Ergebnis

| Bereich | Ergebnis | FAIL REASON |
|---|---|---|
| Giveaway Node-Testpaket | PASS | - |
| Admin Node-Testpaket | PASS | - |
| JavaScript-Syntaxpruefung | PASS | - |
| Browser-Testkonsole | FAIL | Die 17 Browser-Tests sind vorhanden, werden aber von keinem `npm test`-Skript ausgefuehrt und wurden daher nicht automatisiert gegen einen Browser/DOM verifiziert. |
| End-to-End-/Infrastrukturtests | FAIL | Es gibt keine automatisierten Tests ueber Caddy, echte WebSockets, Redis und PostgreSQL hinweg. Proxy-Header, Auth-Gates, Migrationen und Transaktionen werden damit nicht als Gesamtsystem geprueft. |
| CORE_WatchtimeChatActivity | PASS | - |
| CORE_CurrentViewers | PASS | - |
| CORE_TicketBuy | PASS | - |
| CORE_ScreenshotContest | PASS | - |
| Dokumentierter CORE_Quiz | FAIL | In `docs/ARCHITEKTUR-CORES.md` ausdruecklich als „geplant“ beschrieben; kein Modul, kein Registry-Eintrag und keine Tests vorhanden. Kein Fehler der vier als implementiert ausgewiesenen Cores, aber noch keine pruefbare Mechanik. |
| Security-Audit gesamt | FAIL | Mehrere Hardening- und Testluecken; Details in Abschnitt 5. |

Automatisches Ergebnis:

- Giveaway: **147 PASS / 0 FAIL / 0 SKIP**
- Admin: **18 PASS / 0 FAIL / 0 SKIP**
- Gesamt Node: **165 PASS / 0 FAIL / 0 SKIP**
- Syntax: **52/52 JavaScript-Dateien PASS** (ohne den unversionierten `blog/`-Baum)
- Dependency Audit: **0 bekannte Schwachstellen** in beiden installierten Dependency-Baeumen (`npm audit --omit=dev`)

## 2. Umfang und Methode

Geprueft wurden alle durch Git versionierten Projektdateien: Services, Cores, Tests, Browser-Code, Caddy-, Docker-, PostgreSQL-, Backup-, Streamerbot- und Projektdokumentation. Der lokale Ordner `blog/` ist unversioniert (`git status: ?? blog/`) und fachlich ein separates Next.js-Blog; er ist nicht Bestandteil dieses Repository-Pruefstands.

Ausgefuehrte Pruefungen:

1. `npm test` in `services/giveaway`
2. `npm test` in `services/admin`
3. `node --check` fuer alle produktiven `.js`-Dateien ausserhalb `blog/`
4. Abgleich der vier Core-Module mit Registry, Engine-Aufrufen, Dokumentation und vorhandenen Tests
5. Statische Pruefung der Authentisierung, Autorisierung, Eingabevalidierung, SQL-Nutzung, Uploads, WebSockets, Proxy-Konfiguration, Secrets und Container-Konfiguration
6. `npm audit --omit=dev` fuer Giveaway und Admin

Nicht ausgefuehrt wurden ein produktionsnaher Docker-E2E-Lauf, echte Twitch-/Discord-/KI-Aufrufe und aktive Penetrationstests gegen eine laufende Instanz.

## 3. Bewertung der Testfaelle

| Prueffeld | Ergebnis | FAIL REASON / Bewertung |
|---|---|---|
| Fachliche Kernlogik der Kampagne | PASS | Alte Aggregationslogik wird gegen den extrahierten Core verglichen; Berechtigung, Gewicht, Chat-Regel, Multiplikator und Konfiguration sind abgebildet. |
| Multi-Giveaway-Isolation | PASS | Tests pruefen getrennte Staende, Keywords, Pausen, Kanaele, Ziehungen und Cleanup. |
| Sofortverlosung | PASS | Anwesenheitsfenster, Follow/Viewtime-Gates, leere Ziehung, Unabhaengigkeit und Lifecycle sind abgebildet. |
| TicketBuy | PASS | Earn/Settlement, Guthaben, Einsatz, Ruecknahme, Parallelbetrieb, Preisbindung, Opt-in und Doppelruecknahme sind abgebildet. |
| Screenshot-Contest | PASS | Einreichungs-Gates, Ersetzen/Zurueckziehen, Voting-Zustaende, Re-Vote, Gleichstand und Owner-Loeschung sind abgebildet. |
| Ziehungs-/Claim-Regeln | PASS | Reroll-Sperren und Claim-Zustaende sind als reine Regeln getestet. |
| Terms, Tar-Export, Credit-Ledger, AI | PASS | Wesentliche Positiv-, Fehler- und Randfaelle vorhanden. |
| Admin-Authentisierung | PASS | Signatur, Manipulation, Ablauf, Cookies und Passwort-Hashing sind als Unit-Tests vorhanden. |
| HTTP-Autorisierung pro Route | FAIL | Keine automatisierten Requests testen 401/403/Owner/Member/Superadmin ueber die realen Express-Routen. |
| WebSocket-Autorisierung | FAIL | Keine Integrationstests fuer `X-Auth-User`, Team-Zuordnung, Rollen und unerlaubte Commands. |
| Datenbankmigrationen und Transaktionen | FAIL | In-Memory-Fakes decken Logik gut ab, aber Constraints, Locks, Rollbacks und parallele Requests gegen echtes PostgreSQL fehlen. |
| Caddy-Auth-Vertrag | FAIL | Kein Test beweist, dass eingehende Identitaetsheader entfernt/ueberschrieben und alle privaten Pfade vom `forward_auth`-Matcher erfasst werden. |
| Browser/UI | FAIL | 17 Tests existieren nur in einer manuellen HTML-Testkonsole; kein CI-/CLI-Lauf. |

Die vorhandenen Tests sind fuer die isolierte Fachlogik ueberwiegend korrekt und sinnvoll. Die groesste Abbildungsluecke liegt nicht in den vier Core-Regeln, sondern an den Systemgrenzen.

### Nachtrag: automatisierte Negativtests

Am 18. August 2026 wurden acht zusaetzliche Negativ-/Regressionstests ergaenzt:

- Session-Token mit zusaetzlichem Segment oder leerer Signatur werden abgewiesen.
- Fehlerhaftes Prozent-Encoding in Cookies loest keinen Parser-Abbruch aus.
- Core-IDs aus der JavaScript-Prototypenkette (`__proto__`, `constructor`) werden nicht aufgeloest.
- Sofortverlosung sperrt unregistrierte, gebannte und unqualifizierte Nutzer.
- TicketBuy verwirft negative, partielle, mehrdeutige und nicht sichere Ganzzahlen.
- TicketBuy-Pools enthalten keine Null- oder Negativ-Einsaetze.
- Contest-Votes akzeptieren nur vollstaendige, endliche Ganzzahlen.
- Contest-Pools ignorieren ungepruefte und unbewertete Einreichungen.

Die Tests deckten vier reale Parser-/Registry-Fehler auf, die im selben Schritt behoben wurden: Token mit drittem Segment, Cookie-Parser-Abbruch, Prototypenauflösung in der Core-Registry und partielle Zahlen bei Einsatz/Vote.

## 4. CORE-Mechaniken einzeln

### CORE_WatchtimeChatActivity — PASS

- Viewtime und sinnvoller Chat erzeugen Sekunden; Coins werden aus der konfigurierten Basis berechnet.
- Registrierung, Bann, Follow-Minimum und mindestens ein Coin bestimmen die Berechtigung.
- Poolgewicht entspricht den Coins.
- Multi-Giveaway-Trennung, Multiplier, Backup/Restore und Legacy-Migration sind getestet.

### CORE_CurrentViewers — PASS

- Kein eigenes Watchtime-Accrual.
- Teilnahme nur im offenen Keyword-Fenster und mit gemeldeter Praesenz; konfigurierte Follow-/Viewtime-Gates bleiben aktiv.
- Gleiche Chance (`weight = 1`) fuer alle Berechtigten.
- Leerer Pool wird ohne Ziehung beendet; Cleanup und wiederholte Fenster sind getestet.

### CORE_TicketBuy — PASS

- Watchtime erzeugt teamweites Los-Guthaben; beim Schliessen wird in das Ledger gebucht.
- Einsaetze sind preis- und instanzbezogen; Ziehungsgewicht entspricht dem Einsatz.
- Guthabenpruefung, Ruecknahme, Storno-Erstattung, parallele Instanzen und Opt-in sind getestet.
- Die Transaktionslogik ist nur mit Fakes getestet; fuer die produktive Konkurrenzsicherheit bleibt ein PostgreSQL-Integrationstest erforderlich.

### CORE_ScreenshotContest — PASS

- Einreichung erfordert Follow und Mindest-Viewtime; eine Einreichung pro Person, Ersetzen ist moeglich.
- Voting nutzt 1–10 Punkte, eine Stimme je Voter und Einreichung; Re-Vote ersetzt die vorige Wertung.
- Hoechste Punktsumme gewinnt, bei Gleichstand entscheidet die gemeinsame Ziehungsengine.
- Upload-/Bildvalidierung wird im Server implementiert, aber nicht mit echten HTTP-Uploads und Bilddateien automatisiert getestet.

## 5. Security-Audit

### SEC-01 — HIGH — FAIL: PostgreSQL laeuft privilegiert

`docker-compose.yml` setzt fuer den PostgreSQL-Container `privileged: true`. Damit erhaelt ein datenhaltender Netzwerkdienst weit mehr Host-Rechte als erforderlich.

**FAIL REASON:** Unnoetig grosser Blast Radius bei Container-Kompromittierung.  
**Empfehlung:** `privileged: true` entfernen; benoetigte LXC-/Storage-Sonderfaelle gezielt dokumentieren und nur minimale Capabilities vergeben.

### SEC-02 — HIGH — FAIL: Unsichere produktionsfaehige Default-Passwoerter

PostgreSQL faellt auf `changeme`, Redis Commander auf `crewpassword` zurueck. Der Admin-Service akzeptiert ebenfalls `changeme` als DB-Fallback.

**FAIL REASON:** Fehlkonfiguration fuehrt zu bekannten Zugangsdaten statt zu einem sicheren Startabbruch.  
**Empfehlung:** In Team/Production-Compose `${VAR:?must be set}` verwenden und den Service bei fehlenden Secrets fail-closed starten lassen.

### SEC-03 — MEDIUM — FAIL: Proxy-Identitaet ist nicht integration-getestet

Der Giveaway-Service vertraut fuer REST und WebSocket vollstaendig auf `X-Auth-User`. Das ist nur sicher, solange er ausschliesslich intern erreichbar ist und Caddy jeden Client-Header sicher ueberschreibt. Derzeit gibt es dafuer keinen automatisierten Test.

**FAIL REASON:** Ein Konfigurationsfehler oder spaeteres direktes Port-Publishing wuerde Identitaets-Spoofing ermoeglichen.  
**Empfehlung:** Header am Proxy explizit loeschen, danach nur das Ergebnis von `forward_auth` setzen; direkten Servicezugriff blockieren; E2E-Negativtest mit gefaelschtem Header ergaenzen.

### SEC-04 — MEDIUM — FAIL: Giveaway setzt weiterhin Wildcard-CORS

`services/giveaway/server.js` sendet `Access-Control-Allow-Origin: *`, waehrend `caddy/Caddyfile.team` ausdruecklich dokumentiert, dass kein CORS-Freibrief mehr gewollt ist.

**FAIL REASON:** Code und Sicherheitskonzept widersprechen sich; bei direktem Servicezugriff oder geaenderter Proxy-Konfiguration wird die API unnötig cross-origin lesbar.  
**Empfehlung:** Middleware entfernen oder auf eine feste Origin begrenzen und einen Header-Test ergaenzen.

### SEC-05 — MEDIUM — FAIL: Keine reproduzierbaren Lockfiles im Repository

`package-lock.json` ist global ignoriert und kein Lockfile ist versioniert. Die Docker-Builds koennen daher bei identischem Commit unterschiedliche transitive Versionen installieren.

**FAIL REASON:** Supply-Chain-Stand ist nicht reproduzierbar; ein spaeter kompromittiertes oder fehlerhaftes transitives Release kann ungeprueft einlaufen.  
**Empfehlung:** Lockfiles je Service versionieren und in Docker `npm ci --omit=dev` verwenden.

### SEC-06 — MEDIUM — FAIL: Security-Grenzen ohne automatisierte Negativtests

Es fehlen Route-/Proxy-/WebSocket-Tests fuer CSRF-nahe Zustandsaenderungen, Rolleneskalation, Fremdteam-Zugriff, gefaelschte Header, grosse Payloads und konkurrierende Einsaetze/Votes.

**FAIL REASON:** Die Logik wirkt an vielen Stellen defensiv, Regressionen an den wichtigsten Trust Boundaries werden aber nicht erkannt.  
**Empfehlung:** Supertest-/WS-Integrationstests plus einen Caddy-E2E-Test in CI aufnehmen.

### Positive Security-Befunde — PASS

- SQL-Werte werden im geprueften Anwendungscode ueberwiegend parametrisiert.
- Session-Cookies sind `HttpOnly`, `SameSite=Lax` und standardmaessig `Secure`; HMAC-Vergleich ist timing-safe.
- Twitch OAuth verwendet signierten State und begrenzt Redirects auf interne Pfade.
- Ingest leitet Team/Kanal aus einem Token ab statt aus dem Payload und hat Payload-/Rate-/Unauthenticated-Limits.
- Interne Endpunkte sind ohne `INTERNAL_API_KEY` fail-closed.
- Uploads haben Body-, Magic-Byte- und Dimensionspruefungen im Servercode.
- Caddy setzt HSTS, CSP, `nosniff`, Frame-, Referrer- und Permissions-Policy.
- Keine `.env`-Datei ist versioniert; der lokale Secret-Stand wurde nicht in den Bericht uebernommen.
- Der aktuelle installierte Dependency-Stand meldet in `npm audit` 0 bekannte Schwachstellen.

## 6. Priorisierte Folgemassnahmen

1. `privileged: true` entfernen und Default-Secrets in Production fail-closed machen.
2. CORS-Wildcard entfernen und den Caddy-/Header-Vertrag als E2E-Test absichern.
3. Lockfiles versionieren und Docker auf `npm ci` umstellen.
4. Express-/WebSocket-Integrationstests fuer Auth, Rollen, Fremdteams und Parallelzugriffe ergaenzen.
5. Die 17 Browser-Tests in einen automatisierten Runner integrieren.
6. Fuer TicketBuy und Contest echte PostgreSQL-Konkurrenztests sowie Uploadtests ergaenzen.
