using System.Text.Json.Serialization;

namespace Horygon.Core;

public abstract class Entity { public string Id { get; set; } = Guid.NewGuid().ToString("N"); }
public enum Priority { INFORMATIONAL, LOW, MEDIUM, HIGH, CRITICAL }
public enum TaskState { OPEN, IN_PROGRESS, WAITING, COMPLETED, CANCELLED }
public enum SendState { Draft, Sending, Sent, Uncertain, Rejected }
public enum EmailAuthentication { Password, GoogleOAuth }
public enum ActionKind { READ_EMAIL, CLASSIFY_EMAIL, SUMMARIZE_EMAIL, CHECK_ORDER, CREATE_DRAFT, SUGGEST_FORWARD, CREATE_TASK, REQUEST_APPROVAL, SEND_EMAIL, UPDATE_ORDER }
public sealed class EmailAccount : Entity
{
    public EmailAuthentication Authentication { get; set; }
    public string GoogleConnectedAddress { get; set; } = "";
    public string Address { get; set; } = "";
    public string Password { get; set; } = "";
    public string ImapHost { get; set; } = "imaps.aruba.it";
    public int ImapPort { get; set; } = 993;
    public string SmtpHost { get; set; } = "smtps.aruba.it";
    public int SmtpPort { get; set; } = 465;
    public bool SmtpStartTls { get; set; }
    public int HistoryDays { get; set; } = 90;
    public string Signature { get; set; } = "";
    public string SentFolderOverride { get; set; } = "";
    public override string ToString() => Address;
}
public sealed class MailAttachment
{
    public string Name { get; set; } = "allegato";
    public string ContentType { get; set; } = "application/octet-stream";
    public string? ContentId { get; set; }
    public byte[] Bytes { get; set; } = [];
    public override string ToString() => $"{Name} · {Bytes.Length / 1024:N0} KB";
}
public sealed class EmailMessage : Entity
{
    public MailKind? ManualMailKind { get; set; }
    public bool SpamHeaderFlag { get; set; }
    public bool HasListUnsubscribe { get; set; }
    [JsonIgnore] public MailClassification Classification => MailClassifier.Classify(this);
    [JsonIgnore] public string ClassificationLabel => Classification.Label;
    [JsonIgnore] public string ClassificationDetails => $"{Classification.Source}: {Classification.Reason}";

