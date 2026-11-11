using Horygon.Core;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using MimeKit;
namespace Horygon.Email;

public sealed class MailService(IRepository repository, IPermissionValidator permissions, ISmtpSessionFactory? smtpFactory = null, IGoogleOAuthService? googleOAuth = null) : IEmailService
{
    private readonly SemaphoreSlim syncGate = new(1, 1);
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private async Task<string?> GoogleTokenAsync(EmailAccount account, CancellationToken ct) => account.Authentication == EmailAuthentication.GoogleOAuth
        ? await (googleOAuth ?? throw new InvalidOperationException("Servizio OAuth Google non disponibile.")).GetAccessTokenAsync(account, ct) : null;
    private static Task AuthenticateImapAsync(ImapClient client, EmailAccount account, string? token, CancellationToken ct) => token is null
        ? client.AuthenticateAsync(account.Address, account.Password, ct) : client.AuthenticateAsync(new SaslMechanismOAuth2(account.Address, token), ct);
    public async Task<IReadOnlyList<string>> TestAsync(EmailAccount account, CancellationToken ct)
    {
        ValidateAccount(account);
        var token = await GoogleTokenAsync(account, ct);
        using var client = new ImapClient { Timeout = 30000 };
        await EmailSetup.GuardAsync(account, "IMAP · TLS", () => client.ConnectAsync(account.ImapHost, account.ImapPort, SecureSocketOptions.SslOnConnect, ct));
        await EmailSetup.GuardAsync(account, "IMAP · autenticazione", () => AuthenticateImapAsync(client, account, token, ct));
        var folders = await FoldersAsync(client, ct);
        await client.DisconnectAsync(true, ct);
        using var smtp = new SmtpClient { Timeout = 30000 };
        await EmailSetup.GuardAsync(account, "SMTP · TLS (IMAP riuscito)", () => smtp.ConnectAsync(account.SmtpHost, account.SmtpPort, account.SmtpStartTls ? SecureSocketOptions.StartTls : SecureSocketOptions.SslOnConnect, ct));
        await EmailSetup.GuardAsync(account, "SMTP · autenticazione (IMAP riuscito)", () => token is null ? smtp.AuthenticateAsync(account.Address, account.Password, ct) : smtp.AuthenticateAsync(new SaslMechanismOAuth2(account.Address, token), ct));
        await smtp.DisconnectAsync(true, ct);
        return folders.Select(x => x.FullName).ToList();
    }
    private static async Task<List<IMailFolder>> FoldersAsync(ImapClient client, CancellationToken ct, List<string>? issues = null)
    {
        var result = new List<IMailFolder> { client.Inbox };
        try
        {
            var sent = client.GetFolder(SpecialFolder.Sent);
            if (sent is not null) result.Insert(0, sent);
        }
        catch (NotSupportedException) { }
        async Task Walk(IMailFolder folder)
        {
            if ((folder.Attributes & (FolderAttributes.NoSelect | FolderAttributes.NonExistent)) == 0 && result.All(x => x.FullName != folder.FullName)) result.Add(folder);
            try { foreach (var child in await folder.GetSubfoldersAsync(false, ct)) await Walk(child); }
            catch (ImapCommandException) when (issues is not null) { issues.Add($"Elenco sottocartelle incompleto: {folder.FullName}"); }
        }
        foreach (var ns in client.PersonalNamespaces) await Walk(client.GetFolder(ns));
        return result;
    }
    public static int FolderSyncOrder(string name, bool sent, bool inbox) => sent ? 0 : inbox ? 1 : 2;
    public async Task<int> SyncAsync(EmailAccount account, IProgress<SyncProgress>? progress, CancellationToken ct)
    {
        ValidateAccount(account);
        await syncGate.WaitAsync(ct);
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                try { return await DownloadAsync(account, progress, ct); }
                catch (Exception ex) when (attempt < 2 && !ct.IsCancellationRequested && ex is IOException or System.Net.Sockets.SocketException)
                { progress?.Report(new("Connessione interrotta. Nuovo tentativo…", 0)); await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt + 1)), ct); }
            }
        }
        finally { syncGate.Release(); }
    }
    private async Task<int> DownloadAsync(EmailAccount account, IProgress<SyncProgress>? progress, CancellationToken ct)
    {
        var coverage = new MailSyncCoverage { Id = account.Id, StartedAt = DateTimeOffset.UtcNow, Since = DateTimeOffset.UtcNow.AddDays(-account.HistoryDays) };
        await repository.SaveAsync(coverage);
        var count = 0;
        var issues = new List<string>();
        try
        {
            var token = await GoogleTokenAsync(account, ct);
            using var client = new ImapClient { Timeout = 60000 };
            await client.ConnectAsync(account.ImapHost, account.ImapPort, SecureSocketOptions.SslOnConnect, ct);
            await EmailSetup.GuardAsync(account, "IMAP · autenticazione", () => AuthenticateImapAsync(client, account, token, ct));
            var folders = await FoldersAsync(client, ct, issues);
            var sentFolder = !string.IsNullOrWhiteSpace(account.SentFolderOverride)
                ? folders.FirstOrDefault(x => x.FullName.Equals(account.SentFolderOverride.Trim(), StringComparison.OrdinalIgnoreCase))
                : folders.FirstOrDefault(x => x.Attributes.HasFlag(FolderAttributes.Sent)) ?? folders.FirstOrDefault(x => MailDirection.IsSentFolder(x.FullName));
            coverage.SentFolder = sentFolder?.FullName ?? "";
            if (sentFolder is null) issues.Add("Cartella Posta inviata non individuata. Verifica la visibilità IMAP o specifica il nome in Impostazioni.");
            foreach (var folder in folders.OrderBy(x => FolderSyncOrder(x.FullName, x == sentFolder, x == client.Inbox)))
            {
                var stage = $"EXAMINE · apertura cartella {folder.FullName}";
                var isSent = folder == sentFolder || folder.Attributes.HasFlag(FolderAttributes.Sent);
                var isDraft = folder.Attributes.HasFlag(FolderAttributes.Drafts);
                try
                {
                    progress?.Report(new(stage, count));
                    await folder.OpenAsync(FolderAccess.ReadOnly, ct);
                    var checkpointId = EmailMessage.Identity(account.Id, folder.FullName, folder.UidValidity, 0);
                    var checkpoint = await repository.GetAsync<FolderCheckpoint>(checkpointId);
                    if (checkpoint is null || !FolderCheckpoint.CanResume(checkpoint, coverage.Since) || checkpoint.IsSent != isSent || checkpoint.IsDraft != isDraft)
                        checkpoint = new FolderCheckpoint { Id = checkpointId, Since = coverage.Since, IsSent = isSent, IsDraft = isDraft };
                    stage = $"SEARCH · ricerca messaggi in {folder.FullName}";
                    SearchQuery query = SearchQuery.DeliveredAfter(coverage.Since.UtcDateTime);
                    if (checkpoint.LastUid is > 0 and < uint.MaxValue)
                        query = query.And(SearchQuery.Uids(new UniqueIdRange(new UniqueId(checkpoint.LastUid + 1), UniqueId.MaxValue)));
                    var ids = await folder.SearchAsync(query, ct);
                    foreach (var uid in ids.Where(x => x.Id > checkpoint.LastUid).OrderBy(x => x.Id))
                    {
                        ct.ThrowIfCancellationRequested();
                        var id = EmailMessage.Identity(account.Id, folder.FullName, folder.UidValidity, uid.Id);
                        var existing = await repository.GetAsync<EmailMessage>(id);
                        if (existing is not null)
                        {
                            if (existing.IsSentCopy != isSent || existing.IsDraftCopy != isDraft)
                            { existing.IsSentCopy = isSent; existing.IsDraftCopy = isDraft; await repository.SaveAsync(existing); }
                            checkpoint.LastUid = uid.Id;
                            await repository.SaveAsync(checkpoint);
                            continue;
                        }
                        stage = $"FETCH · download in {folder.FullName}, UID {uid.Id}";
                        // ReadOnly plus BODY.PEEK: no server flags or messages are changed.
                        var mime = await folder.GetMessageAsync(uid, ct);
                        var mail = MailParser.Parse(mime, account.Id, folder.FullName, folder.UidValidity, uid.Id);
                        mail.IsSentCopy = isSent; mail.IsDraftCopy = isDraft;
                        await repository.SaveAsync(mail);
                        // Advance only after the message is durable. A crash can replay a UID, never skip it.
                        checkpoint.LastUid = uid.Id;
                        await repository.SaveAsync(checkpoint);
                        progress?.Report(new($"{folder.FullName}: {++count} messaggi scaricati", count));
                    }
                    if (folder == sentFolder) coverage.SentComplete = true;
                    if (folder == client.Inbox) coverage.InboxComplete = true;
                    await repository.SaveAsync(coverage);
                }
                catch (ImapCommandException ex)
                { issues.Add(DescribeSyncCommandFailure(stage, count, ex)); }
            }
            try { await client.DisconnectAsync(true, ct); } catch (ImapCommandException) { }
            coverage.CompletedAt = DateTimeOffset.UtcNow;
            await repository.SaveAsync(new AuditEvent { Action = "READ_EMAIL", EntityId = account.Id, Result = $"{count} nuovi messaggi. Inviata completa: {coverage.SentComplete}; INBOX completa: {coverage.InboxComplete}" });
            if (issues.Count > 0) throw new InvalidOperationException("Sincronizzazione parziale. " + string.Join(" · ", issues));
            return count;
        }
        finally
        {
            coverage.Issue = issues.Count > 0 ? string.Join(" · ", issues) : coverage.CompletedAt is null ? "Sincronizzazione interrotta o in corso; copertura non completa." : "";
            await repository.SaveAsync(coverage);
        }
    }
    public static string DescribeSyncCommandFailure(string stage, int count, ImapCommandException error) =>
        $"Sincronizzazione IMAP interrotta durante {stage}. Il server ha rifiutato il comando ({error.Response}). {count} nuovi messaggi già salvati in questo tentativo. Non indica necessariamente un problema Internet. Riprova Sincronizza: i messaggi salvati saranno saltati. Se si ripete, comunica questo messaggio per individuare il comando rifiutato.";
    public Draft CreateReply(EmailAccount account, EmailMessage mail, bool replyAll = false, bool forward = false)
    {
        var to = forward ? "" : string.IsNullOrWhiteSpace(mail.ReplyTo) ? mail.From : mail.ReplyTo;
        var cc = "";
        if (replyAll)
        {
            var recipients = InternetAddressList.Parse(to).Mailboxes.ToList();
            var existing = recipients.Select(x => x.Address).Append(account.Address).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var others = InternetAddressList.Parse(mail.To + (string.IsNullOrWhiteSpace(mail.Cc) ? "" : ", " + mail.Cc)).Mailboxes.Where(x => existing.Add(x.Address));
            cc = string.Join(", ", others);
        }
        var prefix = forward ? "Fwd: " : "Re: ";
        return new Draft
        {
            AccountId = account.Id, EmailId = mail.Id, To = to, Cc = cc,
            Subject = mail.Subject.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? mail.Subject : prefix + mail.Subject,
            InReplyTo = forward ? "" : mail.MessageId,
            References = forward ? [] : mail.References.Concat(string.IsNullOrEmpty(mail.MessageId) ? [] : new[] { mail.MessageId }).Distinct().ToList(),
            Body = "\n\n" + account.Signature + "\n\n--- Messaggio originale ---\n" + mail.From + "\n" + mail.Body,
            Attachments = forward ? mail.Attachments.ToList() : []
        };
    }
    public static MimeMessage BuildMime(Draft draft, EmailAccount account)
    {
        var message = new MimeMessage { Subject = draft.Subject, MessageId = draft.MessageId, Date = DateTimeOffset.Now };
        message.From.Add(MailboxAddress.Parse(account.Address));
        message.To.AddRange(InternetAddressList.Parse(draft.To));
        if (!string.IsNullOrWhiteSpace(draft.Cc)) message.Cc.AddRange(InternetAddressList.Parse(draft.Cc));
        if (!string.IsNullOrWhiteSpace(draft.Bcc)) message.Bcc.AddRange(InternetAddressList.Parse(draft.Bcc));
        if (!message.To.Mailboxes.Any()) throw new ArgumentException("Specificare almeno un destinatario valido.");
        if (!string.IsNullOrEmpty(draft.InReplyTo)) message.InReplyTo = draft.InReplyTo;
        foreach (var reference in draft.References) message.References.Add(reference);
        var builder = new BodyBuilder { TextBody = draft.Body };
        foreach (var file in draft.Attachments) builder.Attachments.Add(file.Name, file.Bytes);
        message.Body = builder.ToMessageBody();
        return message;
    }
    public async Task SendApprovedAsync(Draft draft, EmailAccount account, CancellationToken ct)
    {
        await sendGate.WaitAsync(ct);
        try
        {
            var persisted = await repository.GetAsync<Draft>(draft.Id);
            if (draft.AccountId != account.Id || persisted?.State is not SendState.Draft || draft.State != SendState.Draft || !permissions.IsAllowed(ActionKind.SEND_EMAIL, draft.ApprovedAt.HasValue && !string.IsNullOrWhiteSpace(draft.ApprovedBy)))
                throw new InvalidOperationException("Invio non autorizzato o bozza già elaborata.");
            using var message = BuildMime(draft, account);
            EmailSetup.Prepare(account);
            var token = await GoogleTokenAsync(account, ct);
            using var client = smtpFactory?.Create() ?? new MailKitSmtpSession();
            await client.ConnectAsync(account.SmtpHost, account.SmtpPort, account.SmtpStartTls ? SecureSocketOptions.StartTls : SecureSocketOptions.SslOnConnect, ct);
            await EmailSetup.GuardAsync(account, "SMTP · autenticazione", () => token is null ? client.AuthenticateAsync(account.Address, account.Password, ct) : client.AuthenticateOAuth2Async(account.Address, token, ct));
            draft.State = SendState.Sending;
            await repository.SaveAsync(draft);
            await repository.SaveAsync(new AuditEvent { Action = "SEND_EMAIL_APPROVED", EntityId = draft.Id, Result = "Snapshot approvato salvato; invio iniziato" });
            try
            {
                await client.SendAsync(message, ct);
                draft.State = SendState.Sent;
                await repository.SaveAsync(draft);
                await repository.SaveAsync(new AuditEvent { Action = "SEND_EMAIL", EntityId = draft.Id, Result = "Accettato dal server SMTP" });
            }
            catch
            {
                draft.State = SendState.Uncertain;
                await repository.SaveAsync(draft);
                await repository.SaveAsync(new AuditEvent { Action = "SEND_EMAIL", EntityId = draft.Id, Result = "Esito incerto: controllare il provider. Nessun retry automatico." });
                throw new InvalidOperationException("Esito SMTP incerto. Verificare con il provider prima di preparare un nuovo invio.");
            }
            // A disconnect failure after successful acceptance must not turn a sent message into a retry.
            try { await client.DisconnectAsync(true, CancellationToken.None); } catch (IOException) { }
        }
        finally { sendGate.Release(); }
    }
    public static void ValidateAccount(EmailAccount account)
    {
        EmailSetup.Prepare(account);
        if (!Enum.IsDefined(account.Authentication) || !MailboxAddress.TryParse(account.Address, out _) || (account.Authentication == EmailAuthentication.Password && string.IsNullOrWhiteSpace(account.Password)) || string.IsNullOrWhiteSpace(account.ImapHost) || string.IsNullOrWhiteSpace(account.SmtpHost) || account.ImapPort is < 1 or > 65535 || account.SmtpPort is < 1 or > 65535 || account.HistoryDays is < 1 or > 3650)
            throw new ArgumentException("Controllare indirizzo, password, server, porte e periodo (1–3650 giorni).");
    }
}

