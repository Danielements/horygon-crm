namespace Horygon.Core;

// The saved email, rather than this counter, is the authoritative analysis checkpoint.
public sealed class WorkProgress : Entity
{
    public string Operation { get; set; } = "Analisi";
    public string Stage { get; set; } = "Analisi";
    public string State { get; set; } = "In corso";
    public bool DownloadIncomplete { get; set; }
    public int Completed { get; set; }
    public int Total { get; set; }
    public string LastEmailId { get; set; } = "";
    public string Detail { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public string Display => $"{State} · {Stage} · analisi salvate {Completed}/{Total} · {Detail}";
}
