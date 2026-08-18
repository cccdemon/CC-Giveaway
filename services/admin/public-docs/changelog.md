# Änderungsprotokoll

Was sich an dieser Plattform geändert hat — für Zuschauer und Veranstalter.
Neueste Änderung oben. Die Roadmap zeigt, was als Nächstes ansteht.

---

## 18. August 2026

### Neuer Tab VERWALTUNG im Dashboard

Die team-weiten Dinge haben jetzt einen eigenen Bereich: oben in der
Hauptflaeche laesst sich zwischen TEILNEHMER und **VERWALTUNG** umschalten.
Dort stehen — gross und mit Erklaerung statt in schmalen Seitenkarten —
die **Stream-Verbindungen** (Streamerbot-Tokens je Kanal), die
**Gewinner-Historie** aller Ziehungen, das **Audit-Log** und die
**Chat-Ansagen** (jetzt alle Mechaniken auf einmal, mit Gruppentiteln).
Die rechte Leiste ist damit deutlich schlanker und zeigt nur noch die
Steuerung des gewaehlten Giveaways.

### Los-Giveaway: Stornieren heisst jetzt Giveaway abbrechen

Der ✖-Knopf am einzelnen Preis ist weg — einen Preis stornieren und in
derselben Instanz einen neuen anlegen war zwei Werkzeuge fuer denselben
Zweck und hinterliess stornierte Karteileichen. Korrekturen (Titel,
Sponsor, Beschreibung, Bild, Einsatz-Ende) laufen weiter ueber ✎.

Neu: **✖ GIVEAWAY STORNIEREN** bricht das ganze Los-Giveaway ab. Es wird
kein Gewinner gezogen, alle Einsaetze werden zurueckgebucht, die erspielte
Zuschauzeit wird als Los-Guthaben gutgeschrieben und das Giveaway wird
geschlossen und entfernt (der Nachweis bleibt im Archiv). Danach oeffnet
sich direkt das Start-Fenster, um das neue Los-Giveaway anzulegen.

### Chat-Ansagen editierbar + Bedienpanels einklappbar

Alle Chat-Ansagen der Plattform (Eroeffnung, Pause/Weiter, Fenster offen/zu,
Preis angelegt/storniert, Voting-Status, Boost, Gewinner — je Mechanik der
passende Text) lassen sich jetzt je Team anpassen: neue Karte CHAT-ANSAGEN
im Panel. Eigener Text mit Platzhaltern wie {keyword}, {befehl} oder
{gewinner}; zwei Haken haengen auf Wunsch den Link zu den
Teilnahmebedingungen und zur Zuschauer-Seite (Setz-/Contest-/Statusseite)
an. Leeres Feld = eingebauter Standardtext. Die Gewinn-Zeile der Eroeffnung
und die Meldefrist-Zeile der Gewinner-Ansage haengt das System immer an.
Speichern darf der Team-Owner, sehen alle Mitglieder.

Ausserdem sind die Bedienkarten in der rechten Leiste jetzt per Klick auf
den Titel ein- und ausklappbar; das Panel merkt sich den Zustand je Karte.

### Los-Giveaway: zwei Roster-Ansichten, Viewtime + tatsaechliche Lose, Losanpassung

Die Teilnehmer-Tabelle des Los-Giveaways hat jetzt zwei Ansichten:
TEILNEHMER zeigt nur die per Keyword Angemeldeten der laufenden Instanz,
TICKETSTAND alle Lose-Konten des Teams. Im Ticketstand markiert 🏆 die
Gewinner der letzten drei Ziehungen (team-weit, alle Mechaniken). Neue
Spalten: Viewtime der Instanz und „Lose" — der tatsaechliche Stand aus
Guthaben plus live erspielter Zuschauzeit; gesetzte und bei einer Ziehung
verbrauchte Lose sind darin schon abgezogen (alle Setzer verlieren ihren
Einsatz, auch der Gewinner — das Setzen erhoeht nur die Chance).

Neu ist ausserdem die Losanpassung in der Preis-Karte: LOSE ZURUECKSETZEN
nullt die Lose-Konten aller Zuschauer im Team fuer einen Neustart, weil
Lose sonst ueber Giveaways hinweg erhalten bleiben. Das geht nur, wenn
kein offener Preis mehr aussteht, laeuft als Gegenbuchung im Journal
(nichts wird geloescht) und wird auditiert.

### Giveaway wieder oeffnen + aufgeraeumte Preis-Karte beim Los-Giveaway

Schliessen ist nicht mehr endgueltig: eine geschlossene, noch nicht
aufgeraeumte Instanz laesst sich per WIEDER OEFFNEN weiterlaufen lassen —
ein versehentlicher Klick auf SCHLIESSEN beendet das Giveaway also nicht
mehr unumkehrbar. Beim Los-Giveaway bleibt dabei das schon gutgeschriebene
Guthaben erhalten und nichts wird doppelt gebucht.

Die Preis-Karte des Los-Giveaways haelt jetzt die Reihenfolge ein:
SCHLIESSEN → ZIEHEN → AUFRAEUMEN. Der ★-ZIEHEN-Knopf am Preis wird erst
scharf, wenn das Giveaway geschlossen ist. Das Preis-Formular zeigt sich
nur noch, wenn es etwas zu tun gibt (neuen Preis anlegen oder per ✎
korrigieren) — vorher stand es dauerhaft ausgegraut in der Karte. Der
✎-Knopf zum Korrigieren eines Preises war ohne Funktion und ist repariert.
Ausserdem gilt „ein Los-Giveaway = ein Preis" jetzt auch nach der Ziehung:
der naechste Preis ist ein neues Los-Giveaway, nur eine Stornierung macht
den Platz wieder frei.

### Los-Giveaway: Teilnahme-Keyword im Panel sichtbar und aenderbar

Die Keyword-Karte war beim Los-Giveaway ausgeblendet — seit die Teilnahme
per Keyword laeuft, gab es damit kein Bedienfeld, um das Teilnahme-Keyword
einer laufenden Instanz zu sehen oder zu aendern. Die Karte ist jetzt auch
beim Los-Giveaway da. Aendern geht jederzeit; Abschalten lehnt der Server
ab, weil ohne Keyword niemand mehr angemeldet setzen koennte. Im
Start-Assistenten ist das Feld beim Los-Giveaway jetzt als Pflicht markiert.

### Viewtime-Boost repariert und abgesichert

Der Boost einer Instanz wurde vom Ablauf-Waechter faelschlich sofort fuer
beendet erklaert (Chat sagte das Ende an, das Panel zeigte Ende und Neustart
im Wechsel). Der Waechter prueft jetzt den Boost des richtigen Giveaways,
und das Panel uebernimmt nur noch Boost-Meldungen der eigenen Auswahl.

Ausserdem laesst sich ein Boost nur noch starten, wenn mindestens ein Kanal
live ist und der Streamerbot Zuschauer-Ticks liefert — sonst wuerde die
Boost-Zeit wirkungslos ablaufen. Die Boost-Karte zeigt das selbststaendig an
und sperrt START, solange kein Kanal sendet; Stoppen geht immer.

