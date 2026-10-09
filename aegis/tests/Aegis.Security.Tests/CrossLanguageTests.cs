using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Aegis.Security;
using Xunit;
using Xunit.Abstractions;

namespace Aegis.Security.Tests;

// 階段二：Node（api/_lib/crypto.js、passwordHistory.js）↔ C#（Aegis.Security）雙向對照。
// 向量由 aegis/baseline/crypto_vectors.mjs 在測試當下用 Node 產生（需要 node；不碰正式金鑰）。
public sealed class NodeVectors
{
    public static string RepoRoot
    {
        get
        {
            var d = new DirectoryInfo(AppContext.BaseDirectory);
            while (d != null && !File.Exists(Path.Combine(d.FullName, "Aegis.sln"))) d = d.Parent;
            return d!.Parent!.FullName;
        }
    }

    public JsonElement Root { get; }

    public NodeVectors()
    {
        var file = Path.Combine(Path.GetTempPath(), $"aegis-crypto-vectors-{Guid.NewGuid():N}.json");
        RunNode("generate", file);
        Root = JsonDocument.Parse(File.ReadAllText(file)).RootElement.Clone();
        File.Delete(file);
    }

    public static string RunNode(string mode, string file)
    {
        var psi = new ProcessStartInfo("node", $"aegis/baseline/crypto_vectors.mjs {mode} \"{file}\"")
        {
            WorkingDirectory = RepoRoot, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("找不到 node（這組測試需要 Node.js）");
        string stdout = p.StandardOutput.ReadToEnd();
        string stderr = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new InvalidOperationException($"node {mode} 失敗：{stderr}");
        return stdout;
    }

    public FieldCrypto Crypto() => new(new StaticFieldKeyProvider(
        Root.GetProperty("keys").GetProperty("current").GetString()!, Root.GetProperty("keys").GetProperty("previous").GetString()));

    public static EncryptedValue Blob(JsonElement b) => EncryptedValue.FromNode(
        b.GetProperty("ct").GetString()!, b.GetProperty("iv").GetString()!, b.GetProperty("tag").GetString()!,
        b.GetProperty("v").GetInt32(), b.TryGetProperty("kid", out var k) ? k.GetString() : null);

    public static FieldPlain ToPlain(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null => new FieldPlain.Null(),
        JsonValueKind.Number => new FieldPlain.Num(v.GetDouble()),
        JsonValueKind.True or JsonValueKind.False => new FieldPlain.Bool(v.GetBoolean()),
        JsonValueKind.String => new FieldPlain.Str(v.GetString()!),
        _ => new FieldPlain.Json(v.Clone()),
    };
}

public sealed class CrossLanguageTests(NodeVectors nv, ITestOutputHelper output) : IClassFixture<NodeVectors>
{
    [Fact]
    public void Node加密_CSharp解密_值與信封逐位元組相同()
    {
        var crypto = nv.Crypto();
        int i = 0;
        foreach (var item in nv.Root.GetProperty("plain").EnumerateArray())
        {
            var expected = NodeVectors.ToPlain(item.GetProperty("value"));
            var got = crypto.Decrypt(NodeVectors.Blob(item.GetProperty("blob")));
            string nodeEnvelope = item.GetProperty("envelope").GetString()!;
            Assert.Equal(nodeEnvelope, JsEnvelope.Serialize(got));        // 解出來的值重新序列化 = Node 的信封
            Assert.Equal(nodeEnvelope, JsEnvelope.Serialize(expected));   // C# 自己序列化同一個值 = Node 的信封
            output.WriteLine($"#{i++} ✓ {nodeEnvelope}");
        }
    }

    [Fact]
    public void 金鑰輪替_舊金鑰無kid與kid指向舊金鑰都解得開()
    {
        var crypto = nv.Crypto();
        foreach (var r in nv.Root.GetProperty("rotation").EnumerateArray())
        {
            var got = Assert.IsType<FieldPlain.Str>(crypto.Decrypt(NodeVectors.Blob(r.GetProperty("blob"))));
            Assert.Equal(r.GetProperty("value").GetString(), got.Value);
            output.WriteLine($"✓ {r.GetProperty("name").GetString()}");
        }
    }

