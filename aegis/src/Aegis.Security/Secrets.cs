namespace Aegis.Security;

// 機密值的來源（神盾計畫階段五）：依序
//   1. 環境變數 NAME（開發 / 測試 / CI）
//   2. 環境變數 NAME_FILE 指到的檔案
//   3. Docker secret：/run/secrets/<name 小寫>（docker compose 的 secrets: 掛載位置）
// 檔案內容會去掉頭尾空白（echo 寫進去常帶換行）。都沒有就回 null，由呼叫端決定要不要擋。
public static class Secrets
{
    public static string SecretsDir { get; set; } = "/run/secrets";

    public static string? Get(string name)
    {
        var env = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
        var path = Environment.GetEnvironmentVariable(name + "_FILE");
        if (string.IsNullOrWhiteSpace(path)) path = Path.Combine(SecretsDir, name.ToLowerInvariant());
        return File.Exists(path) ? NullIfEmpty(File.ReadAllText(path).Trim()) : null;
    }

    private static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;
}
