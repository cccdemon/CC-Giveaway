// Action: "GW – Viewer Tick"
// Trigger: Twitch → General → Present Viewers
//
// Meldet anwesende Zuschauer an den Ingest-Server. Der Kanal wird
// SERVERSEITIG aus dem Token abgeleitet (nicht mitgeschickt = spoofsicher).
// follows/Kanal-Zuordnung macht der Server; Follow-Verifizierung final
// über Helix (Self-OAuth pro Kanal-Owner) vor der Ziehung.

public class CPHInline
{
    private static readonly string[] BOTS = {
        "streamelements","nightbot","moobot","fossabot",
        "wizebot","botrixoficial","commanderroot","corteimos"
    };

    public bool Execute()
    {
        if (!CPH.ObsIsStreaming(0)) return true;

        string user = Sanitize(GetRaw());
        if (string.IsNullOrEmpty(user) || IsBot(user)) return true;

        var payload = Newtonsoft.Json.JsonConvert.SerializeObject(
            new System.Collections.Generic.Dictionary<string, object>
            {
                ["event"] = "viewer_tick",
                ["user"]  = user,
                ["ts"]    = (long)(System.DateTime.UtcNow - new System.DateTime(1970,1,1)).TotalSeconds
            });
        CPH.WebsocketSend(payload, 0);
        return true;
    }

    private string GetRaw()
    {
        if (args.ContainsKey("userName") && args["userName"] != null) return args["userName"].ToString();
        if (args.ContainsKey("user") && args["user"] != null) return args["user"].ToString();
        return null;
    }
    private string Sanitize(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var sb = new System.Text.StringBuilder();
        foreach (char ch in raw.Trim())
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_')
                sb.Append(ch);
        string c = sb.ToString();
        return c.Length > 0 && c.Length <= 25 ? c : null;
    }
    private bool IsBot(string user)
    {
        string u = user.ToLower();
        foreach (var b in BOTS) if (u == b) return true;
        return false;
    }
}
