using System.Text.Json;
using Horygon.Core;
using Xunit;
namespace Horygon.Tests;
public class TaskBoardTests
{
    [Theory]
    [InlineData("Call spostata", "La call è rinviata a domani", "CAMBIO APPUNTAMENTO")]
    [InlineData("Ordine", "C'è un problema con la consegna", "PROBLEMA SEGNALATO")]
    [InlineData("Sollecito", "Attendiamo risposta", "SOLLECITO")]
    [InlineData("Aggiornamento", "Problema risolto", "ESITO DA VERIFICARE")]
    [InlineData("Re: Problema consegna", "Grazie\n> C'è un problema", "NUOVO MESSAGGIO")]
    public void DetectsChangesInNewText(string subject,string body,string expected)
    { Assert.Equal(expected,TaskMailSignals.Detect(new(),new() { Subject=subject,Body=body },"own@example.test").Status); }
    [Fact] public async Task UpdatesOnlyLinkedOpenTasksAndDoesNotRepeatCopies()
    {
        var repo=new Repo(); var task=new AITask { Id="t",EmailId="in",State=TaskState.WAITING,Due=DateTime.Today.AddDays(1) };
        var other=new AITask { Id="other",EmailId="unrelated" }; var closed=new AITask { Id="closed",EmailId="in",State=TaskState.COMPLETED };
        var mail=new EmailMessage { Id="in",MessageId="m",AccountId="a",Date=DateTimeOffset.UtcNow,Subject="Call",Body="Call spostata a domani" };
        var copy=new EmailMessage { Id="copy",MessageId="m",AccountId="a",Date=mail.Date,Body=mail.Body };
        var rows=RoadmapBuilder.Build([mail,copy],[new() { Id="a" }],[task,other,closed],[],24,DateTimeOffset.UtcNow);
        var updater=new TaskBoardUpdater(repo); await updater.UpdateAsync(rows,[]); await updater.UpdateAsync(rows,[]);
        Assert.Equal("CAMBIO APPUNTAMENTO",task.MailStatus); Assert.Equal(TaskState.WAITING,task.State); Assert.Equal(DateTime.Today.AddDays(1),task.Due);
        Assert.Single(await repo.ListAsync<TaskMailEvent>()); Assert.Equal("",closed.LastMailId); Assert.Equal("",other.LastMailId);
    }
    [Fact] public async Task OlderMailCannotOverwriteLatestStatusAndHistoryIsKept()
    {
        var repo=new Repo(); var task=new AITask { Id="t",LastMailAt=DateTimeOffset.UtcNow,MailStatus="CAMBIO APPUNTAMENTO" };
        var mail=new EmailMessage { Id="old",AccountId="a",Date=DateTimeOffset.UtcNow.AddDays(-1),Body="Problema consegna" };
        await new TaskBoardUpdater(repo).UpdateAsync([new() { Tasks=[task],Emails=[mail] }],[]);
        Assert.Equal("CAMBIO APPUNTAMENTO",task.MailStatus); Assert.Single(await repo.ListAsync<TaskMailEvent>());
    }
    [Fact] public async Task PromotionalMailCannotEscalateTask()
    {
        var task=new AITask();var mail=new EmailMessage { Subject="Sconti",Body="Acquista ora. Unsubscribe",Analysis=new() { Priority=Priority.CRITICAL } };
        var repo=new Repo();await new TaskBoardUpdater(repo).UpdateAsync([new() { Tasks=[task],Emails=[mail] }],[]);
        Assert.Empty(await repo.ListAsync<TaskMailEvent>());Assert.Equal(Priority.MEDIUM,task.Priority);
    }
    class Repo : IRepository
    {
        readonly Dictionary<(Type,string),string> data=[];
        public Task InitializeAsync()=>Task.CompletedTask;
        public Task<List<T>> ListAsync<T>() where T:Entity => Task.FromResult(data.Where(x=>x.Key.Item1==typeof(T)).Select(x=>JsonSerializer.Deserialize<T>(x.Value)!).ToList());
        public Task<T?> GetAsync<T>(string id) where T:Entity=>Task.FromResult(data.TryGetValue((typeof(T),id),out var s)?JsonSerializer.Deserialize<T>(s):null);
        public Task SaveAsync<T>(T item) where T:Entity { data[(typeof(T),item.Id)]=JsonSerializer.Serialize(item);return Task.CompletedTask; }
        public Task<bool> ExistsAsync<T>(string id) where T:Entity=>Task.FromResult(data.ContainsKey((typeof(T),id)));
    }
}
