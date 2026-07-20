// Action: "CC – Chat Reply"
// Trigger: Core → WebSocket → Client → Message   (Nachricht vom Ingest-Server)
//
// Der Server schickt Chat-Antworten (Status, Opt-in-Bestätigung ...) über
// die Ingest-Verbindung zurück: { "event":"chat_reply", "message":"..." }.
// Diese Action postet die Nachricht in den Twitch-Chat DIESES Kanals.
// Andere Server-Nachrichten (ingest_ok / ingest_denied) werden ignoriert.

public class CPHInline
{
    public bool Execute()
    {
        string raw = null;
        // Streamerbot legt die empfangenen Daten je nach Version unter
        // unterschiedlichen Arg-Namen ab — defensiv mehrere prüfen.
        foreach (var key in new[] { "data", "message", "wsData", "payload", "body" })
        {
            if (args.ContainsKey(key) && args[key] != null)
            {
                string v = args[key].ToString();
                if (!string.IsNullOrEmpty(v) && v.Contains("chat_reply")) { raw = v; break; }
                if (raw == null && !string.IsNullOrEmpty(v)) raw = v;
            }
        }
        if (string.IsNullOrEmpty(raw)) return true;

        try
        {
            var obj = Newtonsoft.Json.JsonConvert
                .DeserializeObject<System.Collections.Generic.Dictionary<string, object>>(raw);
            if (obj == null || !obj.ContainsKey("event")) return true;
            if (obj["event"] == null || obj["event"].ToString() != "chat_reply") return true;

            string msg = obj.ContainsKey("message") && obj["message"] != null ? obj["message"].ToString() : null;
            if (!string.IsNullOrEmpty(msg)) CPH.SendMessage(msg);
        }
        catch { /* keine gültige JSON-Nachricht – ignorieren */ }
        return true;
    }
}
