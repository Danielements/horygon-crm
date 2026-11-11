using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Horygon.Core;
namespace Horygon.AI;

public sealed class OpenCompatibleProvider(AppSettings settings) : IAIProvider
{
    public static Uri ValidateEndpoint(AppSettings settings)
    {
        if (!settings.AiEnabled) throw new InvalidOperationException("AI disattivata: modalità locale deterministica.");
        if (!Uri.TryCreate(settings.AiEndpoint.TrimEnd('/') + "/", UriKind.Absolute, out var uri) || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            throw new ArgumentException("Endpoint AI non valido.");
        var local = uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || uri.Host is "127.0.0.1" or "[::1]";
        if (uri.Scheme != "https" && !(local && uri.Scheme == "http")) throw new ArgumentException("Usare HTTPS per endpoint non locali.");
        if (!local && !settings.AllowExternalAi) throw new InvalidOperationException("Abilitare esplicitamente l'invio di dati al provider esterno.");
        if (string.IsNullOrWhiteSpace(settings.AiModel)) throw new ArgumentException("Specificare il nome del modello.");
        if (settings.MaxTokens is < 128 or > 8192 || settings.TimeoutSeconds is < 5 or > 300 || settings.Temperature is < 0 or > 2) throw new ArgumentException("Parametri AI fuori intervallo.");
        return uri;
    }
    public async Task<AIResponse> GenerateAsync(AIRequest request, CancellationToken cancellationToken)
    {
        var endpoint = ValidateEndpoint(settings);
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds) };
        if (!string.IsNullOrWhiteSpace(settings.AiKey)) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", settings.AiKey);
        var body = new Dictionary<string, object>
        {
            ["model"] = settings.AiModel, ["temperature"] = settings.Temperature, ["max_tokens"] = settings.MaxTokens,
            ["messages"] = new[] { new { role = "system", content = request.System }, new { role = "user", content = request.User } }
        };
        if (request.Json) body["response_format"] = new { type = "json_object" };
        using var response = await http.PostAsJsonAsync(new Uri(endpoint, "chat/completions"), body, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Provider AI: HTTP {(int)response.StatusCode}. Controllare modello e impostazioni.");
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var content = json.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? throw new InvalidDataException("Risposta AI vuota.");
        if (content.Length > 100000) throw new InvalidDataException("Risposta AI troppo lunga.");
        var tokens = json.RootElement.TryGetProperty("usage", out var usage) && usage.TryGetProperty("total_tokens", out var total) ? total.GetInt32() : 0;
        return new(content, tokens);
    }
}
