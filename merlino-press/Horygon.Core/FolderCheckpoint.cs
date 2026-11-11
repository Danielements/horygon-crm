namespace Horygon.Core;

public sealed class FolderCheckpoint : Entity
{
    public bool IsSent { get; set; }
    public bool IsDraft { get; set; }
    public uint LastUid { get; set; }
    public DateTimeOffset Since { get; set; }
    public static bool CanResume(FolderCheckpoint saved, DateTimeOffset since) => since >= saved.Since;
}
