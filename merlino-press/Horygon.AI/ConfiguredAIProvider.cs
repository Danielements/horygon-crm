using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Horygon.Core;
namespace Horygon.AI;

public sealed class ConfiguredAIProvider(AppSettings settings, HttpClient? transport = null) : IAIProvider
{
    public static Uri Validate(AppSettings settings)
    {
        if (!settings.AiEnabled) throw new InvalidOperationException("AI disattivata. Abilita analisi AI per eseguire il test.");
        if (settings.SelectedAiProvider is not { } kind || !Enum.IsDefined(kind) || !settings.AiProfiles.TryGetValue(kind, out var profile)) throw new ArgumentException("Selezionare un provider AI.");
        var validation = new AppSettings { AiEnabled = true, AiEndpoint = profile.Endpoint, AiModel = profile.Model, AllowExternalAi = settings.AllowExternalAi, MaxTokens = settings.MaxTokens, TimeoutSeconds = settings.TimeoutSeconds, Temperature = settings.Temperature };
        var uri = OpenCompatibleProvider.ValidateEndpoint(validation);
        if (kind is AiProviderKind.OpenAI or AiProviderKind.Anthropic)
        {
            if (uri.AbsoluteUri.TrimEnd('/') != AiConfiguration.Endpoint(kind)) throw new ArgumentException("L'endpoint del provider selezionato deve essere quello ufficiale. Per altri server usare API compatibile.");
            if (string.IsNullOrWhiteSpace(profile.ApiKey)) throw new ArgumentException($"Inserire la API key di {AiConfiguration.Label(kind)}.");
        }
        if (kind == AiProviderKind.Local && uri.Host is not ("localhost" or "127.0.0.1" or "[::1]")) throw new ArgumentException("LM Studio locale deve usare localhost o l'indirizzo loopback. Per un server di rete selezionare API compatibile e autorizzare l'invio esterno.");
        return uri;
    }
    public async Task<AIResponse> GenerateAsync(AIRequest request, CancellationToken cancellationToken)
    {
        var endpoint = Validate(settings);
        var kind = settings.SelectedAiProvider!.Value;
        var profile = settings.AiProfiles[kind];
        var anthropic = kind == AiProviderKind.Anthropic;
        using var message = new HttpRequestMessage(HttpMethod.Post, new Uri(endpoint, anthropic ? "messages" : "chat/completions"));
        if (!string.IsNullOrWhiteSpace(profile.ApiKey)) message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile.ApiKey.Trim());
        Dictionary<string, object> body;
        if (anthropic)
        {
            message.Headers.Add("anthropic-version", "2023-06-01");
            if (!string.IsNullOrWhiteSpace(profile.WorkspaceId)) message.Headers.Add("anthropic-workspace-id", profile.WorkspaceId.Trim());
            body = new()
            {
                ["model"] = profile.Model.Trim(), ["max_tokens"] = settings.MaxTokens,
                ["system"] = request.System + (request.Json ? "\nRispondi esclusivamente con JSON valido, senza blocchi Markdown." : ""),
                ["messages"] = new[] { new { role = "user", content = request.User } }
            };
            // Omit temperature for compatibility with Claude models which only accept their default.
        }
        else
        {
            body = new() { ["model"] = profile.Model.Trim(), ["messages"] = new[] { new { role = "system", content = request.System }, new { role = "user", content = request.User } } };
            if (kind == AiProviderKind.OpenAI) body["max_completion_tokens"] = settings.MaxTokens;
            else { body["max_tokens"] = settings.MaxTokens; body["temperature"] = settings.Temperature; }
            if (request.Json) body["response_format"] = new { type = "json_object" };
        }
        message.Content = JsonContent.Create(body);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(settings.TimeoutSeconds));
        using var ownedClient = transport is null ? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) : null;
        using var response = await (transport ?? ownedClient!).SendAsync(message, timeout.Token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(Error(kind, response.StatusCode));
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token);
        try
        {
            var root = json.RootElement;
            string content;
            var tokens = 0;
            if (anthropic)
            {
                if (root.TryGetProperty("stop_reason", out var stop) && stop.GetString() == "max_tokens") throw new InvalidDataException("Risposta Claude interrotta: aumentare Max output token.");
                content = string.Join("\n", root.GetProperty("content").EnumerateArray().Where(x => x.GetProperty("type").GetString() == "text").Select(x => x.GetProperty("text").GetString()));
                if (root.TryGetProperty("usage", out var usage)) tokens = usage.GetProperty("input_tokens").GetInt32() + usage.GetProperty("output_tokens").GetInt32();
            }
            else
            {
                var choice = root.GetProperty("choices")[0];
                if (choice.TryGetProperty("finish_reason", out var stop) && stop.GetString() == "length") throw new InvalidDataException("Risposta AI interrotta: aumentare Max output token.");
                content = choice.GetProperty("message").GetProperty("content").GetString() ?? "";
                if (root.TryGetProperty("usage", out var usage) && usage.TryGetProperty("total_tokens", out var total)) tokens = total.GetInt32();
            }
            if (string.IsNullOrWhiteSpace(content) || content.Length > 100000) throw new InvalidDataException("Risposta AI vuota o troppo lunga. Verificare modello e limite token.");
            return new(content, tokens);
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException or FormatException)
        { throw new InvalidDataException("Il provider ha restituito un formato inatteso. Verificare endpoint e modello."); }
    }
    private static string Error(AiProviderKind kind, HttpStatusCode status) => $"{AiConfiguration.Label(kind)} · HTTP {(int)status}: " + (status switch
    {
        HttpStatusCode.Unauthorized => "API key non valida o scaduta. Controllare la chiave del provider selezionato.",
        HttpStatusCode.Forbidden => "Accesso negato. Verificare permessi del modello e workspace.",
        HttpStatusCode.NotFound => "Modello o endpoint non trovato. Controllare il nome del modello.",
        HttpStatusCode.TooManyRequests => "Limite di richieste o credito API raggiunto. Controllare il proprio account.",
        HttpStatusCode.BadRequest => "Richiesta non accettata. Verificare modello, token e workspace Anthropic, se richiesto dalla chiave.",
        _ => "Provider non disponibile. Riprovare o controllare la configurazione."
    });
}
