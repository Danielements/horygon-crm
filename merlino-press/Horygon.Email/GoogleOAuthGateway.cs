using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Flows;
using Google.Apis.Auth.OAuth2.Requests;
using Google.Apis.Auth.OAuth2.Responses;
using Google.Apis.Util.Store;
namespace Horygon.Email;

public sealed record GoogleOAuthGrant(string Address, string TokenJson);
public sealed record GoogleAccessToken(string AccessToken, string TokenJson);
public interface IGoogleOAuthGateway
{
    Task<GoogleOAuthGrant> AuthorizeAsync(GoogleDesktopClient client, string addressHint, CancellationToken ct);
    Task<GoogleAccessToken> RefreshAsync(GoogleDesktopClient client, string tokenJson, CancellationToken ct);
}

// Explicit state validation in addition to the official SDK's S256 PKCE flow.
public sealed class StateCheckedGoogleReceiver(ICodeReceiver receiver, string loginHint) : ICodeReceiver
{
    public string RedirectUri => receiver.RedirectUri;
    public async Task<AuthorizationCodeResponseUrl> ReceiveCodeAsync(AuthorizationCodeRequestUrl url, CancellationToken ct)
    {
        var expected = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        url.State = expected;
        if (url is GoogleAuthorizationCodeRequestUrl google)
        { google.AccessType = "offline"; google.Prompt = "consent select_account"; google.LoginHint = loginHint; }
        var response = await receiver.ReceiveCodeAsync(url, ct).ConfigureAwait(false);
        if (response.State is null || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(response.State)))
            throw new InvalidOperationException("Risposta di accesso Google non valida (state). Chiudi la scheda e ripeti Accedi con Google.");
        return response;
    }
}

// No FileDataStore: the SDK sees only an in-memory token. Persistence is done by the DPAPI repository after identity checks.
public sealed class VolatileGoogleTokenStore : IDataStore
{
    private readonly Dictionary<string, string> values = [];
    public Task StoreAsync<T>(string key, T value) { lock (values) values[typeof(T).FullName + ":" + key] = JsonSerializer.Serialize(value); return Task.CompletedTask; }
    public Task<T> GetAsync<T>(string key) { lock (values) return Task.FromResult(values.TryGetValue(typeof(T).FullName + ":" + key, out var value) ? JsonSerializer.Deserialize<T>(value)! : default!); }
    public Task DeleteAsync<T>(string key) { lock (values) values.Remove(typeof(T).FullName + ":" + key); return Task.CompletedTask; }
    public Task ClearAsync() { lock (values) values.Clear(); return Task.CompletedTask; }
}

public sealed class GoogleOAuthGateway : IGoogleOAuthGateway
{
    public static PkceGoogleAuthorizationCodeFlow CreateFlow(GoogleDesktopClient client) => new(new GoogleAuthorizationCodeFlow.Initializer
    {
        ClientSecrets = new ClientSecrets { ClientId = client.ClientId, ClientSecret = client.ClientSecret },
        Scopes = [GoogleOAuthConfiguration.MailScope, "openid", "email"], DataStore = new VolatileGoogleTokenStore()
    });
    public async Task<GoogleOAuthGrant> AuthorizeAsync(GoogleDesktopClient client, string addressHint, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromMinutes(5));
        try
        {
            using var flow = CreateFlow(client);
            var receiver = new StateCheckedGoogleReceiver(new LocalServerCodeReceiver("<html><meta charset='utf-8'><title>Horygon</title><body>Risposta di Google ricevuta. Torna a Horygon per verificare l'esito. Puoi chiudere questa scheda.</body></html>", LocalServerCodeReceiver.CallbackUriChooserStrategy.ForceLoopbackIp), addressHint);
            var credential = await new AuthorizationCodeInstalledApp(flow, receiver).AuthorizeAsync(Guid.NewGuid().ToString("N"), timeout.Token).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(credential.Token.RefreshToken)) throw new InvalidOperationException("Google non ha rilasciato il permesso di accesso continuativo. Ripeti Accedi con Google e controlla le policy dell'organizzazione.");
            if (!(credential.Token.Scope ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(GoogleOAuthConfiguration.MailScope)) throw new InvalidOperationException("Il permesso Gmail non è stato concesso. Ripeti Accedi con Google e autorizza l'accesso alla posta.");
            var accessToken = await credential.GetAccessTokenForRequestAsync(cancellationToken: timeout.Token).ConfigureAwait(false);
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://openidconnect.googleapis.com/v1/userinfo");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Impossibile verificare l'identità dell'account Google. Nessun collegamento salvato.");
            using var identity = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
            var root = identity.RootElement;
            if (!root.TryGetProperty("email_verified", out var verified) || verified.ValueKind != JsonValueKind.True || !root.TryGetProperty("email", out var email) || string.IsNullOrWhiteSpace(email.GetString())) throw new InvalidOperationException("Google non ha restituito un indirizzo email verificato.");
            return new(email.GetString()!, JsonSerializer.Serialize(credential.Token));
        }
        catch (TokenResponseException ex) { throw new InvalidOperationException(GoogleOAuthConfiguration.FriendlyError(ex.Error?.Error)); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new InvalidOperationException("Tempo per l'accesso Google scaduto (5 minuti). Premi nuovamente Accedi con Google."); }
        catch (NotSupportedException) { throw new InvalidOperationException("Impossibile aprire il browser per Accedi con Google. Verifica che sia configurato un browser predefinito."); }
    }
    public async Task<GoogleAccessToken> RefreshAsync(GoogleDesktopClient client, string tokenJson, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(45));
            using var flow = CreateFlow(client);
            var token = JsonSerializer.Deserialize<TokenResponse>(tokenJson) ?? throw new InvalidOperationException("Collegamento Google non valido. Accedi nuovamente.");
            var credential = new UserCredential(flow, "horygon", token);
            var access = await credential.GetAccessTokenForRequestAsync(cancellationToken: timeout.Token).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(access)) throw new InvalidOperationException("Google non ha restituito un token valido. Accedi nuovamente.");
            return new(access, JsonSerializer.Serialize(credential.Token));
        }
        catch (TokenResponseException ex) { throw new InvalidOperationException(GoogleOAuthConfiguration.FriendlyError(ex.Error?.Error)); }
        catch (JsonException) { throw new InvalidOperationException("Collegamento Google non valido. Accedi nuovamente."); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new InvalidOperationException("Rinnovo dell'accesso Google scaduto. Controlla la connessione e riprova."); }
    }
}
