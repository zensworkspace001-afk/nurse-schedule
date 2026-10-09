using Google.OrTools.Sat;

namespace Aegis.Engine;

// 線性運算式 — 刻意不用 OR-Tools 的 LinearExpr。
// Python 版（ortools 9.15 cp_model）把每條線性約束「依變數編號排序、合併同一變數、丟掉係數 0、常數移到值域」；
// C# 的 LinearExpr 則照出現順序、保留係數 0。約束內的變數順序會影響求解器的搜尋路徑，
// 為了讓兩邊的 CpModelProto 完全相同（基準測試的前提），這裡照 Python 的規則自己產生 proto。
public sealed class LinExpr
{
    private readonly SortedDictionary<int, long> _terms = new();
    public long Constant { get; private set; }

    public static LinExpr Zero => new();
    public static LinExpr Const(long c) => new() { Constant = c };
    public static LinExpr Of(IntVar v) => Term(v, 1);
    public static LinExpr Term(IntVar v, long coeff) { var e = new LinExpr(); e.AddTerm(v.GetIndex(), coeff); return e; }

    public static LinExpr Sum(IEnumerable<LinExpr> parts)
    {
        var e = new LinExpr();
        foreach (var p in parts) e.AddInPlace(p, 1);
        return e;
    }

    public static LinExpr Sum(IEnumerable<IntVar> vars) => Sum(vars.Select(Of));

    public IReadOnlyList<KeyValuePair<int, long>> NonZeroTerms => _terms.Where(t => t.Value != 0).ToList();

    private void AddTerm(int index, long coeff)
    {
        _terms[index] = _terms.TryGetValue(index, out var c) ? c + coeff : coeff;
    }

    private void AddInPlace(LinExpr other, long mult)
    {
        foreach (var (i, c) in other._terms) AddTerm(i, c * mult);
        Constant += other.Constant * mult;
    }

    private LinExpr Clone() { var e = new LinExpr(); e.AddInPlace(this, 1); return e; }

    public static LinExpr operator +(LinExpr a, LinExpr b) { var e = a.Clone(); e.AddInPlace(b, 1); return e; }
    public static LinExpr operator -(LinExpr a, LinExpr b) { var e = a.Clone(); e.AddInPlace(b, -1); return e; }
    public static LinExpr operator +(LinExpr a, long c) { var e = a.Clone(); e.Constant += c; return e; }
    public static LinExpr operator -(LinExpr a, long c) { var e = a.Clone(); e.Constant -= c; return e; }
    public static LinExpr operator -(long c, LinExpr a) { var e = Const(c); e.AddInPlace(a, -1); return e; }
    public static LinExpr operator *(long k, LinExpr a) { var e = new LinExpr(); e.AddInPlace(a, k); return e; }
    public static LinExpr operator +(long c, LinExpr a) => a + c;
    public static implicit operator LinExpr(IntVar v) => Of(v);   // BoolVar 繼承 IntVar，一併適用
}

// 以 Python 的形狀把約束 / 目標 / 提示直接寫進 CpModelProto
public static class ProtoWriter
{
    // Python: m.add(lhs >= rhs) → expr = lhs - rhs，值域 [-const, INT64_MAX]
    public static ConstraintProto Ge(CpModel m, LinExpr lhs, LinExpr rhs) => Linear(m, lhs - rhs, Kind.Ge);
    public static ConstraintProto Ge(CpModel m, LinExpr lhs, long rhs) => Linear(m, lhs - rhs, Kind.Ge);
    public static ConstraintProto Le(CpModel m, LinExpr lhs, LinExpr rhs) => Linear(m, lhs - rhs, Kind.Le);
    public static ConstraintProto Le(CpModel m, LinExpr lhs, long rhs) => Linear(m, lhs - rhs, Kind.Le);
    public static ConstraintProto Eq(CpModel m, LinExpr lhs, long rhs) => Linear(m, lhs - rhs, Kind.Eq);

    private enum Kind { Ge, Le, Eq }

    private static ConstraintProto Linear(CpModel m, LinExpr e, Kind k)
    {
        var lin = new LinearConstraintProto();
        foreach (var (i, c) in e.NonZeroTerms) { lin.Vars.Add(i); lin.Coeffs.Add(c); }
        long b = -e.Constant;
        switch (k)
        {
            case Kind.Ge: lin.Domain.Add(b); lin.Domain.Add(long.MaxValue); break;
            case Kind.Le: lin.Domain.Add(long.MinValue); lin.Domain.Add(b); break;
            default: lin.Domain.Add(b); lin.Domain.Add(b); break;
        }
        var ct = new ConstraintProto { Linear = lin };
        m.Model.Constraints.Add(ct);
        return ct;
    }

    // Python: constraint.only_enforce_if(lit)
    public static void OnlyEnforceIf(ConstraintProto ct, BoolVar lit) => ct.EnforcementLiteral.Add(lit.GetIndex());

    // Python: m.add_exactly_one(lits)
    public static void ExactlyOne(CpModel m, IEnumerable<BoolVar> lits)
    {
        var bc = new BoolArgumentProto();
        bc.Literals.AddRange(lits.Select(l => l.GetIndex()));
        m.Model.Constraints.Add(new ConstraintProto { ExactlyOne = bc });
    }

    // Python: m.minimize(expr) → 取代原目標；變數排序、係數 0 丟掉、scaling_factor 1、常數放 offset
    public static void Minimize(CpModel m, LinExpr e)
    {
        var obj = new CpObjectiveProto { ScalingFactor = 1 };
        foreach (var (i, c) in e.NonZeroTerms) { obj.Vars.Add(i); obj.Coeffs.Add(c); }
        if (e.Constant != 0) obj.Offset = e.Constant;   // proto 的 offset 是 double
        m.Model.Objective = obj;
    }

    // Python: m.add_hint(v, value)（依呼叫順序附加）
    public static void AddHint(CpModel m, int varIndex, long value)
    {
        m.Model.SolutionHint ??= new PartialVariableAssignment();
        m.Model.SolutionHint.Vars.Add(varIndex);
        m.Model.SolutionHint.Values.Add(value);
    }

    // Python: m.clear_hints() → 整個 solution_hint 欄位清掉（不是留一個空訊息，否則 proto 不同）
    public static void ClearHints(CpModel m) => m.Model.SolutionHint = null;

    public static void AddAssumption(CpModel m, BoolVar lit) => m.Model.Assumptions.Add(lit.GetIndex());
    public static void ClearAssumptions(CpModel m) => m.Model.Assumptions.Clear();
}
