using System.Security.Cryptography;
namespace Horygon.Core;
public sealed class ServerProtector : IProtector
{
    readonly byte[] key;
    public ServerProtector(byte[] key) { if(key.Length!=32)throw new ArgumentException("Chiave AES non valida.");this.key=key.ToArray(); }
    public byte[] Protect(byte[] data)
    {
        var result=new byte[28+data.Length];RandomNumberGenerator.Fill(result.AsSpan(0,12));
        using var aes=new AesGcm(key,16);aes.Encrypt(result.AsSpan(0,12),data,result.AsSpan(28),result.AsSpan(12,16));return result;
    }
    public byte[] Unprotect(byte[] data)
    {
        if(data.Length<28)throw new CryptographicException("Archivio non valido.");
        var result=new byte[data.Length-28];using var aes=new AesGcm(key,16);aes.Decrypt(data.AsSpan(0,12),data.AsSpan(28),data.AsSpan(12,16),result);return result;
    }
}
