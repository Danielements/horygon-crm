using System.Net.Mail;
namespace Horygon.Core;

public static class MailDirection
{
    public static bool IsSentFolder(string folder) => folder.Replace('\\', '/').Split('/').Last().ToLowerInvariant() is "sent" or "sent mail" or "sent items" or "posta inviata" or "inviata";
    public static bool IsDraft(EmailMessage mail) => mail.IsDraftCopy || mail.Folder.Replace('\\', '/').Split('/').Last().ToLowerInvariant() is "drafts" or "bozze";
    public static bool IsOutgoing(EmailMessage mail, string ownAddress) => !IsDraft(mail) && (mail.IsSentCopy || IsSentFolder(mail.Folder) || (!string.IsNullOrWhiteSpace(ownAddress) && RoadmapBuilder.Address(mail.From).Equals(ownAddress.Trim(), StringComparison.OrdinalIgnoreCase)));
    public static bool ContainsRecipient(string recipients, string address)
    {
        if (string.IsNullOrWhiteSpace(address)) return false;
        try { var list = new MailAddressCollection(); list.Add(recipients); return list.Any(x => x.Address.Equals(address, StringComparison.OrdinalIgnoreCase)); }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return false; }
    }
    public static bool RepliedTo(EmailMessage request, EmailMessage sent, IReadOnlyList<EmailMessage> conversation)
    {
        if (IsDraft(sent) || sent.Date < request.Date) return false;
        var target = RoadmapBuilder.Address(string.IsNullOrWhiteSpace(request.ReplyTo) ? request.From : request.ReplyTo);
        if (!ContainsRecipient(sent.To, target) && !ContainsRecipient(sent.Cc, target) && !ContainsRecipient(sent.Bcc, target)) return false;
        if (!string.IsNullOrWhiteSpace(request.MessageId) && (sent.InReplyTo == request.MessageId || sent.References.Contains(request.MessageId))) return true;
        // Follow ancestor links; manual case grouping alone is not evidence of a reply.
        var pending = new Stack<string>(sent.References.Append(sent.InReplyTo).Where(x => x != ""));
        var visited = new HashSet<string>();
        while (pending.TryPop(out var id))
        {
            if (!visited.Add(id)) continue;
            if (id == request.MessageId && id != "") return true;
            foreach (var parent in conversation.Where(x => x.MessageId == id))
                foreach (var ancestor in parent.References.Append(parent.InReplyTo).Where(x => x != "")) pending.Push(ancestor);
        }
        return false;
    }
}
