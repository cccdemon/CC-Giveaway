// Action: "CC – Ingest Connect / Auth"
// Trigger: Core → WebSocket → Client → Opened   (die Ingest-Verbindung)
//
// Team-Giveaway v6 (inverted ingest): Streamerbot verbindet sich als
// WebSocket-CLIENT zu wss://team.raumdock.org/ingest. Direkt nach dem
// Verbinden MUSS dieser Action den Kanal-Token senden — sonst verwirft
// der Server alle Events.
//
// Voraussetzung: globale Variable "cc_ingest_token" = der im Admin-Panel
// (STREAM-VERBINDUNGEN) generierte Token dieses Kanals.
// WebSocket-Client-Index = 0 (der erste/einzige konfigurierte Client).

public class CPHInline
{
    public bool Execute()
    {
        // Erst persistente, dann nicht-persistente Variable (häufige Fehlerquelle).
        string token = CPH.GetGlobalVar<string>("cc_ingest_token", true);
        if (string.IsNullOrEmpty(token))
            token = CPH.GetGlobalVar<string>("cc_ingest_token", false);
        if (string.IsNullOrEmpty(token))
        {
            CPH.LogWarn("[CC] cc_ingest_token ist leer – Ingest-Auth übersprungen. Token im Admin-Panel generieren und als globale Variable setzen.");
            return true;
        }

        var payload = Newtonsoft.Json.JsonConvert.SerializeObject(
            new System.Collections.Generic.Dictionary<string, object>
            {
                ["event"] = "ingest_auth",
                ["token"] = token
            });

        CPH.WebsocketSend(payload, 0);
        CPH.LogInfo("[CC] Ingest-Auth gesendet.");
        return true;
    }
}
