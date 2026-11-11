using AngleSharp.Html.Parser;
using Horygon.Core;
using Microsoft.Playwright;
namespace Horygon.Integrations;

public sealed record PortalConfig(string UrlTemplate, string[] AllowedHosts, string NumberSelector, string StatusSelector, string CustomerSelector, string DeliverySelector);
public static class PortalGuard
{
    public static Uri Validate(string url, IEnumerable<string> hosts)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length > 0 || !hosts.Contains(uri.IdnHost, StringComparer.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Dominio del portale non autorizzato o URL non HTTPS.");
        return uri;
    }
    public static OrderStatus Parse(string html, string number, PortalConfig config, Uri source)
    {
        var doc = new HtmlParser().ParseDocument(html);
        string Read(string selector) => doc.QuerySelector(selector)?.TextContent.Trim() ?? "";
        var found = Read(config.NumberSelector);
        var status = Read(config.StatusSelector);
        if (!string.Equals(found, number, StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(status)) throw new InvalidDataException("Ordine non trovato o selettori non validi: stato non verificato.");
        return new(found, status, Read(config.CustomerSelector), Read(config.DeliverySelector), source, DateTimeOffset.UtcNow);
    }
}
public sealed class HtmlOrderConnector(PortalConfig config) : IOrderConnector
{
    public async Task<OrderStatus> LookupAsync(string number, CancellationToken ct)
    {
        var uri = PortalGuard.Validate(config.UrlTemplate.Replace("{order}", Uri.EscapeDataString(number)), config.AllowedHosts);
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
        using var response = await http.GetAsync(uri, ct);
        if ((int)response.StatusCode is >= 300 and < 400) throw new InvalidOperationException("Redirect non consentito. Configurare l'URL finale autorizzato.");
        response.EnsureSuccessStatusCode();
        return PortalGuard.Parse(await response.Content.ReadAsStringAsync(ct), number, config, uri);
    }
}
// Browser adapter for public, JavaScript-rendered read-only pages. No arbitrary AI navigation or scripts.
public sealed class BrowserOrderConnector(PortalConfig config) : IOrderConnector
{
    public async Task<OrderStatus> LookupAsync(string number, CancellationToken ct)
    {
        var uri = PortalGuard.Validate(config.UrlTemplate.Replace("{order}", Uri.EscapeDataString(number)), config.AllowedHosts);
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() { Headless = true });
        using var registration = ct.Register(() => _ = browser.CloseAsync());
        var context = await browser.NewContextAsync(new() { AcceptDownloads = false, ServiceWorkers = ServiceWorkerPolicy.Block });
        await context.RouteAsync("**/*", async route =>
        {
            try { PortalGuard.Validate(route.Request.Url, config.AllowedHosts); if (route.Request.Method is not ("GET" or "HEAD")) throw new UnauthorizedAccessException(); await route.ContinueAsync(); }
            catch (UnauthorizedAccessException) { await route.AbortAsync(); }
        });
        var page = await context.NewPageAsync();
        await page.GotoAsync(uri.AbsoluteUri, new() { Timeout = 30000, WaitUntil = WaitUntilState.DOMContentLoaded });
        await page.Locator(config.StatusSelector).WaitForAsync(new() { Timeout = 15000 });
        ct.ThrowIfCancellationRequested();
        return PortalGuard.Parse(await page.ContentAsync(), number, config, PortalGuard.Validate(page.Url, config.AllowedHosts));
    }
}
