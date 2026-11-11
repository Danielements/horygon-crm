using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
namespace Horygon.Core;
public static class PortableBackup
{
    public sealed record Pack(string Kind,JsonElement[] Items);
    static readonly Type[] Types=[typeof(EmailAccount),typeof(EmailMessage),typeof(AITask),typeof(Draft),typeof(AppSettings),typeof(GoogleOAuthSession),typeof(AnalysisReceipt),typeof(WorkProgress),typeof(FolderCheckpoint),typeof(MailSyncCoverage),typeof(TaskMailEvent),typeof(AuditEvent),typeof(RuleVersion)];
    static byte[] Key(string password,byte[] salt){if(password.Length<16)throw new ArgumentException("Usare una passphrase di almeno 16 caratteri.");return Rfc2898DeriveBytes.Pbkdf2(password,salt,200000,HashAlgorithmName.SHA256,32);}
    public static async Task<byte[]> ExportAsync(IRepository repository,string password)
    {
        var packs=new List<Pack>();
        foreach(var type in Types)
        {
            var task=(Task)typeof(IRepository).GetMethod("ListAsync")!.MakeGenericMethod(type).Invoke(repository,null)!;await task;
            var list=task.GetType().GetProperty("Result")!.GetValue(task);
            packs.Add(new(type.Name,JsonSerializer.SerializeToElement(list).EnumerateArray().ToArray()));
        }
        using var memory=new MemoryStream();using(var gzip=new GZipStream(memory,CompressionLevel.Optimal,true))await JsonSerializer.SerializeAsync(gzip,packs);
        var salt=RandomNumberGenerator.GetBytes(16);var payload=new ServerProtector(Key(password,salt)).Protect(memory.ToArray());
        return "HORYGON1"u8.ToArray().Concat(salt).Concat(payload).ToArray();
    }
    public static async Task<int> ImportAsync(IRepository repository,byte[] archive,string password)
    {
        if(archive.Length<52||!archive.AsSpan(0,8).SequenceEqual("HORYGON1"u8))throw new InvalidDataException("Backup non valido.");
        var bytes=new ServerProtector(Key(password,archive[8..24])).Unprotect(archive[24..]);
        using var memory=new MemoryStream(bytes);using var gzip=new GZipStream(memory,CompressionMode.Decompress);
        var packs=await JsonSerializer.DeserializeAsync<List<Pack>>(gzip)??throw new InvalidDataException();
        var validated=new List<(Type,Entity)>();
        foreach(var pack in packs)
        {
            var type=Types.SingleOrDefault(x=>x.Name==pack.Kind)??throw new InvalidDataException("Tipo di record non riconosciuto.");
            foreach(var item in pack.Items){var entity=(Entity?)item.Deserialize(type)??throw new InvalidDataException();if(string.IsNullOrWhiteSpace(entity.Id))throw new InvalidDataException();validated.Add((type,entity));}
        }
        if((await repository.ListAsync<EmailMessage>()).Count>0||(await repository.ListAsync<EmailAccount>()).Count>0)throw new InvalidOperationException("Importazione consentita soltanto su un archivio posta vuoto.");
        foreach(var (type,entity) in validated)
        {
            if(entity is AppSettings settings)settings.AutoSync=false;
            if(entity is WorkProgress work && work.State!="Completato")work.State="In pausa";
            await (Task)typeof(IRepository).GetMethod("SaveAsync")!.MakeGenericMethod(type).Invoke(repository,[entity])!;
        }
        return validated.Count;
    }
}
