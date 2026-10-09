using System.Security.Cryptography;
using System.Text;

namespace Aegis.Security;

// Firebase Auth 的「改良版 scrypt」密碼雜湊（方案 A：遷移後舊密碼照樣能登入，第一次登入時再改存新格式）
//   derived = scrypt(password, salt ‖ saltSeparator, N = 2^memoryCost, r = rounds, p = 1, dkLen = 64)
//   hash    = AES-256-CTR(key = derived[0..32], iv = 16 個 0).Encrypt(signerKey)
// 參數來自 Identity Platform config.signIn.hashConfig（ETL 匯出時一併取得）；salt / hash / 參數都是 base64。
public sealed record FirebaseHashParams(string SignerKeyB64, string SaltSeparatorB64, int Rounds, int MemoryCost);

public static class FirebaseScrypt
{
    public static string Hash(string password, string saltB64, FirebaseHashParams p)
    {
        var salt = B64(saltB64).Concat(B64(p.SaltSeparatorB64)).ToArray();
        var derived = Scrypt.DeriveKey(Encoding.UTF8.GetBytes(password), salt, 1 << p.MemoryCost, p.Rounds, 1, 64);
        return Convert.ToBase64String(AesCtr(derived[..32], B64(p.SignerKeyB64)));
    }

    public static bool Verify(string password, string saltB64, string hashB64, FirebaseHashParams p) =>
        CryptographicOperations.FixedTimeEquals(Convert.FromBase64String(Hash(password, saltB64, p)), B64(hashB64));

    // 帳號 API（accounts:batchGet）回傳 base64url（- _、無補位）；README 範例與 firebase auth:export 是標準 base64 — 兩種都收
    public static byte[] B64(string s)
    {
        var t = s.Trim().Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }

    // .NET 沒有內建 CTR：用 AES-ECB 加密遞增計數器（大端序、從 0 開始）再 XOR
    private static byte[] AesCtr(byte[] key, byte[] data)
    {
        using var aes = Aes.Create();
        aes.Key = key;
        var output = new byte[data.Length];
        var counter = new byte[16];
        for (int off = 0; off < data.Length; off += 16)
        {
            var ks = aes.EncryptEcb(counter, PaddingMode.None);
            for (int i = 0; i < 16 && off + i < data.Length; i++) output[off + i] = (byte)(data[off + i] ^ ks[i]);
            for (int i = 15; i >= 0 && ++counter[i] == 0; i--) { }
        }
        return output;
    }
}
