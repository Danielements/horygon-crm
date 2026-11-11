using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
namespace Horygon.Core;

public sealed class OperationalRecord : Entity
{
    public string Area { get; set; } = "Attività";
    public string Title { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public string PrinterId { get; set; } = "";
    public string ProductionState { get; set; } = "In coda";
    public string Customer { get; set; } = "";
    public string Status { get; set; } = "Da verificare";
    public string Owner { get; set; } = "";
    public DateTime? Due { get; set; }
    public string Problem { get; set; } = "";
    public string NextAction { get; set; } = "";
    public string Tracking { get; set; } = "";
    public string Carrier { get; set; } = "";
    public string Source { get; set; } = "Manuale";
    public List<string> EmailIds { get; set; } = [];
    public List<string> SourceKeys { get; set; } = [];
    public bool NeedsReview { get; set; }
    public string ReviewReason { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public long Revision { get; set; }
    public bool Manual { get; set; }
    public bool Closed { get; set; }
}
public static class OperationsProjection
{
    public static readonly string[] Areas = ["Ordini", "Attività", "Alert", "Contabilità", "Logistica"];
    static string Key(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    static string Clip(string text, int max = 180) => text.Length > max ? text[..max] : text;
    public static List<OperationalRecord> Build(IReadOnlyList<EmailMessage> emails, IReadOnlyList<AITask> tasks)
    {
        var records = new Dictionary<string, OperationalRecord>();
        foreach (var mail in emails.Where(x => !MailDirection.IsDraft(x) && x.Classification.Kind == MailKind.Regular).GroupBy(LogicalMail.Key).Select(x => x.First()).OrderBy(x => x.Date))
        {
            var text = mail.Subject + "\n" + mail.Body[..Math.Min(mail.Body.Length, 12000)];
            var numbers = (mail.Analysis?.OrderNumbers ?? []).Concat(Regex.Matches(text, @"(?i)\b(?:ordine|order)\s*(?:n(?:umero)?[.°]?\s*|[#:]\s*)?([A-Z0-9][A-Z0-9/-]{2,39})", RegexOptions.None, TimeSpan.FromMilliseconds(100)).Select(x => x.Groups[1].Value).Where(x => x.Any(char.IsDigit))).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var tracking = Regex.Matches(text, @"(?i)\b(?:tracking(?:\s+(?:number|code))?|numero\s+(?:di\s+)?(?:tracking|spedizione)|codice\s+(?:di\s+)?(?:tracking|spedizione)|awb)\s*(?:n[.°]?\s*)?[:#= -]\s*([A-Z0-9][A-Z0-9-]{5,39})\b", RegexOptions.None, TimeSpan.FromMilliseconds(100)).Select(x => x.Groups[1].Value).Where(x => x.Any(char.IsDigit)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var carrier = new[] { "DHL", "UPS", "FedEx", "GLS", "BRT", "SDA", "Poste Italiane", "TNT" }.FirstOrDefault(x => Regex.IsMatch(text, @"\b" + Regex.Escape(x) + @"\b", RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100))) ?? "Da identificare";
            foreach (var number in numbers)
            {
                var id = "order:" + Key(mail.AccountId + "|" + number.ToUpperInvariant());
                if (!records.TryGetValue(id, out var row)) records[id] = row = new() { Id = id, Area = "Ordini", OrderNumber = number, Title = "Ordine " + number, Source = "Email · da verificare" };
                row.EmailIds.Add(mail.Id); row.SourceKeys.Add(LogicalMail.Key(mail)); row.UpdatedAt = mail.Date; row.NextAction = "Verificare aggiornamento email";
                row.Problem = mail.Analysis?.Priority >= Priority.HIGH ? Clip(mail.Analysis.Summary) : row.Problem;
            }
            var hasTask=tasks.Any(x=>x.EmailId==mail.Id||x.EmailIds.Contains(mail.Id));
            var caseArea=mail.Analysis?.Category=="administration"?"Contabilità":mail.Analysis?.Priority>=Priority.HIGH?"Alert":Regex.IsMatch(text,@"(?i)\b(call|appuntamento|riunione|meeting)\b",RegexOptions.None,TimeSpan.FromMilliseconds(100))?"Attività":null;
            if(!hasTask && caseArea!=null)
            {
                var id="task:mail:"+Key(mail.AccountId+"|"+(string.IsNullOrEmpty(mail.ThreadKey)?LogicalMail.Key(mail):mail.ThreadKey));
                if(!records.TryGetValue(id,out var row))records[id]=row=new(){Id=id,Area=caseArea,Source="Email · da verificare"};
                row.Title=Clip(mail.Subject);row.UpdatedAt=mail.Date;row.EmailIds.Add(mail.Id); row.SourceKeys.Add(LogicalMail.Key(mail));row.OrderNumber=numbers.Count==1?numbers[0]:row.OrderNumber;
                row.Problem=caseArea=="Alert"?Clip(mail.Analysis?.Summary??mail.Subject):"";
                row.NextAction=caseArea=="Attività"?"Confermare appuntamento e orario":"Verificare la richiesta";
            }
            foreach (var code in tracking)
            {
                var id = "shipment:" + Key(mail.AccountId + "|" + code.ToUpperInvariant());
                if (!records.TryGetValue(id, out var row)) records[id] = row = new() { Id = id, Area = "Logistica", Title = "Spedizione " + code, Tracking = code, Carrier = carrier, Source = "Email · tracking non verificato", Status = "Tracking rilevato" };
                row.EmailIds.Add(mail.Id); row.SourceKeys.Add(LogicalMail.Key(mail)); row.UpdatedAt = mail.Date;
                row.OrderNumber = numbers.Count == 1 ? numbers[0] : row.OrderNumber;
                row.NextAction = numbers.Count > 1 ? "Associare l'ordine corretto" : "Verificare sul servizio del corriere";
            }
        }
        foreach (var task in tasks)
        {
            var source = emails.FirstOrDefault(x => x.Id == task.EmailId);
            var area = source?.Analysis?.Category == "administration" ? "Contabilità" : "Attività";
            var problem = task.MailStatus is "PROBLEMA SEGNALATO" or "SOLLECITO" ? task.MailStatus : "";
            records["task:" + task.Id] = new() { Id = "task:" + task.Id, Area = area, Title = Clip(task.Title), OrderNumber = task.OrderNumber, Status = task.State switch { TaskState.COMPLETED => "Completato", TaskState.CANCELLED => "Annullato", TaskState.IN_PROGRESS => "In corso", TaskState.WAITING => "In attesa", _ => "Aperto" }, Owner = task.Owner, Due = task.Due, Problem = problem, NextAction = task.MailStatus == "NESSUN AGGIORNAMENTO EMAIL" ? "" : task.MailStatus, Source = "Attività locale", SourceKeys = emails.Where(x => x.Id == task.EmailId || task.EmailIds.Contains(x.Id)).Select(LogicalMail.Key).Distinct().ToList(), EmailIds = task.EmailIds.Append(task.EmailId).Where(x => x != "").Distinct().ToList(), UpdatedAt = task.UpdatedAt, Closed = task.State is TaskState.COMPLETED or TaskState.CANCELLED };
        }
        return records.Values.ToList();
    }
    public static void Validate(OperationalRecord row)
    {
        if (!Areas.Contains(row.Area) || string.IsNullOrWhiteSpace(row.Title) || row.Title.Length > 200 || row.Id.Length > 120 || row.EmailIds.Count > 10000 || row.SourceKeys.Count > 10000) throw new ArgumentException("Area o titolo non valido.");
        foreach (var text in new[] { row.PrinterId, row.ProductionState, row.OrderNumber, row.Customer, row.Status, row.Owner, row.Problem, row.NextAction, row.Tracking, row.Carrier })
            if (text.Length > 1000) throw new ArgumentException("Campo troppo lungo (massimo 1000 caratteri).");
    }
}