    [Fact]
    public void 錯誤訊息與Node一字不差()
    {
        var crypto = nv.Crypto();
        foreach (var e in nv.Root.GetProperty("errors").EnumerateArray())
        {
            var ex = Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => crypto.Decrypt(NodeVectors.Blob(e.GetProperty("blob"))));
            Assert.Equal(e.GetProperty("error").GetString(), ex.Message);
            output.WriteLine($"✓ {e.GetProperty("name").GetString()}：{ex.Message}");
        }
    }

    [Fact]
    public void 數字格式與JSON_stringify逐字相同()
    {
        foreach (var x in nv.Root.GetProperty("numbers").EnumerateArray())
        {
            string expected = x.GetProperty("json").GetString()!;
            Assert.Equal(expected, JsEnvelope.Serialize(new FieldPlain.Num(x.GetProperty("x").GetDouble())));
            output.WriteLine($"✓ {expected}");
        }
    }

    [Fact]
    public void 金鑰指紋與Node相同()
    {
        var keys = nv.Root.GetProperty("keys");
        Assert.Equal(keys.GetProperty("currentKid").GetString(), FieldKey.FromBase64(keys.GetProperty("current").GetString()!, "a").KeyId);
        Assert.Equal(keys.GetProperty("previousKid").GetString(), FieldKey.FromBase64(keys.GetProperty("previous").GetString()!, "b").KeyId);
    }

    [Fact]
    public void CSharp加密_Node正式程式解得開()
    {
        var crypto = nv.Crypto();
        var values = nv.Root.GetProperty("plain").EnumerateArray().Select(p => NodeVectors.ToPlain(p.GetProperty("value"))).ToList();
        var blobs = values.Select(v => crypto.Encrypt(v)).ToList();
        var file = Path.Combine(Path.GetTempPath(), $"aegis-cs-blobs-{Guid.NewGuid():N}.json");
        File.WriteAllText(file, JsonSerializer.Serialize(blobs.Select(b => new
        {
            blob = new { ct = Convert.ToBase64String(b.Ciphertext), iv = Convert.ToBase64String(b.Nonce), tag = Convert.ToBase64String(b.Tag), v = (int)b.Version, kid = b.KeyId },
        })));
        var res = JsonDocument.Parse(NodeVectors.RunNode("decrypt", file)).RootElement.EnumerateArray().ToList();
        File.Delete(file);
        Assert.Equal(values.Count, res.Count);
        for (int i = 0; i < values.Count; i++)
        {
            Assert.True(res[i].GetProperty("ok").GetBoolean(), res[i].ToString());
            Assert.Equal(JsEnvelope.Serialize(values[i]), res[i].GetProperty("envelope").GetString());
            Assert.Equal(crypto.CurrentKeyId, blobs[i].KeyId);
        }
        output.WriteLine($"Node 解開 C# 產生的 {values.Count} 筆密文，信封全部逐位元組相同");
    }

    [Fact]
    public void Scrypt與Node密碼歷史雜湊相同()
    {
        foreach (var s in nv.Root.GetProperty("scrypt").EnumerateArray())
        {
            string plain = s.GetProperty("plain").GetString()!, salt = s.GetProperty("salt").GetString()!, hash = s.GetProperty("hash").GetString()!;
            Assert.Equal(hash, Scrypt.HashHex(plain, salt));
            Assert.True(Scrypt.Verify(plain, salt, hash));
            Assert.False(Scrypt.Verify(plain + "x", salt, hash));
        }
    }
}

// RFC 7914 §12 官方測試向量 — 不依賴 Node，獨立證明 scrypt 實作正確
public sealed class ScryptRfcTests
{
    [Theory]
    [InlineData("", "", 16, 1, 1, 64,
        "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906")]
    [InlineData("password", "NaCl", 1024, 8, 16, 64,
        "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640")]
    public void RFC7914(string password, string salt, int N, int r, int p, int dkLen, string expectedHex)
    {
        var dk = Scrypt.DeriveKey(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(salt), N, r, p, dkLen);
        Assert.Equal(expectedHex, Convert.ToHexString(dk).ToLowerInvariant());
    }
}
