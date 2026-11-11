using System.Collections.ObjectModel;

using System.IO;

using System.Windows;

using System.Windows.Threading;

using CommunityToolkit.Mvvm.ComponentModel;

using CommunityToolkit.Mvvm.Input;

using Horygon.Core;

using Horygon.AI;

using Horygon.Email;

using Horygon.Data;

using Microsoft.Win32;

using Serilog;

namespace Horygon.Desktop;



public partial class MainViewModel : ObservableObject, IDisposable

{

    private readonly IRepository repository;

    private readonly IEmailService email;

    private readonly IAnalyzer analyzer;

    private readonly IAIProvider provider;

    private readonly IRuleService rules;

    private readonly HorygonOrchestrator orchestrator;

    private readonly IGoogleOAuthService googleOAuth;

    private CancellationTokenSource? googleLoginCancellation;

    private readonly CancellationTokenSource lifetime = new();

    private readonly DispatcherTimer timer = new();
    private CancellationTokenSource? workCancellation;
    private bool pauseRequested;
    [ObservableProperty] private string workStatus = "Nessuna lavorazione avviata.";
    [ObservableProperty] private bool isWorking;
    [RelayCommand] private void PauseWork() { pauseRequested = true; workCancellation?.Cancel(); }
    [RelayCommand] private Task ResumeWorkAsync() => RunWorkAsync(false);


    private List<EmailMessage> allMail = [];

    public AppSettings Settings { get; }

    public record ProviderOption(AiProviderKind Kind, string Label);

    public ProviderOption[] AiProviders { get; } = Enum.GetValues<AiProviderKind>().Select(x => new ProviderOption(x, AiConfiguration.Label(x))).ToArray();

    [ObservableProperty] private AiProviderKind selectedAiProvider;

    public AiProfile ActiveAiProfile => Settings.AiProfiles[SelectedAiProvider];

    public bool IsOfficialAi => SelectedAiProvider is AiProviderKind.OpenAI or AiProviderKind.Anthropic;

    public bool IsAnthropic => SelectedAiProvider == AiProviderKind.Anthropic;

    public string AiProviderHint => SelectedAiProvider switch

    {

        AiProviderKind.Local => "Elaborazione locale. Carica un modello in LM Studio e avvia il server. API key facoltativa: serve solo se hai abilitato l'autenticazione del server locale.",

        AiProviderKind.OpenAI => "API OpenAI. Inserisci la tua chiave API e l'identificativo esatto di un modello disponibile nel tuo account. Le email vengono inviate a OpenAI solo con il consenso esterno abilitato.",

        AiProviderKind.Anthropic => "API nativa Anthropic Messages. Inserisci la chiave Claude e il nome del modello. Workspace ID richiesto solo se la tua chiave lo richiede. Output JSON sempre validato da Horygon.",

        _ => "Server compatibile con Chat Completions. Per server di rete è richiesto HTTPS e consenso all'invio dei dati."

    };

    public string AiKeyLabel => SelectedAiProvider switch { AiProviderKind.OpenAI => "API key OpenAI", AiProviderKind.Anthropic => "API key Anthropic", AiProviderKind.Local => "API key LM Studio (facoltativa)", _ => "API key del server" };

    public string[] Pages { get; } = ["Dashboard", "Roadmap", "Tabellone task", "Posta in arrivo", "Priorità AI", "Attività", "Ordini", "Workflow", "Approvazioni", "Ricerca", "Report", "Impostazioni"];

    public string[] RuleNames => RuleService.Names;

    public string[] Filters { get; } = ["Tutta la posta", "INBOX", "Posta inviata", "Da gestire", "Urgenti", "Clienti", "Fornitori", "Amministrazione", "Pubblicità", "Spam sospetto", "Posta ordinaria"];

    public TaskState[] TaskStates => Enum.GetValues<TaskState>();

    public ObservableCollection<AITask> OpenTaskBoard { get; } = [];
    public ObservableCollection<TaskMailEvent> BoardHistory { get; } = [];
    [ObservableProperty] private AITask? selectedBoardTask;
    [ObservableProperty] private TaskMailEvent? selectedBoardEvent;
    partial void OnSelectedBoardTaskChanged(AITask? value)
    {
        Replace(BoardHistory, boardEvents.Where(x => x.TaskId == value?.Id).OrderByDescending(x => x.MailDate));
        SelectedBoardEvent = BoardHistory.FirstOrDefault();
    }
    private List<TaskMailEvent> boardEvents = [];
    public ObservableCollection<RoadmapRow> Roadmap { get; } = [];

    [ObservableProperty] private RoadmapRow? selectedRequest;

    [ObservableProperty] private RoadmapRow? mergeTarget;

    [ObservableProperty] private EmailMessage? selectedRequestMail;

    [ObservableProperty] private DateTime? requestDue;

    [ObservableProperty] private string requestOwner = "";

    partial void OnSelectedRequestChanged(RoadmapRow? value)

    {

        SelectedRequestMail = value?.Emails.LastOrDefault();

        RequestDue = value?.Tasks.FirstOrDefault(x => x.State is not (TaskState.COMPLETED or TaskState.CANCELLED))?.Due;

        RequestOwner = value?.Tasks.FirstOrDefault()?.Owner ?? "";

    }

    public ObservableCollection<EmailAccount> Accounts { get; } = [];

    public ObservableCollection<EmailMessage> Mails { get; } = [];

