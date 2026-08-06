# So funktioniert Team Giveaway

Diese Seite erklärt genau, wie das System arbeitet — technisch, aber ohne
Fachchinesisch. Sie beschreibt den tatsächlichen Stand der Plattform; was
sich ändert, steht im [Änderungsprotokoll](/admin/changelog.html).

---

## Die gemeinsame Basis

**Zuschauzeit wird gemessen, nicht geschätzt.** Auf jedem teilnehmenden
Kanal läuft beim Streamer ein kleines Hilfsprogramm (Streamerbot), das etwa
einmal pro Minute meldet, wer gerade zuschaut. Jeder Kanal authentifiziert
sich dafür mit einem eigenen geheimen Zugangs-Token — der Kanalname kommt
immer aus dem Token, nie aus der Meldung selbst. Wer länger als 10 Minuten
keine Meldung hat, gilt nicht mehr als anwesend.

**Chat zählt dazu — der Inhalt wird nicht gespeichert.** Jede sinnvolle
Chat-Nachricht mit mehr als 3 Wörtern gibt einen kleinen Zuschauzeit-Bonus
(Standard: +2 Sekunden), mit Abkühlzeit gegen Spam. Gespeichert wird nur,
DASS eine Nachricht gewertet wurde — nicht ihr Text. Optional kann der
Veranstalter eine KI die Wortzählung ersetzen lassen; fällt die KI aus,
gilt automatisch wieder die Wortregel, der Chat blockiert nie.

**Follows werden doppelt geprüft.** Das Live-Signal aus dem Stream setzt
den Follow-Status sofort; vor jeder echten Ziehung (und bei Bedarf beim
Seitenaufruf) wird er zusätzlich direkt bei Twitch verifiziert. Weicht
beides voneinander ab, wird das markiert.

**Regeln gelten pro Giveaway.** Werte wie „1 Los = X Stunden",
Follow-Mindestzahl oder Chat-Bonus sind Team-Vorgaben; beim Start bekommt
jedes Giveaway eine eigene Kopie. Änderungen während des Laufs wirken nur
auf dieses eine Giveaway.

**Die Ziehung ist nachrechenbar.** Gezogen wird mit kryptographischem
Zufall, gewichtet nach Losen. Zu jeder Ziehung wird ein vollständiger
Schnappschuss des Lostopfs gespeichert (wer, mit wie vielen Losen, mit
welchem Zufallswert). Ziehungsnachweise werden nie gelöscht — nach zwölf
Monaten nur anonymisiert. Jede Verwaltungsaktion landet in einem
Protokoll, das ebenfalls nie gelöscht wird.

**Nach dem Gewinn.** Der Gewinner wird im Chat angesagt und hat 14 Tage
Zeit, sich zu melden — über eine eigene Seite (Login mit Twitch), auf der
nur er selbst seine Kontaktdaten einträgt. Meldet er sich stattdessen z. B.
per WhatsApp, erfasst der Veranstalter das mit einem Klick. Kontaktdaten
werden spätestens nach zwölf Monaten automatisch gelöscht, der
Ziehungsnachweis bleibt.

**Kein Geld, nirgends.** Teilnahme kostet nichts und kann nicht gekauft
werden. Bits, Subs, Spenden oder Käufe haben keinerlei Einfluss auf
Gewinnchancen — es gibt im System schlicht keine Buchungswege dafür.

Bis zu **4 Giveaways gleichzeitig** je Team, auch verschiedene Mechaniken
parallel (je Team maximal ein Los-Giveaway und ein Screenshot-Contest).

---

## Kampagne

Das Langzeit-Giveaway über Wochen, über einen oder mehrere Kanäle.

