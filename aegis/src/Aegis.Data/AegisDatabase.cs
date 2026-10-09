using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Aegis.Data;

// 建立 / 升級資料庫結構（神盾計畫階段五）
//   SQL Server（正式）：EF Core Migrations（Migrations/ 資料夾），由一次性的 aegis-migrator 容器套用
//   SQLite（測試 / 開發）：EnsureCreated + 兩個檢視表 —— migrations 是 SQL Server 專屬的 DDL，不能套到 SQLite
public static partial class AegisDatabase
{
    public static async Task PrepareAsync(AegisDbContext db, CancellationToken ct = default)
    {
        if (db.Database.IsSqlServer()) { await db.Database.MigrateAsync(ct); return; }
        if (await db.Database.EnsureCreatedAsync(ct)) await Views.CreateAsync(db, ct);
    }

    // 地端連線字串：主機 / 資料庫 / 帳號來自設定，密碼來自 Docker secret。
    // 只在 compose 內部網路連線（SQL Server 沒有對外開 port），憑證是 SQL Server 自簽的 → TrustServerCertificate
    public static string SqlServerConnection(string host, string database, string user, string password) => new SqlConnectionStringBuilder
    {
        DataSource = host, InitialCatalog = database, UserID = user, Password = password,
        Encrypt = true, TrustServerCertificate = true, ApplicationName = "aegis", ConnectTimeout = 15,
    }.ConnectionString;

    // API 用的最小權限帳號：只有讀寫資料（db_datareader / db_datawriter），不能改結構；結構只由 migrator 以 sa 變更。
    // 重複執行安全：已存在就只更新密碼（換密碼 = 改 secret 後重跑 migrator）
    public static async Task EnsureAppLoginAsync(AegisDbContext db, string login, string password, CancellationToken ct = default)
    {
        if (!LoginName().IsMatch(login)) throw new ArgumentException($"帳號名稱只能是英數字與底線：{login}");
        if (string.IsNullOrEmpty(password)) throw new ArgumentException("缺少 API 資料庫帳號的密碼（Docker secret db_app_password）");
        // CREATE LOGIN 不收參數 → 動態 SQL；密碼用 REPLACE 跳脫單引號（QUOTENAME 超過 128 字會回 NULL，不能用）
        string sql = $"""
            -- EXEC(...) 的字串只能接變數與字面值（不能放 DB_NAME() 這類函式）→ 先組進 @sql 再 sp_executesql
            DECLARE @lit nvarchar(max) = N'N''' + REPLACE(@pw, N'''', N'''''') + N'''';
            DECLARE @sql nvarchar(max);
            IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'{login}')
                SET @sql = N'CREATE LOGIN [{login}] WITH PASSWORD = ' + @lit + N', CHECK_POLICY = ON, DEFAULT_DATABASE = ' + QUOTENAME(DB_NAME());
            ELSE
                SET @sql = N'ALTER LOGIN [{login}] WITH PASSWORD = ' + @lit;
            EXEC sp_executesql @sql;
            IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{login}')
                EXEC(N'CREATE USER [{login}] FOR LOGIN [{login}]');
            ELSE   -- 備份還原到另一台 SQL Server 後，資料庫使用者和新建的登入帳號 SID 不同（孤立使用者）→ 重新對應
                EXEC(N'ALTER USER [{login}] WITH LOGIN = [{login}]');
            ALTER ROLE db_datareader ADD MEMBER [{login}];
            ALTER ROLE db_datawriter ADD MEMBER [{login}];
            """;
        await db.Database.ExecuteSqlRawAsync(sql, [new SqlParameter("@pw", password)], ct);
    }

    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")]
    private static partial Regex LoginName();
}

// dotnet ef migrations add … 用：只產生 SQL Server 的模型，不會真的連線
public sealed class AegisDesignTimeFactory : IDesignTimeDbContextFactory<AegisDbContext>
{
    public AegisDbContext CreateDbContext(string[] args) => new(new DbContextOptionsBuilder<AegisDbContext>()
        .UseSqlServer("Server=design-time-only;Database=Aegis;TrustServerCertificate=True").Options);
}
