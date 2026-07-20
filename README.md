# CC-Giveaway

Multi-Channel-Community-Giveaway + Viewtime-Punktesystem für Twitch.
Eigenständiges System — keine Abhängigkeit zu anderen Streamer-Tools.

## Was es tut
- Misst **Viewtime pro Zuschauer** über mehrere teilnehmende Kanäle (die nicht
  gleichzeitig streamen). Viewtime zählt kanalübergreifend auf ein Konto.
- **Coin-Basis ist konfigurierbar:** „1 Coin = X Std Viewtime". Derselbe Wert ist
  die Lostopf-Schwelle — im Topf ist, wer **≥1 Coin** hat.
- Sinnvolle Chatnachrichten (>3 Wörter) geben etwas Viewtime dazu (selber Pott).
- **Viewtime-Multiplier:** zeitlich begrenzter Faktor (z.B. „15 min doppelte
  Viewtime"), gilt für Ticks und Chat-Bonus.
- Teilnahme: einer konfigurierbaren Zahl teilnehmender Kanäle folgen + Keyword im
  Chat schreiben (= Zustimmung zu den Teilnahmebedingungen).
- **Ziehung:** Zufall, gewichtet nach Coins. Voll nachvollziehbar — jede Ziehung
  wird mit Teilnehmer-Snapshot, Zufallswert und Follow-Audit gespeichert.
- **Audit-Log:** jede Aktion mit Einfluss auf den Giveaway-Stand wird mit Actor,
  IP, Ziel und Vorher/Nachher protokolliert — inkl. abgelehnter Versuche.
- **Streamermodus:** blendet Zuschauernamen und Ingest-Tokens im Admin-Panel aus,
  damit das Panel live gezeigt werden kann.

## Stack
Dockerisierte Microservices: **bridge** (Streamerbot-Ingest → Redis) ·
**giveaway** (Watchtime-Engine, Ziehung, WS/REST) · **admin** (Login + Admin-UI) ·
**Caddy** (Reverse Proxy) · **Redis** · **PostgreSQL**.

Streamerbot verbindet sich als WebSocket-**Client** zum Ingest-Endpoint und
authentifiziert per Kanal-Token — der Kanal kommt serverseitig aus dem Token,
nie aus dem Payload.

## Entwicklung
```bash
cp .env.example .env                # Twitch-Credentials eintragen
docker compose up -d --build        # lokal (HTTP, Caddyfile)
cd services/<name> && npm test      # node --test, Redis DB 1
```

## Dokumentation
- Konventionen, Architektur, Deploy: [CLAUDE.md](CLAUDE.md)
- Streamerbot-Setup: [streamerbot/CAMPAIGN_SETUP.md](streamerbot/CAMPAIGN_SETUP.md)
- Für Teilnehmer: [docs/ANLEITUNG-TEILNEHMER.md](docs/ANLEITUNG-TEILNEHMER.md) ·
  [docs/TEILNAHMEBEDINGUNGEN.md](docs/TEILNAHMEBEDINGUNGEN.md)

## Lizenz
[AGPL-3.0](LICENSE). Wer diesen Dienst gehostet anbietet, muss den Quellcode
seiner Version zugänglich machen.
