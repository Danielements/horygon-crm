using System.Text.Json;
using Horygon.Core;
using Microsoft.EntityFrameworkCore;
namespace Horygon.Data;

public sealed class StoredRecord
{
    public string Kind { get; set; } = "";
    public string Id { get; set; } = "";
    public byte[] Payload { get; set; } = [];
}
public sealed class HorygonDb(string path) : DbContext
{
    public DbSet<StoredRecord> Records => Set<StoredRecord>();
    protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlite($"Data Source={path}");
    protected override void OnModelCreating(ModelBuilder model) => model.Entity<StoredRecord>().HasKey(x => new { x.Kind, x.Id });
}
public sealed class EncryptedRepository(string path, IProtector protector) : IRepository
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public Task InitializeAsync() => Task.Run(async () =>
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        await using var db = new HorygonDb(path);
        await db.Database.EnsureCreatedAsync();
    });
    public Task<List<T>> ListAsync<T>() where T : Entity => Task.Run(async () =>
    {
        await using var db = new HorygonDb(path);
        var rows = await db.Records.AsNoTracking().Where(x => x.Kind == typeof(T).Name).ToListAsync();
        return rows.Select(x => JsonSerializer.Deserialize<T>(protector.Unprotect(x.Payload))!).ToList();
    });
    public Task<T?> GetAsync<T>(string id) where T : Entity => Task.Run(async () =>
    {
        await using var db = new HorygonDb(path);
        var row = await db.Records.FindAsync(typeof(T).Name, id);
        return row is null ? null : JsonSerializer.Deserialize<T>(protector.Unprotect(row.Payload));
    });
    public Task<bool> ExistsAsync<T>(string id) where T : Entity => Task.Run(async () =>
    {
        await using var db = new HorygonDb(path);
        return await db.Records.AnyAsync(x => x.Kind == typeof(T).Name && x.Id == id);
    });
    public Task SaveAsync<T>(T item) where T : Entity => Task.Run(async () =>
    {
        var payload = protector.Protect(JsonSerializer.SerializeToUtf8Bytes(item));
        await gate.WaitAsync();
        try
        {
            await using var db = new HorygonDb(path);
            var row = await db.Records.FindAsync(typeof(T).Name, item.Id);
            if (row is null) db.Records.Add(new StoredRecord { Kind = typeof(T).Name, Id = item.Id, Payload = payload });
            else row.Payload = payload;
            await db.SaveChangesAsync();
        }
        finally { gate.Release(); }
    });
}
