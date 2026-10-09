using System.Security.Cryptography;
using System.Text;

namespace Aegis.Security;

// 欄位級加密 — 與 Node 的 api/_lib/crypto.js 位元組相容（同一把 FIELD_ENC_KEY 加解密互通）
//   密文：AES-256-GCM，nonce 12 bytes、tag 16 bytes、v = 1、kid = sha256(金鑰) 前 8 碼 hex
//   明文：先包成 { t, v } JSON 信封（見 JsEnvelope），與 Node JSON.stringify 的輸出逐位元組相同

public sealed class EncryptedValue
{
    public byte[] Ciphertext { get; set; } = [];
    public byte[] Nonce { get; set; } = [];
    public byte[] Tag { get; set; } = [];
    public byte Version { get; set; } = 1;
    public string? KeyId { get; set; }

    // Firestore / Node 的 { ct, iv, tag, v, kid } 形狀（base64）
    public static EncryptedValue FromNode(string ct, string iv, string tag, int v, string? kid) => new()
    {
        Ciphertext = Convert.FromBase64String(ct), Nonce = Convert.FromBase64String(iv), Tag = Convert.FromBase64String(tag),
        Version = (byte)v, KeyId = string.IsNullOrEmpty(kid) ? null : kid,
    };
}

public sealed record FieldKey(string KeyId, byte[] Key)
{
    public static FieldKey FromBase64(string b64, string name)
    {
        var key = Convert.FromBase64String(b64.Trim());
        if (key.Length != 32) throw new CryptographicException($"{name} 長度錯誤：必須是 32 bytes (base64 解碼後)，目前 {key.Length} bytes");
        return new FieldKey(Fingerprint(key), key);
    }

    public static string Fingerprint(byte[] key) => Convert.ToHexString(SHA256.HashData(key))[..8].ToLowerInvariant();
}

public interface IFieldKeyProvider
{
    FieldKey Current { get; }
    IReadOnlyList<FieldKey> All { get; }   // [目前金鑰, ...舊金鑰]
}

// = Node 的 FIELD_ENC_KEY + FIELD_ENC_KEYS_PREVIOUS（逗號分隔）。地端由 Docker secret / 環境變數提供
public sealed class StaticFieldKeyProvider : IFieldKeyProvider
{
    public FieldKey Current { get; }
    public IReadOnlyList<FieldKey> All { get; }

    public StaticFieldKeyProvider(string currentB64, string? previousB64 = null)
    {
        if (string.IsNullOrWhiteSpace(currentB64)) throw new CryptographicException("FIELD_ENC_KEY 未設定（環境變數或 Docker secret field_enc_key），無法執行欄位加密");
        var ring = new List<FieldKey> { FieldKey.FromBase64(currentB64, "FIELD_ENC_KEY") };
        foreach (var old in (previousB64 ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var k = FieldKey.FromBase64(old, "FIELD_ENC_KEYS_PREVIOUS");
            if (ring.All(r => r.KeyId != k.KeyId)) ring.Add(k);
        }
        Current = ring[0];
        All = ring;
    }

    public static StaticFieldKeyProvider FromEnvironment() => new(Secrets.Get("FIELD_ENC_KEY") ?? "", Secrets.Get("FIELD_ENC_KEYS_PREVIOUS"));
}

public interface IFieldCrypto
{
    EncryptedValue Encrypt(FieldPlain value);
    FieldPlain Decrypt(EncryptedValue blob);
    string CurrentKeyId { get; }
}

public sealed class FieldCrypto(IFieldKeyProvider keys) : IFieldCrypto
{
    private const int NonceLen = 12, TagLen = 16, Version = 1;
    // 錯誤訊息與 Node 相同：前端 src/api/secureField.js 依這些字串顯示「舊金鑰、請重新輸入」
    public const string AuthFailedMessage = "Unsupported state or unable to authenticate data";

    public string CurrentKeyId => keys.Current.KeyId;

    public EncryptedValue Encrypt(FieldPlain value)
    {
        var key = keys.Current;
        var nonce = RandomNumberGenerator.GetBytes(NonceLen);
        var plain = Encoding.UTF8.GetBytes(JsEnvelope.Serialize(value));
        var ct = new byte[plain.Length];
        var tag = new byte[TagLen];
        using var gcm = new AesGcm(key.Key, TagLen);
        gcm.Encrypt(nonce, plain, ct, tag);
        return new EncryptedValue { Ciphertext = ct, Nonce = nonce, Tag = tag, Version = Version, KeyId = key.KeyId };
    }

    public FieldPlain Decrypt(EncryptedValue blob)
    {
        if (blob.Version != Version) throw new CryptographicException($"密文版本不相容：期望 v={Version}，實際 v={blob.Version}");
        if (blob.Nonce.Length != NonceLen) throw new CryptographicException("IV 長度錯誤");
        if (blob.Tag.Length != TagLen) throw new CryptographicException("Auth tag 長度錯誤");
        IEnumerable<FieldKey> candidates = keys.All;
        if (blob.KeyId is not null)
        {
            candidates = keys.All.Where(k => k.KeyId == blob.KeyId).ToList();
            if (!candidates.Any())
                throw new CryptographicException($"此資料是用金鑰 {blob.KeyId} 加密的，目前環境沒有這把金鑰（目前金鑰 {keys.Current.KeyId}）");
        }
        foreach (var k in candidates)   // 沒有 kid 的舊密文依序嘗試
        {
            var plain = new byte[blob.Ciphertext.Length];
            try
            {
                using var gcm = new AesGcm(k.Key, TagLen);
                gcm.Decrypt(blob.Nonce, blob.Ciphertext, blob.Tag, plain);
            }
            catch (AuthenticationTagMismatchException) { continue; }
            return JsEnvelope.Deserialize(Encoding.UTF8.GetString(plain));
        }
        throw new CryptographicException(AuthFailedMessage);
    }
}
