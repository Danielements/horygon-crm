namespace Horygon.Core;

public enum AiProviderKind { Local, OpenAI, Anthropic, Compatible }
public sealed class AiProfile
{
    public string Endpoint { get; set; } = "";
    public string Model { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string WorkspaceId { get; set; } = "";
}
public static class AiConfiguration
{
    public static string Label(AiProviderKind kind) => kind switch { AiProviderKind.Local => "LM Studio · locale", AiProviderKind.OpenAI => "OpenAI · GPT", AiProviderKind.Anthropic => "Anthropic · Claude", _ => "API compatibile · personalizzata" };
    public static string Endpoint(AiProviderKind kind) => kind switch { AiProviderKind.OpenAI => "https://api.openai.com/v1", AiProviderKind.Anthropic => "https://api.anthropic.com/v1", _ => "http://localhost:1234/v1" };
    // Existing settings migrate once without dropping an existing endpoint, model or key.
    public static bool Migrate(AppSettings settings)
    {
        var changed = false;
        if (settings.SelectedAiProvider is null)
        {
            Uri.TryCreate(settings.AiEndpoint, UriKind.Absolute, out var uri);
            var kind = uri?.Host.ToLowerInvariant() switch { "api.openai.com" => AiProviderKind.OpenAI, "api.anthropic.com" => AiProviderKind.Anthropic, "localhost" or "127.0.0.1" or "[::1]" => AiProviderKind.Local, _ => AiProviderKind.Compatible };
            settings.SelectedAiProvider = kind;
            settings.AiProfiles.TryAdd(kind, new AiProfile { Endpoint = settings.AiEndpoint, Model = settings.AiModel, ApiKey = settings.AiKey });
            settings.AiKey = "";
            changed = true;
        }
        foreach (var kind in Enum.GetValues<AiProviderKind>())
            changed |= settings.AiProfiles.TryAdd(kind, new AiProfile { Endpoint = Endpoint(kind) });
        return changed;
    }
}
