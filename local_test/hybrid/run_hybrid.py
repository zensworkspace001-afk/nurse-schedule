"""
CP-SAT × SA 混合排班 + 權重自動學習 — 多月模擬 runner

    pip install -r local_test/requirements.txt          # 需要 ortools（numpy 隨附）
    python local_test/hybrid/run_hybrid.py               # 預設：2026/5 起 4 個月、D3 E2 N2
    python local_test/hybrid/run_hybrid.py --months 6 --time 15 --seed 7
    python local_test/hybrid/run_hybrid.py --compare-sa  # 第一個月加跑現有 SA 對照

每個月：
  1. 每位護理師用點數制提出休假志願（3 個高優先 + 5 個一般；週末/連假較熱門 → 必然有人被犧牲）
  2. CP-SAT 求「硬約束 0」的班表，軟約束依目前權重 W 與個人補償乘數 m 取捨
  3. SA 在可行域內打磨
  4. compliance.py 獨立驗證法遵、health.py 算健康度
  5. 模擬滿意度回饋 → 重新學習 W、更新補償乘數 m → 下個月用

同時跑一條「固定權重（全 1、無補償）」的對照組，同樣的志願、同樣的隱藏偏好，
用來看「學習」到底有沒有帶來差別。
"""

import argparse
import calendar
import io
import os
import random
import statistics
import sys
from collections import defaultdict

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

from model import (Problem, FEATURES, FEATURE_LABELS, WORK, solve_cpsat, sa_polish,  # noqa: E402
                   features, hard_violations, coverage_ok)
from learning import (PRIOR, WeightLearner, compensation_multipliers, make_true_preferences,  # noqa: E402
                      simulate_feedback, true_satisfaction)
from compliance import check_labor_law_compliance  # noqa: E402
from health import calculate_team_health  # noqa: E402
from run_demo import SAMPLE_STAFF  # noqa: E402


def generate_wishes(staff_ids, year, month, seed, n_high=3, n_normal=5):
    """點數制：每人固定 n_high 個高優先 + n_normal 個一般休假志願；週末 ×3、隨機一個「連假」×6 熱度"""
    rng = random.Random(seed)
    _, nd = calendar.monthrange(year, month)
    hot = rng.randrange(nd)
    weight = [6 if d == hot else 3 if calendar.weekday(year, month, d + 1) >= 5 else 1 for d in range(nd)]
    wishes = {}
    for sid in staff_ids:
        picked = set()
        while len(picked) < n_high + n_normal:
            picked.add(rng.choices(range(nd), weights=weight)[0])
        order = list(picked)
        rng.shuffle(order)
        wishes[sid] = {"high": set(order[:n_high]), "normal": set(order[n_high:])}
    return wishes, hot


def next_month(y, m):
    return (y + 1, 1) if m == 12 else (y, m + 1)


def evaluate(prob, schedule, true_prefs):
    feats = {sid: features(schedule[sid], sid, prob) for sid in prob.ids}
    sats = true_satisfaction(feats, true_prefs)
    sched_dict = {sid: {d + 1: sh for d, sh in enumerate(schedule[sid])} for sid in prob.ids}
    viol = check_labor_law_compliance(sched_dict, prob.staff, prob.year, prob.month)
    health = calculate_team_health(sched_dict, prob.num_days)
    n_high = sum(len(prob.wishes[s]["high"]) for s in prob.ids)
    n_norm = sum(len(prob.wishes[s]["normal"]) for s in prob.ids)
    return {
        "feats": feats,
        "sats": sats,
        "avg": statistics.mean(sats.values()),
        "min": min(sats.values()),
        "std": statistics.pstdev(sats.values()),
        "high_hit": 1 - sum(f["wish_high_miss"] for f in feats.values()) / n_high,
        "norm_hit": 1 - sum(f["wish_normal_miss"] for f in feats.values()) / n_norm,
        "violations": len(viol),
        "health_min": health["team_min"],
    }


def run_month(prob, W, mult, args, seed):
    cp = solve_cpsat(prob, W, mult, args.fairness, time_limit=args.time, seed=seed)
    if cp["schedule"] is None:
        return None, cp, None
    pol = sa_polish(prob, cp["schedule"], W, mult, args.fairness, iters=args.polish_iters, seed=seed)
    sched = pol["schedule"]
    staff_by_id = {s["staff_id"]: s for s in prob.staff}
    assert coverage_ok(sched, prob), "polish 破壞了覆蓋（不應發生）"
    assert not any(hard_violations(sched[sid], staff_by_id[sid], prob) for sid in prob.ids), "polish 引入硬違規"
    return sched, cp, pol


