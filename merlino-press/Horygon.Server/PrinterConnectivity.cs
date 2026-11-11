using System.Net.Sockets;
namespace Horygon.Server;

public static class PrinterConnectivity
{
    public static string Host(string endpoint)
    {
        var host=endpoint.Trim();
        if(Uri.TryCreate(host,UriKind.Absolute,out var uri) && uri.Scheme is "http" or "https")
        {
            if(uri.UserInfo!="")throw new ArgumentException("Non inserire credenziali nell'indirizzo della stampante.");
            host=uri.Host;
        }
        if(Uri.CheckHostName(host)==UriHostNameType.Unknown)throw new ArgumentException("Inserire un indirizzo IP, un nome host o un URL HTTP/HTTPS valido.");
        return host;
    }
    public static async Task<PrinterPortResult> ProbeAsync(string host,int port,CancellationToken ct)
    {
        var service=port switch {80=>"HTTP",443=>"HTTPS",631=>"IPP",9100=>"RAW",515=>"LPD",_=>"TCP"};
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try{using var client=new TcpClient();await client.ConnectAsync(host,port,timeout.Token);return new(port,service,true,"Porta TCP raggiungibile; protocollo e stato stampa non verificati.");}
        catch(OperationCanceledException) when(!ct.IsCancellationRequested){return new(port,service,false,"Timeout: nessuna risposta entro 3 secondi.");}
        catch(SocketException){return new(port,service,false,"Connessione non disponibile o nome host non risolto.");}
    }
}
