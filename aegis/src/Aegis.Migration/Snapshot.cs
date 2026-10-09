using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Aegis.Migration;

// Firestore 快照：在可連網的機器匯出（唯讀），以單一 JSON 檔 + SHA-256 帶進實體隔離網路再匯入。
// 文件欄位存成一般 JSON；Firestore 特有型別明確標記，避免和一般字串混淆：
//   timestamp → {"$ts": "ISO-8601"}，bytes → {"$bytes": "base64"}
public sealed class FirestoreSnapshot
{
    public string Project { get; set; } = "";
    public DateTimeOffset ExportedAt { get; set; }
    public Dictionary<string, List<SnapshotDoc>> Collections { get; set; } = new();   // key = 集合路徑，例如 "LeaveWishes/2026_10/entries"
    public Dictionary<string, int> SkippedCollections { get; set; } = new();          // 刻意不匯出的集合（舊認領流程等）與文件數
    public List<AuthUserRecord>? AuthUsers { get; set; }                              // 方案 A：Firebase 密碼雜湊（--include-auth 才有）
    public FirebaseHashConfig? AuthHashConfig { get; set; }

    public List<SnapshotDoc> Docs(string path) => Collections.TryGetValue(path, out var d) ? d : [];
    public SnapshotDoc? Doc(string path, string id) => Docs(path).FirstOrDefault(d => d.Id == id);
}

public sealed record SnapshotDoc(string Id, JsonObject Fields);

// = identitytoolkit accounts:batchGet 的使用者（只留遷移需要的欄位）
public sealed record AuthUserRecord(string LocalId, string? Email, bool Disabled, string? PasswordHash, string? Salt,
                                    string? CustomAttributes, DateTimeOffset? CreatedAt);

// = Identity Platform config.signIn.hashConfig（Firebase 改良版 scrypt 的參數；驗證舊密碼要用）
public sealed record FirebaseHashConfig(string Algorithm, string SignerKey, string SaltSeparator, int Rounds, int MemoryCost);

public static class SnapshotFile
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    // 寫入 snapshot.json 與 snapshot.json.sha256（帶進隔離網路後先驗雜湊再匯入）
    public static async Task SaveAsync(FirestoreSnapshot s, string path, CancellationToken ct = default)
    {
        await using (var fs = File.Create(path)) await JsonSerializer.SerializeAsync(fs, s, Json, ct);
        await File.WriteAllTextAsync(path + ".sha256", $"{Sha256Of(path)}  {Path.GetFileName(path)}\n", ct);
    }

    public static async Task<FirestoreSnapshot> LoadAsync(string path, CancellationToken ct = default)
    {
        var sumFile = path + ".sha256";
        if (!File.Exists(sumFile)) throw new InvalidDataException($"找不到 {sumFile}：快照必須附 SHA-256 檔才能匯入");
        var expected = (await File.ReadAllTextAsync(sumFile, ct)).Split(' ', 2)[0].Trim();
        var actual = Sha256Of(path);
        if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"快照 SHA-256 不符（檔案在搬運途中被改動或損毀）：預期 {expected}，實際 {actual}");
        await using var fs = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<FirestoreSnapshot>(fs, Json, ct) ?? throw new InvalidDataException("快照是空的");
    }

    private static string Sha256Of(string path)
    {
        using var fs = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(fs)).ToLowerInvariant();
    }
}

// Firestore REST 的型別值 → 一般 JSON
public static class FirestoreValues
{
    public static JsonObject Fields(JsonElement fields)
    {
        var o = new JsonObject();
        if (fields.ValueKind == JsonValueKind.Object)
            foreach (var p in fields.EnumerateObject()) o[p.Name] = Value(p.Value);
        return o;
    }

    public static JsonNode? Value(JsonElement v)
    {
        var p = v.EnumerateObject().First();
        return p.Name switch
        {
            "nullValue" => null,
            "booleanValue" => JsonValue.Create(p.Value.GetBoolean()),
            "integerValue" => JsonValue.Create(long.Parse(p.Value.GetString()!)),   // REST 用字串表示 int64
            "doubleValue" => JsonValue.Create(p.Value.GetDouble()),
            "stringValue" => JsonValue.Create(p.Value.GetString()),
            "timestampValue" => new JsonObject { ["$ts"] = p.Value.GetString() },
            "bytesValue" => new JsonObject { ["$bytes"] = p.Value.GetString() },
            "referenceValue" => JsonValue.Create(p.Value.GetString()),
            "geoPointValue" => JsonNode.Parse(p.Value.GetRawText()),
            "mapValue" => p.Value.TryGetProperty("fields", out var f) ? Fields(f) : new JsonObject(),
            "arrayValue" => new JsonArray((p.Value.TryGetProperty("values", out var a) ? a.EnumerateArray().Select(Value) : []).ToArray()),
            _ => throw new InvalidDataException($"不認得的 Firestore 型別：{p.Name}"),
        };
    }
}
