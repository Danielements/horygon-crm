using System.Threading.Channels;
using Horygon.Core;
using Horygon.AI;
using Horygon.Data;
using Horygon.Email;
namespace Horygon.Server;
public sealed class MailWorker(IRepository repository, OperationsStore operations, string rulesPath) : BackgroundService
{
    readonly Channel<string> queue=Channel.CreateBounded<string>(1);
    readonly object sync=new();
    CancellationTokenSource? current;
    public string Status { get; private set; }="Pronto";
    public bool Busy {get;private set;}
    public async Task RequestAsync(string command)
    {
        if(command=="pause")
        {
            var settings=await repository.GetAsync<AppSettings>("settings")??new(){Id="settings"};settings.AutoSync=false;await repository.SaveAsync(settings);
            lock(sync){if(current!=null)current.Cancel();else if(queue.Reader.TryRead(out _))Busy=false;Status="In pausa · download automatico disattivato";}
            await repository.SaveAsync(new AuditEvent{Action="SERVER_PAUSE",Result="Download automatico disattivato; annullamento richiesto"});return;
        }
        lock(sync){if(command is not ("sync" or "analyze"))throw new ArgumentException("Comando non valido.");if(Busy)throw new InvalidOperationException("Lavorazione già in corso.");Busy=true;Status="In coda";queue.Writer.TryWrite(command);}
    }
    public async Task ProjectAsync()
    {
        var mails=await repository.ListAsync<EmailMessage>();var tasks=await repository.ListAsync<AITask>();
        var accounts=await repository.ListAsync<EmailAccount>();var drafts=await repository.ListAsync<Draft>();
        var rows=RoadmapBuilder.Build(mails,accounts,tasks,drafts,24,DateTimeOffset.Now,await repository.ListAsync<MailSyncCoverage>());
        await new TaskBoardUpdater(repository).UpdateAsync(rows,accounts);
        await operations.SaveAsync(OperationsProjection.Build(mails,await repository.ListAsync<AITask>()),true);
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var startup=await repository.GetAsync<AppSettings>("settings")??new();AiConfiguration.Migrate(startup);
            await new HorygonOrchestrator(repository,new Analyzer(new ConfiguredAIProvider(startup)),new RuleService(rulesPath,repository),new ConservativePermissions()).RestoreCopiesAsync();
            await ProjectAsync();
        }
        catch(Exception){Status="Impossibile caricare il registro iniziale; verificare archivio e chiave.";}
        DateTimeOffset nextPoll=DateTimeOffset.UtcNow;
        while(!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if(!queue.Reader.TryRead(out var command))
                {
                    var settings=await repository.GetAsync<AppSettings>("settings")??new();
                    if(settings.AutoSync && DateTimeOffset.UtcNow>=nextPoll)
                    { lock(sync) { if(Busy)continue;Busy=true; } command="sync"; }
                    else {await Task.Delay(1000,stoppingToken);continue;}
                }
                using var cancellation=CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                lock(sync)current=cancellation;
                var config=await repository.GetAsync<AppSettings>("settings")??new();
                AiConfiguration.Migrate(config);
                var rules=new RuleService(rulesPath,repository);
                var orchestrator=new HorygonOrchestrator(repository,new Analyzer(new ConfiguredAIProvider(config)),rules,new ConservativePermissions());
                var work=new WorkProgress {Id="active-work",Operation=command,Stage=command=="sync"?"Download":"Analisi",State="In corso"};
                await repository.SaveAsync(work);
                try
                {
                    if(command=="sync")
                    {
                        var mail=new MailService(repository,new ConservativePermissions(),googleOAuth:new GoogleOAuthService(repository,config,new GoogleOAuthGateway()));
                        var accounts=await repository.ListAsync<EmailAccount>();if(accounts.Count==0)throw new InvalidOperationException("Configura prima un account email.");
                        foreach(var account in accounts)
                        {
                            var download=mail.SyncAsync(account,new Progress<SyncProgress>(p=>Status=p.Message),cancellation.Token);
                            while(await Task.WhenAny(download,Task.Delay(5000,CancellationToken.None))!=download)
                                try {await ProjectAsync();}catch(Exception){Status="Download in corso; aggiornamento tabellone da riprovare.";}
                            await download;
                        }
                        await orchestrator.RestoreCopiesAsync();
                    }
                    else
                    {
                        if(!config.AiEnabled)throw new InvalidOperationException("AI disattivata: configura e abilita il provider prima di autorizzare le analisi.");
                        await new AnalysisBatch(repository,orchestrator).RunAsync(work,new Progress<string>(p=>Status=p),cancellation.Token);
                    }
                    work.State="Completato";Status=command=="sync"?"Posta aggiornata · nessuna analisi AI automatica":"Analisi completate";
                }
                catch(OperationCanceledException){work.State="In pausa";Status="Lavorazione sospesa; risultati salvati.";}
                catch(Exception ex){work.State="Errore";Status=ex is InvalidOperationException or ArgumentException?ex.Message:$"Operazione non riuscita ({ex.GetType().Name}).";}
                finally
                {
                    work.Detail=Status;await repository.SaveAsync(work);
                    await repository.SaveAsync(new AuditEvent {Action="SERVER_WORK",Result=Status});
                    await ProjectAsync();
                    nextPoll=DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(config.PollSeconds,30,3600));
                    lock(sync){current=null;Busy=false;}
                }
            }
            catch(OperationCanceledException) when(stoppingToken.IsCancellationRequested){break;}
            catch(Exception){lock(sync){current=null;Busy=false;}Status="Errore archivio: controllare il servizio.";await Task.Delay(5000,stoppingToken);}
        }
    }
}
