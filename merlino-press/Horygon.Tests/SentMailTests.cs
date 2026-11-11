using Horygon.Core;
using Xunit;
namespace Horygon.Tests;
public class SentMailTests
{
    static readonly DateTimeOffset Now=DateTimeOffset.UtcNow;
    static readonly EmailAccount Account=new() { Id="a", Address="office@example.test" };
    static EmailMessage Request(string id="in") => new() { Id=id, MessageId=id, AccountId="a", From="customer@example.test", To=Account.Address, Date=Now.AddDays(-2), Analysis=new() { RequiresResponse=true, Priority=Priority.HIGH } };
    static EmailMessage Reply() => new() { Id="out", MessageId="out", AccountId="a", From="Sales <alias@example.test>", To="customer@example.test", InReplyTo="in", Date=Now.AddDays(-1), IsSentCopy=true };
    static List<RoadmapRow> Rows(params EmailMessage[] mails) => RoadmapBuilder.Build(mails,[Account],[],[],24,Now);
    [Fact] public void SentFolderRecognizesAliasAndUpdatesResponseWithoutClosingTask()
    { var row=Assert.Single(Rows(Request(),Reply())); Assert.Equal(1,row.OutgoingCount); Assert.Equal(1,row.IncomingCount); Assert.False(row.NeedsResponse); Assert.False(row.Closed); Assert.Contains("Risposta inviata",row.Response); }
    [Fact] public void UnsentDraftNeverCountsAsReply()
    { var reply=Reply(); reply.IsDraftCopy=true; reply.From=Account.Address; var row=Assert.Single(Rows(Request(),reply)); Assert.True(row.NeedsResponse); Assert.Equal(0,row.OutgoingCount); }
    [Fact] public void InternalForwardIsNotAReplyToCustomer()
    { var reply=Reply(); reply.To="colleague@example.test"; Assert.True(Assert.Single(Rows(Request(),reply)).NeedsResponse); }
    [Fact] public void ManualMergeDoesNotMakeUnrelatedOutgoingAMatchingReply()
    { var request=Request(); request.RequestGroupId="case"; var reply=Reply(); reply.InReplyTo="another"; reply.RequestGroupId="case"; Assert.True(Assert.Single(Rows(request,reply)).NeedsResponse); }
    [Fact] public void ReplyCanTargetExplicitReplyTo()
    { var request=Request(); request.ReplyTo="service@example.test"; var reply=Reply(); reply.To="service@example.test"; Assert.False(Assert.Single(Rows(request,reply)).NeedsResponse); }
    [Fact] public void SentCopyWinsOverDuplicateInAllMail()
    { var sent=Reply(); var copy=Reply(); copy.Id="copy"; copy.IsSentCopy=false; copy.Folder="All Mail"; var row=Assert.Single(Rows(Request(),copy,sent)); Assert.Equal(1,row.OutgoingCount); Assert.False(row.NeedsResponse); }
    [Fact] public void FollowUpAfterResponseReopensWaiting()
    { var follow=Request("follow"); follow.Date=Now; follow.InReplyTo="out"; var row=Assert.Single(Rows(Request(),Reply(),follow)); Assert.True(row.NeedsResponse); Assert.False(row.Overdue); }
    [Fact] public void CoverageShowsHistoryWindowAndDoesNotPretendUnknownIsComplete()
    { var request=Request(); Assert.Contains("non ancora verificata",Assert.Single(Rows(request)).Coverage);
      var coverage=new MailSyncCoverage { Id="a", SentComplete=true, InboxComplete=true, CompletedAt=Now, Since=Now.AddDays(-90) };
      var row=Assert.Single(RoadmapBuilder.Build([request],[Account],[],[],24,Now,[coverage])); Assert.Contains("Ricevuta + inviata",row.Coverage);
      coverage.SentComplete=false; row=Assert.Single(RoadmapBuilder.Build([request],[Account],[],[],24,Now,[coverage])); Assert.Contains("inviata incompleta",row.Coverage);
    }
    [Fact] public void DraftOnlyConversationIsNotAnOpenCustomerCase()
    { var mail=Reply(); mail.Folder="Drafts"; Assert.Empty(Rows(mail)); }
}
