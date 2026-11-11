using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Horygon.Core;
using Horygon.Server;
using Horygon.Data;
using Horygon.AI;
using Horygon.Email;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions{Args=args,ContentRootPath=AppContext.BaseDirectory});
builder.Logging.AddFilter("Microsoft.AspNetCore",LogLevel.Warning);
var data = Path.GetFullPath(Environment.GetEnvironmentVariable("HORYGON_DATA") ?? Path.Combine(AppContext.BaseDirectory,"data"));
Directory.CreateDirectory(data);
string RequiredKey(string name) { var key=Environment.GetEnvironmentVariable(name) ?? ""; if(key.Length<24) throw new InvalidOperationException($"Configurare {name} (almeno 24 caratteri casuali)."); return key; }
var admin = RequiredKey("HORYGON_ADMIN_KEY"); var viewer = RequiredKey("HORYGON_VIEWER_KEY"); 
if(admin==viewer) throw new InvalidOperationException("Usare due codici distinti.");
var origin = Environment.GetEnvironmentVariable("HORYGON_PUBLIC_ORIGIN")?.TrimEnd('/') ?? "";
if(origin!="" && (!Uri.TryCreate(origin, UriKind.Absolute,out var publicUri) || publicUri.Scheme!="https" || publicUri.AbsolutePath!="/" || publicUri.UserInfo!="")) throw new InvalidOperationException("HORYGON_PUBLIC_ORIGIN deve essere un'origine HTTPS.");
builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("HORYGON_URLS") ?? "http://127.0.0.1:80");
builder.WebHost.ConfigureKestrel(x=>x.Limits.MaxRequestBodySize=1024*1024);
builder.Services.AddRateLimiter(x=> { x.RejectionStatusCode=429; x.AddFixedWindowLimiter("login",o=> {o.PermitLimit=12;o.Window=TimeSpan.FromMinutes(1);o.QueueLimit=0;}); });
var key = Convert.FromBase64String(Environment.GetEnvironmentVariable("HORYGON_DATA_KEY") ?? throw new InvalidOperationException("Configurare HORYGON_DATA_KEY: chiave AES base64 da 32 byte."));
var protector = new ServerProtector(key);
var repository = new EncryptedRepository(Path.Combine(data,"mail.db"),protector);await repository.InitializeAsync();
if(args.Length==2 && args[0]=="--import")
{
    var count=await PortableBackup.ImportAsync(repository,await File.ReadAllBytesAsync(args[1]),Environment.GetEnvironmentVariable("HORYGON_MIGRATION_PASSWORD")??"");
    var importedRules=Path.Combine(data,"rules");Directory.CreateDirectory(importedRules);
    foreach(var name in RuleService.Names)
    {
        var latest=(await repository.ListAsync<RuleVersion>()).Where(x=>x.Name==name).OrderByDescending(x=>x.CreatedAt).FirstOrDefault();
        if(latest!=null)await File.WriteAllTextAsync(Path.Combine(importedRules,name),latest.Text);
    }
    Console.WriteLine($"Importati {count} record; download automatico disattivato, nessuna chiamata AI.");return;
}
var rulesPath=Path.Combine(data,"rules");Directory.CreateDirectory(rulesPath);
foreach(var name in RuleService.Names) if(!File.Exists(Path.Combine(rulesPath,name)))File.Copy(Path.Combine(AppContext.BaseDirectory,"config",name),Path.Combine(rulesPath,name));
var store=new OperationsStore(Path.Combine(data,"operations.db"),protector);store.Initialize();
await repository.ListAsync<AppSettings>(); await store.ReadAsync(); // Fail fast if the archive key does not match.
var worker=new MailWorker(repository,store,rulesPath);
builder.Services.AddSingleton(worker);builder.Services.AddHostedService(sp=>sp.GetRequiredService<MailWorker>());
var oauth=new WebGoogleAuth(repository,origin);