### Setz-Seite zeigt wirklich nur noch deine Giveaways

Nachtrag zur Aenderung von heute: auch Teams, mit denen du gar nichts zu tun
hast, sind jetzt von der Setz-Seite verschwunden. Alte Los-Giveaways ohne
Teilnahme-Keyword erscheinen nur noch, wenn du dort Guthaben hast.

### Los-Giveaway: Anmeldung per Keyword, einfacherer Setz-Befehl

Drei Aenderungen am Los-Giveaway:

- **Teilnahme ist jetzt Opt-in.** Jedes Los-Giveaway bekommt beim Start ein
  Teilnahme-Keyword. Wer es nicht in den Chat schreibt, sammelt zwar weiter
  Guthaben, kann aber keine Lose setzen. Die Anmeldung wird im Chat bestaetigt.
- **Setzen ohne Preis-Nummer.** Ein Los-Giveaway verlost genau einen Preis —
  darum reicht jetzt `!setzen <anzahl>` (Rücknahme: `!setzen 0`). Der
  Setz-Befehl waehlt bei mehreren parallelen Los-Giveaways das richtige aus
  und muss deshalb je Team eindeutig sein.
- **Die Setz-Seite zeigt nur noch deine Giveaways.** Bisher erschienen dort
  alle laufenden Los-Giveaways der Plattform — jetzt nur die, bei denen du
  per Keyword angemeldet bist (plus dein vorhandenes Guthaben).

### Chat-Bonus mit An/Aus-Haken

Der Chat-Bonus laesst sich jetzt in der Regeln-Karte per Haken komplett
abschalten — vorher musste man dafuer den Bonuswert auf 0 stellen. Beim
Ausschalten verschwinden die zugehoerigen Eingabefelder, die eingestellten
Regeln (Wortschwelle, Bonus, Cooldown) bleiben gespeichert und gelten beim
Wiedereinschalten sofort wieder. Wie alle Regeln gilt der Haken je Giveaway.

### Screenshot-Contest vorerst abgeschaltet

Die Mechanik ist noch nicht fertig — sie steht deshalb im Start-Fenster nicht
mehr zur Auswahl, und der Server nimmt auch keine Entwuerfe dieses Typs mehr an.
Bereits laufende Contests bleiben vollstaendig bedienbar: Einsendungen,
Freigabe, Voting, Ziehung und Aufraeumen funktionieren wie bisher. Sobald der
Contest fertig ist, kommt er zurueck.

### Ohne Team fuehrt das Dashboard zuerst zum Team

Wer noch in keinem Team ist, sah bisher nur eine leere Uebersicht. Jetzt steht
dort, dass ohne Team kein Giveaway startbar ist, und die Karte rechts bietet
**＋ TEAM ERSTELLEN** an — der Weg fuehrt direkt zu *Meine Teams*.

---

## 10. August 2026

### Los-Giveaway und Screenshot-Contest sind als BETA gekennzeichnet

Beide Mechaniken sind fertig gebaut und durchgetestet, aber im echten Stream
noch kaum gelaufen. Damit niemand ueberrascht wird, steht **BETA** jetzt dort,
wo man die Mechanik waehlt und steuert: im Start-Fenster, in der Auswahl oben,
auf der Uebersichtskachel und auf der Steuerkarte. Benutzbar sind sie
vollstaendig — wenn etwas hakt, bitte ueber *Fehler melden* schicken.

### Doku direkt in der Oberflaeche

Neuer Menuepunkt **DOKU**: die vollstaendige Architektur-Referenz mit
gerenderten Diagrammen, Funktions- und Schnittstellenuebersicht, mit
Abschnittsleiste zum Springen. Quelle ist das Dokument im Repo
(`docs/SOFTWARE-ARCHITEKTUR.md`) - die Seite wird daraus erzeugt, damit beides
nicht auseinanderlaeuft.

### OBS-Overlays entfallen

Gewinner-Overlay und Join-Animation sind ersatzlos entfernt. Sie liefen im
Stream nicht zuverlaessig und hatten keinen Testmodus; die Gewinner-Anzeige im
Panel und die Chat-Ansage decken denselben Zweck ab. Damit verschwinden die
beiden Seiten, das OBS-Menue, die Overlay-Links in der Team-Verwaltung und die
oeffentlichen Overlay-Adressen.

### Zuschauer-Meldungen: Warnung nur noch bei laufendem Stream

Die Meldung "keine Zuschauer-Meldungen" erschien auch dann, wenn gar nicht
gestreamt wurde - dabei sendet Streamerbot ohne laufenden OBS-Stream
absichtlich nichts. Jetzt steht dort **Stream offline** als neutraler Hinweis,
und rot wird es nur, wenn der Stream laeuft und trotzdem nichts ankommt. Die
Betriebsseite zeigt dieselben drei Zustaende je Kanal.

### Fehler melden und Ideen schicken

Neu im Menü unter Tools: **🐛 Fehler melden & Idee schicken**. Drei Arten
(Fehler, Idee, Frage), ein Textfeld, fertig — die Meldung geht direkt in den
Discord-Kanal des Betreiberteams und wird zusätzlich gespeichert, damit nichts
verloren geht, wenn Discord gerade klemmt. Mitgeschickt werden nur dein
Twitch-Login, die genannte Seite, dein Text und der Zeitpunkt.

### Eigener ADMIN-Menüpunkt mit Betriebsübersicht

Die Werkzeuge der Plattform-Verwaltung stecken nicht mehr im Tools-Menü,
sondern in einem eigenen Punkt **ADMIN** — sichtbar nur für
Plattform-Administratoren. Dort gibt es neben Plattform-Verwaltung, Benutzern
und Betroffenenrechten die neue Seite **Betrieb & Diagnose**: Zustand der
Dienste, Zuschauer-Meldungen je Kanal (kommen überhaupt Ticks an?),
Kennzahlen zum laufenden Betrieb, die letzten Fehler und Ablehnungen aus dem
Protokoll, die eingegangenen Rückmeldungen und die Debugzeilen aus Streamerbot.

---

## 9. August 2026

### Startseite des Panels ist jetzt eine Übersicht

Die Auswahl oben beginnt mit **ÜBERSICHT**. Dort steht keine Teilnehmertabelle
mehr, sondern eine **Kachel je laufendem Giveaway**: Mechanik, Name oder Keyword,
Gewinn, Kanäle, Teilnehmerzahl und Zustand (läuft / pausiert / geschlossen,
ziehen). Ein Klick auf die Kachel wählt das Giveaway aus und blendet erst dann
seine Bedienung ein.

Solange nichts gewählt ist, bleibt die rechte Leiste leer bis auf eine Karte
mit **＋ GIVEAWAY STARTEN** - keine Regeln, kein Setup, keine Aktionsleiste für
etwas, das gar nicht ausgewählt ist. Eine laufende Kampagne ist ein eigener
Eintrag in der Auswahl; ohne laufende Kampagne gibt es dort auch nichts zu
bedienen.

### Erst schliessen, dann ziehen - fuer jedes Giveaway

