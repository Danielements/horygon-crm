using AngleSharp.Html.Parser;
using Horygon.Core;
using MimeKit;
namespace Horygon.Email;
public static class MailParser
{
    public static string SafeText(string html)
    {
        var doc = new HtmlParser().ParseDocument(html);
        foreach (var node in doc.QuerySelectorAll("script,style,iframe,object,embed,form,svg,math,link,meta,img")) node.Remove();
        foreach (var node in doc.QuerySelectorAll("br,p,div,tr,li")) node.AppendChild(doc.CreateTextNode("\n"));
        return (doc.Body?.TextContent ?? "").Trim();
    }
    public static EmailMessage Parse(MimeMessage mime, string accountId, string folder, uint validity, uint uid)
    {
        var result = new EmailMessage
        {
            Id = EmailMessage.Identity(accountId, folder, validity, uid), AccountId = accountId, Folder = folder, UidValidity = validity, Uid = uid,
            MessageId = mime.MessageId ?? "", InReplyTo = mime.InReplyTo ?? "", References = mime.References.ToList(),
            SpamHeaderFlag = string.Equals(mime.Headers["X-Spam-Flag"]?.Trim(), "YES", StringComparison.OrdinalIgnoreCase) || (mime.Headers["X-Spam-Status"]?.TrimStart().StartsWith("Yes", StringComparison.OrdinalIgnoreCase) ?? false),
            HasListUnsubscribe = !string.IsNullOrWhiteSpace(mime.Headers["List-Unsubscribe"]),
            From = mime.From.ToString(), ReplyTo = mime.ReplyTo.ToString(), To = mime.To.ToString(), Cc = mime.Cc.ToString(), Bcc = mime.Bcc.ToString(),
            Subject = mime.Subject ?? "(senza oggetto)", Date = mime.Date,
            Body = mime.TextBody ?? SafeText(mime.HtmlBody ?? "")
        };
        result.ThreadKey = result.References.FirstOrDefault() ?? (string.IsNullOrEmpty(result.InReplyTo) ? result.MessageId : result.InReplyTo);
        if (string.IsNullOrEmpty(result.ThreadKey)) result.ThreadKey = result.Id;
        foreach (var part in mime.BodyParts.Where(x => x.IsAttachment || x is MimePart { ContentId: not null }))
        {
            using var stream = new MemoryStream();
            string name;
            if (part is MimePart { Content: not null } file) { file.Content.DecodeTo(stream); name = file.FileName ?? "inline"; }
            else if (part is MessagePart { Message: not null } message) { message.Message.WriteTo(stream); name = "messaggio.eml"; }
            else continue;
            result.Attachments.Add(new MailAttachment { Name = Path.GetFileName(name), ContentType = part.ContentType.MimeType, ContentId = part.ContentId, Bytes = stream.ToArray() });
        }
        return result;
    }
}