var statusSettings = await repository.GetAsync<StatusSettings>("status") ?? new StatusSettings {Id="status",AccessKey=Convert.ToHexString(RandomNumberGenerator.GetBytes(32))};
await repository.SaveAsync(statusSettings);
var statusGate = new SemaphoreSlim(1,1);
var productionGate = new SemaphoreSlim(1,1);
var sessions=new ConcurrentDictionary<string,(string Role,DateTimeOffset Until)>();
bool Equal(string a,string b)=>CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)),SHA256.HashData(Encoding.UTF8.GetBytes(b)));
string? Role(HttpContext ctx)=>ctx.Request.Cookies.TryGetValue("horygon_session",out var token)&&sessions.TryGetValue(token,out var session)&&session.Until>DateTimeOffset.UtcNow ? session.Role:null;
var app=builder.Build();
app.Use(async(ctx,next)=>
{
    ctx.Response.Headers["Cache-Control"]="no-store";
    ctx.Response.Headers["X-Content-Type-Options"]="nosniff";
    ctx.Response.Headers["Referrer-Policy"]="no-referrer";
    ctx.Response.Headers["Content-Security-Policy"]="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    if(origin!="" && ctx.Request.Headers["X-Forwarded-Proto"]!="https") {ctx.Response.StatusCode=400;await ctx.Response.WriteAsync("Accesso tramite HTTPS richiesto.");return;}
    if(ctx.Request.Path.StartsWithSegments("/api") && ctx.Request.Method!="GET" && ctx.Request.Headers["X-Horygon"]!="1") {ctx.Response.StatusCode=403;return;}
    if(ctx.Request.Headers.TryGetValue("Origin",out var requestOrigin) && requestOrigin.Count>0 && requestOrigin.ToString()!=(origin!=""?origin:$"{ctx.Request.Scheme}://{ctx.Request.Host}")) {ctx.Response.StatusCode=403;return;}
    try {await next();}
    catch(ArgumentException ex) {ctx.Response.StatusCode=400;await ctx.Response.WriteAsJsonAsync(new {error=ex.Message});}
    catch(InvalidOperationException ex) {ctx.Response.StatusCode=409;await ctx.Response.WriteAsJsonAsync(new {error=ex.Message});}
    catch(Exception) {ctx.Response.StatusCode=500;await ctx.Response.WriteAsJsonAsync(new {error="Operazione non riuscita. Verificare il servizio e riprovare."});}
});
app.UseRateLimiter();
app.MapPost("/api/login", (LoginRequest request,HttpContext ctx)=>
{
    var role=Equal(request.Code??"",admin)?"operator":Equal(request.Code??"",viewer)?"viewer":null;
    if(role is null)return Results.Unauthorized();
    foreach(var old in sessions.Where(x=>x.Value.Until<=DateTimeOffset.UtcNow))sessions.TryRemove(old.Key,out _);
    var token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));sessions[token]=(role,DateTimeOffset.UtcNow.AddHours(8));
    ctx.Response.Cookies.Append("horygon_session",token,new CookieOptions {HttpOnly=true,Secure=origin!="",SameSite=SameSiteMode.Strict,MaxAge=TimeSpan.FromHours(8),Path="/"});
    return Results.Ok(new {role});
}).RequireRateLimiting("login");
app.MapPost("/api/logout",(HttpContext ctx)=> {if(ctx.Request.Cookies.TryGetValue("horygon_session",out var token))sessions.TryRemove(token,out _);ctx.Response.Cookies.Delete("horygon_session");return Results.Ok();});
app.MapGet("/api/board",async(HttpContext ctx)=>
{
    var role=Role(ctx);if(role is null)return Results.Unauthorized();
    var snapshot=await store.ReadAsync();var printers=(await repository.ListAsync<PrinterConfig>()).Where(x=>!x.Deleted);var printerTests=await repository.ListAsync<PrinterProbe>();return Results.Ok(new {role,printers,printerTests,records=snapshot.Records,lastSync=snapshot.LastSync,trackingService="Non configurato",demo=Environment.GetEnvironmentVariable("HORYGON_DEMO")=="1",work=new{worker.Busy,worker.Status}});
});
app.MapPost("/api/record",async(OperationalRecord row,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    if(string.IsNullOrWhiteSpace(row.Id))return Results.BadRequest();
    await productionGate.WaitAsync();
    try {
        if(row.PrinterId!="") {
            if(row.Area!="Ordini" || (await repository.GetAsync<PrinterConfig>(row.PrinterId)) is not {Deleted:false})throw new ArgumentException("Stampante non valida per questo ordine.");
            if(row.ProductionState is not ("In coda" or "In lavorazione" or "Sospeso" or "Terminato"))throw new ArgumentException("Stato produzione non valido.");
            if(!row.Closed && row.ProductionState=="In lavorazione" && (await store.ReadAsync()).Records.Any(x=>x.Id!=row.Id&&!x.Closed&&x.PrinterId==row.PrinterId&&x.ProductionState=="In lavorazione"))
                throw new InvalidOperationException("La stampante ha già un ordine in lavorazione. Termina o sospendi prima quello attuale.");
        }
        await store.SaveAsync([row],false);
    }finally{productionGate.Release();}
    return Results.Ok();
});
app.MapPost("/api/work/{command}",async(string command,HttpContext ctx)=> {if(Role(ctx)!="operator")return Results.StatusCode(403);await worker.RequestAsync(command);return Results.Accepted();});
app.MapGet("/api/settings",async(HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    var config=await repository.GetAsync<AppSettings>("settings")??new();AiConfiguration.Migrate(config);var profile=config.AiProfiles[config.SelectedAiProvider!.Value];
    var accounts=await repository.ListAsync<EmailAccount>();
    return Results.Ok(new {config.AutoSync,config.PollSeconds,config.AiEnabled,config.AllowExternalAi,provider=config.SelectedAiProvider.ToString(),profile.Endpoint,profile.Model,hasKey=profile.ApiKey.Length>0,config.GoogleOAuthClientId,hasGoogleSecret=config.GoogleOAuthClientSecret.Length>0,accounts=accounts.Select(x=>new{x.Id,x.Address,x.GoogleConnectedAddress})});
});
app.MapPost("/api/settings",async(ServerSettings request,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);if(worker.Busy)return Results.Conflict(new{error="Attendi o sospendi la lavorazione."});
    var config=await repository.GetAsync<AppSettings>("settings")??new(){Id="settings"};AiConfiguration.Migrate(config);
    if(!Enum.TryParse<AiProviderKind>(request.Provider,out var kind)||!Enum.IsDefined(kind))throw new ArgumentException("Provider non valido.");
    config.SelectedAiProvider=kind;var profile=config.AiProfiles[kind];profile.Endpoint=request.Endpoint;profile.Model=request.Model;if(!string.IsNullOrWhiteSpace(request.ApiKey))profile.ApiKey=request.ApiKey;
    config.AiEnabled=request.AiEnabled;config.AllowExternalAi=request.AllowExternalAi;config.AutoSync=request.AutoSync;config.PollSeconds=Math.Clamp(request.PollSeconds,30,3600);
    config.GoogleOAuthClientId=request.GoogleClientId;if(!string.IsNullOrWhiteSpace(request.GoogleSecret))config.GoogleOAuthClientSecret=request.GoogleSecret;
    if(config.AiEnabled)ConfiguredAIProvider.Validate(config);await repository.SaveAsync(config);await repository.SaveAsync(new AuditEvent{Action="SERVER_SETTINGS",Result="Configurazione servizi aggiornata"});return Results.Ok();
});
app.MapPost("/api/google/start",async(GoogleLogin request,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);if(worker.Busy)return Results.Conflict();return Results.Ok(new{url=await oauth.StartAsync(request.Address,ctx)});
});
app.MapGet("/oauth/google/callback",async(HttpContext ctx)=> {await oauth.CompleteAsync(ctx);return Results.Redirect("/?connected=1");});
app.MapGet("/api/mail/{id}",async(string id,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);var mail=await repository.GetAsync<EmailMessage>(id);return mail is null?Results.NotFound():Results.Ok(new{mail.Id,mail.From,mail.To,mail.Subject,mail.Date,mail.Body});
});
app.MapGet("/api/audit",async(HttpContext ctx)=> {if(Role(ctx)!="operator")return Results.StatusCode(403);return Results.Ok((await repository.ListAsync<AuditEvent>()).Concat(await store.ReadAuditAsync()).OrderByDescending(x=>x.Timestamp).Take(100).Select(x=>new{x.Timestamp,x.Action,x.Result}));});
app.MapPost("/api/printers",async(PrinterConfig request,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    if(string.IsNullOrWhiteSpace(request.Name)||request.Name.Length>100||request.Services.Length>1000||request.Endpoint.Length>500||request.Id.Length>120)throw new ArgumentException("Nome obbligatorio; campi stampante troppo lunghi.");
    if(request.Brand.Length>100||request.Model.Length>200||request.Ports.Count>10||request.Ports.Any(p=>p<1||p>65535))throw new ArgumentException("Marca, modello o porte non validi (massimo 10 porte).");
    if(request.Endpoint!="")PrinterConnectivity.Host(request.Endpoint);
    await productionGate.WaitAsync();
    try{
        var old=await repository.GetAsync<PrinterConfig>(request.Id);
        if(old?.Deleted==true)throw new InvalidOperationException("Stampante rimossa.");
        if(request.Revision!=(old?.Revision??0))throw new InvalidOperationException("Configurazione modificata: riapri Impostazioni.");
        if((await repository.ListAsync<PrinterConfig>()).Any(x=>!x.Deleted&&x.Id!=request.Id&&x.Name.Equals(request.Name.Trim(),StringComparison.OrdinalIgnoreCase)))throw new ArgumentException("Esiste già una stampante con questo nome.");
        request.Deleted=false;request.Ports=request.Ports.Distinct().ToList();request.Name=request.Name.Trim();request.Revision++;
        await repository.SaveAsync(request);
        await repository.SaveAsync(new AuditEvent{Action="PRINTER_SETTINGS",EntityId=request.Id,Result="Configurazione stampante aggiornata"});
    }finally{productionGate.Release();}
    return Results.Ok();
});
app.MapPost("/api/printers/{id}/delete",async(string id,PrinterRevision request,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    await productionGate.WaitAsync();
    try{
        var printer=await repository.GetAsync<PrinterConfig>(id);if(printer is null||printer.Deleted)return Results.NotFound();
        if(printer.Revision!=request.Revision)return Results.Conflict(new{error="Stampante modificata: aggiorna Impostazioni."});
        if((await store.ReadAsync()).Records.Any(x=>x.PrinterId==id))return Results.Conflict(new{error="Rimuovi prima l'assegnazione dagli ordini collegati, inclusi quelli chiusi."});
        printer.Deleted=true;printer.Revision++;await repository.SaveAsync(printer);
        await repository.SaveAsync(new AuditEvent{Action="PRINTER_DELETE",EntityId=id,Result="Stampante rimossa dall'anagrafica"});
        return Results.Ok();
    }finally{productionGate.Release();}
});
var probeGate=new SemaphoreSlim(1,1);
app.MapPost("/api/printers/{id}/test",async(string id,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    var printer=await repository.GetAsync<PrinterConfig>(id);if(printer is null||printer.Deleted)return Results.NotFound();
    var host=PrinterConnectivity.Host(printer.Endpoint);
    if(printer.Ports.Count==0)throw new ArgumentException("Configurare almeno una porta TCP.");
    if(!await probeGate.WaitAsync(0))return Results.Conflict(new{error="Un test è già in corso."});
    try{
        var results=await Task.WhenAll(printer.Ports.Select(port=>PrinterConnectivity.ProbeAsync(host,port,ctx.RequestAborted)));
        var result=new PrinterProbe{Id=id,CheckedAt=DateTimeOffset.UtcNow,Results=results.ToList()};await repository.SaveAsync(result);
        await repository.SaveAsync(new AuditEvent{Action="PRINTER_TEST",EntityId=id,Result="Test raggiungibilità TCP completato"});
        return Results.Ok(result);
    }finally{probeGate.Release();}
});
app.MapGet("/api/status-settings",async(HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    var settings=await repository.GetAsync<StatusSettings>("status");
    return Results.Ok(new{settings!.OrdersPerPage,statusPath="/status.html#"+settings.AccessKey});
});
app.MapPost("/api/status-settings",async(StatusOptions request,HttpContext ctx)=>
{
    if(Role(ctx)!="operator")return Results.StatusCode(403);
    if(request.OrdersPerPage is <1 or >30)throw new ArgumentException("Scegli da 1 a 30 ordini per pagina.");
    await statusGate.WaitAsync();
    try {
        var settings=(await repository.GetAsync<StatusSettings>("status"))!;
        settings.OrdersPerPage=request.OrdersPerPage;
        await repository.SaveAsync(settings);
    } finally {statusGate.Release();}
    return Results.Ok();
});
app.MapGet("/api/status",async(HttpContext ctx)=>
{
    var settings=(await repository.GetAsync<StatusSettings>("status"))!;
    if(!Equal(ctx.Request.Headers["X-Horygon-Status"].ToString(),settings.AccessKey))return Results.Unauthorized();
    var snapshot=await store.ReadAsync();
    var printers=(await repository.ListAsync<PrinterConfig>()).ToDictionary(x=>x.Id);
    var rows=snapshot.Records.Where(x=>x.Area=="Ordini"&&!x.Closed).OrderByDescending(x=>x.UpdatedAt).ThenBy(x=>x.Id)
        .Select(x=>new{number=x.OrderNumber,name=x.Customer,description=x.Title,status=x.Status,printer=printers.TryGetValue(x.PrinterId,out var printer)?printer.Name:"",production=x.PrinterId!=""?x.ProductionState:""});
    return Results.Ok(new{records=rows,settings.OrdersPerPage,lastSync=snapshot.LastSync,demo=Environment.GetEnvironmentVariable("HORYGON_DEMO")=="1"});
});
app.MapGet("/health",()=>Results.Ok(new {service="horygon-operations",version="0.9.0"}));
app.UseDefaultFiles();app.UseStaticFiles();
await app.RunAsync();
record LoginRequest(string? Code);

record ServerSettings(bool AutoSync,int PollSeconds,bool AiEnabled,bool AllowExternalAi,string Provider,string Endpoint,string Model,string ApiKey,string GoogleClientId,string GoogleSecret);
record GoogleLogin(string Address);

record StatusOptions(int OrdersPerPage);

record PrinterRevision(long Revision);
