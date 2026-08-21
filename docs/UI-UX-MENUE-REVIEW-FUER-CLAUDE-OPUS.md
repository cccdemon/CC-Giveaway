# UI/UX-Review: Menuefuehrung und Informationsarchitektur

Stand: 18. August 2026  
Scope: ausschliesslich Navigation, Informationsarchitektur, Orientierung und Nutzerwege. Keine Bewertung von Optik, Farben, Typografie oder Brandkit.

## Kurzbewertung

**Gesamturteil: 5/10 – funktional, aber nicht ausreichend aufgabenorientiert.**

Die wichtigsten Ziele sind grundsaetzlich erreichbar. Die Navigation folgt jedoch der technischen Seitenstruktur staerker als den Aufgaben der Nutzer. Drei direkte Hauptpunkte stehen einem sehr langen, heterogenen `TOOLS`-Menue gegenueber. Streamer, Gewinner/Teilnehmer und Plattform-Admins erhalten teilweise dieselbe Navigationsstruktur, obwohl ihre Ziele deutlich verschieden sind. Innerhalb des Dashboards entsteht zudem eine zweite Navigationsebene, deren Begriffe und Zustandswechsel nicht immer selbsterklaerend sind.

## Was bereits gut funktioniert

- `Dashboard`, `Teams` und `Doku` sind dauerhaft erreichbar.
- Plattform-Admin-Seiten werden rollenabhaengig ausgeblendet.
- Das Dashboard bietet mit `Uebersicht` einen Rueckweg aus einer Giveaway-Detailansicht.
- Die Dashboard-Oberflaeche blendet unpassende Core-Funktionen kontextbezogen aus.
- Viewer-Spezialseiten besitzen klare Einzelfunktionen: Gewinn melden, Lose setzen, Contest und Status.
- Kritische Sekundaerbereiche wie Archiv, Claims und Audit haben eigene URLs und sind direkt verlinkbar.

## Befunde und Verbesserungsvorschlaege

### P0 – Eine gemeinsame Navigationsquelle schaffen

**Befund:** Die Navigation ist nahezu doppelt in `admin/public/admin-shared.js` und `giveaway/public/giveaway-shared.js` implementiert. Rollenbehandlung, Warnungsanzeige und Menueintraege koennen dadurch auseinanderlaufen.

**Auswirkung:** Nutzer sehen je nach aufgerufener Seite potentiell eine andere Navigation oder anderes Verhalten. Aenderungen muessen doppelt gepflegt werden.

**Vorschlag:**

- Eine einzige Navigation als gemeinsames Modul ausliefern, beispielsweise `/admin/nav.js`.
- Menuepunkte als zentrale Datenstruktur definieren: `id`, `label`, `href`, `section`, `roles`, `audience`, `activePaths`.
- Admin- und Giveaway-Seiten laden dasselbe Modul.
- Keine zweite Kopie oder abweichende Fallback-Navigation behalten.

**Akzeptanzkriterium:** Dieselbe Route erzeugt auf jeder Admin-/Giveaway-Seite exakt dieselbe Hauptnavigation, Rollenfilterung und aktive Markierung.

### P0 – `TOOLS` in aufgabenbezogene Gruppen zerlegen

**Befund:** Unter `TOOLS` liegen derzeit 14 Eintraege aus mindestens vier verschiedenen mentalen Modellen:

- Giveaway-Betrieb: Archiv, Gewinn-Abwicklung, Audit
- Teilnehmeraktionen: Gewinn melden, Lose setzen, Screenshot-Contest, Meine Daten
- Hilfe/Einrichtung: Anleitung, Setup-Guide
- Recht/Produktinformation: Nutzungsbedingungen, Haftungsausschluss, Changelog, Roadmap
- Feedback

**Auswirkung:** Das Menue ist schwer scannbar. Haeufige operative Aufgaben sind neben seltenen Rechts- und Produktseiten versteckt. Der Begriff `TOOLS` beschreibt die enthaltenen Ziele nicht verlaesslich.

**Vorschlag fuer die Hauptstruktur:**

