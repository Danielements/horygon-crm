using Microsoft.Data.Sqlite;
using System.Text.Json;
using Horygon.Core;
namespace Horygon.Server;
public sealed class OperationsStore(string path, IProtector protector)
{
    readonly SemaphoreSlim gate = new(1,1);
    SqliteConnection Connect() { var db = new SqliteConnection($"Data Source={path}"); db.Open(); return db; }
    public void Initialize()
    {
        using var db = Connect(); using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, recordid TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(id TEXT PRIMARY KEY, value TEXT NOT NULL);"; cmd.ExecuteNonQuery();
    }
    public async Task<(List<OperationalRecord> Records,string? LastSync)> ReadAsync() => await Task.Run(async () =>
    {
        await gate.WaitAsync(); try { using var db = Connect(); return (Read(db), Meta(db)); } finally { gate.Release(); }
    });
    List<OperationalRecord> Read(SqliteConnection db, SqliteTransaction? tx = null)
    { using var cmd = db.CreateCommand(); cmd.Transaction = tx; cmd.CommandText = "SELECT payload FROM records"; using var reader = cmd.ExecuteReader(); var result = new List<OperationalRecord>(); while(reader.Read()) result.Add(JsonSerializer.Deserialize<OperationalRecord>(protector.Unprotect(Convert.FromBase64String(reader.GetString(0))))!); return result; }
    static string? Meta(SqliteConnection db) { using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT value FROM meta WHERE id='sync'"; return cmd.ExecuteScalar() as string; }
    public async Task<List<AuditEvent>> ReadAuditAsync() => await Task.Run(async () =>
    {
        await gate.WaitAsync();
        try
        {
            using var db=Connect();using var cmd=db.CreateCommand();cmd.CommandText="SELECT at,action,recordid FROM audit ORDER BY id DESC LIMIT 100";
            using var reader=cmd.ExecuteReader();var result=new List<AuditEvent>();
            while(reader.Read())result.Add(new(){Timestamp=DateTimeOffset.Parse(reader.GetString(0)),Action="REGISTRO_"+reader.GetString(1),EntityId=reader.GetString(2),Result="Voce operativa aggiornata",Actor="Server"});return result;
        }
        finally{gate.Release();}
    });
    public async Task SaveAsync(List<OperationalRecord> incoming, bool import) => await Task.Run(async () =>
    {
        await gate.WaitAsync(); try
        {
            using var db = Connect(); using var tx = db.BeginTransaction();
            var existing = Read(db,tx).ToDictionary(x => x.Id);
            foreach (var row in incoming)
            {
                OperationsProjection.Validate(row);
                if (import && !(row.Id.StartsWith("order:") || row.Id.StartsWith("shipment:") || row.Id.StartsWith("task:"))) throw new ArgumentException("Identificatore importazione non valido.");
                if (existing.TryGetValue(row.Id, out var old))
                {
                    if (!import && row.Revision != old.Revision) throw new InvalidOperationException("La riga è cambiata: aggiorna e riprova.");
                    if (import && old.Manual)
                    {
                        var sources=old.EmailIds.Concat(row.EmailIds).Distinct().ToList();
                        var sourceKeys=old.SourceKeys.Concat(row.SourceKeys).Distinct().ToList();
                        var newMessage=row.SourceKeys.Count>0 ? sourceKeys.Count!=old.SourceKeys.Count : sources.Count!=old.EmailIds.Count;
                        if(sources.Count!=old.EmailIds.Count || newMessage)
                        {
                            old.EmailIds=sources;old.SourceKeys=sourceKeys;
                            if(newMessage){old.NeedsReview=true;old.ReviewReason=string.IsNullOrWhiteSpace(row.Problem)?"Nuova email collegata: verificare se cambia lo stato della voce.":row.Problem;}
                            old.Revision++;Write(db,tx,old);
                            if(newMessage)AppendAudit(db,tx,"NEW_EMAIL",old.Id);
                        }
                        continue;
                    }
                    if(import){row.Revision=old.Revision;if(JsonSerializer.Serialize(row)==JsonSerializer.Serialize(old))continue;}
                    else { row.EmailIds=old.EmailIds.Concat(row.EmailIds).Distinct().ToList(); row.SourceKeys=old.SourceKeys.Concat(row.SourceKeys).Distinct().ToList(); if(!row.NeedsReview)row.ReviewReason=""; }
                    row.Revision = old.Revision + 1;
                }
                else { if (!import && row.Revision != 0) throw new InvalidOperationException("Riga non trovata."); row.Revision = 1; }
                row.Manual = !import;
                if (!import) { row.Source = "Manuale"; row.UpdatedAt = DateTimeOffset.UtcNow; }
                Write(db,tx,row); existing[row.Id] = row;
                AppendAudit(db,tx,import ? "IMPORT" : "EDIT",row.Id);
            }
            if(import) { using var cmd = db.CreateCommand(); cmd.Transaction=tx; cmd.CommandText="INSERT INTO meta(id,value) VALUES('sync',$at) ON CONFLICT(id) DO UPDATE SET value=$at";cmd.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.ToString("O"));cmd.ExecuteNonQuery(); }
            tx.Commit();
        }
        finally { gate.Release(); }
    });
    static void AppendAudit(SqliteConnection db,SqliteTransaction tx,string action,string id)
    {
        using var audit=db.CreateCommand();audit.Transaction=tx;audit.CommandText="INSERT INTO audit(at,action,recordid) VALUES($at,$action,$id)";
        audit.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.ToString("O"));audit.Parameters.AddWithValue("$action",action);audit.Parameters.AddWithValue("$id",id);audit.ExecuteNonQuery();
    }
    void Write(SqliteConnection db, SqliteTransaction tx, OperationalRecord row)
    { using var cmd = db.CreateCommand();cmd.Transaction=tx;cmd.CommandText="INSERT INTO records(id,payload) VALUES($id,$data) ON CONFLICT(id) DO UPDATE SET payload=$data";cmd.Parameters.AddWithValue("$id",row.Id);cmd.Parameters.AddWithValue("$data",Convert.ToBase64String(protector.Protect(JsonSerializer.SerializeToUtf8Bytes(row))));cmd.ExecuteNonQuery(); }
}
