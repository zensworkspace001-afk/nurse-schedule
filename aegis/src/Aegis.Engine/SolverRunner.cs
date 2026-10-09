using System.Globalization;
using Google.OrTools.Sat;

namespace Aegis.Engine;

// 每次 CpSolver.Solve 的紀錄點 — 基準測試用它擷取「送進求解器的模型」與結果，與 Python 黃金樣本逐次比對
public interface ISolveObserver
{
    void OnSolved(CpModel model, string parameters, CpSolverResponse response);
}

public sealed record SolveCall(CpSolverStatus Status, CpSolverResponse Response, double ElapsedForBudget)
{
    public bool HasSolution => Status is CpSolverStatus.Optimal or CpSolverStatus.Feasible;
    public long Value(IntVar v) => Response.Solution[v.GetIndex()];
    public double ObjectiveValue => Response.ObjectiveValue;
}

// 求解參數與時間計算的唯一出口。
//   Production — 與 Python 正式環境相同：max_time_in_seconds、num_workers、random_seed（有設才設），扣時間用 wall time
//   Baseline   — 與 aegis/baseline/make_golden.py 相同的轉換：num_workers 1、時限改為 max_deterministic_time、
//                max_time_in_seconds 1e9、扣時間用 deterministic_time → 同版本 OR-Tools 下結果完全可重現
public sealed class SolverRunner(DeterminismMode mode, ISolveObserver? observer = null)
{
    public SolveCall Solve(CpModel m, double timeLimit, int workers, int? seed)
    {
        string F(double v) => v.ToString("R", CultureInfo.InvariantCulture);
        string prm = mode == DeterminismMode.Baseline
            ? $"num_workers:1 max_deterministic_time:{F(timeLimit)} max_time_in_seconds:1e9"
            : $"max_time_in_seconds:{F(timeLimit)} num_workers:{workers}";
        if (seed is int s) prm += $" random_seed:{s}";
        var solver = new CpSolver { StringParameters = prm };
        var status = solver.Solve(m, null);
        var resp = solver.Response;
        observer?.OnSolved(m, prm, resp);
        // Baseline：決定性時間取到小數 6 位（與 make_golden.py 相同）— 回報值最後一個位元有雜訊，會被拿去扣下一階段的預算
        double spent = mode == DeterminismMode.Baseline ? Math.Round(resp.DeterministicTime, 6) : resp.WallTime;
        return new SolveCall(status, resp, spent);
    }

    public static string StatusName(CpSolverStatus s) => s switch
    {
        CpSolverStatus.Optimal => "OPTIMAL", CpSolverStatus.Feasible => "FEASIBLE",
        CpSolverStatus.Infeasible => "INFEASIBLE", CpSolverStatus.ModelInvalid => "MODEL_INVALID",
        _ => "UNKNOWN",
    };
}