1. **Giveaways**
   - Uebersicht / Dashboard
   - Gewinn-Abwicklung
   - Vergangene Giveaways
   - Audit-Log
2. **Team**
   - Teams & Mitglieder
   - Einrichtung / Streamerbot
3. **Teilnahme**
   - Mein Status
   - Gewinn melden
   - Lose setzen
   - Screenshot-Contest
   - Meine Daten
4. **Hilfe**
   - Anleitung
   - Feedback
   - Dokumentation
5. **Mehr**
   - Nutzungsbedingungen
   - Haftungsausschluss
   - Changelog
   - Roadmap
6. **Plattform-Admin** – nur Superadmin
   - bestehende Admin-/Diagnosepunkte

Nicht jede Gruppe muss ein eigener Top-Level-Punkt sein. Entscheidend ist eine erkennbare Trennung nach Aufgabe und Zielgruppe.

**Akzeptanzkriterium:** Kein Dropdown enthaelt mehr als sieben ungruppierte Ziele; operative Streamer-Aufgaben stehen vor seltenen Informationsseiten.

### P0 – Aktiven Standort auch in Dropdowns anzeigen

**Befund:** `active` wird nur fuer die drei Primaerpunkte und nur per exaktem Pfadvergleich gesetzt. Dropdown-Eintraege erhalten keine aktive Markierung; auch `TOOLS` selbst wird auf einer enthaltenen Seite nicht als aktiv gekennzeichnet.

**Auswirkung:** Auf Archiv, Claims, Audit, Setup oder Feedback fehlt dem Nutzer die globale Standortanzeige.

**Vorschlag:**

- Jeden Navigationspunkt mit `activePaths` oder einer Route-Gruppe versehen.
- Den konkreten Dropdown-Eintrag aktiv markieren.
- Gleichzeitig den uebergeordneten Menuepunkt markieren.
- Fuer Query- und Detailseiten dieselbe Gruppenzugehoerigkeit erhalten, etwa Archivliste und Archivdetail.
- Optional unter dem Hauptmenue eine kleine Breadcrumb-Zeile fuer tiefe Seiten: `Giveaways > Archiv > Giveaway vom …`.

**Akzeptanzkriterium:** Auf jeder geschuetzten Seite ist ohne Blick auf die URL erkennbar, in welchem Hauptbereich und Unterpunkt man sich befindet.

### P1 – Dashboard als zentralen Arbeitsbereich definieren

**Befund:** Der Brand-Link fuehrt auf das Control Center `/admin/`, waehrend der Primaerpunkt `Dashboard` zum eigentlichen Giveaway-Arbeitsbereich fuehrt. Das Control Center bietet normalen Nutzern im Wesentlichen erneut das Admin Panel und eine Test Console an.

**Auswirkung:** Es existieren zwei konkurrierende Startseiten. Der Begriff `Dashboard` bezeichnet nur eine davon, und der Brand-Link fuehrt nicht dorthin.

**Vorschlag:**

- Fuer Streamer den Brand-Link und den Login-Default direkt auf die Giveaway-Uebersicht fuehren.
- Das technische Control Center als Superadmin-/Entwicklerseite behandeln oder in `Plattform-Admin` einordnen.
- Alternativ das Control Center in eine echte rollenbezogene Startseite umbauen: laufende Giveaways, offene Claims, Setup-Probleme und naechste sinnvolle Aktion.

**Akzeptanzkriterium:** Es gibt pro Rolle genau eine eindeutig erkennbare Startseite; Brand-Link, Login-Redirect und Hauptpunkt fuehren konsistent dorthin.

### P1 – Rollen und Nutzeraufgaben sauber trennen

**Befund:** Streamer-Administration und Teilnehmer-Self-Service liegen im selben `TOOLS`-Menue. `Gewinn melden`, `Lose setzen` und `Screenshot-Contest` sind Teilnehmeraufgaben; `Gewinn-Abwicklung`, `Audit` und `Archiv` sind Veranstalteraufgaben.

**Auswirkung:** Ein Streamer muss zwischen eigenen Teilnehmeraktionen und betrieblichen Aufgaben unterscheiden. Teilnehmer erhalten nach Login Navigationsziele, die nicht ihrem Hauptziel entsprechen oder in Sackgassen fuehren koennen.

