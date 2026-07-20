# Recht & Datenschutz — technische Umsetzung

Wie die rechtlichen Anforderungen im Code verankert sind. Für die Texte selbst
siehe `services/admin/public-docs/`.

> Kein Rechtsrat. Die Texte sind nach bestem Wissen formuliert, aber vor einem
> öffentlichen Launch anwaltlich zu prüfen — insbesondere § 4 der
> Nutzungsbedingungen (Glücksspielabgrenzung, § 284 StGB).

---

## 1. Die Dokumente

| Datei (`services/admin/public-docs/`) | Öffentlich unter | Zweck |
|---|---|---|
| `impressum.md` | `/admin/impressum.html` | Plattformbetreiber, § 5 DDG / § 18 Abs. 2 MStV |
| `datenschutz.md` | `/admin/datenschutz.html` | DSGVO-Informationspflichten, Betroffenenrechte |
| `nutzungsbedingungen.md` | `/admin/nutzungsbedingungen.html` | Vertrag Plattform ↔ Veranstalter, **Glücksspielausschluss** |
| `haftungsausschluss.md` | `/admin/haftungsausschluss.html` | Rollenabgrenzung, kein Rechtsanspruch, kein Glücksspiel |
| `help.md`, `setup.md` | `/admin/*.html` | Anleitungen |

Ausgeliefert werden sie als Markdown über `GET /admin/pub/doc/:name`
(Whitelist `PUB_DOCS` in `services/admin/server.js`) — **ohne Login**. Neue
öffentliche Seite = drei Stellen:

1. Datei in `public-docs/` anlegen
2. Eintrag in `PUB_DOCS`
3. Pfad in die `@needsauth not path`-Ausnahmeliste in `caddy/Caddyfile.team`

Wird 3. vergessen, verlangt Caddy einen Login und die Seite ist faktisch nicht
öffentlich — das ist der häufigste Fehler hier.

Davon zu trennen: die **Teilnahmebedingungen des einzelnen Giveaways**. Die
gehören dem Veranstalter, liegen pro Team in der DB (`terms_versions`) und sind
unter `/viewer/terms?team=<teamId>` erreichbar. Vorlage:
[TEILNAHMEBEDINGUNGEN.md](TEILNAHMEBEDINGUNGEN.md).

---

## 2. Glücksspielabgrenzung

Glücksspiel nach **§ 3 Abs. 1 GlüStV 2021** braucht drei Elemente:
**Entgelt** + **Zufall** + **Gewinnchance**. Zufall und Gewinn sind hier
produktinhärent — steuerbar ist nur das Entgelt. Deshalb setzt § 4 der
Nutzungsbedingungen genau dort an:

- Teilnahme muss **unentgeltlich** sein — weder als Voraussetzung noch als
  Losvorteil dürfen Kauf, Twitch-Abos (auch geschenkte), Bits, Cheers,
  Trinkgelder, Spenden, Kryptowährungen oder Guthaben verlangt werden.
- **Keine Geld-, Krypto-, Wett- oder Casinoguthaben als Preise.**
- Keine Bewerbung von Glücksspielangeboten im Umfeld des Giveaways.
- Kein Handel mit Losen.

**Strukturell abgesichert:** Lose entstehen ausschließlich aus Viewtime und
Chat-Bonus. Es gibt keinen Codepfad, der Bits, Subs oder Spenden in Lose
verwandelt. Die einzige manuelle Lücke ist `gw_add_ticket` — die ist textlich
über § 4 Abs. 3 geschlossen, und jede Vergabe steht mit Actor und Menge im
`audit_log`, ist also im Streitfall belegbar.

---

## 3. Zustimmung zu den Nutzungsbedingungen

Versioniert und als Beweismittel append-only — eine Zustimmung wird nie
überschrieben, jede Version bekommt eine eigene Zeile.

```sql
CREATE TABLE tos_acceptances (
  login       TEXT NOT NULL,
  version     INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (login, version)
);
```

**`TOS_VERSION` steht doppelt im Code** — in `services/admin/server.js` und in
`services/giveaway/server.js`. Bei jeder inhaltlichen Änderung der
Nutzungsbedingungen **beide** erhöhen, sonst prüfen die Services gegen
verschiedene Stände. Kommentare an beiden Stellen weisen darauf hin.

Durchgesetzt wird die Zustimmung an drei Ebenen — Text allein reicht nicht:

