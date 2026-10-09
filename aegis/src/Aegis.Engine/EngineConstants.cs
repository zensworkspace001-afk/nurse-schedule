namespace Aegis.Engine;

// = model.py 模組層常數（數值與註解依據見 Python 原檔）
public static class EngineConstants
{
    public static readonly ShiftCode[] Shifts = { ShiftCode.D, ShiftCode.E, ShiftCode.N, ShiftCode.RG, ShiftCode.RC };
    public static readonly ShiftCode[] Work = { ShiftCode.D, ShiftCode.E, ShiftCode.N };
    public static readonly ShiftCode[] Rest = { ShiftCode.RG, ShiftCode.RC };
    public static readonly (ShiftCode A, ShiftCode B)[] Forbidden =
        { (ShiftCode.E, ShiftCode.D), (ShiftCode.N, ShiftCode.D), (ShiftCode.N, ShiftCode.E) };   // 輪班間隔 < 11h

    public const int MaxConsecWork = 6;      // 七休一（法定上限）
    public const int HealthConsecWork = 5;   // 健康上限
    public const int MaxRgGap = 6;           // 兩 RG 間最多 6 個工作日
    public const int MaxConsecN = 3;         // 連續大夜 ≤ 3
    public const int PostNightRest = 2;      // 大夜段結束後至少連休 2 天
    public const int MaxOverstaff = 2;
    public const int BackwardMaxGap = 4;
    public const int MinRg = 4;
    public const int MinRest = 8;            // RG + RC
    public const int MaxMonthWork = 27;
    public const int MinMonthWork = 20;

    public static readonly string[] SeniorLevels = { "N2", "N3", "N4" };

    public static int ShiftOrder(ShiftCode s) => s switch
    {
        ShiftCode.D => 0, ShiftCode.E => 1, ShiftCode.N => 2,
        _ => throw new ArgumentOutOfRangeException(nameof(s)),
    };

    public static bool IsWork(ShiftCode s) => s is ShiftCode.D or ShiftCode.E or ShiftCode.N;
    public static bool IsRest(ShiftCode s) => s is ShiftCode.RG or ShiftCode.RC;

    // Python round() 是「銀行家捨入」（.5 取偶數）— Math.Round 預設 MidpointRounding.ToEven 相同，不可改成 AwayFromZero
    public static long PyRound(double v) => (long)Math.Round(v, MidpointRounding.ToEven);

    // = int(round(w * 10))：權重放大 10 倍取整數
    public static long Scale10(double w) => PyRound(w * 10);
}
