using Horygon.Core;
namespace Horygon.Server;

public sealed class StatusSettings : Entity
{
    public int OrdersPerPage { get; set; } = 10;
    public string AccessKey { get; set; } = "";
}

public sealed class PrinterConfig : Entity
{
    public bool Deleted { get; set; }
    public string Brand { get; set; } = "";
    public string Model { get; set; } = "";
    public List<int> Ports { get; set; } = [80,443,631,9100];
    public string Name { get; set; } = "";
    public string Services { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public long Revision { get; set; }
}

public sealed class PrinterProbe : Entity
{
    public DateTimeOffset CheckedAt { get; set; }
    public List<PrinterPortResult> Results { get; set; } = [];
}
public sealed record PrinterPortResult(int Port, string Service, bool Reachable, string Detail);
