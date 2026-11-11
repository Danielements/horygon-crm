using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace Horygon.Core;
public sealed class AnalysisReceipt : Entity
{
    public Analysis? Result { get; set; }
    public string State { get; set; } = "Iniziata";
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
}
public static class LogicalMail
{
    public static string Key(EmailMessage mail)
    {
        // Folder, UID and UIDVALIDITY identify a copy, not a logical message.
        if (string.IsNullOrWhiteSpace(mail.MessageId) && (string.IsNullOrWhiteSpace(mail.From) || (string.IsNullOrWhiteSpace(mail.Body) && mail.Attachments.Count == 0) || mail.Date == default)) return mail.AccountId + ":local:" + mail.Id;
        var identity = !string.IsNullOrWhiteSpace(mail.MessageId)
            ? "message:" + mail.MessageId.Trim().Trim('<', '>')
            : "content:" + JsonSerializer.Serialize(new { mail.From, mail.To, mail.Subject, Date = mail.Date.ToUniversalTime(), Body = mail.Body.Replace("\r\n", "\n"), Attachments = mail.Attachments.Select(x => Convert.ToHexString(SHA256.HashData(x.Bytes))).ToArray() });
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(mail.AccountId + "\0" + identity)));
    }
}
