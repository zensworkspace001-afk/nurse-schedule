using Aegis.Data;
using Microsoft.Data.Sqlite;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Tests.Shared;

// 測試用資料庫（Data / Migration / Api 三個測試專案共用，以連結檔加入）
//   預設：SQLite 記憶體資料庫（EnsureCreated + 檢視表），本機不用裝 SQL Server
//   設了 AEGIS_TEST_SQLSERVER（sa 連線字串）：在真的 SQL Server 上開一個用完即丟的資料庫，
//     走正式的 EF Core Migrations —— rowversion、檢視表、N'…' 字串、交易隔離都照正式環境驗（CI 的 aegis-deploy job）
public sealed class TestDatabase : IDisposable
{
    public static string? SqlServer => Environment.GetEnvironmentVariable("AEGIS_TEST_SQLSERVER") is { Length: > 0 } s ? s : null;

    private readonly SqliteConnection? _sqlite;
    public string ConnectionString { get; }
    public bool IsSqlServer => _sqlite == null;
    public string Provider => IsSqlServer ? "SqlServer" : "Sqlite";

    // sharedCache：Api 測試的 WebApplicationFactory 會自己開連線，要用具名的共享記憶體資料庫
    public TestDatabase(bool sharedCache = false)
    {
        if (SqlServer is { } baseCs)
            ConnectionString = new SqlConnectionStringBuilder(baseCs) { InitialCatalog = $"aegis_test_{Guid.NewGuid():N}" }.ConnectionString;
        else
        {
            ConnectionString = sharedCache ? $"DataSource=file:aegis-{Guid.NewGuid():N}?mode=memory&cache=shared" : "DataSource=:memory:";
            _sqlite = new SqliteConnection(ConnectionString);
            _sqlite.Open();   // 記憶體資料庫在最後一條連線關閉時消失 → 測試期間一直開著
        }
        using var db = New();
        AegisDatabase.PrepareAsync(db).GetAwaiter().GetResult();
    }

    public DbContextOptions<AegisDbContext> Options => IsSqlServer
        ? new DbContextOptionsBuilder<AegisDbContext>().UseSqlServer(ConnectionString).Options
        : new DbContextOptionsBuilder<AegisDbContext>().UseSqlite(_sqlite!).Options;

    public AegisDbContext New() => new(Options);

    public void Dispose()
    {
        if (_sqlite != null) { _sqlite.Dispose(); return; }
        using var db = New();
        db.Database.EnsureDeleted();
    }
}
