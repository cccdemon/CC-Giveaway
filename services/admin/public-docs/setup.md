# Streamerbot-Anbindung — Team Giveaway (wasserdicht)

Diese Anleitung verbindet **deinen** Twitch-Kanal mit einem Team-Giveaway.
Jeder teilnehmende Streamer macht das **einmal** auf seinem eigenen PC.

## So funktioniert es (Kurz)
```
Dein Streamerbot ──(WebSocket-Client, wss)──► team.raumdock.org/ingest
    Events raus:  viewer_tick · chat_msg · time_cmd   (Kanal kommt aus dem Token)
    zurück rein:  chat_reply                          (postet CC_ChatReply in deinen Chat)
```
Der **Kanal wird serverseitig aus dem Token abgeleitet** — du schickst ihn nie mit,
niemand kann sich als dein Kanal ausgeben.

---

## Schritt 1 — Team + Giveaway (macht der Team-Owner, einmal)
1. Auf **https://team.raumdock.org/** mit Twitch anmelden.
2. **MEINE TEAMS** → *Team gründen* → Name vergeben.
3. Invite-Link kopieren und an die Mit-Streamer schicken.
4. Mit-Streamer öffnen den Link → mit Twitch anmelden → sind im Team.

## Schritt 2 — Ingest-Token holen (jeder Streamer)
1. Owner öffnet **GW ADMIN** → oben rechts das **Team wählen**.
2. Karte **STREAM-VERBINDUNGEN** → beim eigenen Kanal **GENERIEREN**.
3. Den erzeugten **Token kopieren** (langer Zufallsstring). Das ist dein Kanal-Geheimnis.
   > Token verloren/geleakt? Einfach **NEU** klicken — der alte wird sofort ungültig.

## Schritt 3 — WebSocket-Client in Streamerbot (v1.0.x)
1. Streamerbot → Tab **Servers/Clients** → **WebSocket Clients**.
2. **Add** / neuer Client:
   - **Endpoint:** `wss://team.raumdock.org/ingest`  (kein ws:// selbst tippen — volle URL einfügen)
   - **Auto Connect on Startup:** ✅ an
   - **Reconnect on Disconnect:** ✅ an
   - **TLS Support:** TLS 1.2 ✅
3. Merke dir den **Index** dieses Clients. Der erste ist **0** (die Actions nutzen 0).
   Falls dein Client einen anderen Index hat, in den Actions `CPH.WebsocketSend(payload, 0)` die `0` anpassen.

## Schritt 4 — Token als globale Variable
Der Token darf **nicht** im Klartext in der Action stehen. Setze ihn einmalig als globale Variable:
1. Neue Action **„CC – Set Token"**, Trigger egal (oder manuell einmal ausführen).
2. Sub-Action **Core → Global Variable → Set Global Variable**:
   - **Name:** `cc_ingest_token`
   - **Value:** *(dein Token aus Schritt 2)*
   - **Persisted:** ✅ an
3. Action **einmal manuell ausführen** (Test-Button). Danach kann sie gelöscht werden — der Wert bleibt persistent gespeichert.

## Schritt 5 — Actions importieren + Trigger
Importiere die C#-Actions aus diesem Ordner (Streamerbot → **Import** oder Action anlegen + Code einfügen als **Execute C# Code**). Ordne die Trigger zu:

| Action | Trigger in Streamerbot |
|---|---|
| `CC_IngestConnect.cs` | **Core → WebSocket → Client → Opened** |
| `CC_ChatReply.cs` | **Core → WebSocket → Client → Message** |
| `GW_ViewerTick.cs` | **Twitch → General → Present Viewers** |
| `GW_ChatMessage.cs` | **Twitch → Chat → Message** |
| `GW_StatusCmd.cs` | **Command** `!los` (Aliase `!status !zeit !chance !time`) |
| `GW_GiveawayCmd.cs` | **Command** `!giveaway` (Alias `!gw`) |
| `GW_StreamOnline.cs` | **Twitch → Channel → Stream Online** |
| `GW_StreamOffline.cs` | **Twitch → Channel → Stream Offline** |

> Jede C#-Action braucht `Newtonsoft.Json` — ist in Streamerbot vorinstalliert.

## Schritt 6 — Test-Checkliste
1. **Verbindung:** Servers/Clients → WebSocket Clients zeigt Status **Open** (grün).
2. **Auth:** Streamerbot-Log (unten) zeigt `[CC] Ingest-Auth gesendet`. Im Admin-Panel wird dein Kanal aktiv.
3. **Chat-Test:** schreib im eigenen Chat eine sinnvolle Nachricht (>3 Wörter) → im **GW ADMIN** taucht dein Zähler auf.
4. **Status:** `!los` im Chat → Bot antwortet mit deinen Punkten. (Bei „kein Giveaway aktiv" erst im Panel **ÖFFNEN**.)

## Troubleshooting
- **Keine Reaktion / keine Punkte:** OBS läuft? (`GW_ViewerTick`/`GW_ChatMessage` senden nur bei aktivem Stream.) Client verbunden? Token gesetzt?
- **`ingest_denied` im Log:** Token falsch/abgelaufen → im Panel **NEU** generieren, globale Variable aktualisieren.
- **`!los` antwortet nicht:** `CC_ChatReply` am Trigger *Core → WebSocket → Client → Message*? Falls dein Streamerbot die Nachricht unter anderem Arg-Namen liefert, die Liste in `CC_ChatReply.cs` (`data/message/wsData/…`) ergänzen.
- **Falscher Client-Index:** die `0` in `CPH.WebsocketSend(payload, 0)` auf deinen Client-Index setzen.

## Follow-Verifizierung (nichts am Creator-PC einzurichten)
Vor jeder Ziehung prüft das Backend per Twitch-Helix, wer welchen Kanälen wirklich
folgt (Follow-Reconcile). Grundlage: jeder teilnehmende Streamer meldet sich **einmal**
auf **https://team.raumdock.org** mit Twitch an — dabei wird der Scope
`moderator:read:followers` erteilt, und das Backend liest die Follower des **eigenen**
Kanals über diesen Token (self = broadcaster). Kanäle, deren Owner nie eingeloggt war,
bleiben **permissiv** (kein Follow-Gate). Am Creator-PC ist dafür nichts einzurichten.
