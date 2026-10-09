namespace Aegis.Engine;

// = Python Problem.__post_init__ 之後的狀態：月曆、週、員工編號、每班上限都算好
public sealed class Problem
{
    public ProblemDefinition Def { get; }
    public int Year => Def.Year;
    public int Month => Def.Month;
    public IReadOnlyList<StaffMember> Staff => Def.Staff;
    public ShiftRequirement Reqs => Def.Reqs;
    public ShiftRequirement ReqsMax { get; }
    public MonthCalendar Calendar { get; }
    public int NumDays => Calendar.NumDays;
    public IReadOnlyList<(int Start, int End)> Weeks => Calendar.Weeks;
    public IReadOnlySet<int> Weekend => Calendar.Weekend;
    public IReadOnlyList<string> Ids { get; }

    public Problem(ProblemDefinition def)
    {
        Def = def;
        ReqsMax = def.ReqsMax ?? new ShiftRequirement(
            def.Reqs.D + EngineConstants.MaxOverstaff, def.Reqs.E + EngineConstants.MaxOverstaff,
            def.Reqs.N + EngineConstants.MaxOverstaff);
        Calendar = BuildCalendar(def.Year, def.Month);
        Ids = def.Staff.Select(s => s.StaffId).ToList();
    }

    // Python calendar.weekday：週一 = 0 … 週日 = 6
    public static int PyWeekday(int year, int month, int day) =>
        ((int)new DateTime(year, month, day).DayOfWeek + 6) % 7;

    public static MonthCalendar BuildCalendar(int year, int month)
    {
        int nd = DateTime.DaysInMonth(year, month);
        var weekend = new HashSet<int>(Enumerable.Range(0, nd).Where(d => PyWeekday(year, month, d + 1) >= 5));
        var weeks = new List<(int, int)>();
        int start = 0;
        for (int d = 0; d < nd; d++)
        {
            if (d > 0 && PyWeekday(year, month, d + 1) == 0)
            {
                weeks.Add((start, d - 1));
                start = d;
            }
        }
        weeks.Add((start, nd - 1));
        return new MonthCalendar(year, month, nd, weekend, weeks);
    }

    public WishSet WishesOf(string sid) => Def.Wishes.TryGetValue(sid, out var w) ? w : WishSet.Empty;

    public static bool IsProtected(StaffMember s) => s.IsPregnantOrNursing || s.LeaveStatus == "Student";

    public static bool IsSenior(StaffMember s) => s.IsLeader || EngineConstants.SeniorLevels.Contains(s.Level);

    public static int WeeklyCap(StaffMember s) => s.SpecialStatus == SpecialStatus.BiWeekly ? 6 : 5;   // 48h / 40h
}
