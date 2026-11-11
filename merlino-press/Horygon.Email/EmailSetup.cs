using System.Net.Sockets;
using System.Text.RegularExpressions;
using Horygon.Core;
namespace Horygon.Email;

public static class EmailSetup
{
    public static bool IsGmail(EmailAccount account) => account.ImapHost.Trim().Equals("imap.gmail.com", StringComparison.OrdinalIgnoreCase) || account.SmtpHost.Trim().Equals("smtp.gmail.com", StringComparison.OrdinalIgnoreCase);
    public static void ApplyPreset(EmailAccount account, string preset)
    {
        if (preset is not ("Gmail" or "Aruba")) throw new ArgumentException("Profilo email sconosciuto.");
        account.ImapHost = preset == "Gmail" ? "imap.gmail.com" : "imaps.aruba.it";
        account.SmtpHost = preset == "Gmail" ? "smtp.gmail.com" : "smtps.aruba.it";
        account.ImapPort = 993; account.SmtpPort = 465; account.SmtpStartTls = false;
    }
    public static void Prepare(EmailAccount account)
    {
        account.Address = account.Address.Trim(); account.ImapHost = account.ImapHost.Trim(); account.SmtpHost = account.SmtpHost.Trim();
        if (account.Authentication == EmailAuthentication.GoogleOAuth) { GoogleOAuthConfiguration.ValidateServers(account); return; }
        if (!IsGmail(account)) return;
        var compact = string.Concat(account.Password.Where(c => !char.IsWhiteSpace(c)));
        if (!Regex.IsMatch(compact, "^[a-zA-Z]{16}$")) throw new ArgumentException("Gmail: in modalità Password inserisci una password per le app Google di 16 lettere, non la password normale. Se non è disponibile per il tuo account, seleziona Accedi con Google (OAuth). Richiede la configurazione di un client OAuth App desktop.");
        account.Password = compact;
    }
    public static string? DescribeFailure(EmailAccount account, string stage, Exception exception)
    {
        var advice = account.Authentication == EmailAuthentication.GoogleOAuth
            ? "Google ha rifiutato il token OAuth. Ripeti Accedi con Google e verifica che l'amministratore consenta Gmail IMAP/SMTP e il client OAuth di Horygon. Non inserire la password normale."
            : IsGmail(account)
            ? "Google ha rifiutato l'accesso. Usa l'indirizzo completo e una password per le app Google valida (16 lettere), non la password normale. Controlla verifica in due passaggi, eventuale revoca della password e policy Google Workspace."
            : "Credenziali rifiutate. Controlla indirizzo completo e password o password per le app richiesta dal provider.";
        return exception switch
        {
            MailKit.Security.SslHandshakeException or System.Security.Authentication.AuthenticationException => $"{stage}: negoziazione TLS non riuscita. Controlla server, porta, data del PC ed eventuale filtro antivirus/proxy. Il controllo del certificato non è stato disattivato.",
            MailKit.Security.AuthenticationException => $"{stage}: {advice}",
            SocketException => $"{stage}: server non raggiungibile. Controlla nome server, rete e firewall.",
            IOException => $"{stage}: connessione interrotta o scaduta. Controlla rete e server.",
            _ => null
        };
    }
    public static async Task GuardAsync(EmailAccount account, string stage, Func<Task> action)
    {
        try { await action(); }
        catch (Exception ex) when (ex is not OperationCanceledException && DescribeFailure(account, stage, ex) is not null)
        { throw new InvalidOperationException(DescribeFailure(account, stage, ex)); }
    }
}
