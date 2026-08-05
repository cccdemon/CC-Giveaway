# Änderungsprotokoll

Was sich an dieser Plattform geändert hat — für Zuschauer und Veranstalter.
Neueste Änderung oben. Die Roadmap zeigt, was als Nächstes ansteht.

---

## 6. August 2026

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