    public bool IsSentCopy { get; set; }
    public bool IsDraftCopy { get; set; }
    public string RequestGroupId { get; set; } = "";
    public string AccountId { get; set; } = "";
    public string Folder { get; set; } = "INBOX";
    public uint UidValidity { get; set; }
    public uint Uid { get; set; }
    public string MessageId { get; set; } = "";
    public string InReplyTo { get; set; } = "";
    public List<string> References { get; set; } = [];
    public string ThreadKey { get; set; } = "";
    public string From { get; set; } = "";
    public string ReplyTo { get; set; } = "";
    public string To { get; set; } = "";
    public string Cc { get; set; } = "";
    public string Bcc { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Body { get; set; } = "";
    public DateTimeOffset Date { get; set; }
    public DateTimeOffset DownloadedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<MailAttachment> Attachments { get; set; } = [];
    public Analysis? Analysis { get; set; }
    public bool Handled { get; set; }
    [JsonIgnore] public string PriorityLabel => Analysis?.Priority.ToString() ?? "DA ANALIZZARE";
    [JsonIgnore] public string Preview => Body.Length > 140 ? Body[..140].Replace('\n', ' ') : Body;
    [JsonIgnore] public string Summary => Analysis?.Summary ?? "Analisi non disponibile";
    [JsonIgnore] public string AttachmentLabel => Attachments.Count == 0 ? "" : $"📎 {Attachments.Count}";
    public static string Identity(string account, string folder, uint validity, uint uid) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{account}\0{folder}\0{validity}\0{uid}")));
}
public sealed class Analysis
{
    public string Category { get; set; } = "unclassified";
    public Priority Priority { get; set; } = Priority.MEDIUM;
    public string Summary { get; set; } = "";
    public string SenderType { get; set; } = "unknown";
    public List<string> OrderNumbers { get; set; } = [];
    public bool RequiresResponse { get; set; }
    public bool ContainsDeadline { get; set; }
    public string Sentiment { get; set; } = "neutral";
    public string SuggestedAction { get; set; } = "review";
    public string Reason { get; set; } = "";
    public double Confidence { get; set; }
    public string Source { get; set; } = "fallback";
}
public sealed class Draft : Entity
{
    public string AccountId { get; set; } = "";
    public string EmailId { get; set; } = "";
    public string To { get; set; } = "";
    public string Cc { get; set; } = "";
    public string Bcc { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Body { get; set; } = "";
    public string MessageId { get; set; } = $"{Guid.NewGuid():N}@horygon.local";
    public string InReplyTo { get; set; } = "";
    public List<string> References { get; set; } = [];
    public List<MailAttachment> Attachments { get; set; } = [];
    public SendState State { get; set; }
    public string? ApprovedBy { get; set; }
    public DateTimeOffset? ApprovedAt { get; set; }
    public override string ToString() => $"{State} · {To} · {Subject}";
}
public sealed class AITask : Entity
{
    public string MailStatus { get; set; } = "NESSUN AGGIORNAMENTO EMAIL";
    public string MailStatusDetail { get; set; } = "";
    public string LastMailId { get; set; } = "";
    public DateTimeOffset? LastMailAt { get; set; }
    [JsonIgnore] public string BoardCode => Id.Length > 6 ? Id[..6].ToUpperInvariant() : Id.ToUpperInvariant();
    [JsonIgnore] public string BoardTiming => Due is null ? "DA DEFINIRE" : Due.Value.Date < DateTime.Today ? $"IN RITARDO · {Due:dd/MM}" : Due.Value.ToString("dd/MM/yyyy");

    public List<string> EmailIds { get; set; } = [];
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public Priority Priority { get; set; } = Priority.MEDIUM;
    public string Owner { get; set; } = "";
    public DateTime? Due { get; set; }
    public TaskState State { get; set; }
    public string EmailId { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class AuditEvent : Entity
{
    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.UtcNow;
    public string Action { get; set; } = "";
    public string EntityId { get; set; } = "";
    public string Result { get; set; } = "";
    public string Actor { get; set; } = Environment.UserName;
}
public sealed class RuleVersion : Entity
{
    public string Name { get; set; } = "company_rules.md";
    public string Text { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class AppSettings : Entity
{

    public string GoogleOAuthClientId { get; set; } = "";
    public string GoogleOAuthClientSecret { get; set; } = "";
    public AiProviderKind? SelectedAiProvider { get; set; }
    public Dictionary<AiProviderKind, AiProfile> AiProfiles { get; set; } = [];
    public string Company { get; set; } = "La tua azienda";
    public string AiEndpoint { get; set; } = "http://localhost:1234/v1";
    public string AiModel { get; set; } = "";
    public string AiKey { get; set; } = "";
    public bool AiEnabled { get; set; }
    public bool AllowExternalAi { get; set; }
    public double Temperature { get; set; } = 0.2;
    public int MaxTokens { get; set; } = 1500;
    public int TimeoutSeconds { get; set; } = 60;
    public int PollSeconds { get; set; } = 60;
    public bool AutoSync { get; set; }
    public int ResponseTargetHours { get; set; } = 24;
    public bool LightTheme { get; set; }
}
public sealed class GoogleOAuthSession : Entity
{
    public string Address { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
    public string TokenJson { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public record AIRequest(string System, string User, bool Json = false);
public record AIResponse(string Content, int Tokens);
public record SyncProgress(string Message, int Downloaded);
public record OrderStatus(string Number, string Status, string Customer, string Delivery, Uri Source, DateTimeOffset VerifiedAt);

public sealed class MailSyncCoverage : Entity
{
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public DateTimeOffset Since { get; set; }
    public string SentFolder { get; set; } = "";
    public bool SentComplete { get; set; }
    public bool InboxComplete { get; set; }
    public string Issue { get; set; } = "";
}
