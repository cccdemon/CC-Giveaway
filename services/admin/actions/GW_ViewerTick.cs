// Action: "GW – Viewer Tick"
// Trigger: Twitch → General → Present Viewers
//   (Platforms → Twitch → Settings → Present Viewers: „Live Update" AN,
//    Intervall höchstens 5 Minuten — der Server hält Anwesenheit 10 Minuten.)
//
// Meldet ALLE gerade im Chat verbundenen Zuschauer an den Ingest-Server —
// auch die, die nie etwas schreiben (Lurker). Der Trigger liefert die
// komplette Liste in `users` (List<Dictionary<string,object>>), kein
// einzelnes `user`-Argument. Bis 27.8.26 las diese Action nur `userName`
// und meldete damit pro Poll höchstens einen Namen; Lurker fielen raus.
//
// Der Kanal wird SERVERSEITIG aus dem Token abgeleitet (nicht mitgeschickt =
// spoofsicher). Follow-Verifizierung final über Helix vor der Ziehung.

public class CPHInline
{
    private static readonly string[] BOTS = {
        "streamelements","nightbot","moobot","fossabot",
        "wizebot","botrixoficial","commanderroot","corteimos"
    };
    private const int BATCH = 200;   // Namen je WebSocket-Nachricht (Bridge-Limit 128 KiB)

    public bool Execute()
    {
        if (!CPH.ObsIsStreaming(0)) return true;

        var names = new System.Collections.Generic.List<string>();
        // Dictionary statt HashSet: HashSet liegt in System.Core.dll, das der
        // Streamer.bot-Compiler nicht referenziert (CS0234).
        var seen  = new System.Collections.Generic.Dictionary<string, bool>();

        System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>> users;
        if (CPH.TryGetArg("users", out users) && users != null)
        {
            foreach (var u in users)
            {
                string raw = Pick(u, "userName") ?? Pick(u, "login") ?? Pick(u, "display");
                string user = Sanitize(raw);
                if (string.IsNullOrEmpty(user) || IsBot(user)) continue;
                string key = user.ToLower();
                if (seen.ContainsKey(key)) continue;
                seen[key] = true;
                names.Add(user);
            }
        }
        else
        {
            // Rückfall: Trigger ohne Liste (alte Streamer.bot-Version / Test-Trigger)
            string user = Sanitize(GetRaw());
            if (!string.IsNullOrEmpty(user) && !IsBot(user)) names.Add(user);
        }

        if (names.Count == 0)
        {
            CPH.LogInfo("[CC] viewer_tick: keine Zuschauer in der Liste.");
            return true;
        }

        long ts = (long)(System.DateTime.UtcNow - new System.DateTime(1970,1,1)).TotalSeconds;
        for (int i = 0; i < names.Count; i += BATCH)
        {
            var chunk = names.GetRange(i, System.Math.Min(BATCH, names.Count - i));
            var payload = Newtonsoft.Json.JsonConvert.SerializeObject(
                new System.Collections.Generic.Dictionary<string, object>
                {
                    ["event"] = "viewer_tick",
                    ["users"] = chunk,
                    ["ts"]    = ts
                });
            CPH.WebsocketSend(payload, 0);
        }
        CPH.LogInfo("[CC] viewer_tick: " + names.Count + " Zuschauer gemeldet.");
        return true;
    }

    private static string Pick(System.Collections.Generic.Dictionary<string, object> d, string key)
    {
        object v;
        if (d != null && d.TryGetValue(key, out v) && v != null)
        {
            string s = v.ToString();
            return string.IsNullOrEmpty(s) ? null : s;
        }
        return null;
    }
    private string GetRaw()
    {
        if (args.ContainsKey("userName") && args["userName"] != null) return args["userName"].ToString();
        if (args.ContainsKey("user") && args["user"] != null) return args["user"].ToString();
        return null;
    }
    private static string Sanitize(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var sb = new System.Text.StringBuilder();
        foreach (char ch in raw.Trim())
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_')
                sb.Append(ch);
        string c = sb.ToString();
        return c.Length > 0 && c.Length <= 25 ? c : null;
    }
    private static bool IsBot(string user)
    {
        string u = user.ToLower();
        foreach (var b in BOTS) if (u == b) return true;
        return false;
    }
}
