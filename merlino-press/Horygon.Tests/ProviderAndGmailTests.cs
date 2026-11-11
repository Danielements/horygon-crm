using System.Net;
using System.Text;
using System.Text.Json;
using Horygon.AI;
using Horygon.Core;
using Horygon.Email;
using Xunit;
namespace Horygon.Tests;

public sealed class ProviderAndGmailTests
{
    private static AppSettings Settings(AiProviderKind kind)
    {
        var settings = new AppSettings { AiEnabled = true, AllowExternalAi = true };
        AiConfiguration.Migrate(settings); settings.SelectedAiProvider = kind;
        foreach (var pair in settings.AiProfiles) { pair.Value.ApiKey = "synthetic-key-" + pair.Key; pair.Value.Model = "synthetic-model-" + pair.Key; }
        return settings;
    }
    [Theory] [InlineData("https://api.openai.com/v1", AiProviderKind.OpenAI)] [InlineData("https://api.anthropic.com/v1", AiProviderKind.Anthropic)] [InlineData("http://localhost:1234/v1", AiProviderKind.Local)] [InlineData("https://custom.example.test/v1", AiProviderKind.Compatible)]
    public void MigratesLegacySettingsOnceWithoutMixingKeys(string endpoint, AiProviderKind expected)
    {
        var settings = new AppSettings { AiEndpoint = endpoint, AiModel = "existing", AiKey = "existing-key" };
        Assert.True(AiConfiguration.Migrate(settings)); Assert.Equal(expected, settings.SelectedAiProvider);
        Assert.Equal("existing-key", settings.AiProfiles[expected].ApiKey); Assert.Equal("existing", settings.AiProfiles[expected].Model);
        Assert.All(settings.AiProfiles.Where(x => x.Key != expected), x => Assert.Empty(x.Value.ApiKey));
        Assert.False(AiConfiguration.Migrate(settings)); Assert.False(settings.AllowExternalAi);
        var restored = JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(settings))!;
        Assert.Equal("existing-key", restored.AiProfiles[expected].ApiKey);
    }
    [Theory] [InlineData(AiProviderKind.OpenAI)] [InlineData(AiProviderKind.Local)] [InlineData(AiProviderKind.Compatible)]
    public async Task ChatRequestUsesOnlySelectedKeyAndCorrectTokenParameter(AiProviderKind kind)
    {
        var settings = Settings(kind);
        var handler = new CaptureHandler("""{"choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}],"usage":{"total_tokens":21}}""");
        using var client = new HttpClient(handler);
        var result = await new ConfiguredAIProvider(settings, client).GenerateAsync(new("JSON", "Synthetic", true), default);
        Assert.EndsWith("/v1/chat/completions", handler.Url); Assert.Equal("Bearer synthetic-key-" + kind, handler.Authorization);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("synthetic-model-" + kind, body.RootElement.GetProperty("model").GetString());
        Assert.True(body.RootElement.TryGetProperty(kind == AiProviderKind.OpenAI ? "max_completion_tokens" : "max_tokens", out _));
        Assert.Equal(kind != AiProviderKind.OpenAI, body.RootElement.TryGetProperty("temperature", out _));
        Assert.Equal("json_object", body.RootElement.GetProperty("response_format").GetProperty("type").GetString()); Assert.Equal(21, result.Tokens);
    }
    [Fact] public async Task AnthropicUsesNativeMessagesHeadersAndTextBlocks()
    {
        var settings = Settings(AiProviderKind.Anthropic); settings.AiProfiles[AiProviderKind.Anthropic].WorkspaceId = "test-workspace";
        var handler = new CaptureHandler("""{"content":[{"type":"thinking","thinking":"not user text"},{"type":"text","text":"{\"ok\":true}"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":4}}""");
        using var client = new HttpClient(handler);
        var result = await new ConfiguredAIProvider(settings, client).GenerateAsync(new("System rules", "Synthetic", true), default);
        Assert.Equal("https://api.anthropic.com/v1/messages", handler.Url); Assert.Equal("Bearer synthetic-key-Anthropic", handler.Authorization);
        Assert.Equal("2023-06-01", handler.Version); Assert.Equal("test-workspace", handler.Workspace);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Contains("JSON", body.RootElement.GetProperty("system").GetString()); Assert.False(body.RootElement.TryGetProperty("response_format", out _)); Assert.False(body.RootElement.TryGetProperty("temperature", out _));
        Assert.Equal("user", body.RootElement.GetProperty("messages")[0].GetProperty("role").GetString());
        Assert.Equal("{\"ok\":true}", result.Content); Assert.Equal(14, result.Tokens);
    }
    [Fact] public async Task SwitchingProvidersCannotReuseAnotherProvidersKey()
    {
        var settings = Settings(AiProviderKind.OpenAI); var handler = new CaptureHandler("""{"choices":[{"message":{"content":"OK"}}]}""");
        using var client = new HttpClient(handler); var provider = new ConfiguredAIProvider(settings, client);
        await provider.GenerateAsync(new("test", "test"), default); Assert.Equal("Bearer synthetic-key-OpenAI", handler.Authorization);
        settings.SelectedAiProvider = AiProviderKind.Local;
        await provider.GenerateAsync(new("test", "test"), default); Assert.Equal("Bearer synthetic-key-Local", handler.Authorization);
        Assert.Equal("synthetic-key-OpenAI", settings.AiProfiles[AiProviderKind.OpenAI].ApiKey);
    }
    [Theory] [InlineData(AiProviderKind.OpenAI)] [InlineData(AiProviderKind.Anthropic)]
    public async Task CloudCannotSendWithoutConsent(AiProviderKind kind)
    {
        var settings = Settings(kind); settings.AllowExternalAi = false; var handler = new CaptureHandler("{}"); using var client = new HttpClient(handler);
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ConfiguredAIProvider(settings, client).GenerateAsync(new("test", "test"), default)); Assert.Equal(0, handler.Calls);
    }
    [Fact] public void OfficialKeyCannotBeSentToCustomHost()
    {
        var settings = Settings(AiProviderKind.Anthropic); settings.AiProfiles[AiProviderKind.Anthropic].Endpoint = "https://other.example.test/v1";
        Assert.Throws<ArgumentException>(() => ConfiguredAIProvider.Validate(settings));
    }
    [Fact] public void LocalModeCannotPointToRemoteHost()
    {
        var settings = Settings(AiProviderKind.Local); settings.AiProfiles[AiProviderKind.Local].Endpoint = "https://other.example.test/v1";
        Assert.Throws<ArgumentException>(() => ConfiguredAIProvider.Validate(settings));
    }
    [Fact] public async Task ProviderErrorIsUsefulWithoutLeakingResponseOrKey()
    {
        var handler = new CaptureHandler("raw-provider-error-with-secret", HttpStatusCode.Unauthorized); using var client = new HttpClient(handler);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => new ConfiguredAIProvider(Settings(AiProviderKind.OpenAI), client).GenerateAsync(new("test", "test"), default));
        Assert.Contains("API key non valida", error.Message); Assert.DoesNotContain("secret", error.Message); Assert.DoesNotContain("synthetic-key", error.Message);
    }
    [Theory]
    [InlineData(AiProviderKind.OpenAI, "{\"choices\":[{\"message\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}")]
    [InlineData(AiProviderKind.Anthropic, "{\"content\":[],\"stop_reason\":\"max_tokens\"}")]
    public async Task TruncatedOutputIsNotAccepted(AiProviderKind kind, string response)
    {
        using var client = new HttpClient(new CaptureHandler(response));
        await Assert.ThrowsAsync<InvalidDataException>(() => new ConfiguredAIProvider(Settings(kind), client).GenerateAsync(new("test", "test"), default));
    }
    [Fact] public void GmailPresetPreservesIdentityAndUsesTls()
    {
        var account = new EmailAccount { Address = "user@example.test", Password = "abcd efgh ijkl mnop", Signature = "existing" }; var id = account.Id;
        EmailSetup.ApplyPreset(account, "Gmail"); MailService.ValidateAccount(account);
        Assert.Equal(id, account.Id); Assert.Equal("existing", account.Signature); Assert.Equal("imap.gmail.com", account.ImapHost); Assert.Equal(993, account.ImapPort); Assert.Equal("smtp.gmail.com", account.SmtpHost); Assert.Equal(465, account.SmtpPort); Assert.False(account.SmtpStartTls); Assert.Equal("abcdefghijklmnop", account.Password);
    }
    [Fact] public void GmailRejectsOrdinaryPasswordWithActionableExplanation()
    {
        var account = new EmailAccount { Password = "normal-password-123" }; EmailSetup.ApplyPreset(account, "Gmail");
        var error = Assert.Throws<ArgumentException>(() => EmailSetup.Prepare(account)); Assert.Contains("password per le app", error.Message); Assert.DoesNotContain(account.Password, error.Message);
    }
    [Fact] public void GenericPasswordsKeepTheirSpaces()
    {
        var account = new EmailAccount { Password = " abcd efgh ijkl mnop " }; EmailSetup.Prepare(account); Assert.Equal(" abcd efgh ijkl mnop ", account.Password);
    }
    [Fact] public void AuthenticationAndTlsFailuresAreDistinguishedWithoutRawServerText()
    {
        var account = new EmailAccount(); EmailSetup.ApplyPreset(account, "Gmail");
        var auth = EmailSetup.DescribeFailure(account, "IMAP", new MailKit.Security.AuthenticationException("secret server text"));
        var tls = EmailSetup.DescribeFailure(account, "SMTP", new System.Security.Authentication.AuthenticationException("secret server text"));
        Assert.Contains("Google ha rifiutato", auth); Assert.Contains("TLS", tls); Assert.DoesNotContain("secret", auth); Assert.DoesNotContain("secret", tls);
    }
    private sealed class CaptureHandler(string response, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public string Url = "", Body = "", Authorization = "", Version = "", Workspace = "";
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++; Url = request.RequestUri!.AbsoluteUri; Body = await request.Content!.ReadAsStringAsync(cancellationToken); Authorization = request.Headers.Authorization?.ToString() ?? "";
            Version = request.Headers.TryGetValues("anthropic-version", out var version) ? version.Single() : "";
            Workspace = request.Headers.TryGetValues("anthropic-workspace-id", out var workspace) ? workspace.Single() : "";
            return new(status) { Content = new StringContent(response, Encoding.UTF8, "application/json") };
        }
    }
}