Die Reihenfolge ist jetzt ueberall dieselbe: **schliessen, ziehen, aufraeumen.**
Schliessen beendet nur das Sammeln beziehungsweise die Anmeldung; der Topf bleibt
stehen und das Giveaway bleibt oben in der Auswahl (mit dem Hinweis
"GESCHLOSSEN, ziehen!"). Der Knopf heisst danach **AUFRAEUMEN** und entfernt das
Giveaway erst nach der Ziehung aus der Liste. Vorher war ein geschlossenes
Giveaway sofort verschwunden - samt Topf.

Beim Los-Giveaway heisst das: schliessen buchen die Zuschauzeit als Guthaben,
die Preise koennen danach in Ruhe gezogen werden. Aufgeraeumt wird erst, wenn
kein Preis mehr offen ist.

### Sofortverlosung: das Keyword ist der Anwesenheitsnachweis

Wer im offenen Anmeldefenster das Keyword schreibt, gilt als anwesend. Dazu
kommen zwei Bedingungen, die sich nicht faelschen lassen: **Follow** auf einem
beteiligten Kanal und eine **Mindest-Zuschauzeit** (Vorgabe 10 Minuten, beim
Start einstellbar, 0 schaltet sie ab). Die Zuschauer-Meldungen aus Streamerbot
entscheiden nicht mehr allein darueber, wer im Topf ist - sie liefern weiterhin
die Zuschauzeit und die Spalte "Anwesend".

### Sofortverlosung: sichtbare Warnung statt leerer Ziehung

Am 9. August lief eine Sofortverlosung live ins Leere: 36 Anmeldungen im Chat,
aber im Topf stand niemand und der Knopf zum Ziehen tat scheinbar nichts. Grund
war, dass vom Kanal **keine Zuschauer-Meldungen** (Streamerbot-Aktion
GW_ViewerTick) ankamen. Anwesenheit ist bei der Sofortverlosung Pflicht -
Chat allein reicht bewusst nicht - also war der Topf korrekt leer, nur hat das
niemand gesehen.

Das ist jetzt nicht mehr still:

- Oben im Panel steht ein Warnstreifen, sobald von einem Kanal seit ueber
  10 Minuten keine Zuschauer-Meldung kam - inklusive Hinweis, welche
  Streamerbot-Aktion fehlt.
- Beim Oeffnen des Anmeldefensters und beim Schliessen kommt dieselbe Warnung.
- Bleibt die Ziehung leer, erscheint ein Hinweisfenster mit den Zahlen:
  wie viele angemeldet, wie viele davon anwesend, welcher Kanal stumm ist.
- **Schliessen** fragt jetzt deutlich nach, wenn noch Anmeldungen im Topf sind
  und kein Gewinner gezogen wurde.

### Teilnehmerliste zeigt nur noch echte Teilnehmer

Die Kampagnen-Tabelle listete jeden je gesehenen Zuschauer des Teams, auch mit
lauter Nullen und auch bei geschlossener Kampagne. Jetzt steht dort nur, wer in
diesem Giveaway angemeldet ist, Punkte, Zuschauzeit oder Nachrichten hat - oder
gesperrt ist.

### Ein Giveaway verlost genau einen Preis

Bisher konnte ein Los-Giveaway beliebig viele Preise enthalten. Ab jetzt gilt
ueberall dieselbe Regel: **eine Kampagne, ein Giveaway, ein Preis**. Wer mehrere
Preise verlosen will, startet mehrere Los-Giveaways nebeneinander - das war
vorher gesperrt und ist jetzt erlaubt.

Was das im Betrieb heisst:

- Die Preis-Karte nimmt einen Preis an; solange der offen ist, ist das Formular
  zu (korrigieren und stornieren geht weiter).
- Im Start-Fenster gibt es das Feld **Preis** statt einer Preis-Liste.
- Auf der Seite **Lose setzen** steht jeder Preis in einem eigenen Block mit
  eigenem Setz-Befehl. Das Guthaben bleibt team-weit und gilt fuer alle
  Los-Giveaways.
- Im Chat entscheidet die Preis-Nummer, welches Giveaway gemeint ist - auch wenn
  zwei Giveaways denselben Befehl benutzen. Unbekannte Nummern bekommen eine
  Antwort statt stiller Ablehnung.
- Nur noch der Screenshot-Contest ist auf eine laufende Instanz je Team begrenzt.

### Aufgeraeumte Steuerleiste im Panel

Beim **Los-Giveaway** ist der Knopf **★ ZIEHEN (JE PREIS)** oben wieder da.
Er zieht bewusst nicht selbst - beim Los-Giveaway hat jeder Preis seinen
eigenen Einsatz-Topf - sondern springt zur Preis-Karte und hebt sie hervor,
wo je Preis gezogen wird. Gezogen wird weiterhin ausschliesslich von Hand,
in jeder Mechanik.

Der **Viewtime-Boost** steht jetzt weit oben in der rechten Leiste, nicht mehr
unter dem langen Preis-Formular des Los-Giveaways. Die Karte **Vergangene
Giveaways** ist aus der Leiste verschwunden: sie gehoerte dort in keiner
Mechanik hin und steht vollstaendig im Menue unter *Tools -> Vergangene
Giveaways* (mit Dossier und Nachweis-Export).

### Eckige Klammern in eigenen Bedingungen blockieren den Start nicht mehr

Bisher galt jeder Text in eckigen Klammern als unausgefuellter Platzhalter, auch
wenn dort laengst ein echter Wert stand: „**Stand:** [19.07.2026]" oder
„live auf [MeinKanal]" haben den Start abgebrochen. Das ist behoben.

Jetzt gilt: den Start blockiert nur noch die Vorlagen-Schreibweise
`{{ ... }}`, und die Meldung nennt die gefundenen Stellen beim Namen. Eckige
Klammern mit typischem Platzhalter-Wort (`[Datum]`, `[Haupt-Kanal]`,
`[Dein Name]`, `[TBD]`) ergeben nur noch eine **Warnung** im Panel, der Start
laeuft weiter. Markdown-Links wie `[Datenschutz](...)` waren schon immer
ausgenommen.

---

## 7. August 2026

### Neues Erscheinungsbild: RDOC

Die gesamte Oberflaeche traegt jetzt die Marke **RDOC** — Farben, Schriften,
Zeichen und Favicons kommen aus dem RDOC-Markenhandbuch statt aus dem alten
Chaos-Crew-Look. Sichtbar auf jeder Seite: ruhige Flaechen in Space und
Graphite, Kupfer nur fuer die eine wichtige Handlung einer Ansicht, keine
Neonfarben, keine Verlaeufe, kein Glimmen.

Ueberschriften stehen in **Michroma**, der Schrift, die derselben quadratischen
Konstruktion folgt wie das Zeichen selbst. Fliesstext ist IBM Plex Sans, alles
Technische (Kennungen, Zahlen, Protokollzeilen) IBM Plex Mono. Alle Schriften
liegen auf dem eigenen Server, es geht keine Anfrage an einen fremden Dienst.

Hell und Dunkel sind getrennt gemessene Paletten, nicht die Umkehrung
voneinander. Der Schalter oben rechts merkt sich die Wahl; ohne Wahl folgt die
Seite der Systemeinstellung.