    public ObservableCollection<EmailMessage> Critical { get; } = [];

    public ObservableCollection<Draft> Drafts { get; } = [];

    public ObservableCollection<AITask> Tasks { get; } = [];

    public ObservableCollection<AuditEvent> Audit { get; } = [];

    public ObservableCollection<RuleVersion> RuleHistory { get; } = [];

    [ObservableProperty] private string selectedPage = "Dashboard";

    [ObservableProperty] private string search = "";

    [ObservableProperty] private string selectedFilter = "Tutta la posta";

    [ObservableProperty] private string status = "Pronto · archivio locale";

    [ObservableProperty] private bool isBusy;

    [ObservableProperty] private EmailAccount? selectedAccount;

    [ObservableProperty] private EmailAccount editingAccount = new();

    [ObservableProperty] private bool isGoogleConnecting;

    public record MailAuthOption(EmailAuthentication Kind, string Label);

    public MailAuthOption[] MailAuthenticationOptions { get; } = [new(EmailAuthentication.Password, "Password / password per le app"), new(EmailAuthentication.GoogleOAuth, "Accedi con Google · OAuth 2.0")];

    public EmailAuthentication SelectedMailAuthentication

    {

        get => EditingAccount.Authentication;

        set { EditingAccount.Authentication = value; OnPropertyChanged(); OnPropertyChanged(nameof(IsGoogleAuthentication)); OnPropertyChanged(nameof(GoogleConnectionStatus)); }

    }

    public bool IsGoogleAuthentication => EditingAccount.Authentication == EmailAuthentication.GoogleOAuth;

    public string GoogleConnectionStatus => string.IsNullOrWhiteSpace(EditingAccount.GoogleConnectedAddress) ? "Nessun account Google collegato. Importa il client OAuth e premi Accedi con Google." : $"Account Google collegato: {EditingAccount.GoogleConnectedAddress}. Token cifrati, rinnovo automatico.";

    [ObservableProperty] private EmailMessage? selectedMail;

    [ObservableProperty] private Draft? selectedDraft;

    [ObservableProperty] private AITask? selectedTask;

    [ObservableProperty] private string ruleName = "company_rules.md";

    [ObservableProperty] private string ruleText = "";

    [ObservableProperty] private RuleVersion? selectedRuleVersion;

    [ObservableProperty] private string newTaskTitle = "";

    [ObservableProperty] private string taskSearch = "";

    [ObservableProperty] private string briefing = "Nessuna email sincronizzata. Configura un account per iniziare.";

    [ObservableProperty] private string conversation = "";

    [ObservableProperty] private int newMailCount;

    [ObservableProperty] private int urgentCount;

    [ObservableProperty] private int taskCount;

    [ObservableProperty] private int draftCount;

    public string AiStatus => !Settings.AiEnabled ? "AI disattivata · fallback locale" : $"{AiConfiguration.Label(SelectedAiProvider)} · {(SelectedAiProvider == AiProviderKind.Local ? "elaborazione locale" : Settings.AllowExternalAi ? "invio esterno consentito" : "invio esterno non autorizzato")}";

    public string Welcome => Accounts.Count == 0 ? "Benvenuto in Horygon. 1 · Configura la posta  /  2 · Scegli AI o modalità offline  /  3 · Salva e sincronizza" : "Configurazione della tua postazione";



    public MainViewModel(IRepository repository, IEmailService email, IAnalyzer analyzer, IAIProvider provider, IRuleService rules, HorygonOrchestrator orchestrator, AppSettings settings, IGoogleOAuthService googleOAuth)

    {

        this.repository = repository; this.email = email; this.analyzer = analyzer; this.provider = provider; this.rules = rules; this.orchestrator = orchestrator; Settings = settings;

        this.googleOAuth = googleOAuth;

        AiConfiguration.Migrate(settings); selectedAiProvider = settings.SelectedAiProvider!.Value;

        timer.Tick += async (_, _) => { if (Settings.AutoSync && !IsBusy && Accounts.Count > 0 && (await repository.GetAsync<WorkProgress>("active-work"))?.State is null or "Completato") await SyncDownloadOnlyAsync(); };

    }

    public async Task InitializeAsync()

    {

        await RefreshAsync();
        WorkStatus = (await repository.GetAsync<WorkProgress>("active-work"))?.Display ?? WorkStatus;

        RuleText = await rules.ReadAsync(RuleName);

        SelectedPage = Accounts.Count == 0 ? "Impostazioni" : "Dashboard";

        Theme.Apply(Settings.LightTheme);

        timer.Interval = TimeSpan.FromSeconds(Math.Clamp(Settings.PollSeconds, 15, 3600)); timer.Start();

    }

    private static void Replace<T>(ObservableCollection<T> list, IEnumerable<T> values) { list.Clear(); foreach (var item in values) list.Add(item); }

    private async Task RefreshAsync()

