using System.Text.Json;
using Horygon.Core;
using Horygon.AI;
using Horygon.Email;
using MimeKit;
using Xunit;
namespace Horygon.Tests;
public class MailClassificationTests
{
    [Theory]
    [InlineData("Newsletter di ottobre", "Novità del mese. Unsubscribe", MailKind.Advertising)]
    [InlineData("Black Friday: sconti", "Acquista ora! Disiscriviti", MailKind.Advertising)]
    [InlineData("Fattura ottobre", "Acquista ora! Unsubscribe", MailKind.Regular)]
    [InlineData("Re: offerta speciale", "Richiesta reale. Unsubscribe", MailKind.Regular)]
    [InlineData("Preventivo richiesto", "Codice sconto. Disiscriviti", MailKind.Regular)]
    [InlineData("Aggiornamento", "Unsubscribe", MailKind.Regular)]
    [InlineData("Urgente", "Potete rispondere?", MailKind.Regular)]
    [InlineData("Hai vinto!", "Riscatta il premio", MailKind.SuspectedSpam)]
    [InlineData("Come riconoscere lo spam", "Attenzione ai messaggi che dicono hai vinto: riscatta premio", MailKind.Regular)]
    public void UsesMultipleSignalsWithoutTreatingBusinessRequestsAsAds(string subject, string body, MailKind expected)
    { Assert.Equal(expected, MailClassifier.Classify(new EmailMessage { Subject=subject, Body=body }).Kind); }
    [Fact] public void ManualCorrectionWinsAndSurvivesSerialization()
    {
        var mail = new EmailMessage { Folder="[Gmail]/Spam", ManualMailKind=MailKind.Regular, Analysis=new() { Source="AI", Category="spam" } };
        var restored=JsonSerializer.Deserialize<EmailMessage>(JsonSerializer.Serialize(mail))!;
        Assert.Equal(MailKind.Regular, restored.Classification.Kind); Assert.Equal("manuale",restored.Classification.Source);
        restored.ManualMailKind=null; Assert.Equal(MailKind.SuspectedSpam,restored.Classification.Kind);
    }
    [Fact] public void ImportedHeadersAreSignalsNotInstructions()
    {
        using var mime=new MimeMessage(); mime.Subject="Aggiornamento"; mime.Body=new TextPart("plain") { Text="Ciao" };
        mime.Headers.Add("List-Unsubscribe","<https://example.test/unsubscribe>");
        var mail=MailParser.Parse(mime,"a","INBOX",1,1); Assert.True(mail.HasListUnsubscribe); Assert.Equal(MailKind.Regular,mail.Classification.Kind);
        mime.Headers.Add("X-Spam-Flag","YES"); mail=MailParser.Parse(mime,"a","INBOX",1,1); Assert.Equal(MailKind.SuspectedSpam,mail.Classification.Kind);
    }
    [Theory] [InlineData("advertising",MailKind.Advertising)] [InlineData("newsletter",MailKind.Advertising)] [InlineData("spam",MailKind.SuspectedSpam)]
    public void AiCategoriesAreAcceptedAndDisplayed(string category, MailKind expected)
    {
        var json=JsonSerializer.Serialize(new { category, priority="LOW", summary="Sintesi", sender_type="unknown", order_numbers=Array.Empty<string>(), requires_response=false, contains_deadline=false, sentiment="neutral", suggested_action="review", reason="Segnali da verificare", confidence=0.8 });
        var mail=new EmailMessage { Analysis=Analyzer.Parse(json) }; Assert.Equal(expected,mail.Classification.Kind); Assert.Equal("AI",mail.Classification.Source);
    }
    [Fact] public void LocalAdvertisingDoesNotCreateResponseUrgency()
    { var result=Analyzer.Fallback(new() { Subject="Newsletter", Body="Acquista ora? Unsubscribe" },[]); Assert.False(result.RequiresResponse); Assert.Equal(Priority.INFORMATIONAL,result.Priority); }
    [Fact] public void LegacyMessagesNeedNoMigrationOrApiCall()
    { var mail=JsonSerializer.Deserialize<EmailMessage>("""{"Subject":"Saldi","Body":"Acquista ora! Disiscriviti"}""")!; Assert.Equal(MailKind.Advertising,mail.Classification.Kind); }
}
