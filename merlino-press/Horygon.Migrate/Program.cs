using Horygon.Core;
using Horygon.Data;
using Horygon.Security;
if(args.Length!=1){Console.Error.WriteLine("Uso: Horygon.Migrate percorso-backup.horygon (chiudere prima Horygon). Passphrase nella variabile HORYGON_MIGRATION_PASSWORD.");return 2;}
try
{
    var password=Environment.GetEnvironmentVariable("HORYGON_MIGRATION_PASSWORD")??"";
    var source=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Horygon","Data","horygon.db");
    if(!File.Exists(source))throw new FileNotFoundException("Archivio Horygon non trovato.");
    var repository=new EncryptedRepository(source,new DpapiProtector());
    var archive=await PortableBackup.ExportAsync(repository,password);
    await using var file=new FileStream(Path.GetFullPath(args[0]),FileMode.CreateNew,FileAccess.Write,FileShare.None);await file.WriteAsync(archive);
    Console.WriteLine("Backup portabile cifrato creato. Conservare la passphrase separatamente. Nessuna chiamata AI effettuata.");return 0;
}
catch(Exception ex){Console.Error.WriteLine("Esportazione non riuscita: "+ex.GetType().Name);return 1;}
