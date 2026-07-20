// Action: "GW – Stream Offline"
// Trigger: Twitch → Channel → Stream Offline
//
// Meldet dem Server, dass dieser Kanal offline gegangen ist. Wenn danach
// kein Team-Kanal mehr live ist, kann der Server das Giveaway automatisch
// pausieren (einstellbar im Admin-Panel unter AUTO-STEUERUNG). Der Kanal
// wird serverseitig aus dem Ingest-Token abgeleitet.

public class CPHInline
{
    public bool Execute()
    {
        CPH.WebsocketSend("{\"event\":\"stream_offline\"}", 0);
        CPH.LogInfo("[CC] stream_offline gesendet.");
        return true;
    }
}
