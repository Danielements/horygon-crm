using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;
namespace Horygon.Email;
public interface ISmtpSession : IDisposable
{
    Task ConnectAsync(string host, int port, SecureSocketOptions options, CancellationToken ct);
    Task AuthenticateAsync(string address, string password, CancellationToken ct);
    Task AuthenticateOAuth2Async(string address, string accessToken, CancellationToken ct) => throw new NotSupportedException("Questo trasporto SMTP non supporta OAuth2.");
    Task SendAsync(MimeMessage message, CancellationToken ct);
    Task DisconnectAsync(bool quit, CancellationToken ct);
}
public interface ISmtpSessionFactory { ISmtpSession Create(); }
public sealed class MailKitSmtpSession : ISmtpSession
{
    private readonly SmtpClient client = new() { Timeout = 60000 };
    public Task ConnectAsync(string host, int port, SecureSocketOptions options, CancellationToken ct) => client.ConnectAsync(host, port, options, ct);
    public Task AuthenticateAsync(string address, string password, CancellationToken ct) => client.AuthenticateAsync(address, password, ct);
    public Task AuthenticateOAuth2Async(string address, string accessToken, CancellationToken ct) => client.AuthenticateAsync(new SaslMechanismOAuth2(address, accessToken), ct);
    public async Task SendAsync(MimeMessage message, CancellationToken ct) => await client.SendAsync(message, ct);
    public Task DisconnectAsync(bool quit, CancellationToken ct) => client.DisconnectAsync(quit, ct);
    public void Dispose() => client.Dispose();
}