| Ebene | Ort | Verhalten ohne Zustimmung |
|---|---|---|
| API | `requireTos()` in `services/admin/server.js` | **HTTP 451** `{error:'tos_required'}` bei Team anlegen/beitreten, Einladung, Teilnahmebedingungen und Impressum speichern |
| Giveaway | `ownerAcceptedTos(teamId)` in `services/giveaway/server.js` | `gw_open` und Auto-Open verweigern mit `TOS_HINT`; Auto-Open auditiert `{reason:'no_tos'}` |
| UI | IIFE am Ende von `services/admin/public/admin-shared.js` | Blockierendes Overlay mit Checkbox auf jeder Admin-Seite |

Das Giveaway-Gate hängt an **`teams.owner_login`**, nicht am eingeloggten
Benutzer. Wechselt die Team-Inhaberschaft auf jemanden ohne Zustimmung, blockiert
`gw_open` — auch wenn der Bedienende selbst zugestimmt hat. Direkt danach greift
dieselbe Logik für das Veranstalter-Impressum (`hasImprint`).

Bestehende Teams behalten nach einer Textänderung ihre alten, selbst
gespeicherten Teilnahmebedingungen — die Vorlage wird nicht rückwirkend
ausgerollt.

---

## 4. Selbstauskunft und Löschung (DSGVO Art. 15 / 17 / 20)

Seite: `services/admin/public/meine-daten.html` → `/admin/meine-daten.html`.

| Endpoint | Wirkung |
|---|---|
| `GET /api/me/data` | Auskunft über alle eigenen Datensätze, als JSON herunterladbar |
| `POST /api/me/delete` | Löschung/Pseudonymisierung, Bestätigung durch Tippen des eigenen Namens |
| `GET /api/gdpr/:login` (Admin) | dasselbe für Dritte, wird ebenfalls auditiert |
| `POST /api/gdpr/:login/delete` (Admin) | dito |

**Identitätsnachweis:** der Benutzername kommt bei den `/api/me/*`-Routen
ausschließlich aus der Session, nie aus Parameter oder Body. Der Twitch-Login
ist damit der Nachweis — ohne Zusatzabfrage, ohne Ausweiskopie.

Geteilt in `collectSubjectData(u)` (8 parallele Queries) und `eraseSubject(u, …)`,
beide von Selbst- und Admin-Pfad genutzt, damit die Pfade nicht auseinanderlaufen.

### Was gelöscht und was pseudonymisiert wird

Hart gelöscht: `watchtime_events`, `campaign_participation`, `abuse_flags`,
`session_participants`, `users`.

Zusätzlich, **nur wenn die Person kein Team führt**: `team_members`,
`tos_acceptances`, `streamers`. Führt sie ein Team, bleiben Login und Zustimmung
stehen — sonst verlöre der Veranstalter seine Vertragsgrundlage. Die Antwort
enthält dann `konto_behalten`, die Selbstlöschung bricht mit **HTTP 409** ab und
nennt den Grund.

**Pseudonymisiert statt gelöscht** werden Ziehungsnachweise —
`giveaway_draws.winner`, `eligible_snapshot` (per `REPLACE` auf `::text`) und
`audit_log.target`. Ersetzt durch:

```js
'geloescht_' + crypto.createHash('sha256').update(login).digest('hex').slice(0, 8)
```

Begründung: **Art. 17 Abs. 3 lit. e DSGVO** — die Nachweise werden zur Geltendmachung
und Verteidigung von Rechtsansprüchen gebraucht. Ein Ziehungsprotokoll mit
gelöschten Teilnehmern wäre als Beweis wertlos. Das Pseudonym ist stabil, die
Ziehung bleibt reproduzierbar, die Person ist nicht mehr identifizierbar.

### Auditierbarkeit

`auditGdpr()` schreibt **auch reine Zugriffe** (`gdpr_self_access`,
`gdpr_access`) sowie `denied` und `error` ins `audit_log`. Bewusst **ohne
IP-Adresse** — die Datenschutzerklärung sagt zu, diese Zugriffe nicht mit IP zu
protokollieren. Schlägt der Audit-Insert fehl, wird das über `logErr` sichtbar,
bricht die Operation aber nicht ab.

---

## 5. Offene Punkte

- Nutzungsbedingungen und Haftungsausschluss sind **nicht anwaltlich geprüft**.
- Die Datenschutzerklärung hat einen Platzhalter für den
  **Drittlandtransfer-Hinweis** bei KI-Anbietern — auszufüllen, bevor die
  KI-Bewertung produktiv geschaltet wird.
- Der `audit_log` ist append-only **per Konvention**, nicht per Datenbankrecht.
  Für echten Beweiswert bräuchte es eine Hash-Kette oder getrennte Schreibrechte.
