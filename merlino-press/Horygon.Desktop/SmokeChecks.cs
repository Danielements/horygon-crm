using System.IO;

using System.Windows;

using System.Windows.Media;

using System.Windows.Media.Imaging;

using Horygon.Core;

namespace Horygon.Desktop;

// Invoked only by --smoke-test with an explicit isolated directory; never seeds a normal profile.

internal static class SmokeChecks

{

    public static async Task SeedAsync(IRepository repository)

    {

        await repository.SaveAsync(new AppSettings { Id = "settings", Company = "[TEST SINTETICO]" });

        var account = new EmailAccount { Id = "synthetic-account", Address = "azienda@example.test", Password = "synthetic-not-a-password" };

        var mail = new EmailMessage { Id = "synthetic-mail", AccountId = account.Id, From = "Cliente sintetico <cliente@example.test>", To = account.Address, Subject = "[TEST SINTETICO] Informazioni ordine 2487", Body = "Buongiorno,\nvorrei informazioni sull'ordine 2487.\nQuesto messaggio è un dato sintetico usato esclusivamente per il test del rendering.", MessageId = "synthetic@example.test", ThreadKey = "synthetic@example.test", Date = DateTimeOffset.Now, Analysis = new() { Priority = Priority.HIGH, Summary = "[TEST] Richiesta di informazioni; nessuno stato ordine verificato.", Reason = "[TEST] Dati sintetici, non comunicazioni reali.", RequiresResponse = true }, Attachments = [new() { Name = "test.txt", Bytes = [65,66,67] }] };

        await repository.SaveAsync(account); await repository.SaveAsync(mail);

        await repository.SaveAsync(new Draft { Id = "synthetic-draft", AccountId = account.Id, EmailId = mail.Id, To = mail.From, Subject = "Re: " + mail.Subject, Body = "[TEST SINTETICO — NON INVIARE]\nBuongiorno, la richiesta richiede una verifica. Nessuna consegna è stata confermata." });

        var task = TaskOperations.FromEmail(mail); task.Id = "synthetic-task"; await repository.SaveAsync(task);

    }

    public static async Task RenderAsync(MainWindow window, MainViewModel vm, string directory)

    {

        Directory.CreateDirectory(Path.Combine(directory, "Screenshots"));

        vm.SelectedDraft = vm.Drafts.FirstOrDefault(); vm.SelectedTask = vm.Tasks.FirstOrDefault();

        var pages = new[] { "Dashboard", "Roadmap", "Tabellone task", "Posta in arrivo", "Approvazioni", "Attività", "Workflow", "Impostazioni" };

        foreach (var page in pages)

        {

            vm.SelectedPage = page;

            await Task.Delay(150);

            window.UpdateLayout();

            var visual = (FrameworkElement)window.Content;

            var bitmap = new RenderTargetBitmap((int)visual.ActualWidth, (int)visual.ActualHeight, 96, 96, PixelFormats.Pbgra32);

            bitmap.Render(visual);

            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));

            using var file = File.Create(Path.Combine(directory, "Screenshots", page.Replace(' ', '-') + ".png")); encoder.Save(file);

        }

        vm.SelectedPage = "Impostazioni";

        foreach (var kind in new[] { AiProviderKind.Local, AiProviderKind.OpenAI, AiProviderKind.Anthropic })

        {

            vm.SelectedAiProvider = kind;

            await Task.Delay(150); window.UpdateLayout();

            var card = (FrameworkElement)window.FindName("AiSettingsCard");

            var scroller = (System.Windows.Controls.ScrollViewer)window.FindName("SettingsScroller");

            scroller.ScrollToVerticalOffset(card.TranslatePoint(new Point(0, 0), (UIElement)scroller.Content).Y);

            await Task.Delay(150); window.UpdateLayout();

            var root = (FrameworkElement)window.Content;

            var bitmap = new RenderTargetBitmap((int)root.ActualWidth, (int)root.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);

            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));

            using var file = File.Create(Path.Combine(directory, "Screenshots", $"AI-{kind}.png")); encoder.Save(file);

        }

        vm.ApplyEmailPresetCommand.Execute("Gmail");

        var googleCard = (FrameworkElement)window.FindName("GoogleOAuthCard");

        var settingsScroll = (System.Windows.Controls.ScrollViewer)window.FindName("SettingsScroller");

        settingsScroll.ScrollToVerticalOffset(googleCard.TranslatePoint(new Point(0, 0), (UIElement)settingsScroll.Content).Y);

        await Task.Delay(150); window.UpdateLayout();

        var googleRoot = (FrameworkElement)window.Content;

        var googleBitmap = new RenderTargetBitmap((int)googleRoot.ActualWidth, (int)googleRoot.ActualHeight, 96, 96, PixelFormats.Pbgra32); googleBitmap.Render(googleRoot);

        var googlePng = new PngBitmapEncoder(); googlePng.Frames.Add(BitmapFrame.Create(googleBitmap));

        using (var googleFile = File.Create(Path.Combine(directory, "Screenshots", "Google-OAuth.png"))) googlePng.Save(googleFile);

        vm.SelectedAiProvider = AiProviderKind.Local;

        Theme.Apply(true); vm.SelectedPage = "Roadmap"; await Task.Delay(150); window.UpdateLayout();

        var content = (FrameworkElement)window.Content;

        var light = new RenderTargetBitmap((int)content.ActualWidth, (int)content.ActualHeight, 96, 96, PixelFormats.Pbgra32); light.Render(content);

        var png = new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(light));

        using var output = File.Create(Path.Combine(directory, "Screenshots", "Roadmap-light.png")); png.Save(output);

    }

}

