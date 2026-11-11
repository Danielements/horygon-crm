using System.Net.Mail;
namespace Horygon.Core;

public sealed class RoadmapRow
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Contact { get; init; } = "";
    public string Orders { get; init; } = "";
    public string Evidence { get; init; } = "";
    public string Coherence { get; init; } = "";
    public string Summary { get; init; } = "";
    public string Coverage { get; init; } = "";
    public int IncomingCount { get; init; }
    public int OutgoingCount { get; init; }
    public string State { get; init; } = "";
    public string Response { get; init; } = "";
    public string Timing { get; init; } = "";
    public Priority Priority { get; init; }
    public bool Overdue { get; init; }
    public bool PartialHistory { get; init; }
    public bool NeedsResponse { get; init; }
    public bool Closed { get; init; }
    public DateTimeOffset Latest { get; init; }
    public List<EmailMessage> Emails { get; init; } = [];
    public List<AITask> Tasks { get; init; } = [];
    public string DelayLabel => Overdue ? (PartialHistory ? "RITARDO DA VERIFICARE" : "IN RITARDO") : "—";
    public string MailType => string.Join(" / ", Emails.Select(x => x.Classification.Label).Distinct());
    public int MailCount => Emails.Count;
    public string TaskLabel => $"{Tasks.Count(x => x.State is TaskState.COMPLETED or TaskState.CANCELLED)}/{Tasks.Count}";
}

public static class RoadmapBuilder
{
    public static string Address(string value)
    { try { return new MailAddress(value).Address.ToLowerInvariant(); } catch (Exception ex) when (ex is FormatException or ArgumentException) { return ""; } }

