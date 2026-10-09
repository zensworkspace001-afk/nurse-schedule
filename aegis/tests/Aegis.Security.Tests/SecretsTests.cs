using Aegis.Security;

namespace Aegis.Security.Tests;

[Collection("env")]   // 會改行程的環境變數
public class SecretsTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("aegis-secrets-").FullName;
    private readonly string _origDir = Secrets.SecretsDir;
    public SecretsTests() => Secrets.SecretsDir = _dir;

    public void Dispose()
    {
        Secrets.SecretsDir = _origDir;
        foreach (var n in new[] { "AEGIS_T1", "AEGIS_T1_FILE" }) Environment.SetEnvironmentVariable(n, null);
        Directory.Delete(_dir, true);
    }

    [Fact]
    public void 依序_環境變數_FILE指定檔_DockerSecret_都沒有回null()
    {
        Assert.Null(Secrets.Get("AEGIS_T1"));

        File.WriteAllText(Path.Combine(_dir, "aegis_t1"), "from-secret\n");      // echo 寫進去的換行要去掉
        Assert.Equal("from-secret", Secrets.Get("AEGIS_T1"));

        var other = Path.Combine(_dir, "custom.txt");
        File.WriteAllText(other, "  from-file  ");
        Environment.SetEnvironmentVariable("AEGIS_T1_FILE", other);
        Assert.Equal("from-file", Secrets.Get("AEGIS_T1"));

        Environment.SetEnvironmentVariable("AEGIS_T1", "from-env");
        Assert.Equal("from-env", Secrets.Get("AEGIS_T1"));
    }

    [Fact]
    public void 空檔案視同沒有設定()
    {
        File.WriteAllText(Path.Combine(_dir, "aegis_t1"), "\n");
        Assert.Null(Secrets.Get("AEGIS_T1"));
    }
}