Die letzten Seiten im alten Look sind mitgezogen: **Lose setzen**,
**Screenshot-Contest**, **Mitmachen**, **Team beitreten** und die
**Streamerbot-Einrichtung**. Die Anleitung „Mitmachen" nutzt jetzt dieselbe
Textdarstellung wie Impressum und Datenschutz und bekommt damit auch
Sprungmarken zu den Abschnitten.

---

## 6. August 2026 (viertes Update)

### Plattform-Verwaltung: Moderation durch den Betreiber

Neu für Plattform-Administratoren: die Seite **Plattform-Verwaltung** mit
Überblick (aktive und deaktivierte Teams, Streamer, Zuschauer, offene
Giveaways), Team-Liste und Streamer-Liste. Der Betreiber kann dort Teams
deaktivieren und reaktivieren, Streamer-Konten sperren und entsperren und
**Verwarnungen** aussprechen. Jede Aktion braucht einen Grund und steht im
Prüfprotokoll.

Für Betroffene sichtbar: eine Verwarnung erscheint beim nächsten Besuch als
**Banner** oben auf den Verwaltungsseiten, mit Knopf „Zur Kenntnis genommen".
Ein gesperrtes Konto kann sich nicht mehr anmelden; beim Login erscheint eine
klare Meldung. Eine Sperre löscht keine Daten, Auskunft und Löschung laufen
weiter über „Meine Daten".

---

## 6. August 2026 (drittes Update)

### Kein Start ohne eingefrorene Teilnahmebedingungen

Ein Giveaway startet nur noch, wenn die geltende Bedingungen-Fassung
erfolgreich eingefroren wurde — schlägt das fehl (z. B. Verwaltungsdienst
nicht erreichbar), bricht der Start mit verständlicher Meldung ab, ohne
halb geöffnete Sitzung. Die Standard-Vorlage ist jetzt **komplett ohne
auszufüllende Platzhalter** formuliert (inkl. konkretem Hinweis zum
Drittlandtransfer bei der optionalen KI-Chatbewertung); eigene Bedingungen
mit unausgefüllten Platzhaltern blockierten damals den Start schon bei eckigen
Klammern (seit 9.8.2026 nur noch bei `{{ … }}`).

### Ersatzziehung kann keinen abgewickelten Gewinn duplizieren

Hat sich der Gewinner bereits gemeldet oder hat der Veranstalter die
Abwicklung begonnen (kontaktiert/versendet/erledigt), ist die Ersatzziehung
gesperrt. Der bisherige Gewinner ist bei einer Ersatzziehung immer
ausgeschlossen; das Archiv zeigt Ersatzziehungen mit Ursprung und Grund.

### Klarere Beschriftung überall

„Meine Daten" nennt den Ziehungswert jetzt je Mechanik (Coins, gesetzte
Lose, Voting-Punkte — bei der Sofortverlosung ausdrücklich „ohne Aussage,
gleiche Chance"). Das Audit-Log beschriftet Ziehungen genauso. „Meine
Teilnahmen" zeigt zusätzlich dein Ergebnis je Los-Preis (offen/gewonnen/
nicht gewonnen/storniert), deine Kenntnisnahmen samt geltender Fassung
und einen Download-Button für eigene Contest-Bilder.

---

## 6. August 2026 (zweites Update)

### Alle vier Mechaniken jetzt überall sauber abgebildet

Statusseite, Archiv, Gewinneranzeige und Rechtstexte kannten bisher vor
allem die Kampagne. Jetzt gilt durchgängig: jede Mechanik wird mit ihren
eigenen Begriffen und Regeln dargestellt.

* **„Meine Teilnahmen"** (vorher „Mein Status"): zeigt je Team zusätzlich
  laufende Sofortverlosungen (Anmeldung, Anwesenheit, Fenster), dein
  **Los-Guthaben mit verständlicher Buchungshistorie** und Einsätzen je
  Preis sowie deinen **Contest-Status** (Einsendung, Freigabe, Punkte,
  Rang, eigene Stimmen — inklusive früherer Contests mit Bild-Link).
  Kampagnen- und Sofortverlosungs-Teilnahme kannst du dort selbst
  **zurückziehen**.
* **Archiv:** je Mechanik ein eigenes Dossier — Los-Giveaways mit Preisen,
  Einsätzen und Guthaben-Buchungen, Contests mit Einsendungen, Moderation
  und Endrangliste, Sofortverlosungen mit gleicher Gewichtung. Der Export
  enthält die passenden Dateien (preise.csv, einsaetze.csv, guthaben.csv,
  einsendungen.csv, zustimmungen.csv).
* **Gewinneranzeige, Overlay und Gewinn melden** beschriften den Gewinn
  jetzt korrekt: Punkte bei der Kampagne, gesetzte Lose beim Los-Giveaway,
  Voting-Punkte beim Contest, „gleiche Chance" bei der Sofortverlosung.
* **Sofortverlosung bestätigt die Anmeldung im Chat** (sofern Ansagen an
  sind).

### Rechtstexte und nachweisbare Zustimmung

* Die **Teilnahmebedingungen-Vorlage** und die öffentliche Hilfe wurden an
  das tatsächliche Verhalten aller vier Mechaniken angeglichen (keine
  pauschalen Aussagen mehr wie „keine Lose" oder „immer gewichtete
  Ziehung"; die Zustimmung erfolgt je nach Mechanik per Keyword, erstem
  Einsatz oder Einsendung).
* **Jede Sitzung friert die geltende Fassung der Teilnahmebedingungen
  ein.** Das Archiv verlinkt die historische Fassung; die öffentliche
  Terms-Seite kann jede Fassung anzeigen (`?version=`).
* **Kenntnisnahme wird protokolliert:** erste Anmeldung, erster Einsatz,
  Einsendung und Stimmabgabe werden je Giveaway mit Zeitpunkt und
  geltender Fassung festgehalten. Auf den Setz- und Contest-Seiten gibt es
  dafür eine sichtbare Checkbox mit Links auf Bedingungen, Datenschutz und
  Impressum. Das Protokoll erscheint in der DSGVO-Selbstauskunft und wird
  bei Löschung pseudonymisiert.
* Die Datenschutzerklärung ergänzt den **Drittlandhinweis zur optionalen
  KI-Chatbewertung** und das Kenntnisnahme-Protokoll.

### Teilnehmer-Vorschau vor dem Start

Das Start-Modal zeigt beim Auswählen der Mechanik, **wie viele Zuschauer die
Bedingungen jetzt schon erfüllen würden** — bei der Kampagne Follows +
Mindest-Viewtime, bei der Sofortverlosung die aktuelle Anwesenheit, beim
Los-Giveaway Konten mit Guthaben, beim Contest Follow + Mindest-Zuschauzeit.
Die Vorschau rechnet bei geänderter Kanalauswahl neu.

### Ersatzgewinner mit Nachweis statt einfacher Neuziehung