    {

        var accountId = SelectedAccount?.Id;

        Replace(Accounts, await repository.ListAsync<EmailAccount>());

        SelectedAccount = Accounts.FirstOrDefault(x => x.Id == accountId) ?? Accounts.FirstOrDefault();

        allMail = (await repository.ListAsync<EmailMessage>()).OrderByDescending(x => x.Date).ToList();

        ApplyFilter();



        var drafts = await repository.ListAsync<Draft>();

        Replace(Drafts, drafts.OrderBy(x => x.State).ThenBy(x => x.Subject));

        var requestMailId = SelectedRequest?.Emails.FirstOrDefault()?.Id;

        var snapshotMail = allMail; var snapshotAccounts = Accounts.ToList();
        var snapshotTasks = await repository.ListAsync<AITask>(); var coverage = await repository.ListAsync<MailSyncCoverage>();
        var rows = await Task.Run(() => RoadmapBuilder.Build(snapshotMail, snapshotAccounts, snapshotTasks, drafts, Settings.ResponseTargetHours, DateTimeOffset.Now, coverage));
        await Task.Run(() => new TaskBoardUpdater(repository).UpdateAsync(rows, snapshotAccounts));
        Replace(Roadmap, rows);
        await LoadTasksAsync();
        var boardId = SelectedBoardTask?.Id;
        boardEvents = await repository.ListAsync<TaskMailEvent>();
        Replace(OpenTaskBoard, (await repository.ListAsync<AITask>()).Where(x => x.State is not (TaskState.COMPLETED or TaskState.CANCELLED)).OrderByDescending(x => x.MailStatus is "PROBLEMA SEGNALATO" or "CAMBIO APPUNTAMENTO" or "SOLLECITO").ThenBy(x => x.Due).ThenByDescending(x => x.Priority).ThenByDescending(x => x.LastMailAt));
        SelectedBoardTask = OpenTaskBoard.FirstOrDefault(x => x.Id == boardId) ?? OpenTaskBoard.FirstOrDefault();
        SelectedRequest = Roadmap.FirstOrDefault(x => x.Emails.Any(m => m.Id == requestMailId)) ?? Roadmap.FirstOrDefault();

        Replace(Audit, (await repository.ListAsync<AuditEvent>()).OrderByDescending(x => x.Timestamp).Take(500));

        Replace(RuleHistory, (await repository.ListAsync<RuleVersion>()).OrderByDescending(x => x.CreatedAt));

        NewMailCount = allMail.Count(x => x.DownloadedAt.LocalDateTime.Date == DateTime.Today);

        var urgentRows = Roadmap.Where(x => x.NeedsResponse && x.Priority >= Priority.HIGH && !x.Closed).ToList();
        UrgentCount = urgentRows.Count;
        Replace(Critical, urgentRows.Select(x => x.Emails.Last(m => !MailDirection.IsOutgoing(m, Accounts.FirstOrDefault(a => a.Id == m.AccountId)?.Address ?? "") && !MailDirection.IsDraft(m))).Take(12));

        TaskCount = (await repository.ListAsync<AITask>()).Count(x => x.State is not (TaskState.COMPLETED or TaskState.CANCELLED));

        DraftCount = drafts.Count(x => x.State == SendState.Draft);

        Briefing = allMail.Count == 0 ? "L'archivio è vuoto. Configura la casella e avvia la prima sincronizzazione: qui vedrai soltanto dati reali." : $"Nell'archivio sono presenti {allMail.Count} messaggi. Oggi ne sono stati scaricati {NewMailCount}. {UrgentCount} comunicazioni hanno priorità alta o critica e non sono gestite. Sono aperte {TaskCount} attività e {DraftCount} bozze attendono revisione. {Roadmap.Count(x => x.NeedsResponse)} richieste risultano senza risposta collegata nella posta locale. Verifica la copertura nella Roadmap.";

        OnPropertyChanged(nameof(Welcome)); OnPropertyChanged(nameof(AiStatus));

    }

    private void ApplyFilter()

    {

        var id = SelectedMail?.Id;

        var source = allMail.Where(x => string.IsNullOrWhiteSpace(Search) || $"{x.From} {x.Subject} {x.Body} {string.Join(' ', x.Analysis?.OrderNumbers ?? [])}".Contains(Search, StringComparison.OrdinalIgnoreCase));

        source = SelectedFilter switch

        {

            "Posta inviata" => source.Where(x => MailDirection.IsOutgoing(x, Accounts.FirstOrDefault(a => a.Id == x.AccountId)?.Address ?? "")),
            "Pubblicità" => source.Where(x => x.Classification.Kind == MailKind.Advertising),
            "Spam sospetto" => source.Where(x => x.Classification.Kind == MailKind.SuspectedSpam),
            "Posta ordinaria" => source.Where(x => x.Classification.Kind == MailKind.Regular),
            "INBOX" => source.Where(x => x.Folder.Equals("INBOX", StringComparison.OrdinalIgnoreCase)),

            "Da gestire" => source.Where(x => !x.Handled), "Urgenti" => source.Where(x => x.Analysis?.Priority >= Priority.HIGH),

            "Clienti" => source.Where(x => x.Analysis?.SenderType == "customer"), "Fornitori" => source.Where(x => x.Analysis?.SenderType == "supplier"),

            "Amministrazione" => source.Where(x => x.Analysis?.Category == "administration"), _ => source

        };

        if (SelectedPage == "Priorità AI") source = source.OrderByDescending(x => x.Analysis?.Priority);

        Replace(Mails, source); SelectedMail = Mails.FirstOrDefault(x => x.Id == id) ?? Mails.FirstOrDefault();

    }

    partial void OnSearchChanged(string value) => ApplyFilter();

    partial void OnSelectedAiProviderChanged(AiProviderKind value)

