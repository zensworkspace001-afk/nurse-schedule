using System.Text.Json;
using Aegis.Engine;
using Google.OrTools.Sat;

namespace Aegis.Engine.Baseline;

// 讀 aegis/baseline/golden/<case>/（由 aegis/baseline/make_golden.py 產生，不進 git）
public sealed class GoldenCase
{
    public required string Name { get; init; }
    public required string Dir { get; init; }
    public required JsonElement Case { get; init; }
    public required JsonElement Calls { get; init; }
    public required JsonElement Result { get; init; }

    public string Kind => Case.GetProperty("kind").GetString()!;
    public int Year => Case.GetProperty("year").GetInt32();
    public int Month => Case.GetProperty("month").GetInt32();
    public double TimeLimit => Case.GetProperty("time_limit").GetDouble();
    public ShiftRequirement Reqs
    {
        get { var r = Case.GetProperty("reqs"); return new(r.GetProperty("D").GetInt32(), r.GetProperty("E").GetInt32(), r.GetProperty("N").GetInt32()); }
    }

    public List<StaffMember> Staff => Case.GetProperty("staff").EnumerateArray().Select(s => new StaffMember(
        s.GetProperty("staff_id").GetString()!, s.GetProperty("name").GetString()!,
        s.GetProperty("special_status").GetString() == "BiWeekly" ? SpecialStatus.BiWeekly : SpecialStatus.Standard,
        s.GetProperty("is_pregnant_or_nursing").GetBoolean(), s.GetProperty("leave_status").GetString()!,
        s.GetProperty("level").GetString()!, s.GetProperty("is_leader").GetBoolean())).ToList();

    // 預假（1-indexed，保留 JSON 順序 = Python dict 順序）
    public List<KeyValuePair<string, IReadOnlyList<int>>> Wishes1 => Case.GetProperty("wishes").EnumerateObject()
        .Select(p => new KeyValuePair<string, IReadOnlyList<int>>(p.Name, p.Value.EnumerateArray().Select(d => d.GetInt32()).ToList()))
        .ToList();

    public CpModelProto PythonModel(int i) =>
        CpModelProto.Parser.ParseFrom(File.ReadAllBytes(Path.Combine(Dir, $"call_{i:00}.pb")));

    public static string Root
    {
        get
        {
            var env = Environment.GetEnvironmentVariable("AEGIS_GOLDEN");
            if (!string.IsNullOrEmpty(env)) return env;
            var d = new DirectoryInfo(AppContext.BaseDirectory);
            while (d != null && !File.Exists(Path.Combine(d.FullName, "Aegis.sln"))) d = d.Parent;
            return Path.Combine(d?.FullName ?? ".", "baseline", "golden");
        }
    }

    public static IEnumerable<string> Names() =>
        Directory.Exists(Root) ? Directory.GetDirectories(Root).Select(Path.GetFileName).OrderBy(n => n)! : Enumerable.Empty<string>();

    public static GoldenCase Load(string name)
    {
        var dir = Path.Combine(Root, name);
        JsonElement Read(string f) => JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, f))).RootElement;
        return new GoldenCase { Name = name, Dir = dir, Case = Read("case.json"), Calls = Read("calls.json"), Result = Read("result.json") };
    }
}

public sealed record CapturedSolve(CpModelProto Model, string Parameters, CpSolverResponse Response);

public sealed class RecordingObserver : ISolveObserver
{
    public List<CapturedSolve> Calls { get; } = new();
    public void OnSolved(CpModel model, string parameters, CpSolverResponse response) =>
        Calls.Add(new CapturedSolve(model.Model.Clone(), parameters, response.Clone()));
}
