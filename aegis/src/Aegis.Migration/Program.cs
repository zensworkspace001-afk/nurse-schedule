using Aegis.Data;
using Aegis.Migration;
using Aegis.Security;
using Microsoft.EntityFrameworkCore;

// 神盾計畫階段二 ETL
//   export      --out snapshot.json [--include-auth] [--project id]     可連網機器：Firestore → 快照（唯讀）
//   import      --in snapshot.json --provider sqlserver|sqlite --connection "<cs>" [--commit]   隔離網路：快照 → SQL
//               地端容器內可省略 --connection：以 Docker secret mssql_sa_password 連 db（--database 預設 Aegis），見 aegis/deploy/README.md
//   dryrun-live [--include-auth] [--project id]                         匯出 → 轉換 → 寫進記憶體 SQLite 再回滾，只印報告、不落地
// 金鑰：FIELD_ENC_KEY（+ FIELD_ENC_KEYS_PREVIOUS）環境變數或 Docker secret；匯入有明文個資時必須提供
var argv = args.ToList();
string? Arg(string name) { int i = argv.IndexOf(name); return i >= 0 && i + 1 < argv.Count ? argv[i + 1] : null; }
bool Flag(string name) => argv.Contains(name);
string project = Arg("--project") ?? "scheduling-systembachelor";

IFieldCrypto? CryptoFromEnv(bool allowEphemeral, out string? note)
{
    note = null;
    var key = Secrets.Get("FIELD_ENC_KEY");
    if (!string.IsNullOrWhiteSpace(key)) return new FieldCrypto(StaticFieldKeyProvider.FromEnvironment());
    if (!allowEphemeral) return null;
    note = "未提供 FIELD_ENC_KEY：試跑用一次性金鑰模擬明文個資的加密，正式匯入時必須提供正式金鑰";
    return new FieldCrypto(new StaticFieldKeyProvider(Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))));
}

try
{
    switch (argv.FirstOrDefault())
    {
        case "export":
        {
            var outPath = Arg("--out") ?? throw new ArgumentException("缺少 --out");
            var snap = await new FirestoreRestExporter(project, FirestoreRestExporter.GcloudToken()).ExportAsync(Flag("--include-auth"));
            await SnapshotFile.SaveAsync(snap, outPath);
            Console.WriteLine($"已匯出 {snap.Collections.Sum(c => c.Value.Count)} 份文件、{snap.AuthUsers?.Count ?? 0} 個登入帳號 → {outPath}（含 .sha256）");
            Console.WriteLine("⚠ 快照含加密個資與（若 --include-auth）密碼雜湊：請以加密隨身碟搬運，匯入後銷毀");
            break;
        }
        case "import":
        {
            var snap = await SnapshotFile.LoadAsync(Arg("--in") ?? throw new ArgumentException("缺少 --in"));
            var crypto = CryptoFromEnv(allowEphemeral: false, out _);
            var opts = new DbContextOptionsBuilder<AegisDbContext>();
            bool sqlite = Arg("--provider") == "sqlite";
            string cs = Arg("--connection") ?? (sqlite ? throw new ArgumentException("缺少 --connection")
                : AegisDatabase.SqlServerConnection(Environment.GetEnvironmentVariable("AEGIS_DB_HOST") ?? "db", Arg("--database") ?? "Aegis", "sa",
                                                    Secrets.Get("MSSQL_SA_PASSWORD") ?? throw new ArgumentException("缺少 --connection（或 Docker secret mssql_sa_password）")));
            if (sqlite) opts.UseSqlite(cs); else opts.UseSqlServer(cs);
            await using var db = new AegisDbContext(opts.Options);
            var plan = new SnapshotTransformer(crypto).Transform(snap, new MigrationOptions());
            var report = await new MigrationLoader(db, crypto).LoadAsync(plan, Flag("--commit"));
            Console.WriteLine(report);
            return report.CountsMatch && report.UndecryptableFields.Count == 0 ? 0 : 2;
        }
        case "dryrun-live":
        {
            var snap = await new FirestoreRestExporter(project, FirestoreRestExporter.GcloudToken()).ExportAsync(Flag("--include-auth"));
            var crypto = CryptoFromEnv(allowEphemeral: true, out var note);
            await using var conn = new Microsoft.Data.Sqlite.SqliteConnection("DataSource=:memory:");
            await conn.OpenAsync();
            await using var db = new AegisDbContext(new DbContextOptionsBuilder<AegisDbContext>().UseSqlite(conn).Options);
            var plan = new SnapshotTransformer(crypto).Transform(snap, new MigrationOptions());
            var report = await new MigrationLoader(db, note == null ? crypto : null).LoadAsync(plan, commit: false);
            if (note != null) Console.WriteLine($"— {note}");
            Console.WriteLine(report);
            if (snap.AuthUsers != null)
                Console.WriteLine($"登入帳號 {snap.AuthUsers.Count} 個（有密碼雜湊 {snap.AuthUsers.Count(u => u.PasswordHash != null)}），" +
                                  $"雜湊演算法 {snap.AuthHashConfig?.Algorithm ?? "未取得"}（rounds {snap.AuthHashConfig?.Rounds}、memoryCost {snap.AuthHashConfig?.MemoryCost}）");
            return report.CountsMatch ? 0 : 2;
        }
        case "check-password":   // 方案 A 驗收：用正式帳號的 Firebase 雜湊驗證密碼（密碼從標準輸入讀，只印符不符合）
        {
            var uid = (Arg("--uid") ?? throw new ArgumentException("缺少 --uid")).ToUpperInvariant();
            var snap = await new FirestoreRestExporter(project, FirestoreRestExporter.GcloudToken()).ExportAuthOnlyAsync();
            var u = snap.AuthUsers!.FirstOrDefault(x => x.LocalId.Equals(uid, StringComparison.OrdinalIgnoreCase)
                                                    || (x.Email ?? "").Split('@')[0].Equals(uid, StringComparison.OrdinalIgnoreCase))   // admin 的 uid 是亂數
                    ?? throw new ArgumentException($"找不到帳號 {uid}");
            var cfg = snap.AuthHashConfig ?? throw new InvalidOperationException("沒有取得雜湊參數");
            var pw = Console.In.ReadLine() ?? "";
            bool ok = FirebaseScrypt.Verify(pw, u.Salt!, u.PasswordHash!, new FirebaseHashParams(cfg.SignerKey, cfg.SaltSeparator, cfg.Rounds, cfg.MemoryCost));
            Console.WriteLine(ok ? $"✓ {uid}：密碼與 Firebase 雜湊相符（遷移後可直接登入）" : $"✗ {uid}：不相符");
            return ok ? 0 : 3;
        }
        default:
            Console.WriteLine("用法：export --out <file> [--include-auth] | import --in <file> --provider sqlserver|sqlite --connection <cs> [--commit] | dryrun-live [--include-auth]");
            return 1;
    }
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"失敗：{ex.Message}");
    return 1;
}