    {

        Settings.SelectedAiProvider = value;

        foreach (var name in new[] { nameof(ActiveAiProfile), nameof(IsOfficialAi), nameof(IsAnthropic), nameof(AiProviderHint), nameof(AiKeyLabel), nameof(AiStatus) }) OnPropertyChanged(name);

        Status = $"{AiConfiguration.Label(value)} selezionato. Le chiavi degli altri provider restano separate. Salva le impostazioni per conservare la scelta.";

    }

    partial void OnSelectedFilterChanged(string value) => ApplyFilter();

    partial void OnSelectedPageChanged(string value) => ApplyFilter();

    partial void OnSelectedAccountChanged(EmailAccount? value) { if (value is not null) EditingAccount = System.Text.Json.JsonSerializer.Deserialize<EmailAccount>(System.Text.Json.JsonSerializer.Serialize(value))!; }

    partial void OnEditingAccountChanged(EmailAccount value)

    { OnPropertyChanged(nameof(SelectedMailAuthentication)); OnPropertyChanged(nameof(IsGoogleAuthentication)); OnPropertyChanged(nameof(GoogleConnectionStatus)); }

    partial void OnSelectedMailChanged(EmailMessage? value) => Conversation = value is null ? "" : string.Join("\n\n", allMail.Where(x => x.AccountId == value.AccountId && x.ThreadKey == value.ThreadKey).OrderBy(x => x.Date).Select(x => $"{x.Date:g} · {x.From}\n{x.Subject}\n{x.Preview}"));

    private async Task RunAsync(Func<Task> action)

    {

        if (IsBusy) { Status = "Lavorazione in corso: puoi consultare le pagine. Premi Pausa prima di modificare o avviare altre operazioni."; return; }

        IsBusy = true;

        try { await action(); }

        catch (OperationCanceledException) { Status = "Operazione annullata."; }

        catch (Exception ex)

        {

            Log.Warning("Operation failed: {Type}", ex.GetType().Name);

            Status = ex is ArgumentException or InvalidOperationException or InvalidDataException ? ex.Message : $"Operazione non riuscita ({ex.GetType().Name}). Controllare connessione e configurazione.";

        }

        finally { IsBusy = false; }

    }

    [RelayCommand] private void Navigate(string page) => SelectedPage = page;

    [RelayCommand] private void NewAccount() { SelectedAccount = null; EditingAccount = new(); Status = "Nuovo account: inserire i parametri e salvare."; }

    [RelayCommand] private void ApplyEmailPreset(string preset)

    {

        EmailSetup.ApplyPreset(EditingAccount, preset); OnPropertyChanged(nameof(EditingAccount));

        SelectedMailAuthentication = preset == "Gmail" ? EmailAuthentication.GoogleOAuth : EmailAuthentication.Password;

        Status = preset == "Gmail" ? "Profilo Gmail OAuth applicato. Inserisci l'indirizzo, importa il client OAuth App desktop e premi Accedi con Google." : "Parametri Aruba applicati. Verifica la connessione e salva l'account.";

    }

    [RelayCommand] private Task ImportGoogleClientAsync() => RunAsync(async () =>

    {

        var dialog = new OpenFileDialog { Filter = "Client OAuth Google (*.json)|*.json", Title = "Importa client Google OAuth di tipo App desktop" };

        if (dialog.ShowDialog() != true) return;

        if (new FileInfo(dialog.FileName).Length > 64000) throw new ArgumentException("File OAuth troppo grande.");

        var client = GoogleOAuthConfiguration.ParseDesktopJson(await File.ReadAllTextAsync(dialog.FileName));

        Settings.GoogleOAuthClientId = client.ClientId; Settings.GoogleOAuthClientSecret = client.ClientSecret;

        await repository.SaveAsync(Settings); OnPropertyChanged(nameof(Settings));

        Status = "Client OAuth importato e salvato cifrato. Ora puoi premere Accedi con Google.";

    });

