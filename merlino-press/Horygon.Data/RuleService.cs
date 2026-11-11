using Horygon.Core;
namespace Horygon.Data;
public sealed class RuleService(string directory, IRepository repository) : IRuleService
{
    public static readonly string[] Names = ["company_rules.md", "ai_personality.md", "workflow_rules.md"];
    private string FilePath(string name) => Names.Contains(name) ? Path.Combine(directory, name) : throw new ArgumentException("Nome regola non consentito.");
    public Task<string> ReadAsync(string name) => File.ReadAllTextAsync(FilePath(name));
    public async Task<string> ReadAllAsync() => string.Join("\n\n", await Task.WhenAll(Names.Select(ReadAsync)));
    public async Task ActivateAsync(string name, string text)
    {
        var path = FilePath(name);
        if (string.IsNullOrWhiteSpace(text) || text.Length > 40000 || text.Contains('\0')) throw new ArgumentException("Regola vuota, troppo lunga o non valida.");
        await repository.SaveAsync(new RuleVersion { Name = name, Text = text });
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(path + ".tmp", text);
        File.Move(path + ".tmp", path, true);
        await repository.SaveAsync(new AuditEvent { Action = "ACTIVATE_RULE", EntityId = name, Result = "Versione archiviata; permessi operativi invariati" });
    }
}
