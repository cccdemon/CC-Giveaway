# Navigation & Informationsarchitektur — Umsetzungsplan

**Spec:** `docs/UI-UX-MENUE-REVIEW-FUER-CLAUDE-OPUS.md` (18.8.26)
**Ziel:** Eine gemeinsame, rollenbezogene, aufgabenorientierte Navigation statt zwei
duplizierter Implementierungen mit flachem 14-Punkte-`TOOLS`.
**Nicht im Scope:** Farben, Typografie, Abstaende, Brandkit.

## Ist-Zustand (geprueft am Code, nicht am Review)

- `services/admin/public/admin-shared.js:187-338` und
  `services/giveaway/public/giveaway-shared.js:255-350` enthalten dieselbe Nav
  **zweimal wortgleich** (PRIMARY, TOOLS, ADMIN_MENU, Markup, Dropdown-Logik).
  Einziger Unterschied: admin-Version hat 3 TOOLS-Eintraege mehr
  (`nutzungsbedingungen`, `meine-daten`, `haftungsausschluss`) — die Nav ist also
  je nach Seite bereits heute **verschieden**.
- `services/admin/public/doku.html` laedt **beide** Shared-Libs → zwei Navs.
- **Eingeloggte Seiten ganz ohne Nav (Sackgassen):** `meine-daten.html`,
  `setup.html`, `status.html` (`/viewer/status`) laden nur `rdoc-theme.js`.
- Aktivmarkierung: `isCur()` vergleicht exakt den Pfad, gilt nur fuer die 3
  Primaerpunkte. Dropdown-Eintraege und `TOOLS` selbst werden nie aktiv.
- Rollen: nur `superadmin` (CSS-Klasse `gwnav-adminonly`). Team-Zugehoerigkeit
  ist der Nav unbekannt — `/auth/me` (`services/admin/server.js:144-149`) liefert
  nur `{user, role}`.
- Startseiten konkurrieren: Brand → `/admin/` (Control Center: 4 Kacheln, davon 3
  superadmin-only), Login-Default → `/admin/teams.html`
  (`services/admin/server.js:318,323`), Primaerpunkt DASHBOARD → Giveaway-Panel.
- Mobile: `rdoc.css:496` blendet unter 680px nur Labels aus — kein Drawer.
- a11y: Dropdown-Trigger sind `div` mit Click-Handler, kein `aria-expanded`,
  kein Escape, kein `aria-current`.
- **Sicherheitsluecke (Fund waehrend der Analyse):** die `@superadmin`-Liste in
  `caddy/Caddyfile.team:60` schuetzt nur `/admin/platform.html`,
  `/admin/betrieb.html`, `/admin/betrieb.js`. Die ebenfalls superadmin-only
  gemeinten Seiten `/admin/users.html`, `/admin/datenschutz-admin.html`,
  `/admin/giveaway-test.html`, `/admin/tests/*` liegen NICHT darin — dort reicht
  ein normaler Login fuer die Seite (die APIs dahinter pruefen weiter
  `requireSuperadmin`).

## Route-zu-Menue-Matrix

Legende Sichtbarkeit: `all` = jede eingeloggte Person · `org` = Mitglied in >=1 Team ·
`sa` = Superadmin · `pub` = auch ohne Login erreichbar.

| Route | Bereich | Unterpunkt | Sicht |
|---|---|---|---|
| `/giveaway/giveaway-admin.html` | GIVEAWAYS | Uebersicht | org, sa |
| `/giveaway/claims.html` | GIVEAWAYS | Gewinne abwickeln | org |
| `/giveaway/archive.html` | GIVEAWAYS | Archiv | org |
| `/giveaway/audit.html` | GIVEAWAYS | Protokoll | org |
| `/admin/teams.html` | TEAM | Meine Teams | all |
| `/admin/setup.html` | TEAM | Streamerbot einrichten | all, pub |
| `/viewer/status`, `/admin/status.html` | TEILNEHMEN | Meine Teilnahmen | all |
| `/giveaway/claim.html` | TEILNEHMEN | Gewinn melden | all |
| `/giveaway/wager.html` | TEILNEHMEN | Lose setzen | all |
| `/giveaway/contest.html` | TEILNEHMEN | Screenshot-Contest | all |
| `/admin/meine-daten.html` | TEILNEHMEN | Meine Daten | all |
| `/viewer/help`, `/admin/help.html` | HILFE | Anleitung | all, pub |
| `/admin/funktionsweise.html` | HILFE | So funktioniert es | all, pub |
| `/admin/feedback.html` | HILFE | Fehler melden & Idee | all |
| `/admin/doku.html` | HILFE | Technische Dokumentation | all |
| `/admin/nutzungsbedingungen.html` | HILFE › Rechtliches & Info | Nutzungsbedingungen | all, pub |
| `/admin/datenschutz.html` | HILFE › Rechtliches & Info | Datenschutz | all, pub |
| `/admin/haftungsausschluss.html` | HILFE › Rechtliches & Info | Haftungsausschluss | all, pub |
| `/admin/impressum.html` | HILFE › Rechtliches & Info | Impressum | all, pub |
| `/admin/changelog.html` | HILFE › Rechtliches & Info | Aenderungsprotokoll | all, pub |
| `/admin/roadmap.html` | HILFE › Rechtliches & Info | Roadmap | all, pub |
| `/admin/platform.html` | PLATTFORM | Plattform-Verwaltung | sa |
| `/admin/betrieb.html` | PLATTFORM | Betrieb & Diagnose | sa |
| `/admin/users.html` | PLATTFORM | Benutzer | sa |
| `/admin/datenschutz-admin.html` | PLATTFORM | Betroffenenrechte | sa |
| `/admin/index.html` | PLATTFORM › Diagnose | Control Center | sa |
| `/admin/giveaway-test.html` | PLATTFORM › Diagnose | Test Console | sa |
| `/admin/tests/test-runner.html` | PLATTFORM › Diagnose | Test Suite | sa |
| `/`, `/admin/home.html` | — (Landing, keine App-Nav) | — | pub |
| `/admin/login.html`, `/admin/join.html` | — (Einstieg, keine Nav) | — | pub |
| `/viewer/terms`, `/admin/terms.html` | — (Teilnahmebedingungen je Team, kontextfrei) | — | pub |