- **Sammeln:** Zuschauzeit auf allen Team-Kanälen zählt auf dasselbe
  Konto. Standard: **2 Stunden = 1 Los** (einstellbar). Sinnvoller Chat
  gibt den Zeitbonus obendrauf; der Veranstalter kann zeitweise einen
  Multiplier schalten („nächste 15 Minuten doppelt").
- **Anmelden:** Ein frei wählbares Keyword im Chat meldet an — das ist
  zugleich die Zustimmung zu den Teilnahmebedingungen. Die Anmeldung
  bleibt bestehen, das Keyword muss nicht wiederholt werden.
- **In den Lostopf** kommt, wer angemeldet ist, genug Kanälen folgt
  (Standard: 2, einstellbar 0–10) und mindestens 1 Los voll hat.
- **Ziehung:** Zufall, gewichtet nach Losen — doppelt so viele Lose,
  doppelte Chance. Reine „Lurker" ohne Anmeldung nehmen nicht teil.

## Sofortverlosung

Die schnelle Verlosung zwischen zwei Runden — gleiche Chance für alle.

- Der Streamer öffnet ein **Anmeldefenster** (z. B. 60 Sekunden — auch
  mehrfach; wer angemeldet ist, bleibt es).
- Teilnahme: das Keyword **im offenen Fenster** schreiben UND gerade
  wirklich zuschauen (Anwesenheit laut Zuschauer-Meldung, nicht nur
  offener Chat-Tab).
- Jeder Berechtigte hat **genau ein Los** — Zuschauzeit spielt hier keine
  Rolle. Gezogen wird **manuell** vom Streamer (★ im Dashboard); die
  Anwesenheit zählt zum Zeitpunkt der Ziehung.
- Die Chat-Ansagen der Sofortverlosung lassen sich stummschalten — die
  Gewinner-Ansage kommt immer.

## Los-Giveaway

Zuschauzeit wird zu Guthaben, das gezielt eingesetzt wird.

- Während das Los-Giveaway läuft, sammelt Zuschauzeit **Los-Guthaben**
  (gleiche Umrechnung wie die Kampagne, einstellbar). Beim Schließen
  wandert der erspielte Stand auf ein team-weites Konto und bleibt für das
  nächste Los-Giveaway erhalten.
- Der Veranstalter legt **Preise** an (mit Titel, Sponsor, Beschreibung,
  Bild und optionalem Einsatz-Ende).
- **Setzen:** per Chat-Befehl (Standard `!setzen <preis-nr> <anzahl>`,
  frei konfigurierbar) oder auf der Setz-Seite im Web. Bis zum
  Einsatz-Ende kann ein Einsatz komplett zurückgenommen werden.
- **Ziehung je Preis**, gewichtet nach Einsatz. Nach der Ziehung sind die
  Einsätze **aller** Setzer dieses Preises verbraucht — sonst wäre Setzen
  risikolos. Jede Buchung steht in einem Journal, das nur Gegenbuchungen
  kennt, nie Löschungen.
- Guthaben verfällt nach 12 Monaten ohne Bewegung. Kaufen, Übertragen
  oder Auszahlen gibt es nicht.

## Screenshot-Contest

Die Community entscheidet — kreativ statt Zufall.

- **Einsenden** darf, wer einem Contest-Kanal folgt und die
  Mindest-Zuschauzeit hat (Standard: 10 Minuten, einstellbar). **Ein Bild
  pro Person** (PNG/JPG, Full HD bis 4K, max. 7 MB). Ersetzen geht — die
  bereits erhaltenen Stimmen verfallen dabei (mit Warnung), Zurückziehen
  löscht das Bild.
- **Freigabe-Pflicht:** Jede Einsendung prüft der Veranstalter, bevor sie
  sichtbar wird. Er kann Freigaben korrigieren und Einsendungen bei
  Regelverstoß endgültig löschen.
- **Voting:** Sobald der Veranstalter es öffnet, bewertet die Community
  freigegebene Bilder mit **1–10 Punkten** — eine Stimme je Bild und
  Person, erneutes Voten überschreibt die eigene Wertung. Die eigene
  Einsendung ist tabu; gegen Vote-Bots gelten Mindest-Zuschauzeit und
  Frequenz-Limits.
- **Gewinner** ist die höchste Punktsumme. Bei Gleichstand entscheidet
  das Los unter den Führenden — über dieselbe nachrechenbare Ziehung.

---

## Nachweis und Datenschutz

Jede abgeschlossene Sitzung liegt im Archiv: Teilnehmerstand (kumuliert je
Zuschauer, aufgeschlüsselt nach Kanal), alle Ziehungen mit Schnappschuss,
Gewinnermeldung und Protokoll — als Seite und als Export. Zusammengehörige
Sitzungen einer langen Kampagne werden als Ganzes dargestellt.

Zuschauer sehen ihren eigenen Stand jederzeit auf der
[Status-Seite](/viewer/status) und können über
[Meine Daten](/admin/meine-daten.html) Auskunft und Löschung verlangen.
Details: [Datenschutzerklärung](/admin/datenschutz.html) ·
[Teilnehmer-Anleitung](/viewer/help).
