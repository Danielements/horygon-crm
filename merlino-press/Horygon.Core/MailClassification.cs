using System.Text.RegularExpressions;
namespace Horygon.Core;

public enum MailKind { Regular, Advertising, SuspectedSpam }
public sealed record MailClassification(MailKind Kind, string Reason, string Source)
{
    public string Label => Kind switch { MailKind.Advertising => "PUBBLICITÀ / NEWSLETTER", MailKind.SuspectedSpam => "SPAM SOSPETTO", _ => "POSTA ORDINARIA" };
}

public static class MailClassifier
{
    public static MailClassification Classify(EmailMessage mail)
    {
        if (mail.ManualMailKind is { } manual)
            return new(manual, "Classificazione confermata dall'utente. Usa Automatico per ripristinare il riconoscimento.", "manuale");
        var folder = mail.Folder.Split('/', '\\').LastOrDefault()?.ToLowerInvariant();
        if (mail.SpamHeaderFlag || folder is "spam" or "junk" or "posta indesiderata")
            return new(MailKind.SuspectedSpam, "Segnale nelle intestazioni o nella cartella spam del server; da verificare.", "server / intestazioni");
        if (mail.Analysis is { Source: "AI" } analysis)
        {
            if (analysis.Category == "spam") return new(MailKind.SuspectedSpam, analysis.Reason, "AI");
            if (analysis.Category is "advertising" or "newsletter") return new(MailKind.Advertising, analysis.Reason, "AI");
        }
        var subject = mail.Subject.ToLowerInvariant();
        var body = mail.Body[..Math.Min(mail.Body.Length, 20000)].ToLowerInvariant();
        bool Has(string text, string pattern) => Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        // Multiple independent signals; never trust email instructions or follow unsubscribe links.
        if (Has(subject, @"\b(hai vinto|you have won|vincita|lottery winner)\b") && Has(body, @"\b(riscuoti|riscatta|claim|premio|prize)\b"))
            return new(MailKind.SuspectedSpam, "Promessa di vincita e richiesta di riscossione: possibile spam, verificare il mittente.", "regole locali");
        var transactional = Has(subject, @"\b(fattura|invoice|ricevuta|receipt|reclamo|sollecito|ordine|order|preventivo|quotation|password|sicurezza|security)\b") || subject.StartsWith("re:") || subject.StartsWith("r:");
        var optOut = mail.HasListUnsubscribe || Has(body, @"\b(unsubscribe|disiscriviti|cancella iscrizione|annulla iscrizione)\b");
        var campaign = Has(subject, @"\b(newsletter|black friday|saldi|sconti|promozione|promozioni|offerta speciale|offerte speciali|special offer|sale|discount|webinar)\b");
        var marketingBody = Has(body, @"\b(acquista ora|shop now|codice sconto|coupon|scopri le offerte|iscriviti al webinar|register now)\b");
        if (!transactional && optOut && (campaign || marketingBody))
            return new(MailKind.Advertising, "Segnali di campagna promozionale o newsletter insieme a indicazione di disiscrizione.", "regole locali");
        return new(MailKind.Regular, "Nessun segnale sufficiente per classificare come pubblicità o spam. Non è una verifica di sicurezza.", "regole locali");
    }
}
