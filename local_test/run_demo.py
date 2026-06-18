"""
本機測試 runner — 一次跑完 SA 排班、法遵檢查、健康度計算，印出綜合報告。

使用方式：
  python local_test/run_demo.py                          # 用預設樣本
  python local_test/run_demo.py --year 2026 --month 6
  python local_test/run_demo.py --d 4 --e 3 --n 2 --iters 30000
  python local_test/run_demo.py --seed 42                # 固定種子可重現

報告分三段：
  1. SA 內部統計（罰分、迭代、退火接受率）
  2. JS 端法遵規則對齊檢查（找出 SA 沒抓到的違規）
  3. 個人健康度（與 PublishPanel 計算邏輯一致）
"""

import argparse
import sys
import os
import io
import calendar
from collections import defaultdict

# Windows console 預設 cp950 / cp1252 無法輸出 emoji 與部分中文 → 強制 UTF-8
# 必須在任何 print 之前執行
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# 確保跑 python local_test/run_demo.py 也能 import 同資料夾的模組
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scheduler import run_sa
from compliance import check_labor_law_compliance, summarize_violations
from health import calculate_team_health


# ============================================================
# 樣本員工資料（10 人；含 1 孕婦、1 實習生、1 雙週彈性）
# ============================================================
SAMPLE_STAFF = [
    {"staff_id": "N001", "name": "N001", "tenure_years": 5,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N002", "name": "N002", "tenure_years": 3,  "special_status": "Standard", "is_pregnant_or_nursing": True,  "leave_status": "None"},  # 孕婦
    {"staff_id": "N003", "name": "N003", "tenure_years": 8,  "special_status": "BiWeekly", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N004", "name": "N004", "tenure_years": 2,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N005", "name": "N005", "tenure_years": 10, "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N006", "name": "N006", "tenure_years": 1,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N007", "name": "N007", "tenure_years": 6,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N008", "name": "N008", "tenure_years": 4,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N009", "name": "N009", "tenure_years": 0,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "Student"},  # 實習生
    {"staff_id": "N010", "name": "N010", "tenure_years": 7,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N011", "name": "N011", "tenure_years": 4,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N012", "name": "N012", "tenure_years": 2,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N013", "name": "N013", "tenure_years": 6,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N014", "name": "N014", "tenure_years": 3,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
]


# ============================================================
# Pretty-print helpers
# ============================================================
def _hr(title=""):
    bar = "=" * 70
    if title:
        return f"\n{bar}\n{title}\n{bar}"
    return bar


def _print_schedule_grid(schedule_list, nurses, num_days):
    """以表格印出班表（每行一位員工，每天一格）"""
    by_nurse = defaultdict(dict)
    for cell in schedule_list:
        day = int(cell["date"].split("-")[2])
        by_nurse[cell["nurse_id"]][day] = cell["shift"]

    # 表頭
    header = "員工     " + " ".join(f"{d:>2}" for d in range(1, num_days + 1))
    print(header)
    print("-" * len(header))

    for nid in nurses:
        row = f"{nid:<8} " + " ".join(
            f"{by_nurse[nid].get(d, '?'):>2}" for d in range(1, num_days + 1)
        )
        print(row)


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="SA 排班 + 法遵 + 健康度 本機測試")
    parser.add_argument("--year",  type=int, default=2026)
    parser.add_argument("--month", type=int, default=5)
    parser.add_argument("--d", type=int, default=3, help="每日 D 班需求人數")
    parser.add_argument("--e", type=int, default=2, help="每日 E 班需求人數")
    parser.add_argument("--n", type=int, default=2, help="每日 N 班需求人數")
    parser.add_argument("--iters", type=int, default=10000, help="SA 最大迭代次數")
    parser.add_argument("--seed",  type=int, default=None, help="固定隨機種子（可重現）")
    parser.add_argument("--no-grid", action="store_true", help="不要印整月班表表格")
    args = parser.parse_args()

    nurses = [s["staff_id"] for s in SAMPLE_STAFF]
    protected_indices = [
        i for i, s in enumerate(SAMPLE_STAFF)
        if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"
    ]
    daily_reqs = {1: args.d, 2: args.e, 3: args.n}

    print(_hr(f"🧪 本機測試 — {args.year}/{args.month} | {len(nurses)} 名員工"))
    print(f"班別需求：D={args.d}  E={args.e}  N={args.n}  (每日總計 {args.d + args.e + args.n} 人)")
    print(f"保護名單 ({len(protected_indices)} 人，禁排 E/N)：")
    for i in protected_indices:
        s = SAMPLE_STAFF[i]
        reason = "孕/哺乳" if s["is_pregnant_or_nursing"] else "實習生"
        print(f"  • [{i}] {s['staff_id']} {s['name']} ({reason})")
    if args.seed is not None:
        print(f"隨機種子：{args.seed}")

    # ============================================================
    # 1. 跑 SA
    # ============================================================
    print(_hr("1️⃣  執行 SA 排班"))
    try:
        result = run_sa(
            year=args.year, month=args.month,
            nurses=nurses, protected_indices=protected_indices,
            daily_reqs=daily_reqs, custom_rules=[],
            max_iterations=args.iters, seed=args.seed,
        )
    except ValueError as e:
        print(f"❌ Pre-flight 攔截：{e}")
        return 1

    stats = result["stats"]
    icon = "✅" if stats["final_penalty"] == 0 else "⚠️"
    print(f"{icon} 求解狀態：{result['solver_status']}")
    print(f"   耗時：{result['elapsed_seconds']}s")
    print(f"   最終罰分：{stats['final_penalty']} (0 = 完美)")
    print(f"   ├─ 硬約束（禁止模式）：{stats.get('hard_penalty', '?')}（0 = 全員合法）")
    print(f"   └─ 軟約束（不理想模式）：{stats.get('soft_penalty', '?')}")
    if stats.get("feasibility_reached"):
        print(f"   可行性階段在第 {stats.get('feasibility_iteration')} 次迭代達成（硬約束歸零）→ 進入優化階段")
    else:
        print(f"   ⚠️ 未達可行性（仍有禁止模式）— 全程停留在可行性階段")
    print(f"   TLPS 模式分類（理想=法遵+健康）：理想 DP {stats.get('desirable_pattern_count', '?')} / "
          f"不理想 {stats.get('undesirable_pattern_count', '?')} / "
          f"禁止 {stats.get('prohibited_pattern_count', '?')}（共 {stats['num_nurses']} 人）"
          f"｜DP-polish {stats.get('dp_polish_iterations', 0)} 次")
    print(f"   最佳解出現在第 {stats['best_iteration']} / {stats['max_iterations']} 次迭代")
    print(f"   接受次優交換 {stats['accepted_worse_swaps']} 次 / 拒絕 {stats['rejected_swaps']} 次")
    if stats["violation_breakdown"]:
        print(f"   SA 內部殘留違規：")
        for k, v in stats["violation_breakdown"].items():
            print(f"     • {k}: {v} 處")
    else:
        print(f"   SA 內部殘留違規：無")

    # ============================================================
    # 班表表格（可選）
    # ============================================================
    if not args.no_grid:
        print(_hr("📅 整月班表"))
        _print_schedule_grid(result["schedule"], nurses, stats["num_days"])
        print()
        print("  圖例：D=白班  E=小夜  N=大夜  O=休假")

    # 把 schedule 轉成 compliance 期待的結構：{nurse_id: {day: shift}}
    schedule_dict = defaultdict(dict)
    for cell in result["schedule"]:
        day = int(cell["date"].split("-")[2])
        schedule_dict[cell["nurse_id"]][day] = cell["shift"]
    schedule_dict = dict(schedule_dict)

    # ============================================================
    # 2. 法遵檢查（與 JS 端對齊）
    # ============================================================
    print(_hr("2️⃣  法遵檢查（對齊前端 src/constants.js 規則）"))
    violations = check_labor_law_compliance(
        schedule_dict, SAMPLE_STAFF, args.year, args.month,
    )
    summary = summarize_violations(violations)
    if not violations:
        print("✅ 0 處違規 — 完全合規！")
    else:
        print(f"⚠️ 共 {len(violations)} 處違規")
        print("   按類型分布：")
        for vtype, count in sorted(summary.items(), key=lambda x: -x[1]):
            print(f"     • {vtype}: {count}")
        print()
        print(f"   前 10 筆細節：")
        for v in violations[:10]:
            print(f"     • [{v['staffName']:<8}] Day {v['day']}: {v['message']}")
        if len(violations) > 10:
            print(f"     ... 其餘 {len(violations) - 10} 筆省略")

    # ============================================================
    # 3. 健康度
    # ============================================================
    print(_hr("3️⃣  個人健康度（對齊 PublishPanel calculateHealthScore）"))
    health = calculate_team_health(schedule_dict, stats["num_days"])
    print(f"團隊平均：{health['team_avg']}  /  最低 {health['team_min']}  /  最高 {health['team_max']}")
    print(f"<75 分：{len(health['below_75'])} 人 {health['below_75'] or ''}")
    print(f"<90 分：{len(health['below_90'])} 人 {health['below_90'] or ''}")
    print()
    print("   每人分數：")
    name_map = {s["staff_id"]: s["name"] for s in SAMPLE_STAFF}
    for nid in nurses:
        h = health["per_staff"][nid]
        icon = "✅" if h["score"] >= 90 else "⚠️" if h["score"] >= 75 else "❌"
        print(f"     {icon} [{nid}] {name_map[nid]:<8} {h['score']:>3} 分", end="")
        if h["deductions"]:
            print(f"  扣分：{len(h['deductions'])} 項")
            for d in h["deductions"][:3]:
                print(f"           {d}")
            if len(h["deductions"]) > 3:
                print(f"           ...其餘 {len(h['deductions']) - 3} 項")
        else:
            print()

    # ============================================================
    # 總結
    # ============================================================
    print(_hr("📊 總結"))
    pass_sa = stats["final_penalty"] == 0
    pass_compliance = len(violations) == 0
    pass_health = health["team_min"] >= 75
    print(f"  SA 內部罰分為 0      : {'✅' if pass_sa else '❌ (penalty=' + str(stats['final_penalty']) + ')'}")
    print(f"  JS 端法遵 0 違規     : {'✅' if pass_compliance else '❌ (' + str(len(violations)) + ' 處)'}")
    print(f"  全員健康度 ≥ 75     : {'✅' if pass_health else '❌ (最低 ' + str(health['team_min']) + ' 分)'}")
    print()
    if pass_sa and pass_compliance and pass_health:
        print("  🎉 三項全過")
        return 0
    else:
        print("  💡 提示：SA 內部跟 JS 端規則不完全一致；")
        print("        SA 罰分 0 不代表 JS 法遵會過（例如 SA 沒檢查月例假 ≥4 等規則）")
        return 1


if __name__ == "__main__":
    sys.exit(main())
