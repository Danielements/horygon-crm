using System.IO;
using System.Windows;
using Horygon.Core;
using Horygon.Data;
using Horygon.Security;
using Horygon.Email;
using Horygon.AI;
using Microsoft.Extensions.DependencyInjection;
using Serilog;
namespace Horygon.Desktop;
public partial class App : Application
{
    private ServiceProvider? services;
    private Mutex? instanceMutex;
    private bool ownsMutex;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Horygon");
            // Isolated smoke test path is only accepted via an explicit command line switch.
            if (e.Args.Length == 2 && e.Args[0] is "--smoke-test" or "--preview-test") root = Path.GetFullPath(e.Args[1]);
            var mutexKey = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(root.ToUpperInvariant())));
            instanceMutex = new Mutex(false, "Local\\Horygon-" + mutexKey);
            try { ownsMutex = instanceMutex.WaitOne(0); } catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex) { MessageBox.Show("Horygon è già aperto per questo archivio. Usa la finestra esistente.", "Horygon"); Shutdown(); return; }
            foreach (var folder in new[] { "Data", "Mail", "Attachments", "Rules", "Logs", "Cache", "Backups" }) Directory.CreateDirectory(Path.Combine(root, folder));
            Log.Logger = new LoggerConfiguration().WriteTo.File(Path.Combine(root, "Logs", "horygon-.log"), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14).CreateLogger();
            var repository = new EncryptedRepository(Path.Combine(root, "Data", "horygon.db"), new DpapiProtector());
            await repository.InitializeAsync();
            if (e.Args.Length == 2 && e.Args[0] == "--smoke-test") await SmokeChecks.SeedAsync(repository);
            var settings = await repository.GetAsync<AppSettings>("settings") ?? new AppSettings { Id = "settings" };
            if (AiConfiguration.Migrate(settings)) await repository.SaveAsync(settings);
            // Cost protection: every application start requires an explicit user action.
            settings.AutoSync = false;
            await repository.SaveAsync(settings);
            var pendingWork = await repository.GetAsync<WorkProgress>("active-work");
            if (pendingWork is not null && pendingWork.State != "Completato")
            { pendingWork.State = "In pausa"; pendingWork.Detail = "Protezione costi: ripresa solo manuale, massimo 10 nuove analisi."; await repository.SaveAsync(pendingWork); }

            foreach (var name in RuleService.Names)
            {
                var destination = Path.Combine(root, "Rules", name);
                if (!File.Exists(destination)) File.Copy(Path.Combine(AppContext.BaseDirectory, "config", name), destination);
            }
            // Interrupted SMTP attempts must never become automatically sendable drafts.
            foreach (var draft in (await repository.ListAsync<Draft>()).Where(x => x.State == SendState.Sending))
            { draft.State = SendState.Uncertain; await repository.SaveAsync(draft); }
            services = new ServiceCollection()
                .AddSingleton<IRepository>(repository).AddSingleton(settings)
                .AddSingleton<IPermissionValidator, ConservativePermissions>()
                .AddSingleton<IRuleService>(new RuleService(Path.Combine(root, "Rules"), repository))
                .AddSingleton<IGoogleOAuthGateway, GoogleOAuthGateway>().AddSingleton<IGoogleOAuthService, GoogleOAuthService>()
                .AddSingleton<IEmailService, MailService>().AddSingleton<IAIProvider, ConfiguredAIProvider>()
                .AddSingleton<IAnalyzer, Analyzer>().AddSingleton<HorygonOrchestrator>()
                .AddSingleton<MainViewModel>().BuildServiceProvider();
            var vm = services.GetRequiredService<MainViewModel>();
            await services.GetRequiredService<HorygonOrchestrator>().RestoreCopiesAsync();
            await vm.InitializeAsync();
            var window = new MainWindow { DataContext = vm };
            if (e.Args.Length == 2 && e.Args[0] == "--preview-test") window.Title += " · ARCHIVIO DI TEST ISOLATO";
            MainWindow = window;
            window.Show();
            
            if (e.Args.Length == 2 && e.Args[0] == "--smoke-test")
            {
                window.Title += " · TEST SINTETICO";
                await Task.Delay(1200);
                var pendingMail = new EmailMessage { Id = "synthetic-pending", AccountId = "synthetic-account", Subject = "[TEST] Richiesta", From = "cliente@example.test", Date = DateTimeOffset.Now.AddHours(-30), Body = "Informazioni?" };
                await repository.SaveAsync(pendingMail);
                var analysisWork = vm.AnalyzePendingCommand.ExecuteAsync(null);
                vm.SelectedPage = "Roadmap";
                await System.Windows.Threading.Dispatcher.Yield(System.Windows.Threading.DispatcherPriority.Background);
                if (!((UIElement)window.FindName("WorkArea")).IsEnabled) throw new InvalidOperationException("Background work disabled the browsing area.");
                await analysisWork;
                if ((await repository.GetAsync<WorkProgress>("active-work"))?.State != "Completato") throw new InvalidOperationException("Work checkpoint not completed.");
                if ((await repository.GetAsync<EmailMessage>(pendingMail.Id))?.Analysis is null) throw new InvalidOperationException("Local backlog analysis failed.");
                var auditCount = (await repository.ListAsync<AuditEvent>()).Count(x => x.Action == "CLASSIFY_EMAIL");
                await vm.AnalyzePendingCommand.ExecuteAsync(null);
                if ((await repository.ListAsync<AuditEvent>()).Count(x => x.Action == "CLASSIFY_EMAIL") != auditCount) throw new InvalidOperationException("Already analyzed mail was repeated.");
                vm.SelectedRequest = vm.Roadmap.First(x => x.Emails.Any(m => m.Id == pendingMail.Id));
                await vm.UpdateRequestCommand.ExecuteAsync("COMPLETED");
                if (!vm.SelectedRequest!.Closed) throw new InvalidOperationException("Roadmap closure failed: " + vm.Status);
                await vm.UpdateRequestCommand.ExecuteAsync("OPEN");
                if (vm.SelectedRequest!.Closed) throw new InvalidOperationException("Roadmap reopen failed: " + vm.Status);
                vm.MergeTarget = vm.Roadmap.First(x => x.Id != vm.SelectedRequest.Id);
                await vm.MergeRequestCommand.ExecuteAsync(null);
                if (vm.Roadmap.Count != 1) throw new InvalidOperationException("Roadmap merge failed.");
                await vm.SplitRequestCommand.ExecuteAsync(null);
                if (vm.Roadmap.Count != 2) throw new InvalidOperationException("Roadmap split failed.");
                vm.SelectedRequestMail = vm.SelectedRequest!.Emails.First();
                vm.OpenRequestMailCommand.Execute(null);
                if (vm.SelectedMail?.Id != vm.SelectedRequestMail.Id) throw new InvalidOperationException("Roadmap email navigation failed.");
                var sentTest = new EmailMessage { Id = "synthetic-sent", AccountId = "synthetic-account", Folder = "[Gmail]/Sent Mail", IsSentCopy = true, MessageId = "sent@example.test", InReplyTo = "synthetic@example.test", From = "Alias <sales@example.test>", To = "cliente@example.test", Subject = "Re: [TEST] Informazioni ordine", Body = "Risposta sintetica da verificare.", Date = DateTimeOffset.Now.AddMinutes(1) };
                await repository.SaveAsync(sentTest);
                await repository.SaveAsync(new MailSyncCoverage { Id = "synthetic-account", SentFolder = "[Gmail]/Sent Mail", SentComplete = true, InboxComplete = true, StartedAt = DateTimeOffset.Now, CompletedAt = DateTimeOffset.Now, Since = DateTimeOffset.Now.AddDays(-90) });
                await vm.RefreshAsyncCommandCommand.ExecuteAsync(null);
                vm.SelectedFilter = "Posta inviata";
                if (vm.Mails.Count != 1 || vm.Mails[0].Id != sentTest.Id) throw new InvalidOperationException("Sent mail filter failed.");
                var sentRow = vm.Roadmap.First(x => x.Emails.Any(m => m.Id == sentTest.Id));
                if (sentRow.NeedsResponse || sentRow.OutgoingCount != 1 || sentRow.IncomingCount != 1) throw new InvalidOperationException("Sent reply status failed.");
                vm.SelectedRequest = sentRow;
                foreach (var sample in new[] { ("call", "Call progetto", "La call è spostata a domani alle 15."), ("issue", "Consegna ordine", "C'è un problema: la consegna è bloccata."), ("reminder", "Preventivo cliente", "Sollecito urgente, attendiamo risposta.") })
                {
                    var boardMail = new EmailMessage { Id = "board-" + sample.Item1, MessageId = "board-" + sample.Item1, AccountId = "synthetic-account", From = "cliente@example.test", Date = DateTimeOffset.Now, Subject = "[TEST] " + sample.Item2, Body = sample.Item3 };
                    await repository.SaveAsync(boardMail);
                    await repository.SaveAsync(new AITask { Id = "task-" + sample.Item1, Title = "[TEST] " + sample.Item2, EmailId = boardMail.Id, Owner = "Team test", Due = DateTime.Today.AddDays(1) });
                }
                await vm.RefreshAsyncCommandCommand.ExecuteAsync(null);
                vm.SelectedBoardTask = vm.OpenTaskBoard.First(x => x.Id == "task-call");
                if (vm.SelectedBoardTask.MailStatus != "CAMBIO APPUNTAMENTO") throw new InvalidOperationException("Task board update failed.");
                vm.OpenBoardEmailCommand.Execute(null);
                if (vm.SelectedMail?.Id != "board-call") throw new InvalidOperationException("Task board source navigation failed.");
                await vm.CloseBoardTaskCommand.ExecuteAsync(null);
                if (vm.OpenTaskBoard.Any(x => x.Id == "task-call")) throw new InvalidOperationException("Task board closure failed.");
                var reopened = (await repository.GetAsync<AITask>("task-call"))!; reopened.State = TaskState.OPEN; await repository.SaveAsync(reopened);
                await vm.RefreshAsyncCommandCommand.ExecuteAsync(null);
                vm.SelectedBoardTask = vm.OpenTaskBoard.First(x => x.Id == "task-call");
                await SmokeChecks.RenderAsync(window, vm, root);
                await File.WriteAllTextAsync(Path.Combine(root, "smoke-ok.txt"), $"Window loaded: {window.IsLoaded}; Database initialized; {vm.Mails.Count} messages");
                Shutdown();
            }
        }
        catch (Exception ex)
        {
            if (e.Args.Length == 2 && e.Args[0] == "--smoke-test")
            {
                await File.WriteAllTextAsync(Path.Combine(Path.GetFullPath(e.Args[1]), "smoke-error.txt"), ex.ToString());
                Shutdown(1); return;
            }
            Log.Error("Startup failed: {Type}", ex.GetType().Name);
            MessageBox.Show("Avvio non riuscito. Controllare accesso alla cartella dati e integrità dell'installazione.\n" + ex.GetType().Name, "Horygon", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }
    protected override void OnExit(ExitEventArgs e) { services?.Dispose(); if (ownsMutex) instanceMutex?.ReleaseMutex(); instanceMutex?.Dispose(); Log.CloseAndFlush(); base.OnExit(e); }
}
