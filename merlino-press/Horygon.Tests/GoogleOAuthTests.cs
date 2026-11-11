using System.Text.Json;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Requests;
using Google.Apis.Auth.OAuth2.Responses;
using Horygon.Core;
using Horygon.Email;
using Xunit;
namespace Horygon.Tests;
public class GoogleOAuthTests
{
    [Fact] public void ImapFailureReportsStageAndSavedCountWithoutRawServerText()
    {
        var error = new MailKit.Net.Imap.ImapCommandException(MailKit.Net.Imap.ImapCommandResponse.No, "private server text");
        var message = MailService.DescribeSyncCommandFailure("FETCH · INBOX", 12, error);
        Assert.Contains("FETCH", message); Assert.Contains("12", message); Assert.DoesNotContain("private server text", message);
    }
    static EmailAccount Account() => new() { Address = "person@example.test", ImapHost = "imap.gmail.com", ImapPort = 993, SmtpHost = "smtp.gmail.com", SmtpPort = 465, SmtpStartTls = false, Authentication = EmailAuthentication.GoogleOAuth };
    static AppSettings Settings() => new() { GoogleOAuthClientId = "synthetic.apps.googleusercontent.com", GoogleOAuthClientSecret = "synthetic-secret" };
    [Fact] public void DesktopImportRejectsWebAndIgnoresEndpoints()
    {
        Assert.Throws<ArgumentException>(() => GoogleOAuthConfiguration.ParseDesktopJson("{\"web\":{}}"));
        var client = GoogleOAuthConfiguration.ParseDesktopJson("""{"installed":{"client_id":"synthetic.apps.googleusercontent.com","client_secret":"test","token_uri":"https://evil.example.test"}}""");
        Assert.Equal("test", client.ClientSecret);
        using var flow = GoogleOAuthGateway.CreateFlow(client);
        var request = flow.CreateAuthorizationCodeRequest("http://127.0.0.1:1234/", out var verifier);
        Assert.NotEmpty(verifier); Assert.Contains("code_challenge", request.Build().Query); Assert.Contains("S256", request.Build().Query);
        Assert.Contains("google", request.Build().Host);
    }
    [Theory] [InlineData(true)] [InlineData(false)]
    public async Task CallbackValidatesState(bool valid)
    {
        var receiver = new StateCheckedGoogleReceiver(new Receiver(valid), "person@example.test");
        var url = new GoogleAuthorizationCodeRequestUrl(new Uri("https://accounts.google.com/o/oauth2/auth"));
        if (valid) Assert.Equal("test-code", (await receiver.ReceiveCodeAsync(url, default)).Code);
        else await Assert.ThrowsAsync<InvalidOperationException>(() => receiver.ReceiveCodeAsync(url, default));
        Assert.Equal("offline", url.AccessType); Assert.Equal("consent select_account", url.Prompt);
    }
    [Fact] public async Task TokensRoundTripWithoutLosingExpiryOrRefresh()
    {
        var store = new VolatileGoogleTokenStore(); var issued = DateTime.UtcNow.AddMinutes(-20);
        await store.StoreAsync("test", new TokenResponse { AccessToken = "synthetic", RefreshToken = "refresh", IssuedUtc = issued, ExpiresInSeconds = 3600 });
        var token = await store.GetAsync<TokenResponse>("test");
        Assert.Equal(issued, token.IssuedUtc); Assert.Equal("refresh", token.RefreshToken);
        await store.ClearAsync(); Assert.Null(await store.GetAsync<TokenResponse>("test"));
    }
    [Fact] public async Task ConnectRefreshAndDisconnectBindCredentialsToAccount()
    {
        var repo = new MemoryRepository(); var settings = Settings(); var gateway = new Gateway(); var service = new GoogleOAuthService(repo, settings, gateway); var account = Account(); account.Password = "old-password";
        await service.ConnectAsync(account, default); Assert.Empty(account.Password);
        settings.GoogleOAuthClientId = "changed.apps.googleusercontent.com";
        Assert.Equal("access", await service.GetAccessTokenAsync(account, default));
        Assert.Equal("synthetic.apps.googleusercontent.com", gateway.LastClient!.ClientId);
        Assert.Equal("updated", (await repo.GetAsync<GoogleOAuthSession>(account.Id))!.TokenJson);
        account.Address = "other@example.test";
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.GetAccessTokenAsync(account, default));
        account.Address = "person@example.test"; account.ImapHost = "evil.example.test";
        await Assert.ThrowsAsync<ArgumentException>(() => service.GetAccessTokenAsync(account, default));
        account.ImapHost = "imap.gmail.com";
        await service.DisconnectLocalAsync(account, default);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.GetAccessTokenAsync(account, default));
    }
    [Fact] public async Task WrongIdentityDoesNotReplaceSession()
    {
        var repo = new MemoryRepository(); var account = Account(); var gateway = new Gateway { Address = "wrong@example.test" };
        var service = new GoogleOAuthService(repo, Settings(), gateway);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ConnectAsync(account, default));
        Assert.Null(await repo.GetAsync<GoogleOAuthSession>(account.Id));
    }
    [Theory] [InlineData("other.example.test", 465, false)] [InlineData("smtp.gmail.com", 25, false)] [InlineData("smtp.gmail.com", 587, false)]
    public void RejectsUnsafeServers(string host, int port, bool startTls)
    { var account = Account(); account.SmtpHost = host; account.SmtpPort = port; account.SmtpStartTls = startTls; Assert.Throws<ArgumentException>(() => GoogleOAuthConfiguration.ValidateServers(account)); }
    class Receiver(bool valid) : ICodeReceiver
    {
        public string RedirectUri => "http://127.0.0.1:1234/";
        public Task<AuthorizationCodeResponseUrl> ReceiveCodeAsync(AuthorizationCodeRequestUrl url, CancellationToken ct) => Task.FromResult(new AuthorizationCodeResponseUrl { Code = "test-code", State = valid ? url.State : "wrong" });
    }
    class Gateway : IGoogleOAuthGateway
    {
        public string Address = "person@example.test"; public GoogleDesktopClient? LastClient;
        public Task<GoogleOAuthGrant> AuthorizeAsync(GoogleDesktopClient client, string hint, CancellationToken ct) => Task.FromResult(new GoogleOAuthGrant(Address, "initial"));
        public Task<GoogleAccessToken> RefreshAsync(GoogleDesktopClient client, string json, CancellationToken ct) { LastClient = client; return Task.FromResult(new GoogleAccessToken("access", "updated")); }
    }
    class MemoryRepository : IRepository
    {
        readonly Dictionary<(Type,string),string> data = [];
        public Task InitializeAsync() => Task.CompletedTask;
        public Task<List<T>> ListAsync<T>() where T : Entity => Task.FromResult(data.Where(x => x.Key.Item1 == typeof(T)).Select(x => JsonSerializer.Deserialize<T>(x.Value)!).ToList());
        public Task<T?> GetAsync<T>(string id) where T : Entity => Task.FromResult(data.TryGetValue((typeof(T),id), out var value) ? JsonSerializer.Deserialize<T>(value) : null);
        public Task SaveAsync<T>(T item) where T : Entity { data[(typeof(T),item.Id)] = JsonSerializer.Serialize(item); return Task.CompletedTask; }
        public Task<bool> ExistsAsync<T>(string id) where T : Entity => Task.FromResult(data.ContainsKey((typeof(T),id)));
    }
}

