using System.Diagnostics;
using Aegis.Security;
using Xunit;

namespace Aegis.Security.Tests;

public sealed class FirebaseScryptTests
{
    // github.com/firebase/scrypt README 的公開範例（Firebase 官方提供的對照值）
    private static readonly FirebaseHashParams Readme = new(
        "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==", "Bw==", 8, 14);

    [Fact]
    public void Firebase官方範例()
    {
        const string expected = "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==";
        Assert.Equal(expected, FirebaseScrypt.Hash("user1password", "42xEC+ixf3L2lw==", Readme));
        Assert.True(FirebaseScrypt.Verify("user1password", "42xEC+ixf3L2lw==", expected, Readme));
        Assert.False(FirebaseScrypt.Verify("user1passworD", "42xEC+ixf3L2lw==", expected, Readme));
    }

    [Fact]
    public void 與Node獨立實作相同()   // Node：crypto.scryptSync + aes-256-ctr（不經過 C# 的任何程式碼）
    {
        const string js = """
            const c=require('crypto');const [pw,salt,key,sep,r,m]=process.argv.slice(1);
            const d=c.scryptSync(Buffer.from(pw,'utf8'),Buffer.concat([Buffer.from(salt,'base64'),Buffer.from(sep,'base64')]),64,{N:2**+m,r:+r,p:1,maxmem:256*1024*1024});
            const ci=c.createCipheriv('aes-256-ctr',d.subarray(0,32),Buffer.alloc(16,0));
            process.stdout.write(Buffer.concat([ci.update(Buffer.from(key,'base64')),ci.final()]).toString('base64'));
            """;
        foreach (var (pw, salt) in new[] { ("n00112345666", "c2FsdHNhbHQxMjM0"), ("密碼🙂", "AAAAAAAAAAAAAA=="), ("", "42xEC+ixf3L2lw==") })
        {
            var psi = new ProcessStartInfo("node") { RedirectStandardOutput = true };
            foreach (var a in new[] { "-e", js, pw, salt, Readme.SignerKeyB64, Readme.SaltSeparatorB64, "8", "14" }) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            string node = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            Assert.Equal(node, FirebaseScrypt.Hash(pw, salt, Readme));
        }
    }
}