    public static List<RoadmapRow> Build(IReadOnlyList<EmailMessage> mails, IReadOnlyList<EmailAccount> accounts, IReadOnlyList<AITask> tasks, IReadOnlyList<Draft> drafts, int targetHours, DateTimeOffset now, IReadOnlyList<MailSyncCoverage>? coverage = null)
    {
        var rows = new List<RoadmapRow>();
        foreach (var accountGroup in mails.GroupBy(x => x.AccountId))
        {
            var own = accounts.FirstOrDefault(x => x.Id == accountGroup.Key)?.Address.ToLowerInvariant() ?? "";
            var source = accountGroup.Where(x => !MailDirection.IsDraft(x)).ToList();
            if (source.Count == 0) continue;
            var parent = Enumerable.Range(0, source.Count).ToArray();
            int Root(int i) { while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
            void Union(int a, int b) { parent[Root(b)] = Root(a); }
            var links = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < source.Count; i++)
            {
                foreach (var key in source[i].References.Append(source[i].MessageId).Append(source[i].InReplyTo).Append(source[i].ThreadKey).Append("logical:" + LogicalMail.Key(source[i])).Append(string.IsNullOrEmpty(source[i].RequestGroupId) ? "" : "manual:" + source[i].RequestGroupId).Where(x => !string.IsNullOrWhiteSpace(x)))
                { if (links.TryGetValue(key, out var previous)) Union(i, previous); else links[key] = i; }
            }
            // Separate threads are only candidates: never silently merge on subject or AI similarity.
            var candidates = source.Where(x => !MailDirection.IsOutgoing(x, own) && !MailDirection.IsDraft(x) && Address(x.From) != "" && x.Analysis?.OrderNumbers.Count == 1)
                .GroupBy(x => $"{Address(x.From)}|{x.Analysis!.OrderNumbers[0]}|{x.Analysis.Category}")
                .Where(x => x.Select(m => Root(source.IndexOf(m))).Distinct().Count() > 1).SelectMany(x => x.Select(m => m.Id)).ToHashSet();
            foreach (var group in source.Select((m, i) => (m, root: Root(i))).GroupBy(x => x.root))
            {
                var all = group.Select(x => x.m).OrderBy(x => x.Date).ToList();
                var unique = all.GroupBy(x => LogicalMail.Key(x)).Select(x => x.OrderBy(m => MailDirection.IsDraft(m)).ThenByDescending(m => MailDirection.IsOutgoing(m, own)).First()).OrderBy(x => x.Date).ToList();
                var ids = all.Select(x => x.Id).ToHashSet();
                var related = tasks.Where(x => ids.Contains(x.EmailId) || x.EmailIds.Any(ids.Contains)).ToList();
                var inbound = unique.Where(x => !MailDirection.IsOutgoing(x, own) && !MailDirection.IsDraft(x)).ToList();
                var outbound = unique.Where(x => MailDirection.IsOutgoing(x, own)).ToList();
                var last = inbound.LastOrDefault() ?? unique.Last();
                bool Answered(EmailMessage request) => outbound.Any(x => MailDirection.RepliedTo(request, x, unique)) || drafts.Any(x =>
                    x.AccountId == accountGroup.Key && x.EmailId == request.Id && x.State == SendState.Sent && x.ApprovedAt >= request.Date &&
                    (MailDirection.ContainsRecipient(x.To, Address(string.IsNullOrWhiteSpace(request.ReplyTo) ? request.From : request.ReplyTo)) || MailDirection.ContainsRecipient(x.Cc, Address(request.From))));
                var openRequests = inbound.Where(x => x.Analysis?.RequiresResponse == true && !Answered(x)).ToList();
                var sync = coverage?.FirstOrDefault(x => x.Id == accountGroup.Key);
                var complete = sync is { SentComplete: true, InboxComplete: true, CompletedAt: not null } && string.IsNullOrWhiteSpace(sync.Issue);
                var coverageLabel = sync is null ? "Inviata non ancora verificata: sincronizza" : complete ? $"Ricevuta + inviata dal {sync.Since:dd/MM/yyyy} · aggiornato {sync.CompletedAt:g}" : "Storico parziale: " + (sync.SentComplete ? "inviata acquisita, " : "inviata incompleta, ") + (sync.InboxComplete ? "ricevuta acquisita" : "ricevuta incompleta");
                var closedTasks = related.Where(x => x.State is TaskState.COMPLETED or TaskState.CANCELLED).ToList();
                var closed = related.Count > 0 && related.All(x => x.State is TaskState.COMPLETED or TaskState.CANCELLED) && inbound.All(x => closedTasks.Any(t => t.EmailId == x.Id || t.EmailIds.Contains(x.Id)));
                var needs = !closed && openRequests.Count > 0;
                var due = related.Where(x => x.State is not (TaskState.COMPLETED or TaskState.CANCELLED) && x.Due.HasValue).Select(x => x.Due).Min();
                var dateKnown = !needs || openRequests[0].Date.Year > 1970;
                var elapsed = needs && dateKnown ? now - openRequests[0].Date : TimeSpan.Zero;
                var overdue = !closed && ((due.HasValue && due.Value.Date < now.LocalDateTime.Date) || (needs && dateKnown && elapsed.TotalHours > Math.Clamp(targetHours, 1, 8760)));
                var categories = inbound.Where(x => x.Analysis != null).Select(x => x.Analysis!.Category).Distinct().Count();
                rows.Add(new RoadmapRow
                {
                    PartialHistory = !complete, Coverage = coverageLabel, IncomingCount = inbound.Count, OutgoingCount = outbound.Count,
                    Id = all[0].Id, Title = last.Subject, Contact = inbound.Count > 0 ? last.From : last.To, Emails = all, Tasks = related,
                    Orders = string.Join(", ", unique.SelectMany(x => x.Analysis?.OrderNumbers ?? []).Distinct()),
                    Evidence = all.Any(x => x.RequestGroupId != "") ? "Accorpamento confermato manualmente" : unique.Count > 1 ? "Collegamenti Message-ID / References della conversazione" : "Messaggio singolo",
                    Coherence = categories > 1 ? "Categorie diverse: verificare" : inbound.Any(x => x.Analysis is null) ? "Analisi incompleta" : "Categoria coerente (non verifica dei fatti)",
                    Summary = last.Summary + (last.Analysis?.ContainsDeadline == true && due is null ? " · Scadenza citata nella mail: verificarla e impostarla." : "") + (all.Any(x => candidates.Contains(x.Id)) ? " · Possibili richieste correlate per mittente, ordine e categoria: confrontare prima di accorpare." : ""),
                    Priority = openRequests.Count > 0 ? openRequests.Max(x => x.Analysis!.Priority) : last.Analysis?.Priority ?? Priority.MEDIUM,
                    NeedsResponse = needs, Closed = closed, Overdue = overdue, Latest = unique.Last().Date,
                    State = closed ? "Chiusa" : related.Any(x => x.State == TaskState.IN_PROGRESS) ? "In lavorazione" : related.Any(x => x.State == TaskState.WAITING) ? "In attesa" : closedTasks.Count > 0 ? "Da riaprire / nuova email" : "Aperta",
                    Response = closed ? "Chiusa manualmente" : needs && !complete ? "Risposta non trovata: storico parziale" : needs ? (openRequests.Any(x => x.Analysis!.Priority >= Priority.HIGH) ? "Risposta urgente" : "Da rispondere") : inbound.Count == 0 ? "Inviata: verifica riscontro" : Answered(last) ? "Risposta inviata (da verificare)" : last.Analysis is null ? "Da analizzare" : "Da verificare / non richiesta",
                    Timing = due.HasValue ? $"Scadenza {due:dd/MM/yyyy}" + (overdue ? (complete ? " · IN RITARDO" : " · ritardo da verificare") : "") : needs && !dateKnown ? "Data email non disponibile" : needs ? $"Attesa {Math.Max(0, elapsed.TotalHours):0} h / obiettivo {targetHours} h" + (overdue ? (complete ? " · IN RITARDO" : " · ritardo da verificare") : "") : "Nessuna scadenza impostata"
                });
            }
        }
        return rows.OrderBy(x => x.Closed).ThenByDescending(x => x.Overdue).ThenByDescending(x => x.NeedsResponse).ThenByDescending(x => x.Priority).ThenByDescending(x => x.Latest).ToList();
    }
}