„Ersatz ziehen" verknüpft die neue Ziehung mit der ursprünglichen, hält
den **Grund** fest und schließt den bisherigen Gewinner aus (abwählbar).
Der alte Gewinnanspruch wird als „ersetzt" markiert; eine bereits vom
Veranstalter bearbeitete Gewinnermeldung kann der Gewinner nicht mehr
ändern. Außerdem: Los-Giveaway-**Preise lassen sich schon im Entwurf
anlegen**, und der Start warnt, wenn die eigenen Teilnahmebedingungen noch
unausgefüllte Platzhalter enthalten.

---

## 6. August 2026

### Archiv: Kampagnen-Klammer über zusammengehörige Sitzungen

Vor der Systemumstellung legte jeder Stream-Start eine neue Sitzung an,
während der Punktestand der Kampagne durchlief — im Archiv sah eine
wochenlange Kampagne deshalb wie viele kleine Giveaways aus. Das Archiv
fasst zusammengehörige Sitzungen jetzt als **Kampagne** zusammen (goldene
Karte): Gesamtzeitraum laut Daten, Teilnehmer über alle Sitzungen,
Endstand, Ziehungen und Gewinner. Ein Klick filtert die zugehörigen
Einzel-Sitzungen. Eine Kampagne endet mit der Sitzung, in der gezogen und
geschlossen wurde (oder mit einem Zurücksetzen). Der Klick öffnet rechts
außerdem das **kumulierte Kampagnen-Dossier**: Gesamtzeitraum, alle
Ziehungen, Gewinnermeldungen und der Teilnehmerstand über alle Sitzungen
(je Zuschauer der Endstand — keine Doppelzählung).

### Giveaways vorbereiten, Hilfemodus und „So funktioniert es"

Drei Neuerungen für die Bedienung: **(1) Giveaways vorbereiten** — im
Start-Modal gibt es jetzt „Als Entwurf speichern": vor dem Stream anlegen,
im Stream per ▶ aus der Karte „Vorbereitete Giveaways" starten. **(2)
Hilfemodus im Dashboard** — der Schalter „？ HILFE" in der Kopfzeile
blendet an jedem Bereich eine Erklärung ein, die die aktuelle
Funktionsweise beschreibt. **(3) Neue öffentliche Seite
[So funktioniert es](/admin/funktionsweise.html)** — die genaue, aber
verständliche Erklärung des gesamten Systems und jeder einzelnen Mechanik;
von der Startseite aus verlinkt (Klick auf eine Mechanik-Karte springt
direkt zur passenden Erklärung).

### Dashboard: Gewinn-Abwicklung und vergangene Giveaways direkt sichtbar

Zwei neue Karten in der rechten Spalte des Dashboards: **Gewinn-Abwicklung**
(nur Owner) zeigt alle offenen Fälle mit Ein-Klick-Aktionen — „extern
gemeldet" (z. B. WhatsApp), kontaktiert, versendet, erledigt; Kontaktdaten
bleiben bewusst auf der Abwicklungs-Seite (Streamermodus-sicher).
**Vergangene Giveaways** listet die letzten Abschlüsse mit Gewinner und
Teilnehmerzahl, mit Direktlink ins Archiv samt Nachweis-Export.

### Archiv: Teilnehmer kumuliert, echter Zeitraum, externe Gewinnmeldung

