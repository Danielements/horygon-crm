namespace Horygon.Core;

public interface IProtector { byte[] Protect(byte[] data); byte[] Unprotect(byte[] data); }
public interface IRepository
{
    Task InitializeAsync();
    Task<List<T>> ListAsync<T>() where T : Entity;
    Task<T?> GetAsync<T>(string id) where T : Entity;
    Task SaveAsync<T>(T item) where T : Entity;
    Task<bool> ExistsAsync<T>(string id) where T : Entity;
}
public interface IEmailService
{
    Task<IReadOnlyList<string>> TestAsync(EmailAccount account, CancellationToken ct);
    Task<int> SyncAsync(EmailAccount account, IProgress<SyncProgress>? progress, CancellationToken ct);
    Draft CreateReply(EmailAccount account, EmailMessage mail, bool replyAll = false, bool forward = false);
    Task SendApprovedAsync(Draft draft, EmailAccount account, CancellationToken ct);
}
public interface IGoogleOAuthService
{
    Task ConnectAsync(EmailAccount account, CancellationToken ct);
    Task<string> GetAccessTokenAsync(EmailAccount account, CancellationToken ct);
    Task DisconnectLocalAsync(EmailAccount account, CancellationToken ct);
}
public interface IAIProvider { Task<AIResponse> GenerateAsync(AIRequest request, CancellationToken cancellationToken); }
public interface IAnalyzer { Task<Analysis> AnalyzeAsync(EmailMessage email, IReadOnlyList<EmailMessage> history, string rules, CancellationToken ct); Task<string> DraftAsync(EmailMessage email, string rules, CancellationToken ct); }
public interface IRuleService { Task<string> ReadAsync(string name); Task ActivateAsync(string name, string text); Task<string> ReadAllAsync(); }
public interface IOrderConnector { Task<OrderStatus> LookupAsync(string number, CancellationToken ct); }
public interface ISemanticSearch { Task<IReadOnlyList<string>> SearchAsync(string query, CancellationToken ct); }
public interface IPermissionValidator { bool IsAllowed(ActionKind kind, bool explicitlyApproved = false); }
public sealed class ConservativePermissions : IPermissionValidator
{
    public bool IsAllowed(ActionKind kind, bool explicitlyApproved = false) => kind switch
    {
        ActionKind.UPDATE_ORDER => false,
        ActionKind.SEND_EMAIL => explicitlyApproved,
        _ => Enum.IsDefined(kind)
    };
}
public static class TaskOperations
{
    public static AITask FromEmail(EmailMessage mail) => new() { Title = mail.Subject, Description = mail.Analysis?.Summary ?? mail.Preview, EmailId = mail.Id, Priority = mail.Analysis?.Priority ?? Priority.MEDIUM, OrderNumber = mail.Analysis?.OrderNumbers.FirstOrDefault() ?? "" };
    public static void Transition(AITask task, TaskState state) { if (!Enum.IsDefined(state)) throw new ArgumentOutOfRangeException(nameof(state)); task.State = state; task.UpdatedAt = DateTimeOffset.UtcNow; }
}