Kein Dropdown hat mehr als sieben ungruppierte Ziele (HILFE nutzt die Gruppe
„Rechtliches & Info").

## Stand der Umsetzung (21.8.26)

Tasks 1-5 sind umgesetzt und getestet (`services/admin/tests/nav.test.js`,
10 Tests: Rollenmatrix, aktive Pfade, Alias-Routen, unbekannte Pfade,
Dropdown-Groesse, Startseite). Task 6 bleibt bewusst offen.

## Aufgaben

### Task 1 — Zentrale Navigationsquelle `services/admin/public/nav.js`
Datenstruktur (`id`, `label`, `href`, `icon`, `audience`, `activePaths`) + Rendering +
Dropdown-Logik + Mobile-Drawer + a11y an EINER Stelle. Beide Shared-Libs verlieren
ihren Nav-Block und laden stattdessen `/admin/nav.js`.
Testbar: `tests/nav.test.js` (pure Funktionen `visibleSections`, `activeFor`).

### Task 2 — Rollenquelle: `/auth/me` um `teams` erweitern
`services/admin/server.js:144` liefert zusaetzlich `teams: <Anzahl Mitgliedschaften>`.
Ohne Team → Veranstalter-Bereiche werden ausgeblendet.

### Task 3 — Nav auf allen eingeloggten Seiten
`meine-daten.html`, `setup.html`, `status.html` laden `nav.js`;
`doku.html` verliert die doppelte Lib. `/admin/nav.js` in die Caddy-Public-Whitelist
(analog `rdoc-theme.js`), damit auch oeffentliche Seiten dieselbe Nav zeigen.

### Task 4 — Startseite je Rolle
Login-Default: Veranstalter → `/giveaway/giveaway-admin.html`, sonst
`/viewer/status`. Brand-Link zeigt auf dieselbe Startseite; `/admin/` wird
Superadmin-Werkzeug (Eintrag unter PLATTFORM › Diagnose).

### Task 5 — Caddy-Superadmin-Liste vervollstaendigen
`/admin/users.html`, `/admin/datenschutz-admin.html`, `/admin/giveaway-test.html`,
`/admin/tests/*` in `@superadmin path` aufnehmen (Haertung, kein Abschwaechen).

### Task 6 (separat, NICHT in diesem Durchgang)
Dashboard-interne Hierarchie / Aufloesung des Tabs `VERWALTUNG` und
Lifecycle-Schrittindikator. Grund: der Tab wurde am 18.8.26 frisch gebaut
(`892e345`); ein Umbau gehoert abgestimmt, nicht nebenbei.


## Ergebnis

- `services/admin/public/nav.js` ist die einzige Nav-Implementierung; beide
  Shared-Libs laden sie nur noch nach (Loader mit Node-Guard, weil
  `tests/audit-summary.test.js` die Lib in Node importiert).
- `/auth/me` liefert `teams`; Sektion GIVEAWAYS erscheint nur mit Team
  (oder als Superadmin).
- Aktive Markierung: Bereich + Unterpunkt, `aria-current="page"`, Alias-Routen
  ueber `activePaths` (`/viewer/status` = `/admin/status.html`).
- Mobil (<=680px): Menue-Knopf + Drawer mit Akkordeon und sichtbaren Labels
  statt nur ausgeblendeter Beschriftungen.
- a11y: `<button>`-Trigger mit `aria-expanded`/`aria-controls`, Escape schliesst
  und gibt den Fokus zurueck, Pfeiltasten laufen durch die Eintraege,
  Logout hat einen dauerhaften Namen.
- Sackgassen beseitigt: `meine-daten`, `setup`, `status` und die acht
  Rechtstext-/Hilfeseiten haben jetzt dieselbe Navigation. `pub-doc.js` montiert
  seinen Theme-Umschalter nur noch, wenn keine Nav da ist.
- Caddy: `/admin/nav.js` oeffentlich (wie `rdoc-theme.js`), `@superadmin`-Liste
  um `users`, `datenschutz-admin`, `giveaway-test` und `tests/*` ergaenzt.
