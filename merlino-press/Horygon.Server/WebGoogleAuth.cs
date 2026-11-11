using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Net.Http.Json;
using Google.Apis.Auth.OAuth2.Responses;
using Horygon.Core;
using Horygon.Email;
namespace Horygon.Server;
public sealed class WebGoogleAuth(IRepository repository,string origin)
{
    sealed record Pending(string Address,string Verifier,string Correlation,DateTimeOffset Until,string ClientId,string Secret);
    readonly ConcurrentDictionary<string,Pending> pending=new();
    static string Random()=>Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    public async Task<string> StartAsync(string address,HttpContext ctx)
    {
        if(origin=="")throw new InvalidOperationException("Per Gmail sul server configura prima il dominio HTTPS e il client OAuth Google di tipo Applicazione web.");
        if(!System.Net.Mail.MailAddress.TryCreate(address,out var parsed)||parsed.Address!=address)throw new ArgumentException("Indirizzo email non valido.");
        var settings=await repository.GetAsync<AppSettings>("settings")??new();GoogleOAuthConfiguration.ValidateClient(settings.GoogleOAuthClientId,settings.GoogleOAuthClientSecret);
        foreach(var old in pending.Where(x=>x.Value.Until<DateTimeOffset.UtcNow))pending.TryRemove(old.Key,out _);
        var state=Random();var verifier=Random();var correlation=Random();
        pending[state]=new(address,verifier,correlation,DateTimeOffset.UtcNow.AddMinutes(10),settings.GoogleOAuthClientId,settings.GoogleOAuthClientSecret);
        ctx.Response.Cookies.Append("horygon_oauth",correlation,new CookieOptions{HttpOnly=true,Secure=true,SameSite=SameSiteMode.Lax,MaxAge=TimeSpan.FromMinutes(10),Path="/oauth/google/callback"});
        var challenge=Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+','-').Replace('/','_');
        var query=new Dictionary<string,string>{{"client_id",settings.GoogleOAuthClientId},{"redirect_uri",origin+"/oauth/google/callback"},{"response_type","code"},{"scope",GoogleOAuthConfiguration.MailScope+" openid email"},{"state",state},{"code_challenge",challenge},{"code_challenge_method","S256"},{"access_type","offline"},{"prompt","consent select_account"},{"login_hint",address}};
        return "https://accounts.google.com/o/oauth2/v2/auth?"+string.Join("&",query.Select(x=>Uri.EscapeDataString(x.Key)+"="+Uri.EscapeDataString(x.Value)));
    }
    public async Task CompleteAsync(HttpContext ctx)
    {
        var state=ctx.Request.Query["state"].ToString();
        if(!pending.TryRemove(state,out var item)||item.Until<DateTimeOffset.UtcNow||!ctx.Request.Cookies.TryGetValue("horygon_oauth",out var correlation)||correlation!=item.Correlation)throw new InvalidOperationException("Accesso Google scaduto o non valido. Ripetere il collegamento.");
        ctx.Response.Cookies.Delete("horygon_oauth",new CookieOptions{Path="/oauth/google/callback"});
        if(ctx.Request.Query.ContainsKey("error"))throw new InvalidOperationException("Consenso Google non completato.");
        using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(40)};
        using var response=await client.PostAsync("https://oauth2.googleapis.com/token",new FormUrlEncodedContent(new Dictionary<string,string>{{"code",ctx.Request.Query["code"].ToString()},{"client_id",item.ClientId},{"client_secret",item.Secret},{"redirect_uri",origin+"/oauth/google/callback"},{"grant_type","authorization_code"},{"code_verifier",item.Verifier}}));
        if(!response.IsSuccessStatusCode)throw new InvalidOperationException("Google non ha autorizzato il collegamento.");
        using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync());var token=json.RootElement;
        if(!token.TryGetProperty("refresh_token",out var refresh)||!token.TryGetProperty("scope",out var scopes)||!scopes.GetString()!.Split(' ').Contains(GoogleOAuthConfiguration.MailScope))throw new InvalidOperationException("Google non ha concesso l'accesso continuativo Gmail.");
        var access=token.GetProperty("access_token").GetString()!;
        using var request=new HttpRequestMessage(HttpMethod.Get,"https://openidconnect.googleapis.com/v1/userinfo");request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",access);
        using var identityResponse=await client.SendAsync(request);if(!identityResponse.IsSuccessStatusCode)throw new InvalidOperationException("Identità Google non verificata.");
        using var identity=JsonDocument.Parse(await identityResponse.Content.ReadAsStringAsync());
        if(!identity.RootElement.GetProperty("email_verified").GetBoolean()||!string.Equals(identity.RootElement.GetProperty("email").GetString(),item.Address,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("L'account Google scelto non corrisponde all'indirizzo indicato.");
        var account=(await repository.ListAsync<EmailAccount>()).FirstOrDefault(x=>x.Address.Equals(item.Address,StringComparison.OrdinalIgnoreCase))??new EmailAccount{Address=item.Address};
        account.Authentication=EmailAuthentication.GoogleOAuth;account.ImapHost="imap.gmail.com";account.ImapPort=993;account.SmtpHost="smtp.gmail.com";account.SmtpPort=465;account.SmtpStartTls=false;account.GoogleConnectedAddress=item.Address;account.Password="";
        var grant=new TokenResponse{AccessToken=access,RefreshToken=refresh.GetString(),ExpiresInSeconds=token.GetProperty("expires_in").GetInt64(),IssuedUtc=DateTime.UtcNow,Scope=scopes.GetString(),TokenType="Bearer"};
        await repository.SaveAsync(new GoogleOAuthSession{Id=account.Id,Address=item.Address,ClientId=item.ClientId,ClientSecret=item.Secret,TokenJson=JsonSerializer.Serialize(grant)});
        await repository.SaveAsync(account);await repository.SaveAsync(new AuditEvent{Action="GOOGLE_WEB_CONNECTED",EntityId=account.Id,Result="Gmail collegato al server"});
    }
}
