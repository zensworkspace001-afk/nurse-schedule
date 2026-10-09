namespace Aegis.Engine;

// = cpsat_service.py 的 GEN_WEIGHTS / GEN_PROBLEM_KW（與使用者確認過的優先序）
//   資深 30 > 預假 20 > 整月混 2 種班 6（3 種 18）> 逆向輪班 3 > 孤立休 2 > 夜班 / 週末 0.3
public static class GenerationProfile
{
    public static FeatureWeights Weights { get; } = new(new Dictionary<SoftFeature, double>
    {
        [SoftFeature.WishHighMiss] = 20.0, [SoftFeature.WishNormalMiss] = 1.0, [SoftFeature.Nights] = 0.3,
        [SoftFeature.IsolatedOff] = 2.0, [SoftFeature.WeekendWork] = 0.3, [SoftFeature.ShiftSwitch] = 1.0,
        [SoftFeature.Streak6] = 1.0,
    });

    public const double Mix2Weight = 6.0, Mix3Weight = 18.0, BackwardWeight = 3.0, SeniorWeight = 30.0;

    // = cpsat_service._problem：排班用的 Problem（預假放 high）
    public static ProblemDefinition ForGeneration(int year, int month, IReadOnlyList<StaffMember> staff, ShiftRequirement reqs,
                                                  IReadOnlyDictionary<string, IReadOnlyList<int>>? wishes0 = null) =>
        new(year, month, staff, reqs,
            staff.ToDictionary(s => s.StaffId, s => new WishSet(
                new HashSet<int>(wishes0 != null && wishes0.TryGetValue(s.StaffId, out var w) ? w : Array.Empty<int>()),
                new HashSet<int>())),
            Mix2Weight: Mix2Weight, Mix3Weight: Mix3Weight, BackwardWeight: BackwardWeight, SeniorWeight: SeniorWeight);
}