    [RelayCommand] private Task ConnectGoogleAsync() => RunAsync(async () =>

    {

        if (!IsGoogleAuthentication) throw new InvalidOperationException("Seleziona Accedi con Google come metodo di autenticazione.");

        MailService.ValidateAccount(EditingAccount);

        GoogleOAuthConfiguration.ValidateClient(Settings.GoogleOAuthClientId, Settings.GoogleOAuthClientSecret);

        await repository.SaveAsync(Settings);

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);

        googleLoginCancellation = cancellation; IsGoogleConnecting = true;

        Status = "Completa l'accesso nel browser con l'account aziendale indicato. Puoi annullare dal pulsante in basso.";

        try

        {

            var account = EditingAccount;

            await googleOAuth.ConnectAsync(account, cancellation.Token);

            await RefreshAsync(); SelectedAccount = Accounts.First(x => x.Id == account.Id);

            Status = "Account Google collegato e salvato. Premi Verifica connessione, poi Sincronizza. Nessuna email è stata inviata.";

        }

        finally { IsGoogleConnecting = false; googleLoginCancellation = null; }

    });

    [RelayCommand] private void CancelGoogleLogin() => googleLoginCancellation?.Cancel();

    [RelayCommand] private Task DisconnectGoogleAsync() => RunAsync(async () =>

    {

        if (MessageBox.Show("Rimuovere i token Google da questo collegamento locale? La posta archiviata rimane disponibile. Il consenso sul sito Google non viene revocato da questa operazione.", "Scollega Google da Horygon", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) != MessageBoxResult.Yes) return;

        await googleOAuth.DisconnectLocalAsync(EditingAccount, lifetime.Token);

        OnPropertyChanged(nameof(EditingAccount)); OnPropertyChanged(nameof(GoogleConnectionStatus));

        Status = "Collegamento locale rimosso. Per revocare anche il consenso, usa la pagina delle connessioni del tuo account Google.";

    });

    [RelayCommand] private void OpenGoogleOAuthGuide() => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "GOOGLE_OAUTH_SETUP.md")) { UseShellExecute = true });

    [RelayCommand] private void OpenGoogleAppPasswords() => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://myaccount.google.com/apppasswords") { UseShellExecute = true });

    [RelayCommand] private Task SaveAccountAsync() => RunAsync(async () => { MailService.ValidateAccount(EditingAccount);
        if ((await repository.ListAsync<EmailAccount>()).Any(x => x.Id != EditingAccount.Id && x.Address.Trim().Equals(EditingAccount.Address.Trim(), StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Questo indirizzo è già configurato. Seleziona e modifica l'account esistente.");
        await repository.SaveAsync(EditingAccount); await repository.SaveAsync(new AuditEvent { Action = "SAVE_ACCOUNT", EntityId = EditingAccount.Id, Result = "Configurazione cifrata aggiornata" }); await RefreshAsync(); Status = "Account salvato con credenziali cifrate."; });

    [RelayCommand] private Task TestAccountAsync() => RunAsync(async () => { Status = "Verifica TLS e autenticazione IMAP/SMTP…"; var folders = await email.TestAsync(EditingAccount, lifetime.Token); Status = $"Connessione IMAP e SMTP riuscita. Cartelle: {string.Join(", ", folders)}"; });

    [RelayCommand] private Task SaveSettingsAsync() => RunAsync(async () =>

    {

        if (Settings.ResponseTargetHours is < 1 or > 8760) throw new ArgumentException("Obiettivo risposta: da 1 a 8760 ore.");

        if (Settings.PollSeconds is < 15 or > 3600) throw new ArgumentException("Intervallo polling: da 15 a 3600 secondi.");

        if (Settings.AiEnabled) ConfiguredAIProvider.Validate(Settings);

        await repository.SaveAsync(Settings); timer.Interval = TimeSpan.FromSeconds(Settings.PollSeconds); Theme.Apply(Settings.LightTheme); OnPropertyChanged(nameof(Settings)); OnPropertyChanged(nameof(AiStatus)); Status = "Impostazioni salvate.";

    });

    [RelayCommand] private Task TestAiAsync() => RunAsync(async () => { var response = await provider.GenerateAsync(new("Rispondi brevemente in italiano.", "Test di connessione. Rispondi OK."), lifetime.Token); Status = $"{AiConfiguration.Label(SelectedAiProvider)} raggiungibile · modello {ActiveAiProfile.Model} · token dichiarati: {response.Tokens}. Nessuna email usata nel test."; });

    private async Task RenderDuringDownloadAsync(Task download)
    {
        while (await Task.WhenAny(download, Task.Delay(TimeSpan.FromSeconds(5))) != download)
        {
            try { await RefreshAsync(); }
            catch (Exception ex) { Log.Warning("Board refresh during download failed: {Type}", ex.GetType().Name); }
        }
        await download;
    }

    private Task SyncDownloadOnlyAsync() => RunAsync(async () =>
    {
        var progress = new Progress<SyncProgress>(p => Status = p.Message);
        foreach (var account in Accounts.ToList()) await RenderDuringDownloadAsync(Task.Run(() => email.SyncAsync(account, progress, lifetime.Token)));
        await orchestrator.RestoreCopiesAsync();
        await RefreshAsync();
        Status = "Download completato. Nuove analisi solo su avvio manuale (massimo 10).";
    });

    [RelayCommand] private Task SyncAsync() => RunWorkAsync(true);
    [RelayCommand] private Task AnalyzePendingAsync() => RunWorkAsync(false);

    private Task RunWorkAsync(bool sync) => RunAsync(async () =>
    {
        var saved = await repository.GetAsync<WorkProgress>("active-work");
        var work = saved is not null && saved.State != "Completato" ? saved : new WorkProgress
        { Id = "active-work", Operation = sync ? "Sincronizzazione" : "Analisi", Stage = sync ? "Download" : "Analisi" };
        var accounts = Accounts.ToList();
        if (work.Stage == "Download" && accounts.Count == 0) throw new InvalidOperationException("Salvare almeno un account.");
        work.State = "In corso"; work.UpdatedAt = DateTimeOffset.UtcNow;
        await repository.SaveAsync(work);
        await repository.SaveAsync(new AuditEvent { Action = "WORK_START_RESUME", EntityId = work.Id, Result = work.Display });
        WorkStatus = work.Display; IsWorking = true; pauseRequested = false;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        workCancellation = cancellation;
        var ct = cancellation.Token;
        var progress = new Progress<string>(message => { WorkStatus = message; Status = message; });
        var syncProgress = new Progress<SyncProgress>(p => { Status = p.Message; WorkStatus = "In corso · Download · " + p.Message; });
        Task<int>? batch = null;
        string? syncFailure = work.DownloadIncomplete ? "Download incompleto da riprovare." : null;
        try
        {
            if (work.Stage == "Download")
            {
                syncFailure = null; work.DownloadIncomplete = false;
                foreach (var account in accounts)
                {
                    try { await RenderDuringDownloadAsync(Task.Run(() => email.SyncAsync(account, syncProgress, ct), ct)); }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex) { syncFailure = ex is InvalidOperationException or ArgumentException ? ex.Message : $"Download da riprovare ({ex.GetType().Name})."; work.DownloadIncomplete = true; work.Detail = syncFailure; await repository.SaveAsync(work); }
                }
                work.Stage = "Analisi";
                await repository.SaveAsync(work);
                await RefreshAsync();
            }
            batch = Task.Run(() => new AnalysisBatch(repository, orchestrator).RunAsync(work, progress, ct), ct);
            while (await Task.WhenAny(batch, Task.Delay(TimeSpan.FromSeconds(20), ct)) != batch)
            {
                if (ct.IsCancellationRequested) break;
                await RefreshAsync();
            }
            await batch;
            work.State = syncFailure is null ? "Completato" : "Errore";
            if (syncFailure is not null) work.Stage = "Download";
            work.Detail = syncFailure ?? "Risultati salvati. Nessun invio automatico.";
        }
        catch (OperationCanceledException) { work.State = pauseRequested ? "In pausa" : "Interrotto"; work.Detail = "Ripresa dalle email ancora da elaborare."; }
        catch (Exception ex) { work.State = "Errore"; work.Detail = ex is InvalidOperationException ? ex.Message : $"Lavoro interrotto ({ex.GetType().Name})."; }
        finally
        {
            if (batch is not null && !batch.IsCompleted)
            {
                cancellation.Cancel();
                try { await batch; } catch (Exception) { /* Original failure remains recorded below. */ }
            }
            work.UpdatedAt = DateTimeOffset.UtcNow;
            try
            {
                await repository.SaveAsync(work);
                await repository.SaveAsync(new AuditEvent { Action = "WORK_CHECKPOINT", EntityId = work.Id, Result = work.Display });
                await RefreshAsync();
                Status = WorkStatus = work.Display;
            }
            finally { workCancellation = null; IsWorking = false; }
        }
    });

    [RelayCommand] private Task AnalyzeAsync() => RunAsync(async () => { if (SelectedMail is null) return; Status = "Analisi in corso…"; await Task.Run(() => orchestrator.AnalyzeAsync(SelectedMail, lifetime.Token)); await RefreshAsync(); Status = "Analisi salvata. Verificare fonte e motivazione nel dettaglio."; });

    [RelayCommand] private Task SetMailKindAsync(string kind) => RunAsync(async () =>
    {
        if (SelectedMail is null) return;
        if (kind == "Auto") SelectedMail.ManualMailKind = null;
        else if (Enum.TryParse<MailKind>(kind, out var selected) && Enum.IsDefined(selected)) SelectedMail.ManualMailKind = selected;
        else throw new ArgumentException("Classificazione non valida.");
        await repository.SaveAsync(SelectedMail);
        await repository.SaveAsync(new AuditEvent { Action = "MAIL_CLASSIFICATION", EntityId = SelectedMail.Id, Result = $"Classificazione locale: {kind}" });
        await RefreshAsync(); Status = "Classificazione salvata. Nessuna modifica sul server email.";
    });
    [RelayCommand] private Task MarkHandledAsync() => RunAsync(async () => { if (SelectedMail is null) return; SelectedMail.Handled = !SelectedMail.Handled; await repository.SaveAsync(SelectedMail); await repository.SaveAsync(new AuditEvent { Action = "LOCAL_HANDLED", EntityId = SelectedMail.Id, Result = SelectedMail.Handled.ToString() }); await RefreshAsync(); Status = "Stato locale aggiornato."; });

    [RelayCommand] private Task ReplyAsync(string mode) => RunAsync(async () =>

    {

        if (SelectedMail is null) return;

        var account = Accounts.First(x => x.Id == SelectedMail.AccountId);

        var draft = email.CreateReply(account, SelectedMail, mode == "all", mode == "forward");

        if (mode == "ai") { Status = "Preparazione risposta…"; draft.Body = await analyzer.DraftAsync(SelectedMail, await rules.ReadAllAsync(), lifetime.Token) + "\n\n" + account.Signature; }

        await repository.SaveAsync(draft); await repository.SaveAsync(new AuditEvent { Action = "CREATE_DRAFT", EntityId = draft.Id, Result = "Bozza locale; revisione e invio esplicito necessari" });

        await RefreshAsync(); SelectedDraft = Drafts.First(x => x.Id == draft.Id); SelectedPage = "Approvazioni"; Status = "Controlla destinatari e contenuto prima di approvare l'invio.";

    });

    [RelayCommand] private Task SaveDraftAsync() => RunAsync(async () => { if (SelectedDraft?.State != SendState.Draft) throw new InvalidOperationException("Solo le bozze non elaborate sono modificabili."); var id = SelectedDraft.Id; await repository.SaveAsync(SelectedDraft); await RefreshAsync(); SelectedDraft = Drafts.First(x => x.Id == id); Status = "Bozza salvata."; });

    [RelayCommand] private Task RejectDraftAsync() => RunAsync(async () => { if (SelectedDraft?.State != SendState.Draft) return; SelectedDraft.State = SendState.Rejected; await repository.SaveAsync(SelectedDraft); await repository.SaveAsync(new AuditEvent { Action = "REJECT_DRAFT", EntityId = SelectedDraft.Id, Result = "Rifiutata dall'utente" }); await RefreshAsync(); SelectedDraft = null; Status = "Bozza rifiutata."; });

    [RelayCommand] private Task SendDraftAsync() => RunAsync(async () =>

    {

        if (SelectedDraft?.State != SendState.Draft) throw new InvalidOperationException("Selezionare una bozza non ancora inviata. Gli esiti incerti richiedono verifica presso il provider.");

        var draft = SelectedDraft;

        var account = Accounts.First(x => x.Id == draft.AccountId);

        using var validation = MailService.BuildMime(draft, account);

        if (MessageBox.Show($"Inviare realmente tramite {account.Address}?\n\nA: {draft.To}\nCC: {draft.Cc}\nBCC: {draft.Bcc}\nOggetto: {draft.Subject}\nAllegati: {draft.Attachments.Count}\n\nConfermi il contenuto visualizzato nella bozza?", "Approva e invia", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) != MessageBoxResult.Yes) return;

        draft.ApprovedBy = Environment.UserName; draft.ApprovedAt = DateTimeOffset.UtcNow;

        await repository.SaveAsync(draft); Status = "Invio SMTP in corso…";

        try { await email.SendApprovedAsync(draft, account, lifetime.Token); Status = "Messaggio accettato dal server SMTP."; }

        finally { await RefreshAsync(); SelectedDraft = Drafts.FirstOrDefault(x => x.Id == draft.Id); }

    });

    [RelayCommand] private Task SaveAttachmentAsync(MailAttachment? attachment) => RunAsync(async () =>

    {

        if (attachment is null) return;

        var dialog = new SaveFileDialog { FileName = Path.GetFileName(attachment.Name), Title = "Esporta allegato (copia non cifrata)" };

        if (dialog.ShowDialog() == true) { await File.WriteAllBytesAsync(dialog.FileName, attachment.Bytes); await repository.SaveAsync(new AuditEvent { Action = "EXPORT_ATTACHMENT", EntityId = SelectedMail?.Id ?? "", Result = "Esportazione esplicita di un allegato" }); Status = "Allegato salvato. La copia esportata non è cifrata da Horygon."; }

    });

    [RelayCommand] private Task AddAttachmentAsync() => RunAsync(async () =>

    {

        if (SelectedDraft?.State != SendState.Draft) return;

        var dialog = new OpenFileDialog { Multiselect = true };

        if (dialog.ShowDialog() != true) return;

        foreach (var file in dialog.FileNames) { if (new FileInfo(file).Length > 25 * 1024 * 1024) throw new ArgumentException("Limite per allegato: 25 MB."); SelectedDraft.Attachments.Add(new() { Name = Path.GetFileName(file), Bytes = await File.ReadAllBytesAsync(file) }); }

        var id = SelectedDraft.Id; await repository.SaveAsync(SelectedDraft); await RefreshAsync(); SelectedDraft = Drafts.First(x => x.Id == id); Status = $"Bozza salvata con {SelectedDraft.Attachments.Count} allegati.";

    });

    [RelayCommand] private void OpenRequestMail()

    {

        var id = SelectedRequestMail?.Id;

        if (id is null) return;

        Search = ""; SelectedFilter = "Tutta la posta"; SelectedPage = "Posta in arrivo";

        SelectedMail = Mails.FirstOrDefault(x => x.Id == id);

    }

    [RelayCommand] private Task UpdateRequestAsync(string state) => RunAsync(async () =>

    {

        if (SelectedRequest is null || !Enum.TryParse<TaskState>(state, out var next)) return;

        var row = SelectedRequest;

        var linked = row.Tasks;

        if (linked.Count == 0) linked = [new AITask { Title = row.Title, Description = row.Summary, EmailId = row.Emails.Last().Id, Priority = row.Priority }];

        foreach (var task in linked)

        {

            task.EmailIds = row.Emails.Select(x => x.Id).ToList();

            task.Owner = RequestOwner; task.Due = RequestDue;

            TaskOperations.Transition(task, next); await repository.SaveAsync(task);

        }

        await repository.SaveAsync(new AuditEvent { Action = "REQUEST_STATE", EntityId = row.Id, Result = $"{next} · {linked.Count} attività · {row.MailCount} email collegate" });

        await RefreshAsync(); Status = "Stato della richiesta e delle attività salvato. Nessuna modifica su Gmail.";

    });

    [RelayCommand] private Task MergeRequestAsync() => RunAsync(async () =>

    {

        if (SelectedRequest is null || MergeTarget is null || SelectedRequest.Id == MergeTarget.Id) throw new InvalidOperationException("Scegli una richiesta diversa da accorpare.");

        if (SelectedRequest.Emails[0].AccountId != MergeTarget.Emails[0].AccountId) throw new InvalidOperationException("Accorpa soltanto richieste della stessa casella.");

        var groupId = Guid.NewGuid().ToString("N");

        foreach (var mail in SelectedRequest.Emails.Concat(MergeTarget.Emails)) { mail.RequestGroupId = groupId; await repository.SaveAsync(mail); }

        await repository.SaveAsync(new AuditEvent { Action = "MERGE_REQUEST", EntityId = groupId, Result = "Accorpamento manuale di due richieste" });

        MergeTarget = null; await RefreshAsync(); Status = "Richieste accorpate. Le email originali restano consultabili.";

    });

    [RelayCommand] private Task SplitRequestAsync() => RunAsync(async () =>

    {

        if (SelectedRequest is null) return;

        foreach (var mail in SelectedRequest.Emails) { mail.RequestGroupId = ""; await repository.SaveAsync(mail); }

        // After splitting, each task remains with its originating email's conversation.
        foreach (var task in SelectedRequest.Tasks) { task.EmailIds = []; await repository.SaveAsync(task); }
        await repository.SaveAsync(new AuditEvent { Action = "SPLIT_REQUEST", EntityId = SelectedRequest.Id, Result = "Rimosso accorpamento manuale; mantenuti collegamenti della conversazione" });

        await RefreshAsync(); Status = "Accorpamento manuale rimosso. Restano unite le email della stessa conversazione.";

    });

    [RelayCommand] private void OpenBoardEmail()
    {
        var id = SelectedBoardEvent?.EmailId ?? SelectedBoardTask?.LastMailId;
        if (string.IsNullOrWhiteSpace(id)) { Status = "Questo task non ha ancora un'email collegata."; return; }
        Search = ""; SelectedFilter = "Tutta la posta"; SelectedPage = "Posta in arrivo";
        SelectedMail = Mails.FirstOrDefault(x => x.Id == id);
    }
    [RelayCommand] private void EditBoardTask()
    {
        if (SelectedBoardTask is null) return;
        SelectedTask = SelectedBoardTask; SelectedPage = "Attività";
    }
    [RelayCommand] private Task CloseBoardTaskAsync() => RunAsync(async () =>
    {
        if (SelectedBoardTask is null) return;
        var task = SelectedBoardTask;
        TaskOperations.Transition(task, TaskState.COMPLETED); await repository.SaveAsync(task);
        await repository.SaveAsync(new AuditEvent { Action = "TASK_CLOSED", EntityId = task.Id, Result = "Chiusura manuale dal tabellone" });
        await RefreshAsync(); Status = "Task chiuso. Rimane consultabile in Attività.";
    });
    [RelayCommand] private Task CreateTaskAsync() => RunAsync(async () => { if (SelectedMail is null) return; var key = LogicalMail.Key(SelectedMail); var copies = allMail.Where(x => LogicalMail.Key(x) == key).Select(x => x.Id).ToHashSet();
        var task = (await repository.ListAsync<AITask>()).FirstOrDefault(x => copies.Contains(x.EmailId) || x.EmailIds.Any(copies.Contains)) ?? TaskOperations.FromEmail(SelectedMail); await repository.SaveAsync(task); await repository.SaveAsync(new AuditEvent { Action = "CREATE_TASK", EntityId = task.Id, Result = "Attività collegata a email" }); await RefreshAsync(); SelectedPage = "Attività"; SelectedTask = Tasks.First(x => x.Id == task.Id); Status = "Attività creata."; });

    [RelayCommand] private Task AddTaskAsync() => RunAsync(async () => { if (string.IsNullOrWhiteSpace(NewTaskTitle)) throw new ArgumentException("Inserire un titolo."); await repository.SaveAsync(new AITask { Title = NewTaskTitle.Trim() }); NewTaskTitle = ""; await RefreshAsync(); Status = "Attività aggiunta."; });

    [RelayCommand] private Task SaveTaskAsync() => RunAsync(async () =>
    {
        if (SelectedTask is null) return;
        if (string.IsNullOrWhiteSpace(SelectedTask.Title)) throw new ArgumentException("Titolo obbligatorio.");
        var latest = await repository.GetAsync<AITask>(SelectedTask.Id) ?? SelectedTask;
        latest.Title = SelectedTask.Title; latest.Description = SelectedTask.Description;
        latest.Owner = SelectedTask.Owner; latest.Due = SelectedTask.Due;
        TaskOperations.Transition(latest, SelectedTask.State);
        await repository.SaveAsync(latest);
        await repository.SaveAsync(new AuditEvent { Action = "UPDATE_TASK", EntityId = latest.Id, Result = latest.State.ToString() });
        await RefreshAsync(); SelectedTask = Tasks.FirstOrDefault(x => x.Id == latest.Id); Status = "Attività salvata.";
    });

    private async Task LoadTasksAsync() => Replace(Tasks, (await repository.ListAsync<AITask>()).Where(x => $"{x.Title} {x.Description} {x.Owner} {x.OrderNumber} {x.State}".Contains(TaskSearch, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x.State).ThenBy(x => x.Due).ThenByDescending(x => x.Priority));

    [RelayCommand] private Task FilterTasksAsync() => RunAsync(LoadTasksAsync);

    [RelayCommand] private Task LoadRuleAsync() => RunAsync(async () => { RuleText = await rules.ReadAsync(RuleName); Status = "Regola attiva caricata."; });

    [RelayCommand] private Task SaveRuleAsync() => RunAsync(async () => { await rules.ActivateAsync(RuleName, RuleText); await RefreshAsync(); Status = "Regola validata, versionata e attivata. I permessi restano controllati dal codice."; });

    [RelayCommand] private void PreviewRuleVersion() { if (SelectedRuleVersion is not null) { RuleName = SelectedRuleVersion.Name; RuleText = SelectedRuleVersion.Text; Status = "Versione storica caricata nell'editor. Premi Salva e attiva per ripristinarla."; } }

    [RelayCommand] private Task RefreshAsyncCommand() => RunAsync(async () => { await RefreshAsync(); Status = "Archivio aggiornato."; });

    public void Dispose() { timer.Stop(); lifetime.Cancel(); lifetime.Dispose(); }

}

