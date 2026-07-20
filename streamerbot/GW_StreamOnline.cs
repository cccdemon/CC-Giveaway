// Action: "GW – Stream Online"
// Trigger: Twitch → Channel → Stream Online
//
// Meldet dem Server, dass dieser Kanal jetzt live ist. Der Server kann
// das Giveaway automatisch starten/fortsetzen (einstellbar im Admin-Panel
// unter AUTO-STEUERUNG). Der Kanal wird serverseitig aus dem Ingest-Token
// abgeleitet — nichts mitschicken.

public class CPHInline
{
    public bool Execute()
    {
        CPH.WebsocketSend("{\"event\":\"stream_online\"}", 0);
        CPH.LogInfo("[CC] stream_online gesendet.");
        return true;
    }
}