Drei Verbesserungen an Nachweis und Abwicklung: **(1)** Der Teilnehmerstand
im Archiv zeigt jetzt **eine Zeile je Zuschauer** mit Gesamt-Zuschauzeit und
der Aufschlüsselung, wer wie lange auf welchem Kanal geschaut hat (vorher
eine Zeile je Kanal, nicht kumuliert). **(2)** Bei Kampagnen aus der Zeit
vor der Systemumstellung zeigt das Dossier die **echte Eröffnung** laut
ältestem Viewtime-Event statt des Migrations-Datums — der Datenzeitraum
steht jetzt immer dabei. **(3)** Meldet sich ein Gewinner **außerhalb der
Plattform** (z. B. WhatsApp), erfasst der Owner das in der Gewinn-Abwicklung
mit einem Klick („Extern gemeldet") — die Frist gilt als erfüllt, der
Nachweis unterscheidet das sauber von der Selbstmeldung, Kontaktdaten
entstehen dabei keine. Danach wie gewohnt kontaktiert/versendet/erledigt.

### Repariert: Contest-Seite erkennt Follows auch ohne Live-Meldung

Wer einem Contest-Kanal folgt, aber noch keine Live-Meldung aus dem Stream
bekommen hatte, sah „Folge zuerst einem Contest-Kanal". Der Follow wird
jetzt bei Bedarf direkt bei Twitch nachgeprüft (sofern der Kanal-Streamer
auf der Plattform eingeloggt war und den Lese-Zugriff erteilt hat).

### Repariert: Login führt zur ursprünglich angeforderten Seite

Wer ohne Anmeldung z. B. die Contest-Seite öffnete, landete nach dem
Twitch-Login immer auf „Meine Teams" statt auf der angeforderten Seite.
Die Ziel-Adresse wird jetzt durch den gesamten Login-Weg durchgereicht.

### Repariert: Contest- und Setz-Seite fanden laufende Giveaways nicht

Wer die Contest- oder Setz-Seite öffnete, ohne vorher als Zuschauer erfasst
worden zu sein (z. B. der Streamer selbst oder ein frisch eingeloggter
Zuschauer), sah „kein Contest" bzw. „kein Guthaben", obwohl eine Instanz
lief. Beide Seiten finden laufende Instanzen jetzt zuverlässig; die
Teilnahme-Voraussetzungen (Follow, Zuschauzeit) gelten unverändert.

### Contest-Moderation: Bild-Vorschau und endgültiges Löschen

Die Einsendungs-Liste im Dashboard zeigt jetzt zu jeder Einsendung ein
**Vorschaubild**, den **Einsender** und den Status im Klartext — Freigeben
und Ablehnen gehen damit auf einen Blick. Neu ist der **Löschen-Knopf** für
den Team-Owner: anders als das Ablehnen (Bild bleibt gesperrt gespeichert)
entfernt er eine Einsendung **endgültig** — für Inhalte, die gar nicht
gespeichert bleiben dürfen. Abgegebene Stimmen verfallen dabei; der Vorgang
wird protokolliert. Der neue Knopf **„📸 Bilder prüfen"** in der Kopfleiste
führt direkt zur Moderation, sobald ein Contest läuft. Außerdem angepasst:
Bilder dürfen jetzt **bis 7 MB** groß sein, erlaubt sind **PNG und JPG**
(WebP entfällt) in einer Auflösung von **Full HD (1920×1080) bis 4K**.

### Chat-Ansagen verlinken jetzt die Mitmach-Seiten

Beim Start eines Screenshot-Contests oder Los-Giveaways stand in der
Chat-Ansage zwar „auf der Contest-Seite" — aber ohne Link. Jetzt nennen die
Eröffnungs-Ansage, die `!los`-Zusatzzeile und die „Voting ist offen"-Ansage
die vollständige Adresse (…/viewer/contest bzw. …/viewer/wager).

### Sicherheits-Härtung nach externer Prüfung

Eine erneute externe Sicherheitsprüfung hat keine Datenlecks gefunden, aber
Verbesserungspotenzial — das meiste davon ist jetzt umgesetzt: **Lose setzen
und zurücknehmen ist gegen parallele Anfragen abgesichert** (kein doppeltes
Setzen oder doppelte Erstattung mehr möglich, auch nicht durch Zufall oder
Trickserei), Bild-Adressen von Contest-Einsendungen und Preisen sind nicht
mehr erratbar, hochgeladene Bilder werden auf ihre echte Dateisignatur
geprüft, Login- und Beitrittsversuche sind gedrosselt, und auffällige
Sprünge bei den gemeldeten Zuschauerzahlen eines Kanals werden automatisch
markiert und protokolliert. Dazu kommen strengere Sicherheits-Header und
Größen-/Frequenz-Limits an den technischen Schnittstellen.

### Teams lassen sich jetzt vollständig selbst verwalten

Unter **Meine Teams** gibt es einen neuen Verwaltungsbereich: Mitglieder
können ein Team **selbst verlassen**, der Owner kann das Team **umbenennen**,
die **Eigentümerschaft an ein Mitglied übergeben** (die Veranstalter-Pflichten
wie Impressum und Nutzungsbedingungen gehen mit über — der neue Owner muss den
aktuellen Nutzungsbedingungen bereits zugestimmt haben), **Einladungen
pausieren** und das Team **deaktivieren**. Jedes Mitglied kann außerdem den
**eigenen Twitch-Kanal ändern** (nur solange kein Giveaway läuft; der alte
Zugangs-Token wird dabei widerrufen).

Beim Deaktivieren werden alle Live-Daten (Zuschauzeiten, Anmeldungen) und
Zugangs-Tokens gelöscht — **Ziehungsnachweise und Protokolle bleiben**, wie es
die Nachweispflichten verlangen. Ein deaktiviertes Team kann keine Giveaways
mehr öffnen; der Owner kann es jederzeit reaktivieren. Alle
Verwaltungsaktionen werden protokolliert.

### Dashboard zeigt jedes Giveaway in seinen eigenen Spalten

Die Teilnehmer-Tabelle zeigte bisher immer die Coin- und Viewtime-Spalten
der Kampagne — auch bei Sofortverlosung, Los-Giveaway und Contest, wo diese
Zahlen nichts aussagen. Jetzt passt sich die Tabelle der Mechanik an:
**Sofortverlosung** zeigt Anwesenheit und wer im Topf ist, das
**Los-Giveaway** zeigt Guthaben und gesetzte Lose je Teilnehmer, der
**Contest** zeigt Einsendung, Status, Punkte und Stimmen. Die
Giveaway-Auswahl oben zeigt zu jeder laufenden Instanz jetzt außerdem
**Teilnehmerzahl und Startzeit**. Auch die Statistik-Kacheln in der
Kopfzeile passen sich an: Sofortverlosung zeigt Angemeldet/Anwesend/Im Topf,
das Los-Giveaway Konten/gesetzte Lose/freies Guthaben/Setzer, der Contest
Einsendungen/Freigegeben/Stimmen/Punkte.

### Preise mit Bild und Beschreibung

Beim Los-Giveaway können Preise jetzt eine **Beschreibung** und ein **Bild**
bekommen (max. 2 MB) — beides direkt im Preis-Formular, auch nachträglich,
solange der Preis nicht gezogen ist. Zuschauer sehen Bild und Beschreibung
auf der Setz-Seite beim jeweiligen Preis.

### Regeln gelten jetzt pro Giveaway — nicht mehr fürs ganze Team

Die Einstellungen „folge X Kanälen", „1 Coin = X Stunden" und der Chat-Bonus
waren bisher team-weit und wirkten sofort auf alles Laufende — das war
schwer zu durchschauen. Jetzt bekommt **jedes Giveaway beim Start seine
eigene Kopie** dieser Regeln. Die Karte im Dashboard heißt darum
**„Regeln"** und zeigt an, was sie gerade bearbeitet: das **laufende
Giveaway** (wirkt sofort, nur dort) oder die **Vorgaben** für den nächsten
Start (wenn nichts läuft). Sie erscheint auch beim Los-Giveaway — dessen
Guthaben-Umrechnung folgt denselben Regeln. KI-Chat-Bewertung und
Auto-Pause/Start bleiben team-weit und sind entsprechend beschriftet.

### Neu: Gewinn-Abwicklung im Blick

Neue Seite **Gewinn-Abwicklung** (Tools-Menü, nur Team-Owner): alle
Gewinnermeldungen an einem Ort — wer hat sich gemeldet, welche Frist läuft,
was ist zu tun. Der Stand lässt sich als **kontaktiert → versendet →
erledigt** markieren, und die Kontaktdaten des Gewinners können sofort nach
der Abwicklung gelöscht werden (der Ziehungsnachweis bleibt). Abgelaufene
Fristen sind rot markiert. Außerdem repariert: der Link „Gewinn melden" aus
der Chat-Ansage führte ins Leere — jetzt landet er auf der Meldeseite.

### Contest: Einsendung zurückziehen, Freigabe korrigierbar

Wer seinen Screenshot ganz zurückziehen will (nicht ersetzen), kann das
jetzt auf der Contest-Seite — das Bild wird gelöscht, abgegebene Stimmen
verfallen (mit Warnung). Der Veranstalter kann Freigabe-Entscheidungen
korrigieren: ein freigegebenes Bild wieder sperren oder ein abgelehntes
doch freigeben.

### Dashboard: Zuschauer-Links, Namen für Giveaways, aufgeräumte Menüs

Die Karten von Los-Giveaway und Contest haben jetzt **„Link kopieren"** und
**„Im Chat ansagen"** — die Zuschauer-Seiten sind unter den Kurzadressen
`/viewer/wager` und `/viewer/contest` erreichbar. Zusatz-Giveaways können
beim Start einen **Anzeigenamen** bekommen (statt kryptischer Nummern in
der Auswahl), und jede Mechanik zeigt ihr Symbol (⚡ 🎟 📸).
Plattform-Admin-Werkzeuge (Benutzer, Betroffenenrechte, Test-Konsole)
erscheinen im Menü nur noch für Plattform-Administratoren.

### Los-Giveaway: sicherer Lebenszyklus und volle Preisverwaltung

Ein Los-Giveaway lässt sich **nicht mehr schließen, solange ungezogene Preise
offen sind** — vorher konnten offene Preise nach dem Schließen weder gezogen
noch entfernt werden. Sammeln stoppen geht jederzeit mit PAUSE; danach in
Ruhe je Preis ziehen (★), dann schließen. Preise können jetzt außerdem
**korrigiert** (Titel, Sponsor, Einsatz-Ende — ✎) und **storniert** werden
(✖): beim Stornieren bekommen alle Teilnehmer ihre gesetzten Lose
automatisch zurückgebucht, und der Chat wird informiert.

### Eine Instanz je Mechanik — und ehrliche Knöpfe

Je Team läuft ab jetzt **maximal ein Los-Giveaway und ein
Screenshot-Contest gleichzeitig** — die Zuschauer-Seiten (Lose setzen,
Contest) könnten zwei parallele Instanzen derselben Art nicht
unterscheiden. Sofortverlosungen dürfen weiterhin mehrfach parallel laufen.
Im Dashboard sind ÖFFNEN/PAUSE/FORTSETZEN/SCHLIESSEN nur noch klickbar,
wenn die Aktion im aktuellen Zustand gültig ist, und der angezeigte Status
wechselt erst nach Bestätigung des Servers — kein kurzzeitig falscher
Status mehr, wenn der Server ablehnt.

## 5. August 2026

### Sofortverlosung: Chat-Ansagen abschaltbar

Die automatischen Chat-Nachrichten der Sofortverlosung (Start, Anmeldefenster
öffnet/schließt, Zusatzzeile in `!los`) lassen sich jetzt je Instanz aus- und
wieder einschalten — beim Start im Assistenten oder jederzeit über die
Sofortverlosungs-Karte im Dashboard. Ausgeschaltet läuft die Verlosung still,
der Streamer sagt sie selbst an. **Die Gewinner-Ansage kommt immer** — der
Gewinner muss erfahren, dass er gezogen wurde.

### !los kennt jetzt alle laufenden Giveaways

Der Status-Befehl `!los` nannte bisher nur die Kampagne. Läuft parallel eine
Sofortverlosung, ein Los-Giveaway oder ein Screenshot-Contest, hängt die
Antwort jetzt je eine kurze Zeile an — bei der Sofortverlosung mit Keyword
und Restzeit des offenen Anmeldefensters, beim Los-Giveaway mit dem
Setz-Befehl, beim Contest mit dem Voting-Stand. Instanzen, die nur auf
bestimmten Kanälen laufen, werden auch nur dort genannt; pausierte bleiben
stumm.

### Gewinn und Sponsor gehören jetzt zu jedem Giveaway

Beim Öffnen eines Giveaways muss ab jetzt eingetragen werden, **was verlost
wird** — optional dazu, **wer den Gewinn bereitgestellt hat** (Sponsor).
Beides wird im Chat angesagt und steht im Ziehungsnachweis. Beim
Los-Giveaway gilt das je Preis. Außerdem: das Anmeldefenster der
Sofortverlosung wird in Minuten eingestellt, der Öffnen-Knopf ist gesperrt,
solange ein Fenster läuft, und die Instanz-Steuerung (Preise, Setz-Befehl,
Voting, Fenster) sitzt jetzt als Karten im Dashboard statt in
Browser-Dialogen.

### Neu: Screenshot-Contest

Vierter Giveaway-Typ: die Community sendet Screenshots ein und bewertet sie —
**1 (schlecht) bis 10 (SUPER!)**. Die höchste Punktsumme gewinnt; bei
Gleichstand entscheidet das Los. Einsenden und Bewerten können nur echte
Zuschauer (Follow + Mindest-Zuschauzeit — das hält auch Vote-Bots draußen),
je Person zählt **eine Einsendung** und **eine Stimme pro Bild** (erneutes
Bewerten ändert die eigene Wertung, das eigene Bild ist tabu). Jede
Einsendung wird vor der Sichtbarkeit vom Streamer geprüft und freigegeben.

Der Streamer steuert das Voting ausdrücklich: **öffnen, pausieren,
fortsetzen, schließen** — jede Änderung wird im Chat angesagt. Wer seinen
Screenshot ersetzt, verliert die dafür schon abgegebenen Stimmen und wird
vorher deutlich gewarnt.

---

## 4. August 2026

### Neu: Los-Giveaway — Zuschauzeit wird Guthaben, Einsatz auf Preise

Dritter Giveaway-Typ: beim **Los-Giveaway** wird Zuschauzeit zu
Los-Guthaben, das beim Ende des Giveaways deinem Konto gutgeschrieben wird
und **beim nächsten Los-Giveaway erhalten bleibt**. Der Streamer legt
konkrete Preise an; du setzt deine Lose gezielt darauf — im Chat mit einem
Befehl (Standard „!setzen", der Streamer kann ihn umbenennen):
„!setzen 3 2" = 2 Lose auf Preis 3, „!setzen 3 0" = Einsatz zurückholen
(bis zum Einsatz-Ende). Gezogen wird je Preis, gewichtet nach Einsatz —
jedes Los kann gewinnen. Nach der Ziehung sind die Einsätze aller
Teilnehmer dieses Preises verbraucht.

Neben dem Chat gibt es die Seite **„Lose setzen"** (Login mit Twitch):
Guthaben je Team, alle offenen Preise mit deinem Einsatz, Setzen und
Rücknahme per Klick.

Guthaben entsteht ausschließlich aus Zuschauzeit: es ist nicht kaufbar,
nicht auszahlbar, nicht übertragbar, und verfällt nach 12 Monaten ohne
Bewegung. Alle Bewegungen stehen in „Meine Daten".

### Neu: Sofortverlosung

Neben der langlaufenden Kampagne gibt es jetzt die **Sofortverlosung**: der
Streamer öffnet ein Anmeldefenster mit Keyword (z.B. 60 Sekunden — auch
mehrmals hintereinander), alle die das Keyword im Fenster schreiben **und
gerade zuschauen** sind im Topf — gleiches Los für alle, kein Punktesammeln.
**Gezogen wird live vom Streamer selbst**, das System sagt Fenster und
Gewinner im Chat an. Nur den Chat offen zu haben reicht nicht: wer nicht
als Zuschauer gemeldet ist, nimmt nicht teil. Meldet niemand Anwesenheit,
wird die Verlosung mit klarer Ansage abgebrochen statt leer gezogen.

### Mehrere Giveaways gleichzeitig

Ein Team kann jetzt **neben der laufenden Kampagne zusätzliche Giveaways**
starten — etwa eine spontane Verlosung mit eigenem Keyword, auch nur auf
einzelnen Kanälen. Im Dashboard gibt es dafür eine Giveaway-Auswahl neben der
Team-Auswahl (＋ startet eine Zusatz-Instanz, ✕ schließt sie). Boost, Pause
und Ziehung wirken auf das jeweils gewählte Giveaway. Zuschauzeit zählt
gleichzeitig für alle laufenden Giveaways, deren Kanäle man schaut.
Obergrenze: 4 gleichzeitige Giveaways je Team.

### Jedes Giveaway hat jetzt seinen eigenen Stand

Punktestände, Anmeldungen und Boosts gehören ab jetzt zum **einzelnen
Giveaway**, nicht mehr zum Team. Ein laufendes Giveaway übernimmt seinen
bisherigen Stand automatisch — für Zuschauer ändert sich nichts.

**Für Veranstalter wichtig:** Wer ein Giveaway schließt und ein neues öffnet,
startet das neue **bei null** — auch ohne vorheriges Zurücksetzen. Bisher
liefen alte Punktestände in so einem Fall stillschweigend weiter. Der Stand
des alten Giveaways bleibt bis zum Zurücksetzen erhalten (z.B. für Ziehungen
nach dem Schließen). Ein zeitlich begrenzter Boost gilt ebenfalls nur noch
für das Giveaway, in dem er gestartet wurde.

Das ist die Grundlage dafür, dass künftig **mehrere Giveaways gleichzeitig**
laufen können — siehe Roadmap.

---

## 3. August 2026

### Gewinnchancen wurden zu niedrig angezeigt — behoben

Der CSV- und der Chancen-Export haben die Gewinnwahrscheinlichkeit über **alle**
Zuschauer gerechnet statt nur über die zum Lostopf zugelassenen. Dadurch waren
alle ausgewiesenen Chancen systematisch zu niedrig.

**Die Ziehung selbst war davon nie betroffen** — sie hat immer korrekt nur unter
den Zugelassenen und gewichtet nach Losen gezogen. Falsch war ausschließlich die
Anzeige im Export. Der Export weist jetzt zusätzlich je Person aus, ob sie
zugelassen ist.

### Vergangene Giveaways sind vollständig einsehbar

Neue Seite **„Vergangene Giveaways"**. Zu jedem abgeschlossenen Giveaway stehen
dort beieinander: Sitzung und teilnehmende Kanäle, der Teilnehmerstand, jede
Ziehung mit Zufallswert und dem Stand aller Berechtigten zum Ziehungszeitpunkt,
das Protokoll des Zeitraums und die Gewinnermeldung.

Damit lässt sich jede Ziehung nachrechnen. Der Veranstalter kann das Ganze
zusätzlich als Archivdatei (`.tar.gz`) herunterladen.

### Gewinner melden sich selbst

Wer gezogen wird, meldet sich über die neue Seite **„Gewinn melden"** — mit dem
eigenen Twitch-Konto angemeldet. Name, E-Mail und, falls versandt wird, die
Anschrift trägt **nur der Gewinner selbst** ein; der Veranstalter kann das nicht
für ihn tun.

Diese Kontaktdaten werden **12 Monate nach der Meldung automatisch gelöscht**.
Die Meldefrist beträgt 14 Tage und ist auf der Seite tagesgenau ausgewiesen.

### Protokolle werden nicht mehr gelöscht, sondern anonymisiert

Bisher wurden Ziehungs- und Verwaltungsprotokoll nach zwölf Monaten gelöscht.
Das hat genau den Nachweis vernichtet, für den sie da sind.

Beide bleiben jetzt dauerhaft erhalten. Nach zwölf Monaten fallen stattdessen
die personenbezogenen Anteile weg: IP-Adressen werden entfernt, Benutzernamen
durch ein Pseudonym ersetzt. Was passiert ist, wann und mit welchem Ergebnis,
bleibt nachvollziehbar — wer es war, nicht mehr.

### Das Giveaway meldet sich im Chat

Öffnen, Schließen, Pause, Fortsetzen und Boost werden jetzt im Chat aller
teilnehmenden Kanäle angesagt — inklusive Grund, wenn die Automatik ausgelöst
hat („alle Streams offline"). Ein Boost nennt Dauer und Faktor und meldet sich
auch, wenn er ausläuft.

Vorher haben Zuschauer nur gemerkt, dass die Zuschauzeit schneller oder gar
nicht mehr lief, ohne zu erfahren warum.

### Eigene Seite für das Verwaltungsprotokoll

Das Protokoll war bisher ein kleines Fenster im Dashboard, das nur die letzten
200 Einträge zeigte. Jetzt gibt es eine eigene Seite mit Filtern nach Person,
Aktion, Ergebnis und Zeitraum, seitenweisem Nachladen und Export.

Gleiche Einträge, die kurz hintereinander entstehen, werden zu einer Zeile mit
Zähler zusammengefasst. Ein Fehler in der Rechteprüfung hatte zuvor Millionen
gleichartiger Einträge erzeugt und das Protokoll damit unlesbar gemacht — die
Ursache ist behoben.

### Zustimmung zu den Nutzungsbedingungen war blockiert

Der Zustimmen-Knopf schlug mit einer technischen Fehlermeldung fehl. Ursache war
eine Fehlkonfiguration im Zugangsschutz, die den Inhalt abgeschickter Formulare
verworfen hat. Betroffen waren alle Formulare hinter der Anmeldung, auch die
Löschung der eigenen Daten. Behoben.

---

## 24. Juli 2026

### Team-Mitglieder dürfen das Giveaway steuern

Bis dahin konnte nur der Team-Eigentümer ein Giveaway öffnen, pausieren,
fortsetzen oder einen Boost setzen. Das können jetzt alle Team-Mitglieder —
sinnvoll, wenn mehrere Kanäle abwechselnd streamen. Konfiguration, Ziehung und
Einsicht ins Protokoll bleiben beim Eigentümer.

---

## 20. Juli 2026

### Start der Plattform

Erste öffentliche Fassung des Multi-Kanal-Giveaways.

**Für Zuschauer**

- Zuschauzeit zählt über alle teilnehmenden Kanäle **zusammen** auf ein Konto.
  Die Kanäle streamen abwechselnd, niemand muss sich entscheiden.
- Sinnvolle Chatnachrichten geben zusätzliche Zuschauzeit. Chatinhalte werden
  **nicht** gespeichert — nur, ob eine Nachricht als sinnvoll gewertet wurde.
- Teilnahme per Keyword im Chat. Für den Lostopf zusätzlich: einer Mindestzahl
  der Kanäle folgen und genug Zuschauzeit gesammelt haben.
- Eigener Stand jederzeit über `!los` im Chat oder die Statusseite.
- Selbstauskunft und Löschung der eigenen Daten über **„Meine Daten"**, ohne
  Umweg über den Veranstalter.

**Für Veranstalter**

- Mehrere Kanäle als Team, gemeinsamer Punktetopf.
- Frei einstellbar: wie viel Zuschauzeit ein Los kostet, wie vielen Kanälen man
  folgen muss, wie stark der Chat-Bonus ausfällt.
- Zeitlich begrenzter Boost auf Zuschauzeit und Chat-Bonus.
- Automatisches Öffnen und Pausieren, wenn Streams online oder offline gehen.
- Optionale Bewertung der Chatqualität durch eine KI, mit eigenem Zugang je Team.
  Fällt sie aus, greift automatisch wieder die einfache Wortregel — der Chat
  blockiert nie.
- Gewichtete Ziehung mit vollständigem, nachrechenbarem Nachweis.
- Schutz vor Manipulation: Follow-Abgleich vor der Ziehung, Spam-Erkennung,
  lückenloses Verwaltungsprotokoll.

**Recht und Datenschutz**

- Impressum, Datenschutzerklärung, Nutzungsbedingungen und Haftungsausschluss
  öffentlich einsehbar.
- Klare Trennung: der Veranstalter verantwortet sein Gewinnspiel, die Plattform
  stellt die Technik.
- Zustimmung zu den Nutzungsbedingungen ist versioniert und wird erzwungen; ohne
  hinterlegtes Impressum lässt sich kein Giveaway öffnen.
- Teilnahme muss kostenlos bleiben — Bits, Subs oder Spenden dürfen die
  Gewinnchance nicht beeinflussen.
- Feste Löschfristen, automatisch angewendet.