**Vorschlag:**

- Navigation anhand der Session und Teamrolle zusammenstellen.
- Veranstalter sehen Giveaway-Betrieb und Teamverwaltung prominent.
- Nutzer ohne Teamrolle sehen `Meine Teilnahmen`, `Gewinn melden`, `Lose setzen`, `Contest` und `Meine Daten`.
- Nutzer mit beiden Rollen erhalten getrennte Bereiche `Veranstalten` und `Teilnehmen`, nicht eine vermischte Liste.

**Akzeptanzkriterium:** Jede Rolle erreicht ihre drei haeufigsten Aufgaben mit hoechstens einem Menueklick und sieht keine funktionslosen Ziele.

### P1 – Dashboard-interne Navigation vereinfachen

**Befund:** Innerhalb des Dashboards bestehen mehrere parallele Navigationsmuster:

- Giveaway-Uebersicht versus ausgewaehlte Instanz
- Tabs `TEILNEHMER` und `VERWALTUNG`
- optionaler Umschalter innerhalb TicketBuy
- einklappbare Karten in Hauptbereich und rechter Rail
- globale Aktionsleiste
- `+`-Dialog fuer neue Instanzen

**Auswirkung:** Die Hierarchie ist schwer zu erkennen. `VERWALTUNG` ist sehr breit und ueberschneidet sich begrifflich mit `Teams`, `TOOLS` und `ADMIN`. Der aktuelle Giveaway-Kontext kann beim Wechsel in Unterbereiche verloren wirken.

**Vorschlag:**

- Dashboard-Hierarchie verbindlich auf drei Ebenen begrenzen:
  1. Team
  2. Giveaway
  3. Arbeitsbereich des Giveaways
- Giveaway-Arbeitsbereiche klar benennen: `Uebersicht`, `Teilnehmer`, `Konfiguration`, `Gewinner & Abwicklung`, `Protokoll`.
- Den unspezifischen Tab `VERWALTUNG` aufloesen.
- Aktionen wie Oeffnen, Pausieren, Schliessen und Ziehen im aktiven Giveaway-Kontext belassen; keine Navigation damit vermischen.
- Teamverwaltung nicht noch einmal im Giveaway-Arbeitsbereich nachbilden, sondern gezielt auf `Teams & Mitglieder` verlinken.

**Akzeptanzkriterium:** Ein Nutzer kann jederzeit beantworten: Welches Team? Welches Giveaway? Welcher Arbeitsbereich? Keine Ebene verwendet `Verwaltung` als Sammelbegriff.

### P1 – Lifecycle als gefuehrten Ablauf abbilden

**Befund:** Die Aktionsleiste zeigt je nach Zustand viele Aktionen wie Oeffnen, Follow-Pruefung, Pause, Fortsetzen, Schliessen, Wieder oeffnen, Ziehen und Aufraeumen. Die Erklaerung steckt teilweise in langen Tooltips.

**Auswirkung:** Die richtige Reihenfolge muss gelernt werden. Besonders TicketBuy und Contest haben abweichende Abläufe.

**Vorschlag:**

- Pro Core einen kleinen Zustands-/Schrittindikator verwenden:
  - Entwurf
  - Aktiv
  - Pausiert
  - Geschlossen / bereit zur Ziehung
  - Gewinner gezogen
  - Abwicklung
  - Archiviert
- Nur die primaere naechste Aktion prominent anbieten.
- Alternative oder destruktive Aktionen in ein Kontextmenue `Weitere Aktionen` verschieben.
- Nach jeder Aktion direkt zur naechsten notwendigen Aufgabe verlinken.

**Akzeptanzkriterium:** Pro Zustand gibt es genau eine visuell und semantisch primaere Folgeaktion; unzulaessige Aktionen erscheinen nicht.

### P1 – Mobile Navigation als echtes Menue behandeln

**Befund:** Unter 680 px werden nur Textlabels und Nutzername ausgeblendet. Die Desktop-Navigationsstruktur bleibt bestehen; das lange Dropdown wird nicht zu einer mobilen Navigation. Ein Hamburger-/Drawer-Modell ist nicht vorhanden.

