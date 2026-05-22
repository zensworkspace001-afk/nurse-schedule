"""
SA 排班視覺化 Dashboard (Streamlit)
========================================
本機跑：
  pip install -r local_test/requirements.txt
  streamlit run local_test/dashboard.py

打開 http://localhost:8501 後可以：
  - sidebar 調月份 / 班別需求 / 迭代數 / 種子
  - 主畫面分四個 tab：
      📅 班表        — 著色月曆，按 staff 一行
      ⚖️ 法遵        — JS 端規則對齊的違規清單 + 類別圓餅
      💪 健康度      — 每人 0-100 分 + 扣分原因
      📊 SA 統計     — 罰分組成 / 接受率 / 內部 breakdown
"""

import sys
import os
from collections import defaultdict

import streamlit as st
import pandas as pd

# 確保 import 同資料夾的模組
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scheduler import run_sa, run_sa_with_feedback, run_sa_multistart, OPTIMAL_THRESHOLD, estimate_required_staff
from compliance import check_labor_law_compliance, summarize_violations
from health import calculate_team_health

# ============================================================
# 樣本員工資料（跟 run_demo.py 同步）
# ============================================================
SAMPLE_STAFF = [
    {"staff_id": "N001", "name": "N001", "tenure_years": 5,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N002", "name": "N002", "tenure_years": 3,  "special_status": "Standard", "is_pregnant_or_nursing": True,  "leave_status": "None"},
    {"staff_id": "N003", "name": "N003", "tenure_years": 8,  "special_status": "BiWeekly", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N004", "name": "N004", "tenure_years": 2,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N005", "name": "N005", "tenure_years": 10, "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N006", "name": "N006", "tenure_years": 1,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N007", "name": "N007", "tenure_years": 6,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N008", "name": "N008", "tenure_years": 4,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N009", "name": "N009", "tenure_years": 0,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "Student"},
    {"staff_id": "N010", "name": "N010", "tenure_years": 7,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N011", "name": "N011", "tenure_years": 4,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N012", "name": "N012", "tenure_years": 2,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N013", "name": "N013", "tenure_years": 6,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
    {"staff_id": "N014", "name": "N014", "tenure_years": 3,  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"},
]

SHIFT_COLORS = {
    "D":  "#FFD93D",  # 白班 — 黃
    "E":  "#FF6B9D",  # 小夜 — 粉
    "N":  "#4D96FF",  # 大夜 — 藍
    "RG": "#2ECC71",  # 例假 — 深綠（強制休、不可出勤）
    "RC": "#D5F5E3",  # 休息日 — 淺綠（可加班）
    "O":  "#E2E3E5",  # 舊版單一休假 — 灰（向下相容）
}


# ============================================================
# Helpers
# ============================================================
def _color_shift(val):
    color = SHIFT_COLORS.get(val, "")
    if not color:
        return ""
    # 淺色（黃/淺綠/灰）用黑字；深色（粉/藍/深綠）用白字
    text_color = "#000" if val in ("D", "RC", "O") else "#fff"
    return f"background-color: {color}; color: {text_color}; text-align: center; font-weight: bold;"


def _schedule_to_df(schedule_list, nurses, num_days, name_map):
    """把 SA 回傳的 [{nurse_id, date, shift}] 轉成 DataFrame (row=員工, col=日期)"""
    by_nurse = defaultdict(dict)
    for cell in schedule_list:
        day = int(cell["date"].split("-")[2])
        by_nurse[cell["nurse_id"]][day] = cell["shift"]

    rows = []
    for nid in nurses:
        row = {"員工": nid}
        for d in range(1, num_days + 1):
            row[str(d)] = by_nurse[nid].get(d, "?")
        rows.append(row)
    return pd.DataFrame(rows).set_index("員工")


def _schedule_to_dict(schedule_list):
    """轉成 compliance 期待的 {nurse_id: {day: shift}}"""
    by_nurse = defaultdict(dict)
    for cell in schedule_list:
        day = int(cell["date"].split("-")[2])
        by_nurse[cell["nurse_id"]][day] = cell["shift"]
    return dict(by_nurse)


# ============================================================
# Page setup
# ============================================================
st.set_page_config(
    page_title="SA 排班視覺化",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.title("🧪 SA 排班 + 法遵 + 健康度 視覺化")
st.caption("本機測試用 dashboard — 完全不需要 Firebase / Render，輸入參數即時跑")

# ============================================================
# Sidebar
# ============================================================
with st.sidebar:
    st.header("⚙️ 排班參數")

    col_y, col_m = st.columns(2)
    year = col_y.number_input("年", min_value=2024, max_value=2030, value=2026)
    month = col_m.selectbox("月", options=list(range(1, 13)), index=4)

    st.divider()
    st.subheader("📊 每日人力需求")
    d_req = st.slider("D 白班 07-16", 1, 8, 3)
    e_req = st.slider("E 小夜 15-00", 1, 8, 2)
    n_req = st.slider("N 大夜 23-08", 1, 8, 2)
    daily_total = d_req + e_req + n_req
    st.caption(f"每日需 **{daily_total}** 人上班；員工總數 **{len(SAMPLE_STAFF)}** 人")

    # —— Pre-flight 人力試算（即時跑，不用按按鈕）——
    import calendar as _cal
    _, _num_days = _cal.monthrange(year, month)
    _protected_count = sum(1 for s in SAMPLE_STAFF
                           if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student")
    # 放寬版：每人月工作天數 ∈ [num_days-11, num_days-7] = [20, 24]
    _est = estimate_required_staff(
        num_days=_num_days,
        daily_reqs={1: d_req, 2: e_req, 3: n_req},
        protected_count=_protected_count,
        work_days_range=(_num_days - 11, _num_days - 7),
    )
    if "error" in _est:
        st.error(f"⛔ {_est['error']}")
    else:
        # 數學不可解時提前警告（沒整數人數能讓人均工時落進區間）
        if _est.get("infeasible_types"):
            st.error("🚫 規則與人均工時範圍**數學不可解**：\n" +
                     "\n".join(f"  • {t}" for t in _est["infeasible_types"]) +
                     "\n\n建議放寬 work_days 範圍（例如 [21, 23] 或更寬）或降低 daily demand。")

        n_have = len(SAMPLE_STAFF)
        lo, hi = _est["total_min"], _est["total_max"]
        # infeasible 時 max 可能小於 min（per-type 衝突）— 取高值避免出現「11~8」這種怪顯示
        if hi < lo:
            hi = lo
        rest_lo, rest_hi = _est["rest_range_per_nurse"]
        work_lo, work_hi = _est["work_range_per_nurse"]

        if n_have < lo:
            badge = f"⛔ 人力不足 — 至少需 {lo} 人，目前 {n_have}"
            color = "error"
        elif n_have > hi:
            badge = f"⚠️ 人力過剩 — 建議 {lo}~{hi}，目前 {n_have}（會造成 RG/RC 上限超標）"
            color = "warning"
        else:
            badge = f"✅ 人力適中（建議 {lo}~{hi}，目前 {n_have}）"
            color = "success"

        if color == "error":   st.error(badge)
        elif color == "warning": st.warning(badge)
        else:                  st.success(badge)

        with st.expander("📐 試算細節"):
            st.markdown(f"""
- 每人月工作天數應在 **{work_lo} – {work_hi}** 天（休 {rest_lo}–{rest_hi} 天）
- D 班需求 {d_req}/日 × {_num_days} 天 = {_est['person_days']['D']} 人-日 → **D pool {_est['min_d']}~{_est['max_d']} 人**
- E 班需求 {e_req}/日 × {_num_days} 天 = {_est['person_days']['E']} 人-日 → **E pool {_est['min_e']}~{_est['max_e']} 人**
- N 班需求 {n_req}/日 × {_num_days} 天 = {_est['person_days']['N']} 人-日 → **N pool {_est['min_n']}~{_est['max_n']} 人**
- 保護名單 {_protected_count} 人強制入 D pool → 實際 D 下限 {_est['min_d_with_protected']}
- **總計建議 {lo}~{hi} 人**
""")

        # —— 結構性下限預估 ——
        # 即便人力建議剛好，rule set 本身會在 avg rest > 10（RG+RC 上限）或 avg work-days
        # /週 > 5（40h 上限）時造成「數學上無法避免」的違規。把這個下限揭露出來，
        # 避免使用者誤以為 SA 沒收斂；其實是 rule 本身把可行區壓到結構臨界。
        _eff_n = max(min(n_have, target_count), 1)
        _person_work = _est['person_days']['D'] + _est['person_days']['E'] + _est['person_days']['N']
        _avg_rest = _num_days - _person_work / _eff_n
        _avg_week_workdays = (_person_work / _eff_n) / (_num_days / 7)
        _floor_hints = []
        if _avg_rest > 10:
            _over_rest = _avg_rest - 10
            _floor_hints.append(
                f"avg rest = **{_avg_rest:.1f} 天/人** > 10 (RG=5 + RC=5)，"
                f"預期 ~{int(_over_rest * _eff_n)} 處 excess_rg/rc"
            )
        if _avg_week_workdays > 5:
            _floor_hints.append(
                f"avg 週工作 = **{_avg_week_workdays:.1f} 天/週** > 5 (40h 上限)，"
                f"預期週時數違規結構性發生"
            )
        if _floor_hints:
            st.warning(
                "📐 **結構性下限**：以下規則的違規無法靠 SA 完全消除（rule set 與人力/需求組合鎖死）：\n\n"
                + "\n".join(f"  • {h}" for h in _floor_hints)
                + "\n\n→ 預估收斂下限約 **10,000 ~ 20,000** 罰分，"
                "FEASIBLE 屬正常；要降到 OPTIMAL (<1000) 需放寬 rule 或調整人力/需求。"
            )

        # 自動調整人力：不足就補 placeholder、過剩就從尾端砍非保護員工
        if n_have < lo:
            auto_adjust = st.checkbox(
                f"🤖 自動補足員工到建議下限 ({lo} 人)",
                value=True,
                help="勾選後跑 SA 前會產生 placeholder 員工 (N0XX, Standard, 非保護)，"
                     "讓 pool 大小剛好符合每日需求。SAMPLE_STAFF 不會被改寫，只影響本次 run。",
            )
            adjust_mode = "fill"
            target_count = lo
        elif n_have > hi:
            n_drop = n_have - hi
            auto_adjust = st.checkbox(
                f"🤖 自動裁減員工到建議上限 ({hi} 人，砍 {n_drop} 人)",
                value=True,
                help="勾選後跑 SA 前會從 SAMPLE_STAFF 尾端砍掉非保護員工。"
                     "保護名單（孕婦/實習生）永遠留下。SAMPLE_STAFF 本身不會被改寫。",
            )
            adjust_mode = "trim"
            target_count = hi
        else:
            auto_adjust = False
            adjust_mode = None
            target_count = n_have

    st.divider()
    st.subheader("🔧 SA 參數")
    iters = st.slider("最大迭代次數", 1000, 50000, 10000, step=1000)
    seed_mode = st.radio("隨機種子", options=["固定 (可重現)", "每次不同"], index=0, horizontal=True)
    seed = st.number_input("種子值", value=42, min_value=0, max_value=99999) if seed_mode == "固定 (可重現)" else None

    st.divider()
    st.subheader("🎲 Multi-start (取最佳)")
    use_multistart = st.checkbox(
        "啟用多次重跑",
        value=False,
        help="同 scenario 跑 N 次 SA（不同 seed），取罰分最低的那次。"
             "SA 是隨機演算法，多跑幾次常能找到大幅更好的解。"
    )
    if use_multistart:
        num_starts = st.slider("重跑次數", 2, 10, 5)

    st.divider()
    st.subheader("💪 健康度約束")
    use_health = st.checkbox(
        "啟用健康度規則 (Level 1+2)",
        value=True,
        help=(
            "Level 1：每扣 1 分健康度 → 5 penalty（軟提示，鼓勵高健康分數）。\n"
            "Level 2：個人健康分數 < 70 → 50000 天譴罰分（強制疲勞均分）。\n"
            "取消勾選 = 把這兩條權重設 0，SA 完全不管健康度。"
        ),
    )

    st.divider()
    st.subheader("🎯 Focused SA (L3)")
    use_focused = st.checkbox(
        "啟用 Focused 模式",
        value=True,
        help=(
            "L3 Focused SA：把每位 nurse 個人罰分拆開，分綠燈（凍結）／紅燈（active）。\n"
            "Mutation 強制以紅燈 nurse 為主角，並依其主要違規類型路由到對症修復動作\n"
            "（excess_rg → RG↔work swap、consecutive_work → 在 streak 中段插入休息 等）。\n"
            "搭配 tabu list 防止反向操作，stagnation 偵測自動解凍攪局。"
        ),
    )
    if use_focused:
        freeze_th = st.slider("綠燈門檻（個人罰分 <）", 0, 5000, 500, step=100,
                              help="個人罰分低於此就凍結為綠燈，mutation 不會挑為主角")
        reclassify_n = st.slider("重新分類間隔（iter）", 50, 1000, 200, step=50)
        stag_thaw_n = st.slider("解凍門檻（iter 無進步）", 200, 3000, 800, step=100)
        tabu_n = st.slider("tabu list 長度", 0, 200, 50, step=10)
    else:
        freeze_th, reclassify_n, stag_thaw_n, tabu_n = 500, 200, 800, 50

    st.divider()
    st.subheader("🔁 自動加重 (feedback loop)")
    use_feedback = st.checkbox(
        "啟用 auto-tighten",
        value=False,
        help="跑完 SA 後用 JS 端法遵 check 找出違規類型，把對應 SA 罰分權重加重後重跑。最多 N 輪。"
    )
    if use_feedback:
        max_rounds = st.slider("最多輪數", 1, 5, 3)
        multiplier = st.slider("每輪權重倍率", 1.1, 3.0, 1.5, step=0.1)

    st.divider()
    run_btn = st.button("🚀 執行 SA 排班", type="primary", use_container_width=True)


# ============================================================
# Main — 沒按按鈕的初始畫面
# ============================================================
if not run_btn:
    st.info("👈 在左邊調好參數後，按「執行 SA 排班」開始運算。")
    st.subheader("樣本員工清單")
    df_staff = pd.DataFrame(SAMPLE_STAFF)
    df_staff["保護"] = df_staff.apply(
        lambda r: "🤰 孕/哺乳" if r["is_pregnant_or_nursing"]
                  else ("🎓 實習生" if r["leave_status"] == "Student" else ""),
        axis=1,
    )
    st.dataframe(
        df_staff[["staff_id", "name", "tenure_years", "special_status", "保護"]],
        use_container_width=True,
        hide_index=True,
    )
    st.stop()


# ============================================================
# 跑 SA — 視 auto_fill 決定是否自動補足員工
# ============================================================
effective_staff = list(SAMPLE_STAFF)

if 'auto_adjust' in dir() and auto_adjust and adjust_mode == "fill":
    starting_id = len(effective_staff) + 1
    needed = target_count - len(effective_staff)
    new_ids = []
    for i in range(starting_id, starting_id + needed):
        sid = f"N{i:03d}"
        new_ids.append(sid)
        effective_staff.append({
            "staff_id": sid, "name": sid,
            "tenure_years": 3, "special_status": "Standard",
            "is_pregnant_or_nursing": False, "leave_status": "None",
        })
    st.info(f"🤖 自動補足 {needed} 名 placeholder：{new_ids} → 共 {len(effective_staff)} 人")

elif 'auto_adjust' in dir() and auto_adjust and adjust_mode == "trim":
    # 保護名單永遠留；其餘從尾端往前砍
    protected_set = {s["staff_id"] for s in SAMPLE_STAFF
                     if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"}
    kept_protected = [s for s in effective_staff if s["staff_id"] in protected_set]
    non_protected = [s for s in effective_staff if s["staff_id"] not in protected_set]
    keep_non_prot = target_count - len(kept_protected)
    if keep_non_prot < 0:
        st.error(f"⛔ 保護名單 {len(kept_protected)} 人已超過建議上限 {target_count}，無法裁減")
        st.stop()
    dropped = [s["staff_id"] for s in non_protected[keep_non_prot:]]
    kept_non_prot = non_protected[:keep_non_prot]
    # 保留原 SAMPLE_STAFF 中的順序：依 staff_id sort
    effective_staff = sorted(kept_protected + kept_non_prot, key=lambda s: s["staff_id"])
    st.info(f"🤖 自動裁減 {len(dropped)} 名員工：{dropped} → 留下 {len(effective_staff)} 人")

nurses = [s["staff_id"] for s in effective_staff]
name_map = {s["staff_id"]: s["name"] for s in effective_staff}
protected_indices = [
    i for i, s in enumerate(effective_staff)
    if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"
]

if use_multistart:
    spinner_msg = f"🎲 Multi-start：跑 {num_starts} 次 SA 取最佳..."
elif use_feedback:
    spinner_msg = f"🔁 Auto-tighten 模式：最多跑 {max_rounds} 輪 SA..."
else:
    spinner_msg = f"🧮 SA 退火運算中（最多 {iters} 次迭代）..."

# 健康度 toggle 透過 weight_overrides 把兩條健康規則的權重壓 0 來停用
base_overrides = {} if use_health else {
    "health_deficit_per_point": 0,
    "health_floor_breach": 0,
}

with st.spinner(spinner_msg):
    try:
        if use_multistart:
            result = run_sa_multistart(
                year=year, month=month,
                nurses=nurses, protected_indices=protected_indices,
                daily_reqs={1: d_req, 2: e_req, 3: n_req},
                custom_rules=[],
                max_iterations=iters,
                num_starts=num_starts, base_seed=seed,
                weight_overrides=base_overrides,
                focused_mode=use_focused,
                freeze_threshold=freeze_th,
                reclassify_every=reclassify_n,
                tabu_size=tabu_n,
                stagnation_thaw=stag_thaw_n,
            )
        elif use_feedback:
            result = run_sa_with_feedback(
                year=year, month=month,
                nurses=nurses, staff_data=effective_staff,
                protected_indices=protected_indices,
                daily_reqs={1: d_req, 2: e_req, 3: n_req},
                custom_rules=[],
                max_iterations=iters, seed=seed,
                max_rounds=max_rounds, multiplier=multiplier,
                initial_weight_overrides=base_overrides,
            )
        else:
            result = run_sa(
                year=year, month=month,
                nurses=nurses, protected_indices=protected_indices,
                daily_reqs={1: d_req, 2: e_req, 3: n_req},
                custom_rules=[],
                max_iterations=iters, seed=seed,
                weight_overrides=base_overrides,
                focused_mode=use_focused,
                freeze_threshold=freeze_th,
                reclassify_every=reclassify_n,
                tabu_size=tabu_n,
                stagnation_thaw=stag_thaw_n,
            )
    except ValueError as e:
        st.error(f"❌ Pre-flight 攔截：{e}")
        st.stop()

stats = result["stats"]
schedule_dict = _schedule_to_dict(result["schedule"])
violations = check_labor_law_compliance(schedule_dict, effective_staff, year, month)
health = calculate_team_health(schedule_dict, stats["num_days"])

# ============================================================
# 頂部三大指標
# ============================================================
m1, m2, m3, m4 = st.columns(4)

penalty_color = "normal" if stats["final_penalty"] < OPTIMAL_THRESHOLD else "inverse"
_pen = stats["final_penalty"]
_ok = _pen < OPTIMAL_THRESHOLD
m1.metric(
    "SA 內部罰分",
    f"{'✅' if _ok else '⚠️'} {_pen}",
    delta=f"第 {stats['best_iteration']}/{stats['max_iterations']} 次迭代 / 門檻 <{OPTIMAL_THRESHOLD}",
    delta_color="off",
)
m2.metric(
    "JS 法遵違規",
    f"{len(violations)} 處",
    delta="0 = 完全合規" if not violations else None,
    delta_color="off",
)
m3.metric(
    "團隊平均健康度",
    f"{health['team_avg']} 分",
    delta=f"最低 {health['team_min']} / 最高 {health['team_max']}",
    delta_color="off",
)
m4.metric(
    "運算耗時",
    f"{result['elapsed_seconds']}s",
    delta=f"接受次優 {stats['accepted_worse_swaps']}",
    delta_color="off",
)

# ============================================================
# 三個 Tab（法遵已併入 SA 統計）
# ============================================================
tab_grid, tab_health, tab_sa = st.tabs([
    "📅 整月班表", "💪 個人健康度", "📊 SA 統計 + 法遵檢查"
])

# ----- Tab 1: 班表 -----
with tab_grid:
    df = _schedule_to_df(result["schedule"], nurses, stats["num_days"], name_map)
    styled = df.style.applymap(_color_shift)
    st.dataframe(styled, use_container_width=True, height=420)

    legend_cols = st.columns(5)
    for col, (code, label, desc) in zip(legend_cols, [
        ("D",  "白班", "07-16"),
        ("E",  "小夜", "15-00"),
        ("N",  "大夜", "23-08"),
        ("RG", "例假", "§36 強制"),
        ("RC", "休息日", "可加班"),
    ]):
        col.markdown(
            f"<div style='background:{SHIFT_COLORS[code]}; padding:8px; "
            f"border-radius:6px; text-align:center; "
            f"color:{'#000' if code in ('D','RC','O') else '#fff'}; font-weight:bold;'>"
            f"{code} — {label}<br/><span style='font-size:0.8em; opacity:0.85'>{desc}</span></div>",
            unsafe_allow_html=True,
        )

    st.divider()
    st.subheader("📊 每人班別/休假天數統計")

    count_rows = []
    for nid in nurses:
        days = schedule_dict.get(nid, {})
        counts = {"D": 0, "E": 0, "N": 0, "RG": 0, "RC": 0, "O": 0}
        for shift in days.values():
            if shift in counts:
                counts[shift] += 1
        work_days = counts["D"] + counts["E"] + counts["N"]
        rest_days = counts["RG"] + counts["RC"] + counts["O"]
        row = {
            "員工": nid,
            "D 白班": counts["D"],
            "E 小夜": counts["E"],
            "N 大夜": counts["N"],
            "RG 例假": counts["RG"],
            "RC 休息日": counts["RC"],
        }
        if counts["O"]:
            row["O 休假"] = counts["O"]
        row["工作天"] = work_days
        row["休假天"] = rest_days
        count_rows.append(row)
    count_df = pd.DataFrame(count_rows)

    cc1, cc2 = st.columns([3, 2])
    with cc1:
        st.dataframe(count_df, use_container_width=True, hide_index=True, height=380)
    with cc2:
        st.markdown("**休假天數分布（RG + RC）**")
        rest_chart = count_df.set_index("員工")[["RG 例假", "RC 休息日"]]
        st.bar_chart(rest_chart)

    st.caption(
        f"📌 全月 **{stats['num_days']}** 天 ｜ "
        f"團隊總休假 RG **{count_df['RG 例假'].sum()}** + "
        f"RC **{count_df['RC 休息日'].sum()}** = **{count_df['RG 例假'].sum() + count_df['RC 休息日'].sum()}** 人-日 ｜ "
        f"人均休假 **{count_df['休假天'].mean():.1f}** 天（工作 **{count_df['工作天'].mean():.1f}** 天）"
    )

# ----- Tab 2: 健康度 -----
with tab_health:
    score_rows = []
    for nid in nurses:
        h = health["per_staff"][nid]
        score_rows.append({
            "員工": nid,
            "分數": h["score"],
            "扣分項目數": len(h["deductions"]),
        })
    score_df = pd.DataFrame(score_rows)

    c1, c2 = st.columns([1, 1])
    with c1:
        st.subheader("分數分布")
        chart_df = score_df.set_index("員工")[["分數"]]
        st.bar_chart(chart_df)
    with c2:
        st.subheader("分數概覽")
        def _grade(s):
            if s >= 95: return "🟢 優"
            if s >= 90: return "🟡 良"
            if s >= 75: return "🟠 中"
            return "🔴 差"
        score_df["評等"] = score_df["分數"].apply(_grade)
        st.dataframe(score_df, use_container_width=True, hide_index=True, height=380)

    st.divider()
    st.subheader("逐人扣分明細")
    for nid in nurses:
        h = health["per_staff"][nid]
        if not h["deductions"]:
            continue
        with st.expander(f"[{nid}] {nid} — {h['score']} 分（扣 {len(h['deductions'])} 項）"):
            for d in h["deductions"]:
                st.markdown(f"- {d}")

# ----- Tab 3: SA 統計 + 法遵檢查（合併） -----
with tab_sa:
    # ============ Section -1: Multi-start summary（啟用時顯示）============
    ms_summary = stats.get("multistart_summary")
    if ms_summary:
        st.markdown(f"### 🎲 Multi-start 結果（{len(ms_summary)} 次跑取最佳）")
        st.caption(f"最佳是第 {stats.get('multistart_best_attempt', '?')} 次")
        ms_df = pd.DataFrame([{
            "嘗試 #": r["attempt"],
            "Seed": r["seed"],
            "罰分": r["penalty"],
            "狀態": r["solver_status"],
            "耗時 (s)": r["elapsed_seconds"],
            "前 3 大違規": ", ".join(f"{k}×{v}" for k, v in r["top_violations"][:3]) or "無",
        } for r in ms_summary])
        st.dataframe(ms_df, use_container_width=True, hide_index=True)
        # 罰分趨勢小圖
        trend_df = pd.DataFrame([{
            "嘗試 #": r["attempt"], "罰分": r["penalty"]
        } for r in ms_summary]).set_index("嘗試 #")
        st.line_chart(trend_df)
        st.divider()

    # ============ Section 0: Auto-tighten 歷程（只在啟用時顯示） ============
    feedback_rounds = stats.get("feedback_rounds")
    if feedback_rounds:
        st.markdown("### 🔁 Auto-tighten 歷程")
        rounds_df = pd.DataFrame([{
            "輪數": r["round"],
            "SA 罰分": r["final_penalty"],
            "JS 違規數": r["js_violations"],
            "權重 overrides": ", ".join(f"{k}={v}" for k, v in r["weight_overrides"].items()) or "無",
            "前 3 大違規": ", ".join(f"{t}×{c}" for t, c in r["top_violations"][:3]) or "無",
        } for r in feedback_rounds])
        st.dataframe(rounds_df, use_container_width=True, hide_index=True)

        # 趨勢圖
        trend_df = pd.DataFrame([{
            "輪數": r["round"],
            "SA 罰分": r["final_penalty"],
            "JS 違規數 × 100": r["js_violations"] * 100,  # 同尺度方便比較
        } for r in feedback_rounds]).set_index("輪數")
        st.line_chart(trend_df)
        st.divider()

    # ============ Section -0.5: Focused SA stats（啟用時顯示）============
    if stats.get("focused_mode"):
        st.markdown("### 🎯 Focused SA 統計")
        fc1, fc2, fc3, fc4, fc5 = st.columns(5)
        fc1.metric("Focused iters", stats.get("focused_iterations", 0))
        fc2.metric("對症 mutation", stats.get("targeted_iterations", 0))
        fc3.metric("解凍攪局", stats.get("thaw_iterations", 0))
        fc4.metric("tabu 阻擋", stats.get("tabu_hits", 0))
        fc5.metric(
            "綠燈/紅燈",
            f"{len(stats.get('final_green_nurses', []))}/{len(stats.get('final_red_nurses', []))}",
        )

        fcc1, fcc2 = st.columns([1, 1])
        with fcc1:
            st.markdown("**🟢 綠燈名單（已收斂，凍結）**")
            green = stats.get("final_green_nurses", [])
            if green:
                green_rows = [{"員工": nid, "個人罰分": stats["nurse_penalties"].get(nid, 0)}
                              for nid in green]
                st.dataframe(pd.DataFrame(green_rows), use_container_width=True,
                             hide_index=True, height=240)
            else:
                st.caption("無 — 所有 nurse 都還有顯著違規")
        with fcc2:
            st.markdown("**🔴 紅燈名單（active，需修復）**")
            red = stats.get("final_red_nurses", [])
            if red:
                dominant = stats.get("nurse_dominant_violation", {})
                red_rows = [{
                    "員工": nid,
                    "個人罰分": stats["nurse_penalties"].get(nid, 0),
                    "主違規": dominant.get(nid, "-"),
                } for nid in red]
                red_df = pd.DataFrame(red_rows).sort_values("個人罰分", ascending=False)
                st.dataframe(red_df, use_container_width=True, hide_index=True, height=240)
            else:
                st.success("🎉 無紅燈 — 全員已收斂")

        # 分類軌跡（紅燈數隨 iter 變化）
        log = stats.get("classify_log", [])
        if len(log) > 1:
            trend_df = pd.DataFrame([{
                "iter": x["iter"], "紅燈數": x["red"], "綠燈數": x["green"],
            } for x in log]).set_index("iter")
            st.markdown("**紅/綠燈數隨 iter 變化**")
            st.line_chart(trend_df)

        st.divider()

    # ============ Section A: 退火動態 + SA 內部 breakdown ============
    st.markdown("### 🌡️ SA 退火動態")
    c1, c2 = st.columns(2)
    with c1:
        st.metric("接受變更交換", stats["accepted_worse_swaps"])
        st.metric("拒絕交換", stats["rejected_swaps"])
        accept_rate = (
            stats["accepted_worse_swaps"]
            / max(1, stats["accepted_worse_swaps"] + stats["rejected_swaps"]) * 100
        )
        st.metric("次優交換接受率", f"{accept_rate:.1f}%")

    with c2:
        st.markdown("**SA 內部違規（按罰分函數定義）**")
        if not stats["violation_breakdown"]:
            st.success("無違規")
        else:
            bd_df = pd.DataFrame(
                [{"類型": k, "次數": v} for k, v in stats["violation_breakdown"].items()]
            )
            st.bar_chart(bd_df.set_index("類型"))

    st.divider()

    # ============ Section B: JS 端法遵檢查（從原 tab_law 搬過來） ============
    st.markdown("### ⚖️ JS 端法遵檢查（對齊 src/constants.js checkLaborLawCompliance）")
    st.caption(
        "這裡跑的是 production 前端用的 11 條規則：每日/每週/每月工時、七休一、輪班間隔、"
        "母性保護、實習生禁夜班、月例假/休息日、特休額度等。**SA 內部沒檢查週工時與整月例假**，"
        "所以這裡常常會抓到 SA 漏掉的違規。"
    )
    if not violations:
        st.success("✅ 0 處違規 — 完全合規！")
    else:
        summary = summarize_violations(violations)
        cc1, cc2 = st.columns([1, 2])
        with cc1:
            st.markdown("**違規類型分布**")
            sum_df = pd.DataFrame(
                [{"類型": k, "次數": v} for k, v in summary.items()]
            ).sort_values("次數", ascending=False)
            st.bar_chart(sum_df.set_index("類型"))
        with cc2:
            st.markdown(f"**完整違規清單 ({len(violations)} 處)**")
            v_df = pd.DataFrame(violations)
            v_df = v_df.rename(columns={
                "staffId": "工號", "staffName": "姓名",
                "day": "日期", "type": "類型", "message": "說明",
            })
            st.dataframe(
                v_df[["工號", "姓名", "日期", "類型", "說明"]],
                use_container_width=True, hide_index=True, height=380,
            )

    st.divider()

    # ============ Section C: 完整 JSON ============
    with st.expander("📋 完整 SA 回應 JSON（debug 用）", expanded=False):
        st.json({
            "solver_status": result["solver_status"],
            "elapsed_seconds": result["elapsed_seconds"],
            "stats": stats,
        })

st.divider()
st.caption(
    "💡 SA 罰分函數已對齊 JS 端 checkLaborLawCompliance 的 11 條規則（七休一、"
    "輪班間隔、週 40h、月加班 ≤222h、月例假 ≥ 4、RG+RC ≥ 8、RG 間隔 ≤ 6 工作日、"
    "孕婦/實習生禁夜班等），再加上健康度 Level 1+2 約束。雙邊跑同樣的規則理論上會收斂到一致；"
    "若 SA 罰分 0 而 JS 仍有違規，可能是個別 edge case（例如月底跨週、年資相關特休額度），"
    "歡迎回報用來補規則。"
)
