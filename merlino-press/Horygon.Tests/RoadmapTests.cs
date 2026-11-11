using Horygon.Core;
using Xunit;
namespace Horygon.Tests;
public class RoadmapTests
{
    static readonly DateTimeOffset Now = new(2026,10,28,12,0,0,TimeSpan.Zero);
    static EmailAccount Account => new() { Id = "a", Address = "team@example.test" };
    static EmailMessage Mail(string id, int hours = 0) => new() { Id = id, AccountId = "a", MessageId = id, From = "client@example.test", Subject = "Richiesta ordine", Date = Now.AddHours(hours), Analysis = new() { RequiresResponse = true, Priority = Priority.HIGH, Category = "commercial" } };
    static List<RoadmapRow> Build(List<EmailMessage> mails, List<AITask>? tasks = null, List<Draft>? drafts = null) => RoadmapBuilder.Build(mails, [Account], tasks ?? [], drafts ?? [], 24, Now);
    [Theory] [InlineData("")] [InlineData("not an email")] public void MissingSenderIsUnknown(string value) => Assert.Equal("", RoadmapBuilder.Address(value));
    [Fact] public void ReferencesJoinButSameSubjectDoesNot()
    { var a = Mail("1"); var b = Mail("2"); b.InReplyTo = "1"; var c = Mail("3"); Assert.Equal(2, Build([a,b,c]).Count); Assert.Contains(Build([a,b,c]), x => x.MailCount == 2); }
    [Fact] public void NeverJoinsAcrossAccounts()
    { var a=Mail("1"); var b=Mail("1"); b.AccountId="b"; Assert.Equal(2,Build([a,b]).Count); }
    [Fact] public void RemindersDoNotResetResponseClock()
    { var a=Mail("1",-48); var b=Mail("2",-1); b.InReplyTo="1"; var row=Assert.Single(Build([a,b])); Assert.True(row.Overdue); Assert.Contains("48",row.Timing); }
    [Fact] public void OutgoingReplyResolvesWaitingUntilNewInbound()
    { var a=Mail("1",-48); var reply=Mail("2",-12); reply.From=Account.Address; reply.To="client@example.test"; reply.InReplyTo="1"; Assert.False(Assert.Single(Build([a,reply])).NeedsResponse); var b=Mail("3",-1); b.InReplyTo="2"; var row=Assert.Single(Build([a,reply,b])); Assert.True(row.NeedsResponse); Assert.False(row.Overdue); }
    [Fact] public void OnlyConfirmedSentDraftCountsAsReply()
    { var a=Mail("1",-48); var draft=new Draft { AccountId="a", EmailId="1", State=SendState.Uncertain, To="client@example.test", ApprovedAt=Now }; Assert.True(Assert.Single(Build([a],drafts:[draft])).NeedsResponse); draft.State=SendState.Sent; Assert.False(Assert.Single(Build([a],drafts:[draft])).NeedsResponse); }
    [Fact] public void NewEmailAfterClosureReopensRequest()
    { var a=Mail("1",-48); var task=new AITask { EmailId="1", EmailIds=["1"], State=TaskState.COMPLETED }; Assert.True(Assert.Single(Build([a],[task])).Closed); var b=Mail("2"); b.InReplyTo="1"; var row=Assert.Single(Build([a,b],[task])); Assert.False(row.Closed); Assert.Contains("riaprire",row.State); }
    [Fact] public void ExplicitTaskDeadlineCanBeOverdueWithoutResponseRequest()
    { var a=Mail("1"); a.Analysis!.RequiresResponse=false; var task=new AITask { EmailId="1", Due=Now.LocalDateTime.AddDays(-1) }; Assert.True(Assert.Single(Build([a],[task])).Overdue); }
    [Fact] public void OrderSimilarityIsSuggestionNotAutomaticMerge()
    { var a=Mail("1"); var b=Mail("2"); a.Analysis!.OrderNumbers=["123"]; b.Analysis!.OrderNumbers=["123"]; var rows=Build([a,b]); Assert.Equal(2,rows.Count); Assert.All(rows,x=>Assert.Contains("Possibili richieste",x.Summary)); a.RequestGroupId=b.RequestGroupId="confirmed"; Assert.Single(Build([a,b])); }
    [Fact] public void EmptyIdsAndSubjectsCannotMergeUnrelatedMessages()
    { var a=Mail("1"); var b=Mail("2"); a.MessageId=b.MessageId=""; Assert.Equal(2,Build([a,b]).Count); }
    [Fact] public void DownloadedCopyCannotReopenClosedRequest()
    {
        var old = Mail("original"); var copy = Mail("copy"); copy.MessageId = old.MessageId; copy.Date = old.Date.AddMinutes(1);
        var task = new AITask { EmailId = old.Id, EmailIds = [old.Id], State = TaskState.COMPLETED };
        Assert.True(Assert.Single(Build([old,copy], [task])).Closed);
    }
    [Fact] public void CopiesAndMixedCategoriesRemainVisible()
    { var a=Mail("1"); var b=Mail("2"); b.MessageId="1"; var c=Mail("3"); c.InReplyTo="1"; c.Analysis!.Category="complaint"; var row=Assert.Single(Build([a,b,c])); Assert.Equal(3,row.MailCount); Assert.Contains("Categorie diverse",row.Coherence); }
}