**Auswirkung:** Icons verlieren ohne Labels Eindeutigkeit. Lange Dropdowns koennen kleine Viewports ueberfordern. Nutzer muessen die Bedeutung der Symbole kennen.

**Vorschlag:**

- Unter einem geeigneten Breakpoint auf einen Menue-Button mit Drawer/Sheet wechseln.
- Im mobilen Menue immer Textlabels zeigen.
- Menuegruppen als Akkordeons darstellen.
- Aktiven Bereich und Unterpunkt im Drawer markieren.
- Fokus beim Oeffnen in das Menue setzen und beim Schliessen zurueckgeben.

**Akzeptanzkriterium:** Alle Navigationsziele sind bei 320 px Breite erreichbar, lesbar und ohne horizontales Scrollen bedienbar.

### P1 – Navigation semantisch und per Tastatur bedienbar machen

**Befund:** Dropdown-Trigger sind `div`-Elemente mit Click-Handlern. Es fehlen unter anderem Button-Semantik, `aria-expanded`, `aria-controls`, Escape-Verhalten und definierte Tastaturnavigation.

**Auswirkung:** Tastatur- und Screenreader-Nutzer koennen Menues nur eingeschraenkt verstehen und bedienen.

**Vorschlag:**

- Trigger als `<button type="button">` implementieren.
- `aria-expanded` und `aria-controls` aktuell halten.
- Escape schliesst das Menue; Fokus kehrt zum Trigger zurueck.
- Tab-Reihenfolge bleibt logisch; Enter/Space oeffnen das Menue.
- Der aktive Link erhaelt `aria-current="page"`.
- Icon-only Aktionen wie Logout brauchen dauerhafte zugaengliche Namen, nicht nur `title`.

**Akzeptanzkriterium:** Die komplette Hauptnavigation ist ohne Maus erreichbar; aktive Seite und Menuezustand werden durch assistive Technik angesagt.

### P2 – Begriffe vereinheitlichen

**Befund:** Mehrere Begriffe konkurrieren oder sind zu technisch:

- `Dashboard`, `Control Center`, `Admin Panel`
- `Tools`, `Verwaltung`, `Admin`
- `Doku`, `Anleitung`, `Setup-Guide`
- `Gewinn melden` versus `Gewinn-Abwicklung`
- `Vergangene Giveaways` versus `Archiv`

**Vorschlag:**

- Ein kontrolliertes Navigationsvokabular festlegen.
- Empfohlene Begriffe:
  - `Giveaways` fuer den operativen Arbeitsbereich
  - `Teams & Mitglieder` fuer Teamverwaltung
  - `Gewinne abwickeln` fuer Veranstalter
  - `Gewinn melden` fuer Gewinner
  - `Archiv` fuer abgeschlossene Giveaways
  - `Hilfe` fuer Anleitung und Setup
  - `Technische Dokumentation` statt bloss `Doku`, falls die Seite weiterhin Architektur beschreibt

**Akzeptanzkriterium:** Derselbe Gegenstand hat global denselben Namen; Veranstalter- und Gewinneraktion sind sprachlich eindeutig unterscheidbar.

### P2 – Kontextwechsel und Rueckwege erhalten

**Befund:** Links aus Dashboard, Archiv, Claims und Viewer-Seiten wechseln auf eigenstaendige Seiten. Team- oder Giveaway-Kontext wird dabei nicht immer sichtbar in der Navigation weitergefuehrt.

**Vorschlag:**

- `team` und gegebenenfalls `giveawayId/sessionId` in Ziel-URLs erhalten.
- Auf Sekundaerseiten einen kontextuellen Ruecklink anbieten: `Zurueck zu <Giveaway-Name>`.
- Team-Auswahl zentral speichern und auf allen Veranstalterseiten konsistent verwenden.
- Bei extern aus einem Chat betretenen Viewer-Seiten keinen Admin-Rueckweg erzwingen; dort auf die jeweilige Teilnahmeaufgabe fokussieren.

