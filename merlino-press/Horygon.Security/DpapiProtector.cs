using System.Security.Cryptography;
using System.Text;
using Horygon.Core;
namespace Horygon.Security;
public sealed class DpapiProtector : IProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Horygon.Payload.v1");
    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, Entropy, DataProtectionScope.CurrentUser);
}
