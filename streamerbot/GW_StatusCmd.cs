// Action: "GW – Status Command"
// Trigger: Command  !los  (Aliase: !status !zeit !chance !time)
//
// Fragt den Teilnahmestatus ab. Der Server antwortet über die Ingest-
// Verbindung mit einer chat_reply (Punkte, Kanäle x/2, Chance, ob im
// Lostopf) → CC_ChatReply postet sie in den Chat.

public class CPHInline
{
    public bool Execute()
    {
        string user = Sanitize(GetRaw());
        if (string.IsNullOrEmpty(user)) return true;

        var payload = Newtonsoft.Json.JsonConvert.SerializeObject(
            new System.Collections.Generic.Dictionary<string, object>
            {
                ["event"] = "time_cmd",
                ["user"]  = user
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
}