**Akzeptanzkriterium:** Der Wechsel zu Archiv, Claims oder Audit verliert weder das aktive Team noch den Bezug zum gewaehlten Giveaway.

## Empfohlene Zielnavigation

### Veranstalter

```text
Giveaways
  Uebersicht
  Offene Gewinn-Abwicklungen [Anzahl]
  Archiv
  Audit-Log

Teams & Mitglieder
  Meine Teams
  Streamerbot einrichten

Teilnehmen
  Meine Teilnahmen
  Lose setzen
  Screenshot-Contest
  Gewinn melden

Hilfe
  Anleitung
  Feedback
  Technische Dokumentation
  Mehr: Rechtliches, Changelog, Roadmap
```

### Teilnehmer ohne Veranstalterrolle

```text
Meine Teilnahmen
Lose setzen
Screenshot-Contest
Gewinn melden
Meine Daten
Hilfe
```

### Plattform-Admin

Die Veranstalter-Navigation bleibt bestehen. Zusaetzlich erscheint ein klar abgegrenzter Bereich `Plattform-Admin` mit Plattformverwaltung, Betrieb, Benutzer, Betroffenenrechten und Entwicklungswerkzeugen.

## Umsetzungsauftrag fuer Claude Opus

> Ueberarbeite die Menuefuehrung des CC-Giveaway-Repositories. Bewerte und veraendere ausschliesslich Informationsarchitektur, Navigation, Benennung, aktive Zustaende, Rollenfilterung, mobile Bedienung und Accessibility. Farben, Typografie, Abstaende und Brandkit sollen unveraendert bleiben.
>
> Lies zuerst `services/admin/public/admin-shared.js`, `services/giveaway/public/giveaway-shared.js`, `services/admin/public/rdoc.css`, alle HTML-Einstiegspunkte unter `services/admin/public` und `services/giveaway/public` sowie die Caddy-Routen. Bewahre alle bestehenden URLs oder fuehre kompatible Redirects ein.
>
> Ziele:
>
> 1. Eine einzige gemeinsame Navigationsquelle statt der beiden duplizierten Implementierungen.
> 2. Aufgabenbezogene Bereiche statt eines flachen 14-Punkte-`TOOLS`-Menues.
> 3. Rollenbezogene Navigation fuer Teilnehmer, Veranstalter und Plattform-Admins.
> 4. Aktive Markierung fuer Hauptbereich und Unterseite inklusive `aria-current`.
> 5. Eindeutige Startseite pro Rolle; Brand-Link und Login-Redirect muessen dazu passen.
> 6. Echte mobile Navigation mit sichtbaren Labels.
> 7. Semantische Button-Trigger, `aria-expanded`, Escape- und Fokussteuerung.
> 8. Im Dashboard eine klare Hierarchie aus Team, Giveaway und Arbeitsbereich; den Sammelbegriff `VERWALTUNG` durch konkrete Bereiche ersetzen.
> 9. Bestehende Rollen- und Caddy-Sicherheitspruefungen nicht abschwaechen.
> 10. Keine optische Neugestaltung.
>
> Erstelle vor der Implementierung eine Route-zu-Menue-Matrix. Implementiere danach kleine, nachvollziehbare Aenderungen. Ergaenze automatisierte Navigationstests fuer Rollen, aktive Pfade, unbekannte Pfade und Keyboard-Zustaende. Fuehre abschliessend alle vorhandenen Tests aus und dokumentiere geaenderte Nutzerwege.

## Definition of Done

- Eine zentrale Menuekonfiguration und eine Rendering-Implementierung.
- Keine Navigation-Duplikate in Admin und Giveaway.
- Jede geschuetzte Route ist genau einer Menuegruppe zugeordnet.
- Aktiver Haupt- und Unterpunkt auf allen Routen.
- Rollenmatrix fuer Teilnehmer, Veranstalter und Superadmin automatisiert getestet.
- Vollstaendige Tastaturbedienbarkeit der Navigation.
- Mobile Bedienbarkeit bei 320, 375 und 768 px verifiziert.
- Bestehende URLs, Auth-Gates und Fachfunktionen bleiben erhalten.
- Keine Aenderung an Brandkit oder visueller Designsprache.