def print_grid(prob, schedule):
    short = {"D": "D", "E": "E", "N": "N", "RG": "R", "RC": "r"}
    print("     " + "".join(f"{d + 1:>3}" for d in range(prob.num_days)))
    print("     " + "".join("  六" if d in prob.weekend and calendar.weekday(prob.year, prob.month, d + 1) == 5
                            else "  日" if d in prob.weekend else "   " for d in range(prob.num_days)))
    for sid in prob.ids:
        w = prob.wishes[sid]
        cells = []
        for d, sh in enumerate(schedule[sid]):
            mark = " "
            if d in w["high"] or d in w["normal"]:
                hit = sh not in WORK
                mark = ("★" if d in w["high"] else "☆") if hit else ("✗" if d in w["high"] else "x")
            cells.append(f"{short[sh]:>2}{mark}")
        print(f"{sid:<5}" + "".join(cells))
    print("  圖例：R=例假 r=休息日 ｜ ★/☆=高優先/一般志願已滿足  ✗/x=高優先/一般志願被犧牲")


def main():
    ap = argparse.ArgumentParser(description="CP-SAT × SA 混合排班 + 權重學習（多月模擬）")
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--month", type=int, default=5)
    ap.add_argument("--months", type=int, default=4)
    ap.add_argument("--d", type=int, default=3)
    ap.add_argument("--e", type=int, default=2)
    ap.add_argument("--n", type=int, default=2)
    ap.add_argument("--time", type=float, default=8.0, help="CP-SAT 每月時間上限（秒）")
    ap.add_argument("--polish-iters", type=int, default=20000)
    ap.add_argument("--fairness", type=float, default=2.0, help="λ：最不滿者的權重")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-ablation", action="store_true", help="不跑固定權重對照組")
    ap.add_argument("--compare-sa", action="store_true", help="第一個月加跑現有 SA（scheduler.run_sa）對照")
    ap.add_argument("--no-grid", action="store_true")
    args = ap.parse_args()

    ids = [s["staff_id"] for s in SAMPLE_STAFF]
    reqs = {"D": args.d, "E": args.e, "N": args.n}
    true_prefs = make_true_preferences(ids, seed=args.seed)

    pipelines = {"learned": {}, "fixed": {}} if not args.no_ablation else {"learned": {}}
    for p in pipelines.values():
        p.update(learner=WeightLearner(), W=dict(PRIOR), history=[], rows=[])

    print("=" * 96)
    print(f"🧪 CP-SAT × SA 混合排班 | {len(ids)} 人 | 每日 D{args.d} E{args.e} N{args.n} | "
          f"{args.months} 個月 | λ={args.fairness} | seed={args.seed}")
    print("=" * 96)

    y, m = args.year, args.month
    last = None
    for i in range(args.months):
        wishes, hot = generate_wishes(ids, y, m, seed=args.seed * 100 + i)
        prob = Problem(y, m, SAMPLE_STAFF, reqs, wishes)
        print(f"\n📅 {y}/{m}（熱門日：{hot + 1} 號）")
        for name, p in pipelines.items():
            if name == "learned":
                W, mult = p["W"], compensation_multipliers(p["history"]) or {s: 1.0 for s in ids}
            else:
                W, mult = dict(PRIOR), {s: 1.0 for s in ids}
            sched, cp, pol = run_month(prob, W, mult, args, seed=args.seed + i)
            if sched is None:
                print(f"  [{name:<7}] ❌ CP-SAT {cp['status']} — 硬約束無解（人力不足？）")
                return 1
            ev = evaluate(prob, sched, true_prefs)
            p["rows"].append(ev)
            improve = (pol["start_obj"] - pol["best_obj"]) / max(1e-9, pol["start_obj"]) * 100
            print(f"  [{name:<7}] CP-SAT {cp['status']:<8} {cp['elapsed']:>5}s gap {cp['gap']:>5.1%} │ "
                  f"SA polish −{improve:4.1f}% │ 法遵違規 {ev['violations']} │ 健康最低 {ev['health_min']} │ "
                  f"滿意度 平均 {ev['avg']:.2f} 最低 {ev['min']:.2f} σ {ev['std']:.2f} │ "
                  f"志願達成 高 {ev['high_hit']:.0%} 一般 {ev['norm_hit']:.0%}")
            if name == "learned":
                feedback = simulate_feedback(ev["feats"], true_prefs, seed=args.seed * 1000 + i)
                p["learner"].observe(ev["feats"], feedback)
                p["W"] = p["learner"].fit()
                p["history"].append({sid: 10 - s for sid, s in feedback.items()})
                if mult and max(mult.values()) != min(mult.values()):
                    top = sorted(mult.items(), key=lambda kv: -kv[1])[:3]
                    print(f"            補償乘數（上月被犧牲 → 本月優先）：" +
                          "、".join(f"{s}×{v:.2f}" for s, v in top))
                last = (prob, sched)

        if args.compare_sa and i == 0:
            from scheduler import run_sa
            prot = [k for k, s in enumerate(SAMPLE_STAFF) if prob.is_protected(s)]
            r = run_sa(year=y, month=m, nurses=ids, protected_indices=prot,
                       daily_reqs={1: args.d, 2: args.e, 3: args.n}, max_iterations=10000, seed=args.seed)
            sa_sched = {sid: ["RG"] * prob.num_days for sid in ids}
            for c in r["schedule"]:
                sh = c["shift"]
                sa_sched[c["nurse_id"]][int(c["date"].split("-")[2]) - 1] = sh if sh in ("D", "E", "N", "RC") else "RG"
            ev = evaluate(prob, sa_sched, true_prefs)
            print(f"  [現有 SA] {r['solver_status']:<8} {r['elapsed_seconds']:>5}s（不知道志願）│ 法遵違規 {ev['violations']} │ "
                  f"滿意度 平均 {ev['avg']:.2f} 最低 {ev['min']:.2f} │ 志願達成 高 {ev['high_hit']:.0%} 一般 {ev['norm_hit']:.0%}")
        y, m = next_month(y, m)

    # —— 學到的權重 vs 真實 ——
    learned_W = pipelines["learned"]["W"]
    pop = {k: statistics.mean(true_prefs[s][k] for s in ids) for k in FEATURES}
    print("\n" + "=" * 96)
    print(f"🧠 學到的權重 vs 隱藏真實偏好（{args.months} 個月 × {len(ids)} 人 = {args.months * len(ids)} 筆回饋）")
    print("=" * 96)
    print(f"  {'軟約束':<18}{'先驗':>8}{'學到':>8}{'真實(族群平均)':>16}")
    for k in FEATURES:
        print(f"  {FEATURE_LABELS[k]:<16}{PRIOR[k]:>8.2f}{learned_W[k]:>8.2f}{pop[k]:>16.2f}")
    import numpy as np
    a, b = np.array([learned_W[k] for k in FEATURES]), np.array([pop[k] for k in FEATURES])
    a0 = np.array([PRIOR[k] for k in FEATURES])
    cos = lambda u, v: float(u @ v / np.linalg.norm(u) / np.linalg.norm(v))  # noqa: E731
    print(f"  方向相似度 cos(學到, 真實) = {cos(a, b):.3f}   （先驗只有 {cos(a0, b):.3f}）")

    if "fixed" in pipelines:
        print("\n" + "=" * 96)
        print("📊 學習組 vs 固定權重組（第 2 個月起才有學到的權重，故只比第 2 月之後）")
        print("=" * 96)
        for name in ("learned", "fixed"):
            rows = pipelines[name]["rows"][1:] or pipelines[name]["rows"]
            print(f"  [{name:<7}] 平均滿意度 {statistics.mean(r['avg'] for r in rows):.2f} │ "
                  f"最低滿意度 {statistics.mean(r['min'] for r in rows):.2f} │ "
                  f"高優先志願 {statistics.mean(r['high_hit'] for r in rows):.0%} │ "
                  f"法遵違規 {sum(r['violations'] for r in pipelines[name]['rows'])}")

    if not args.no_grid and last:
        prob, sched = last
        print("\n" + "=" * 96)
        print(f"📅 最後一個月班表（學習組）{prob.year}/{prob.month}")
        print("=" * 96)
        print_grid(prob, sched)
    return 0


if __name__ == "__main__":
    sys.exit(main())
