using Aegis.Engine;

namespace Aegis.Scheduling;

public static class Eligibility
{
    // = cpsat_service.eligible_staff：在職、且不是產假 / 長假；缺欄位套預設值
    public static List<StaffMember> EligibleStaff(IEnumerable<StaffRow> rows)
    {
        var outList = new List<StaffMember>();
        foreach (var s in rows)
        {
            if (s.IsActive == false) continue;
            if (s.LeaveStatus is "Maternal" or "OnLeave") continue;
            if (string.IsNullOrEmpty(s.StaffId)) continue;
            outList.Add(new StaffMember(
                s.StaffId, s.Name ?? s.StaffId,
                s.SpecialStatus == "BiWeekly" ? SpecialStatus.BiWeekly : SpecialStatus.Standard,
                s.IsPregnantOrNursing == true, s.LeaveStatus ?? "None", s.Level ?? "N0", s.IsLeader == true));
        }
        return outList;
    }

    // = cpsat_service._reqs
    public static ShiftRequirement ValidateReqs(ShiftRequirement? r)
    {
        if (r is null) throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, "每日人力需求格式錯誤，需要 {D, E, N}");
        if (Math.Min(r.D, Math.Min(r.E, r.N)) < 0 || r.Total == 0)
            throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, "每日人力需求不可為負，且總和需大於 0");
        return r;
    }

    public static bool IsProtectedRaw(StaffMember s) => s.IsPregnantOrNursing || s.LeaveStatus == "Student";
}
