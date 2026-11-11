using Horygon.Core;
using Horygon.Data;
using Horygon.Server;
using System.Security.Cryptography;
using Xunit;
namespace Horygon.Tests;
public class ServerOperationsTests
{
    [Fact] public void TrackingDoesNotInventDeliveredStateOrAmbiguousOrderAssociation()
    {
        var mail=new EmailMessage{Id="m",AccountId="a",MessageId="message",Subject="Ordine 12345 e ordine 67890",Body="DHL tracking: ABC12345678",Date=DateTimeOffset.UtcNow};
        var copy=new EmailMessage{Id="copy",AccountId="a",MessageId=mail.MessageId,Subject=mail.Subject,Body=mail.Body,Date=mail.Date};
        var rows=OperationsProjection.Build([mail,copy],[]);
        Assert.Equal(2,rows.Count(x=>x.Area=="Ordini"));var shipment=Assert.Single(rows,x=>x.Area=="Logistica");
        Assert.Equal("ABC12345678",shipment.Tracking);Assert.Equal("",shipment.OrderNumber);Assert.Equal("Tracking rilevato",shipment.Status);
    }
    [Fact] public async Task ManualUpdatesSurviveImportsAndStaleEditsAreRejected()
    {
        var path=Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db");var store=new OperationsStore(path,new ServerProtector(RandomNumberGenerator.GetBytes(32)));store.Initialize();
        var row=new OperationalRecord{Id="order:one",Area="Ordini",Title="Ordine 1",OrderNumber="1",Status="Da verificare"};
        await store.SaveAsync([row],true);var old=(await store.ReadAsync()).Records.Single();
        old.Status="Consegnato";await store.SaveAsync([old],false);
        await store.SaveAsync([new(){Id=old.Id,Area="Ordini",Title=old.Title,Status="Da verificare",EmailIds=["new-mail"]}],true);
        var current=(await store.ReadAsync()).Records.Single();Assert.Equal("Consegnato",current.Status);Assert.Contains("new-mail",current.EmailIds);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>store.SaveAsync([old],false));
    }
    [Fact] public async Task IdenticalImportDoesNotChangeRevisionOrDuplicateRows()
    {
        var store=new OperationsStore(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));store.Initialize();
        var row=new OperationalRecord{Id="order:one",Area="Ordini",Title="Ordine 1"};await store.SaveAsync([row],true);
        var first=(await store.ReadAsync()).Records.Single();await store.SaveAsync([first],true);var second=Assert.Single((await store.ReadAsync()).Records);Assert.Equal(first.Revision,second.Revision);
    }
    [Fact] public async Task NewEmailFlagsClosedManualRecordButDuplicateCopyDoesNotReopenReview()
    {
        var store=new OperationsStore(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));store.Initialize();
        await store.SaveAsync([new(){Id="order:one",Area="Ordini",Title="Ordine",EmailIds=["original"],SourceKeys=["logical-original"]}],true);
        var row=(await store.ReadAsync()).Records.Single();row.Closed=true;row.Status="Consegnato";await store.SaveAsync([row],false);
        await store.SaveAsync([new(){Id=row.Id,Area="Ordini",Title="Ordine",EmailIds=["original","new"],SourceKeys=["logical-original","logical-new"]}],true);
        row=(await store.ReadAsync()).Records.Single();Assert.True(row.NeedsReview);Assert.True(row.Closed);Assert.Equal("Consegnato",row.Status);
        row.NeedsReview=false;await store.SaveAsync([row],false);
        await store.SaveAsync([new(){Id=row.Id,Area="Ordini",Title="Ordine",EmailIds=["copy-of-new"],SourceKeys=["logical-new"]}],true);
        row=(await store.ReadAsync()).Records.Single();Assert.False(row.NeedsReview);Assert.True(row.Closed);
    }
    [Fact] public async Task PausePersistsDisabledAutomaticDownloadWithoutStartingProvider()
    {
        var repo=new EncryptedRepository(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));await repo.InitializeAsync();await repo.SaveAsync(new AppSettings{Id="settings",AutoSync=true});
        var store=new OperationsStore(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));store.Initialize();
        var worker=new MailWorker(repo,store,Path.GetTempPath());await worker.RequestAsync("sync");await worker.RequestAsync("pause");
        Assert.False(worker.Busy);Assert.False((await repo.GetAsync<AppSettings>("settings"))!.AutoSync);Assert.Empty(await repo.ListAsync<AnalysisReceipt>());
    }
    [Fact] public void ServerEncryptionRejectsWrongKeyAndTampering()
    {
        var protector=new ServerProtector(RandomNumberGenerator.GetBytes(32));var data=protector.Protect([1,2,3]);Assert.Equal(new byte[]{1,2,3},protector.Unprotect(data));
        Assert.ThrowsAny<CryptographicException>(()=>new ServerProtector(RandomNumberGenerator.GetBytes(32)).Unprotect(data));data[^1]^=1;Assert.ThrowsAny<CryptographicException>(()=>protector.Unprotect(data));
    }
    [Fact] public async Task PortableMigrationPreservesAnalysesAndDisablesAutoSync()
    {
        var source=new EncryptedRepository(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));await source.InitializeAsync();
        await source.SaveAsync(new EmailMessage{Id="mail",MessageId="same",Analysis=new(){Source="AI"}});await source.SaveAsync(new AppSettings{Id="settings",AutoSync=true});
        var archive=await PortableBackup.ExportAsync(source,"synthetic passphrase 12345");
        var target=new EncryptedRepository(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".db"),new ServerProtector(RandomNumberGenerator.GetBytes(32)));await target.InitializeAsync();
        await Assert.ThrowsAnyAsync<CryptographicException>(()=>PortableBackup.ImportAsync(target,archive,"incorrect password long"));
        await PortableBackup.ImportAsync(target,archive,"synthetic passphrase 12345");Assert.Equal("AI",(await target.GetAsync<EmailMessage>("mail"))!.Analysis!.Source);Assert.False((await target.GetAsync<AppSettings>("settings"))!.AutoSync);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>PortableBackup.ImportAsync(target,archive,"synthetic passphrase 12345"));
    }
}
