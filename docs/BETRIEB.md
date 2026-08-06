# Betrieb — Deploy, Datenbank, Runbook

Alles, was zum Betrieb der Produktivinstanz **team.raumdock.org** nötig ist.

---

## 1. Zugang

Ziel: **LXC 103 „streamer"** auf raumdock, intern `10.10.10.99`.
Projektpfad auf dem Host: `/opt/team-giveaway`.

**Nur über den Proxmox-Host, nie direkt zur LXC-IP:**

```bash
ssh -i ~/.ssh/claude_deploy root@ve.raumdock.org "pct exec 103 -- sh -c '<befehl>'"
```

Zu beachten: der Befehl läuft durch **drei** Ebenen (lokale Shell → ssh → `sh -c`).
Anführungszeichen müssen entsprechend geschachtelt werden — siehe
[SQL auf der Produktivdatenbank](#3-sql-auf-der-produktivdatenbank) für den
verlässlichen Weg um das Problem herum.

### Netzwerkweg

```
team.raumdock.org:443
  └─ LXC 101 nginx (L4 SNI-Passthrough)
       └─ 10.10.10.99:9444
            └─ cc-web (Caddy, TLS via Cloudflare DNS-01)
```

Port 80/443 auf LXC 103 sind anderweitig belegt, daher `:9444`.

---

## 2. Deploy

```bash
cd /opt/team-giveaway && git pull
docker compose -f docker-compose.yml -f docker-compose.team.yml -p team up -d --build
```

Compose-Projektname ist **`team`** — ohne `-p team` entstehen parallele
Container-Sätze.

Danach **verifizieren, nicht annehmen**: HTTP-Status der geänderten Seiten
prüfen und die neuen Strings per `curl` gegenlesen. Ein grünes `up -d` bedeutet
nur, dass der Container läuft.

Öffentliche Seiten (ohne Login erreichbar) müssen **200** liefern, keine
Weiterleitung zum Login:

```
/ · /admin/login.html · /admin/impressum.html · /admin/datenschutz.html
/admin/nutzungsbedingungen.html · /admin/haftungsausschluss.html
/viewer/status · /viewer/terms · /health
```

### INTERNAL_API_KEY (Team-Verwaltung, seit Aug 2026)

Shared-Secret zwischen admin- und giveaway-Service für den internen
Endpunkt `POST giveaway:/internal/team/cleanup` (Ingest-Token-Widerruf bei
Kanalwechsel/Austritt, Live-State-Wipe bei Team-Deaktivierung). In der
`.env` auf dem Server setzen:

```bash
grep -q INTERNAL_API_KEY .env || echo "INTERNAL_API_KEY=$(openssl rand -hex 24)" >> .env
```

Fehlt der Key, funktionieren die Team-Aktionen trotzdem (PG-Seite), nur das
Redis-Aufräumen wird übersprungen (`{skipped:'no_internal_key'}` im Audit-Detail).

### Deploy-Hinweise Core-Umbau (Branch `feature/EngineCores`)

Der erste Deploy dieses Standes hat gewollte, aber sichtbare Effekte:

1. **Alle Veranstalter müssen den Nutzungsbedingungen neu zustimmen**
   (`TOS_VERSION = 2`). Bereits **offene** Giveaways laufen weiter — nur das
   Öffnen (auch Auto-Open) ist bis zur Zustimmung blockiert. Das ist kein
   Fehlerbild.
2. **Neu-Öffnen ohne vorheriges Zurücksetzen startet bei null.** Vorher liefen
   Alt-Stände still weiter; jetzt hat jedes Giveaway seinen eigenen Stand
   (`t:<team>:g:<sid>:*`). Ein beim Deploy **laufendes** Giveaway übernimmt
   seinen Bestand automatisch (Lazy-Migration der Legacy-Schlüssel).
3. **Schema wächst automatisch** über `ensureSchema()` beim Start des
   giveaway-Containers: `credit_ledger`, `giveaway_prizes`, `prize_wagers`,
   neue Spalten an `sessions`/`giveaway_draws`. Kein manuelles SQL nötig.
4. **Sofortverlosungen brauchen `viewer_tick`-Meldungen** in Abständen unter
   10 Minuten (`PRESENCE_TTL` 600 s) — sonst ist niemand „anwesend" und die
   Verlosung bricht (mit Ansage) leer ab. Streamerbot-Actions sind unverändert;
   prüfen, dass `GW_ViewerTick` am Trigger *Present Viewers* hängt und feuert.
5. **`MAX_PARALLEL_GIVEAWAYS`** (ENV, Default 4) begrenzt gleichzeitige
   Giveaways je Team.
6. **Smoke-Test nach dem Deploy** (die neuen Pfade liefen bisher nur gegen
   Test-Mocks, nicht gegen echtes Redis/Postgres): Dashboard → ＋ →
   Sofortverlosung mit 60-s-Fenster auf dem eigenen Kanal, Keyword schreiben,
   Auto-Ziehung abwarten; danach ein Los-Giveaway öffnen, Preis anlegen,
   `!setzen <nr> 1` und `/giveaway/wager.html` prüfen. Fehler landen im
   Container-Log (`docker logs team-giveaway-1`) und im Audit-Log.

---

## 3. SQL auf der Produktivdatenbank

Container `cc-postgres`, **Benutzer und Datenbank heißen beide `chaoscrew`**
(nicht `postgres`, nicht `root` — das ist die häufigste Fehlerquelle; im Zweifel
`docker exec cc-postgres env | grep POSTGRES`).

Direktes Durchreichen von SQL scheitert an der Zitierung über die drei Ebenen.
Verlässlicher Weg — SQL base64-kodiert durchschleusen:

```bash
ssh -i ~/.ssh/claude_deploy root@ve.raumdock.org "pct exec 103 -- sh -c '
  B64=\$(printf \"SELECT id,name,owner_login FROM teams;\" | base64 -w0);
  echo \$B64 | base64 -d > /tmp/q.sql;
  docker cp /tmp/q.sql cc-postgres:/tmp/q.sql;
  docker exec cc-postgres psql -U chaoscrew -d chaoscrew -v ON_ERROR_STOP=1 -f /tmp/q.sql'"
```

Bei schreibenden Aussagen immer `BEGIN; … COMMIT;` plus `-v ON_ERROR_STOP=1`,
und im selben Skript ein `SELECT` zur Kontrolle nachstellen.

**Manuelle Eingriffe gehören ins Audit-Log.** Sie laufen nicht durch
`handleAdminCmd()`, also von Hand nachtragen:

```sql
INSERT INTO audit_log (team_id, actor, action, target, result, detail)
VALUES ('team_xxx', 'manual', '<aktion>', '<ziel>', 'ok', '{"...":"..."}');
```

### Team-Inhaberschaft übertragen

Kommt vor, wenn ein Team versehentlich am Bootstrap-Konto `admin` hängt.
`teams.owner_login` **und** `team_members` müssen zusammen gepflegt werden:

```sql
BEGIN;
UPDATE teams SET owner_login='<neu>' WHERE id='<teamId>' AND owner_login='<alt>';
DELETE FROM team_members WHERE team_id='<teamId>' AND login='<alt>';
INSERT INTO audit_log (team_id, actor, action, target, result, detail)
VALUES ('<teamId>','manual','team_owner_change','<alt>','ok',
        '{"from":"<alt>","to":"<neu>"}');
COMMIT;
```

Danach prüfen, ob der **neue** Owner den Nutzungsbedingungen zugestimmt hat —
das Gate in `gw_open` hängt an `teams.owner_login`, nicht am Bedienenden:

```sql
SELECT t.name, t.owner_login, a.version
  FROM teams t LEFT JOIN tos_acceptances a ON a.login = t.owner_login;
```

Fehlt die Zeile, verweigert `gw_open` mit `TOS_HINT`. Details:
[RECHT-UND-DATENSCHUTZ.md](RECHT-UND-DATENSCHUTZ.md).

---

## 4. Datensicherung

- **Automatisch:** Container `cc-backup`, täglich 03:00, sichert PostgreSQL.
- **Nicht** gesichert: der Live-Stand in Redis. Vor riskanten Eingriffen den
  manuellen JSON-Export im Admin-Panel ziehen (wahlweise mit Ziehungs- und
  Audit-Historie).
- **Redis DB 0 = produktiv, DB 1 = Tests.** Nie DB 0 in Testcode.

---

## 5. Fallstricke aus dem laufenden Betrieb

- **Windows-Checkout, Linux-Server:** `diff` zwischen lokalem Stand und Server
  meldet ohne `--strip-trailing-cr` jede Datei als verschieden (CRLF vs. LF).
- **`git add -A` in diesem Repo** zieht schnell Dateien mit, die lokal untracked,
  aber anderswo längst committet sind. Vor dem Commit `git status --short`
  gegenlesen.
- **Arbeitsverzeichnis auf dem Server sauber halten.** Nach `sed -i`-Läufen
  bleiben gern `*.bak-*`-Dateien liegen; ein fehlgeleitetes `2>&1` hat schon eine
  Datei namens `&1` erzeugt. `git status` auf dem Server zeigt das.
- **Öffentliche Seite hinzugefügt, aber Login verlangt** → Pfad fehlt in der
  `@needsauth not path`-Liste in `caddy/Caddyfile.team`.
