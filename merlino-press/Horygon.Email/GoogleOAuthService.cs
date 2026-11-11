using Horygon.Core;
using MimeKit;
namespace Horygon.Email;

public sealed class GoogleOAuthService(IRepository repository, AppSettings settings, IGoogleOAuthGateway gateway) : IGoogleOAuthService
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task ConnectAsync(EmailAccount account, CancellationToken ct)
    {
        GoogleOAuthConfiguration.ValidateClient(settings.GoogleOAuthClientId, settings.GoogleOAuthClientSecret);
        GoogleOAuthConfiguration.ValidateServers(account);
        if (!MailboxAddress.TryParse(account.Address.Trim(), out var address) || address.Address != account.Address.Trim()) throw new ArgumentException("Inserisci l'indirizzo email aziendale completo prima di Accedi con Google.");
        var client = new GoogleDesktopClient(settings.GoogleOAuthClientId.Trim(), settings.GoogleOAuthClientSecret.Trim());
        await gate.WaitAsync(ct);
        try
        {
            var grant = await gateway.AuthorizeAsync(client, address.Address, ct);
            if (!string.Equals(address.Address, grant.Address, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Nel browser hai scelto un account diverso da quello indicato in Horygon. Nessun collegamento sostituito: scegli l'account corretto oppure modifica l'indirizzo prima di riprovare.");
            await repository.SaveAsync(new GoogleOAuthSession { Id = account.Id, Address = grant.Address, ClientId = client.ClientId, ClientSecret = client.ClientSecret, TokenJson = grant.TokenJson });
            account.Authentication = EmailAuthentication.GoogleOAuth; account.Address = grant.Address; account.GoogleConnectedAddress = grant.Address; account.Password = "";
            await repository.SaveAsync(account);
            await repository.SaveAsync(new AuditEvent { Action = "GOOGLE_OAUTH_CONNECTED", EntityId = account.Id, Result = "Identità verificata; credenziali OAuth cifrate salvate" });
        }
        finally { gate.Release(); }
    }
    public async Task<string> GetAccessTokenAsync(EmailAccount account, CancellationToken ct)
    {
        GoogleOAuthConfiguration.ValidateServers(account);
        if (account.Authentication != EmailAuthentication.GoogleOAuth) throw new InvalidOperationException("Account non configurato per OAuth Google.");
        await gate.WaitAsync(ct);
        try
        {
            var session = await repository.GetAsync<GoogleOAuthSession>(account.Id);
            if (session is null || string.IsNullOrWhiteSpace(session.TokenJson) || !string.Equals(account.Address.Trim(), session.Address, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Collegamento Google mancante o relativo a un altro indirizzo. Premi Accedi con Google in Impostazioni.");
            var refreshed = await gateway.RefreshAsync(new(session.ClientId, session.ClientSecret), session.TokenJson, ct);
            if (refreshed.TokenJson != session.TokenJson) { session.TokenJson = refreshed.TokenJson; session.UpdatedAt = DateTimeOffset.UtcNow; await repository.SaveAsync(session); }
            return refreshed.AccessToken;
        }
        finally { gate.Release(); }
    }
    public async Task DisconnectLocalAsync(EmailAccount account, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await repository.SaveAsync(new GoogleOAuthSession { Id = account.Id });
            account.GoogleConnectedAddress = ""; account.Password = "";
            await repository.SaveAsync(account);
            await repository.SaveAsync(new AuditEvent { Action = "GOOGLE_OAUTH_LOCAL_DISCONNECT", EntityId = account.Id, Result = "Token rimossi dal collegamento locale. Consenso Google gestibile nell'account Google." });
        }
        finally { gate.Release(); }
    }
}
