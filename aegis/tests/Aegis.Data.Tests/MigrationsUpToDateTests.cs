using Aegis.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Aegis.Data.Tests;

public class MigrationsUpToDateTests
{
    // 改了實體 / OnModelCreating 卻忘了 dotnet ef migrations add → 正式環境的資料表和程式對不上。這裡直接擋。
    [Fact]
    public void Migrations快照與目前的模型一致()
    {
        using var db = new AegisDesignTimeFactory().CreateDbContext([]);
        var snapshot = db.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;
        Assert.NotNull(snapshot);
        if (snapshot is IMutableModel mutable) snapshot = mutable.FinalizeModel();
        snapshot = db.GetService<IModelRuntimeInitializer>().Initialize(snapshot);
        var diff = db.GetService<IMigrationsModelDiffer>()
                     .GetDifferences(snapshot.GetRelationalModel(), db.GetService<IDesignTimeModel>().Model.GetRelationalModel());
        Assert.True(diff.Count == 0, "模型有變更但沒有對應的 migration：" + string.Join("；", diff.Select(d => d.GetType().Name)) +
                                     "\n請執行 dotnet tool run dotnet-ef migrations add <名稱> -p src/Aegis.Data -s src/Aegis.Data -o Migrations");
    }

    [Fact]
    public void 初始Migration建立兩個檢視表()
    {
        using var db = new AegisDesignTimeFactory().CreateDbContext([]);
        var sql = db.GetService<IMigrator>().GenerateScript();
        Assert.Contains("CREATE VIEW vStaffPublic", sql);
        Assert.Contains("CREATE VIEW vSchedulePublic", sql);
        Assert.Contains("rowversion", sql);
    }
}
