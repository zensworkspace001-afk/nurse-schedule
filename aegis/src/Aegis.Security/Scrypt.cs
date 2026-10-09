using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Aegis.Security;

// scrypt（RFC 7914）— .NET 沒有內建，地端又不能隨意拉第三方套件，所以自己實作。
// 只用在密碼歷史（api/_lib/passwordHistory.js）：Node crypto.scryptSync(plain, salt, 32)，
// 預設 N=16384、r=8、p=1；salt 是 16 bytes 隨機值的 hex 字串，Node 把「這個字串的 UTF-8 位元組」當 salt。
public static class Scrypt
{
    public static byte[] DeriveKey(byte[] password, byte[] salt, int N = 16384, int r = 8, int p = 1, int dkLen = 32)
    {
        if (N < 2 || (N & (N - 1)) != 0) throw new ArgumentException("N 必須是 2 的次方且大於 1", nameof(N));
        int blockLen = 128 * r;
        byte[] B = Rfc2898DeriveBytes.Pbkdf2(password, salt, 1, HashAlgorithmName.SHA256, p * blockLen);
        var X = new uint[32 * r];
        var V = new uint[32 * r * N];
        var T = new uint[32 * r];
        for (int i = 0; i < p; i++)
        {
            var span = B.AsSpan(i * blockLen, blockLen);
            for (int w = 0; w < X.Length; w++) X[w] = BinaryPrimitives.ReadUInt32LittleEndian(span[(w * 4)..]);
            ROMix(X, V, T, N, r);
            for (int w = 0; w < X.Length; w++) BinaryPrimitives.WriteUInt32LittleEndian(span[(w * 4)..], X[w]);
        }
        return Rfc2898DeriveBytes.Pbkdf2(password, B, 1, HashAlgorithmName.SHA256, dkLen);
    }

    // = passwordHistory.js scryptHash(plain, salt) → hex
    public static string HashHex(string plain, string salt) =>
        Convert.ToHexString(DeriveKey(Encoding.UTF8.GetBytes(plain), Encoding.UTF8.GetBytes(salt))).ToLowerInvariant();

    public static bool Verify(string plain, string salt, string hashHex) =>
        CryptographicOperations.FixedTimeEquals(Convert.FromHexString(HashHex(plain, salt)), Convert.FromHexString(hashHex));

    private static void ROMix(uint[] X, uint[] V, uint[] T, int N, int r)
    {
        int words = 32 * r;
        for (int i = 0; i < N; i++)
        {
            Array.Copy(X, 0, V, i * words, words);
            BlockMix(X, T, r);
        }
        for (int i = 0; i < N; i++)
        {
            int j = (int)(X[(2 * r - 1) * 16] & (uint)(N - 1));   // Integerify：最後一個 64-byte 區塊的第一個字
            for (int w = 0; w < words; w++) X[w] ^= V[j * words + w];
            BlockMix(X, T, r);
        }
    }

    // BlockMix_{Salsa20/8, r}：輸出依偶數 / 奇數區塊重新排列
    private static void BlockMix(uint[] B, uint[] Y, int r)
    {
        Span<uint> x = stackalloc uint[16];
        B.AsSpan((2 * r - 1) * 16, 16).CopyTo(x);
        for (int i = 0; i < 2 * r; i++)
        {
            for (int w = 0; w < 16; w++) x[w] ^= B[i * 16 + w];
            Salsa208(x);
            int dst = (i % 2 == 0 ? i / 2 : r + i / 2) * 16;
            x.CopyTo(Y.AsSpan(dst, 16));
        }
        Array.Copy(Y, B, 32 * r);
    }

    private static void Salsa208(Span<uint> b)
    {
        Span<uint> x = stackalloc uint[16];
        b.CopyTo(x);
        static uint R(uint a, int c) => BitOperations.RotateLeft(a, c);
        for (int i = 0; i < 8; i += 2)
        {
            x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
            x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
            x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
            x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
            x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
            x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
            x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
            x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
        }
        for (int i = 0; i < 16; i++) b[i] += x[i];
    }
}
