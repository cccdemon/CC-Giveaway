// Action: "GW – Giveaway Info"
// Trigger: Command  !giveaway  (Aliase: !gw)
//
// Postet eine Kurzinfo: was das Giveaway ist, wie man mitmacht, welche
// Befehle es gibt, plus Links zu Regeln & Statusseite. Der Server baut
// die Antwort (mit aktuellem Keyword) und schickt sie als chat_reply.

public class CPHInline
{
    public bool Execute()
    {
        CPH.WebsocketSend("{\"event\":\"giveaway_cmd\"}", 0);
        return true;
    }
}
