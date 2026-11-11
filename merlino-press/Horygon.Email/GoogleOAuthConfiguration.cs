using System.Text.Json;
using System.Text.RegularExpressions;
using Horygon.Core;
namespace Horygon.Email;

public sealed record GoogleDesktopClient(string ClientId, string ClientSecret);
public static class GoogleOAuthConfiguration
{
    public const string MailScope = "https://mail.google.com/";
    public static GoogleDesktopClient ParseDesktopJson(string json)
    {
        if (json.Length > 64000) throw new ArgumentException("Il file OAuth è troppo grande.");
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("installed", out var installed)) throw new ArgumentException("Importa il JSON di un client OAuth di tipo App desktop. Un client web del CRM non è adatto a questo flusso.");
            var id = installed.GetProperty("client_id").GetString() ?? "";
            var secret = installed.GetProperty("client_secret").GetString() ?? "";
            ValidateClient(id, secret);
            // Never trust auth/token URLs from imported files: SDK uses fixed Google endpoints.
            return new(id.Trim(), secret.Trim());
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        { throw new ArgumentException("JSON OAuth non valido. Scarica il client di tipo App desktop dalla Google Cloud Console."); }
    }
    public static void ValidateClient(string id, string secret)
    {
        if (!Regex.IsMatch(id.Trim(), @"^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$") || string.IsNullOrWhiteSpace(secret))
            throw new ArgumentException("Configura prima il client OAuth Google di tipo App desktop: importa il JSON in Impostazioni oppure inserisci Client ID e Client secret.");
    }
    public static void ValidateServers(EmailAccount account)
    {
        if (!account.ImapHost.Equals("imap.gmail.com", StringComparison.OrdinalIgnoreCase) || account.ImapPort != 993 || !account.SmtpHost.Equals("smtp.gmail.com", StringComparison.OrdinalIgnoreCase) || !(account.SmtpPort == 465 && !account.SmtpStartTls || account.SmtpPort == 587 && account.SmtpStartTls))
            throw new ArgumentException("OAuth Google può essere usato solo con i server Gmail ufficiali. Premi Usa Gmail per ripristinare IMAP 993 SSL/TLS e SMTP 465 SSL/TLS.");
    }
    public static string FriendlyError(string? code) => code switch
    {
        "access_denied" => "Accesso Google negato o bloccato. Controlla il consenso e le policy Google Workspace; l'amministratore potrebbe dover autorizzare il Client ID di Horygon e l'accesso Gmail.",
        "admin_policy_enforced" => "Accesso bloccato dalle policy Google Workspace. Chiedi all'amministratore di autorizzare il client OAuth Horygon per Gmail.",
        "invalid_grant" => "Autorizzazione Google scaduta o revocata. Premi di nuovo Accedi con Google. Verifica anche le policy dell'organizzazione.",
        "invalid_client" or "unauthorized_client" => "Client OAuth Google non valido o non autorizzato. Importa il JSON corretto di tipo App desktop.",
        "redirect_uri_mismatch" => "Il client OAuth non accetta il ritorno locale. Usa un Client ID di tipo App desktop, non quello web del CRM.",
        "invalid_scope" => "Il consenso OAuth deve includere il permesso Gmail https://mail.google.com/.",
        _ => "Accesso Google non riuscito. Controlla configurazione OAuth, consenso e policy aziendali, poi riprova."
    };
}
