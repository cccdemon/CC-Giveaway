# Features

CC-Giveaway ist ein Verlosungssystem für Twitch, bei dem **Lose aus echter
Zuschauzeit entstehen** statt aus einem Klick zur richtigen Sekunde.

Es funktioniert für **einen einzelnen Kanal** genauso wie für ein **Team mit
mehreren Kanälen** — dann zählt die Zuschauzeit von allen Kanälen auf ein
gemeinsames Konto pro Zuschauer. Ein Team ist keine Voraussetzung; du kannst
allein anfangen und später Kanäle dazunehmen, ohne dass gesammelte Zeit
verlorengeht.

**Alle Regeln sind einstellbar.** Die Zahlen in diesem Dokument sind
Voreinstellungen, keine festen Vorgaben — siehe
[Was du einstellen kannst](#was-du-einstellen-kannst).

Drei Sichtweisen: [Streamer](#für-streamer) · [Streamteams](#für-streamteams) ·
[Zuschauer](#für-zuschauer-und-teilnehmer)

---

## Was du einstellen kannst

Nichts davon ist fest verdrahtet. Änderungen greifen sofort und rückwirkend —
Coins werden immer aus der gespeicherten Zuschauzeit berechnet, nie eingefroren.

| Einstellung | Bedeutung | Voreinstellung | Bereich |
|---|---|---|---|
| **Coin-Basis** | Wie viel Zuschauzeit ein Los kostet. Gleichzeitig die Schwelle für den Lostopf: drin ist, wer ≥1 Los hat. | 2 Stunden | 1 Minute – 100 Stunden |
| **Follow-Bedingung** | Wie vielen der teilnehmenden Kanäle jemand folgen muss. `0` schaltet die Bedingung ganz ab. | 2 Kanäle | 0 – 10 |
| **Keyword** | Das Wort, mit dem sich Zuschauer anmelden. Leer = keine Anmeldung nötig. | frei wählbar | beliebiger Text |
| **Chat-Bonus** | Zuschauzeit-Gutschrift für sinnvolle Nachrichten, mit Cooldown gegen Spam. | +2 s ab 4 Wörtern, 10 s Cooldown | 0–300 s, 1–50 Wörter, 0–3600 s |
| **KI-Bewertung** | Statt der Wortzahl entscheidet ein Modell, ob eine Nachricht sinnvoll ist. Anbieter und Modell pro Team, eigener API-Key. | aus | Anthropic / OpenAI / Gemini |
| **Viewtime-Multiplier** | Zeitlich begrenzter Faktor auf Zuschauzeit und Chat-Bonus. | aus | Faktor 1–10, 1 s – 24 h |
| **Automatik** | Giveaway startet/pausiert automatisch mit dem Stream-Status. | aus | an/aus |
| **Teilnehmende Kanäle** | Von einem bis viele. | dein eigener | 1 – n |

Für den **Einzelstreamer-Betrieb** setzt du die Follow-Bedingung auf `1` (nur
deinem eigenen Kanal folgen) oder `0` (Follow spielt keine Rolle). Alles andere
funktioniert unverändert.

---

## Für Streamer

### Einrichten und loslegen
- **Login per Twitch.** Kein separates Konto, kein Passwort. Der Twitch-Login
  ist gleichzeitig der Nachweis, dass dir dein Kanal gehört.
- **Streamerbot-Anbindung ohne Frickelei.** Streamerbot verbindet sich als
  WebSocket-**Client** zum System — du musst also keinen Port öffnen und nichts
  ins Internet stellen. Das Admin-Panel zeigt dir Endpoint und Kanal-Token zum
  Kopieren, dazu die C#-Actions zum Importieren.
- **Dein Kanal steckt im Token.** Welcher Kanal die Daten schickt, entscheidet
  serverseitig der Token — nicht der Payload. Ein manipulierter Bot kann keine
  Zuschauzeit für einen fremden Kanal buchen.
- **Token rotieren** mit einem Klick, falls er mal irgendwo gelandet ist.

### Steuerung während des Streams
- **Öffnen, pausieren, fortsetzen, schließen** — jederzeit, ohne dass der
  gesammelte Stand verlorengeht. Pause heißt: es läuft nichts weiter, aber alles
  bleibt stehen.
- **Automatik an Stream-Status gekoppelt.** Optional startet das Giveaway, wenn
  ein Kanal live geht, und pausiert, wenn alle offline sind. So sammelt niemand
  Zeit, während gar nicht gestreamt wird.
- **Viewtime-Multiplier.** Zeitlich begrenzter Boost, z.B. „die nächsten 15
  Minuten zählt doppelt". Gilt für Zuschauzeit und Chat-Bonus gleichermaßen.
  Läuft von selbst ab, du musst nichts zurückstellen.
- **Teilnehmerliste in Echtzeit** mit Coins, Zuschauzeit pro Kanal und
  Gesamtsumme, sortierbar, durchsuchbar.
- **Wer im Lostopf ist, siehst du sofort:** grün markiert und mit Badge. Gelb
  markiert sind die **Vorgemerkten** — die haben sich per Keyword angemeldet,
  erfüllen aber noch nicht alle Bedingungen. Sie rutschen automatisch nach,
  sobald es reicht, ohne das Keyword erneut zu schreiben.
- **Manuell nachhelfen:** Coins einzeln vergeben oder abziehen, Zuschauer
  sperren und entsperren.

### Die Ziehung
- **Gewichteter Zufall** nach Coins — mehr Zuschauzeit heißt bessere Chance,
  aber keine Garantie.
- **Testziehung** möglich, die getrennt markiert wird und die echte Historie
  nicht verfälscht.
- **OBS-Overlay** für den Gewinner, das du als Browserquelle einbindest.
- **Jede Ziehung ist reproduzierbar.** Gespeichert werden Gewinner, Coins,
  Teilnehmerzahl, der verwendete Zufallswert und ein vollständiger Snapshot
  aller Teilnehmer mit ihren Losanteilen. Du kannst also jederzeit belegen, dass
  sauber gezogen wurde.

### Nachvollziehbarkeit und Sicherheit
- **Audit-Log.** Jede Aktion, die den Stand verändert, wird protokolliert: wer,
  wann, an wem, mit Vorher/Nachher. Coin-Vergabe, Bans, Multiplier,
  Keyword-Änderungen, Resets, Ziehungen. Auch abgelehnte und fehlgeschlagene
  Versuche, und was das System selbst automatisch getan hat. Als CSV
  exportierbar.
- **Streamermodus.** Ein Klick blendet Zuschauernamen und Tokens aus, damit du
  das Panel live zeigen kannst. Kopieren und Bedienen funktioniert weiter — nur
  die Anzeige ist maskiert.
- **Anti-Abuse.** Wiederholte identische Nachrichten und Nachrichtensalven
  werden als Auffälligkeit markiert. Das System bannt niemanden von selbst — es
  zeigt dir nur, wo du hinschauen solltest.
- **Manuelles Backup.** Kompletter Stand als JSON exportierbar, wahlweise mit
  Ziehungs- und Audit-Historie. Zurückspielen entweder additiv oder ersetzend,
  beides mit Rückfrage und Protokolleintrag.

---

## Für Streamteams

> Dieser Abschnitt beschreibt den Mehr-Kanal-Betrieb. Als Einzelstreamer kannst
> du ihn überspringen — das System läuft mit einem einzigen Kanal genauso.

### Das Grundprinzip
- **Ein Giveaway, mehrere Kanäle.** Zuschauzeit von allen teilnehmenden Kanälen
  läuft auf ein gemeinsames Konto pro Zuschauer. Gedacht für Teams, die
  **nacheinander** streamen — die Community wandert mit, statt sich aufzuteilen.
- **Später erweiterbar.** Startest du allein und nimmst später Kanäle dazu,
  bleibt die bereits gesammelte Zuschauzeit aller Zuschauer erhalten.
- **Kein Kanal wird bevorzugt.** Es zählt die Summe, nicht wo sie entstanden
  ist. Ein Zuschauer, der nur bei einem Teammitglied guckt, ist genauso
  teilnahmeberechtigt wie einer, der überall vorbeischaut.
- **Follow-Bedingung als Team-Anreiz.** Ihr legt fest, wie vielen der
  teilnehmenden Kanäle jemand folgen muss, um in den Lostopf zu kommen
  (Voreinstellung: zwei, abschaltbar). Zuschauen zählt überall, aber Folgen ist
  die Eintrittskarte — so profitiert das ganze Team, nicht nur der Kanal mit den
  meisten Zuschauern.

### Team-Verwaltung
- **Team anlegen** und per **Einladungslink** Mitglieder aufnehmen. Jedes
  Mitglied loggt sich mit seinem eigenen Twitch-Konto ein.
- **Jeder verwaltet seinen eigenen Kanal.** Teammitglieder sehen und rotieren
  ihren eigenen Ingest-Token, kommen aber nicht an die Tokens der anderen und
  nicht an die Giveaway-Steuerung.
- **Nur der Team-Owner steuert das Giveaway** — öffnen, ziehen, Coins vergeben,
  Backups, Audit-Log einsehen. Alle anderen Zugriffe werden abgelehnt und dabei
  protokolliert.
- **Mitglieder entfernen** möglich; der Owner selbst kann nicht entfernt werden.
- **Mehrere Teams parallel** laufen sauber getrennt. Zuschauzeiten, Teilnehmer
  und Einstellungen eines Teams sind für andere Teams unsichtbar.

### Regeln, die ihr gemeinsam festlegt
- **Coin-Basis:** „1 Coin = X Stunden Zuschauzeit". Derselbe Wert ist die
  Schwelle für den Lostopf — drin ist, wer mindestens einen vollen Coin hat.
- **Follow-Schwelle:** wie vielen Team-Kanälen gefolgt werden muss.
- **Keyword:** das Wort, mit dem sich Zuschauer anmelden.
- **Automatik:** ob das Giveaway an den Stream-Status gekoppelt ist.

### Follow-Prüfung
- **Zweistufig.** Während des Streams meldet der Bot den Follow-Status live;
  vor der Ziehung wird zusätzlich per Twitch-API gegengeprüft.
- **Pro Kanal über den Token des jeweiligen Kanal-Owners.** Kanäle ohne
  eingeloggten Owner bleiben bewusst permissiv, statt Zuschauer fälschlich
  auszuschließen.
- **Abweichungen werden markiert**, nicht still korrigiert.

---

## Für Zuschauer und Teilnehmer

### Mitmachen
- **Zuschauen reicht zum Sammeln.** Zuschauzeit läuft, sobald du da bist — auch
  bevor du dich anmeldest. Du verlierst also nichts, wenn du das Keyword erst
  später schreibst.
- **Anmelden per Keyword im Chat.** Ein Wort genügt. Es zählt, sobald es als
  eigenes Wort in deiner Nachricht vorkommt — `!keyword bin dabei` funktioniert
  genauso wie das Keyword allein.
- **Einmal anmelden reicht.** Die Anmeldung bleibt bestehen. Wenn du die
  Bedingungen später erfüllst, rutschst du automatisch in den Lostopf, ohne
  nochmal etwas schreiben zu müssen.
- **Chatten bringt etwas.** Sinnvolle Nachrichten geben einen kleinen
  Zuschauzeit-Bonus, auf denselben Topf. Was als sinnvoll gilt, legt der
  Streamer fest — entweder über eine Mindest-Wortzahl oder, wenn aktiviert,
  über eine KI-Bewertung. Ein Cooldown verhindert, dass Spammen sich lohnt.
- **Kanal egal.** Läuft das Giveaway über mehrere Kanäle, macht es für deine
  Zuschauzeit keinen Unterschied, bei welchem du zuschaust — sie zählt zusammen.
- **Wie viel wofür nötig ist, legt der Streamer fest.** Wie lange eine Stunde
  Zuschauen wert ist und wie vielen Kanälen du folgen musst, steht in den
  Teilnahmebedingungen des jeweiligen Giveaways — `!los` sagt dir jederzeit
  deinen konkreten Stand.

### Deinen Stand sehen
- **`!los` im Chat** — der Bot sagt dir deine Punkte, deine Gewinnchance und,
  falls du noch nicht im Lostopf bist, **was genau dir noch fehlt** (Follows
  oder Zuschauzeit, mit Restzeit).
- **`!giveaway`** erklärt kurz die Regeln und verlinkt Status und
  Teilnahmebedingungen.
- **Statusseite im Browser.** Mit Twitch-Login siehst du deine Zuschauzeit,
  deine Coins, deine Gewinnchance in Prozent und deinen Fortschritt bis zur
  nächsten Schwelle — über alle Teams, an denen du teilnimmst.

### Fairness
- **Nur Zuschauen bringt Lose, nicht Glück beim Timing.** Es gibt kein
  Wettrennen um einen Klick — wer länger dabei ist, hat mehr Lose.
- **Mehr Lose heißt bessere Chance, nicht sichere Chance.** Gezogen wird
  gewichtet zufällig; auch mit einem Los kannst du gewinnen.
- **Die Ziehung ist überprüfbar.** Jede Ziehung speichert die vollständige
  Teilnehmerliste mit Losanteilen und den verwendeten Zufallswert. Der Streamer
  kann jederzeit belegen, dass nichts nachgeholfen wurde.
- **Anmelden heißt zustimmen.** Das Keyword zu schreiben gilt als Zustimmung zu
  den Teilnahmebedingungen, die als Seite verlinkt sind.
- **Gewinner haben eine Meldefrist**, die in den Teilnahmebedingungen des
  jeweiligen Giveaways steht (Vorschlag im Standardtext: 14 Kalendertage). Wer
  sich nicht meldet, verliert den Gewinn; der Veranstalter darf einen
  Ersatzgewinner ziehen.

### Datenschutz
- Gespeichert wird, was fürs Giveaway nötig ist: dein Twitch-Name, Zuschauzeit
  und Nachrichtenzahl pro Kanal, Follow-Status, Anmeldung.
- **Chat-Inhalte werden im Normalfall nicht gespeichert.** Für den Bonus zählt
  nur, ob eine Nachricht lang genug war — der Text selbst wird verworfen.
  **Ausnahme:** Wird eine Nachricht als Spam auffällig (mehrfach identisch), wird
  ein Auszug von bis zu 140 Zeichen als Beleg zum Flag gespeichert, damit der
  Streamer die Markierung nachvollziehen und ungerechtfertigte Flags erkennen
  kann.
- Der Streamer kann seine Teilnehmerliste einsehen und exportieren — das ist
  nötig, um Gewinner zu kontaktieren und die Ziehung zu belegen.
- **Deine Daten selbst einsehen und löschen:** unter „Meine Daten" siehst du mit
  Twitch-Login alles, was zu dir gespeichert ist, kannst es als JSON
  herunterladen und die Löschung selbst auslösen — ohne Mail, ohne Wartezeit.

---

## Rechtlicher Rahmen

- **Kein Glücksspiel — und das ist verbindlich.** Die Nutzungsbedingungen
  verbieten, Lose oder die Teilnahme an eine Gegenleistung zu koppeln: kein Kauf,
  keine Abos (auch keine geschenkten), keine Bits, Trinkgelder, Spenden oder
  Guthaben. Auch Geld- und Krypto-Preise sind ausgeschlossen. Technisch entstehen
  Lose ohnehin nur aus Zuschauzeit und Chat — es gibt keinen Weg, Geld in Lose zu
  verwandeln.
- **Zustimmung ist Pflicht, nicht Dekoration.** Wer ein Team führt, muss den
  Nutzungsbedingungen zugestimmt haben — sonst lassen sich weder Teams anlegen
  noch Giveaways öffnen. Jede Zustimmung wird mit Version und Zeitstempel
  gespeichert; ältere Zustimmungen bleiben als Nachweis erhalten.
- **Veranstalter bleibt der Streamer.** Die Plattform stellt das Werkzeug, das
  Gewinnspiel veranstaltet der Streamer — mit eigenem Impressum und eigenen
  Teilnahmebedingungen. Ohne hinterlegtes Impressum lässt sich kein Giveaway
  öffnen.
- **Alle Rechtstexte sind ohne Login erreichbar** — Impressum, Datenschutz,
  Nutzungsbedingungen und Haftungsausschluss, dazu die Teilnahmebedingungen des
  jeweiligen Giveaways. Verlinkt sind sie in der Team-Karte und auf der
  Zuschauer-Statusseite, jeweils mit Kopierknopf.
- **Löschen heißt nicht Beweise vernichten.** Wird ein Konto gelöscht,
  verschwinden Zuschauzeit und Teilnahmedaten; in bereits erfolgten Ziehungen
  wird der Name durch ein Pseudonym ersetzt, damit die Ziehung überprüfbar
  bleibt. Jeder Auskunfts- und Löschvorgang steht im Audit-Log — auch der reine
  Zugriff, bewusst ohne IP-Adresse.

---

## Was das System (noch) nicht tut

Ehrlich gesagt, damit niemand falsche Erwartungen hat:

- **Die Rechtstexte sind nicht anwaltlich geprüft.** Sie sind nach bestem Wissen
  formuliert und decken die üblichen Punkte ab, ersetzen aber keine Prüfung vor
  einem öffentlichen Launch.
- **Kein automatischer Gewinner-Kontakt.** Das System zieht und protokolliert;
  Anschreiben und Preisversand macht der Streamer von Hand.
- **Keine Mehrfachpreise in einem Zug.** Mehrere Gewinner ziehst du nacheinander.
- **Kein automatischer Ausschluss bei Auffälligkeiten.** Anti-Abuse markiert nur,
  die Entscheidung bleibt beim Streamer.
- **Der Audit-Log ist append-only per Konvention, nicht per Datenbankrecht.** Wer
  direkten Datenbankzugriff hat, könnte Einträge entfernen. Für echten
  Beweiswert bräuchte es eine Hash-Kette oder getrennte Schreibrechte.
- **Kein automatisches Offsite-Backup der Live-Daten.** Der Export ist manuell;
  die nächtliche Sicherung deckt die Datenbank ab, nicht den Live-Stand in Redis.
