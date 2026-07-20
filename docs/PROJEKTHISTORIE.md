# Projekthistorie & Neuaufsetzen

Was ein frischer Checkout wissen muss, das nicht im Code steht.

---

## 1. Herkunft

CC-Giveaway ist aus der **CC-StreamSuite** hervorgegangen, ist aber **kein Fork
mehr**: keine Abhängigkeit zu Spacefight, Alerts, HUD-Chat, Gamescenes, Stats
oder Hauling.

Die beiden Repositories haben **keine gemeinsame Historie** — `git merge-base`
zwischen ihnen liefert nichts. Wer versucht, zwischen ihnen zu mergen oder zu
rebasen, arbeitet gegen unrelated histories; Änderungen werden zwischen den
Repos von Hand übertragen, nicht gemerged.

| | |
|---|---|
| Aktives Repo | `https://github.com/cccdemon/CC-Giveaway.git` (Remote `origin`, Branch `main`) |
| Altes Repo | `git@github.com:cccdemon/STS_Streamertools_Twitch_Streamerbot.git` |

**Push ausschließlich über HTTPS mit dem `gh`-Credential-Helper.** Lokale
SSH-Keys sind für diese Repos nicht autorisiert und laufen in
„correct access rights"-Fehler.

## 2. Altbestände auf dem Entwicklungsrechner

Diese liegen **nur lokal** und sind in keinem Checkout enthalten:

- Sicherung `…/CC/_backup-CC-StreamSuite-20260720-123218/` —
  `full-history.bundle` (vollständige Historie, 8 Refs), `env.backup`,
  drei `package-lock.json`.
- Branches `streamsuite-main`, `streamsuite-teamgiveaway`,
  `streamsuite-architecture-switch` im alten Arbeitsverzeichnis. Die Commits
  `88e5641` und `141989d` existieren **ausschließlich** dort und im Bundle.

Solange diese Commits nicht anderweitig gesichert sind, darf weder der
Backup-Ordner noch das alte Arbeitsverzeichnis gelöscht werden.

---

## 3. Frisches Arbeitsverzeichnis aufsetzen

```bash
git clone https://github.com/cccdemon/CC-Giveaway.git
cd CC-Giveaway
cp .env.example .env      # Twitch-Credentials eintragen
docker compose up -d --build
cd services/giveaway && npm test
```

Nicht im Repo enthalten und daher aus dem alten Verzeichnis zu übernehmen:

- **`.env`** — Twitch-Client-ID/-Secret, Session-Secret, DB-Zugangsdaten.
  Kopie liegt unter `env.backup` in der Sicherung.
- `.claude/settings.local.json` — lokale Claude-Code-Einstellungen, bewusst
  ignoriert statt versioniert. (Wurde bei der Migration einmal von einem
  Branchwechsel entfernt, weil sie im alten Repo getrackt war.)

Geheimnisse gehören **nie** ins Repo und nie in Server-Umgebungsvariablen, wenn
sie konfigurierbar sein sollen — API-Keys für die KI-Bewertung werden
verschlüsselt in der Datenbank abgelegt und über die GUI gepflegt
(`app_secrets`).

---

## 4. Orientierung im Repo

| Ich will … | … lesen |
|---|---|
| wissen, was das System kann | [../FEATURES.md](../FEATURES.md) |
| Architektur, Konventionen, Dateiübersicht | [../CLAUDE.md](../CLAUDE.md) |
| deployen oder an die Produktiv-DB | [BETRIEB.md](BETRIEB.md) |
| Recht, DSGVO, Zustimmungslogik | [RECHT-UND-DATENSCHUTZ.md](RECHT-UND-DATENSCHUTZ.md) |
| Streamerbot anbinden | [../streamerbot/CAMPAIGN_SETUP.md](../streamerbot/CAMPAIGN_SETUP.md) |
| Teilnehmern etwas erklären | [ANLEITUNG-TEILNEHMER.md](ANLEITUNG-TEILNEHMER.md) · [TEILNAHMEBEDINGUNGEN.md](TEILNAHMEBEDINGUNGEN.md) |
