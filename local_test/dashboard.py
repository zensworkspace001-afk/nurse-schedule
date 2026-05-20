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

from scheduler import run_sa, run_sa_with_feedback
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

    st.divider()
    st.subheader("🔧 SA 參數")
    iters = st.slider("最大迭代次數", 1000, 50000, 10000, step=1000)
    seed_mode = st.radio("隨機種子", options=["固定 (可重現)", "每次不同"], index=0, horizontal=True)
    seed = st.number_input("種子值", value=42, min_value=0, max_value=99999) if seed_mode == "固定 (可重現)" else None

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
# 跑 SA
# ============================================================
nurses = [s["staff_id"] for s in SAMPLE_STAFF]
name_map = {s["staff_id"]: s["name"] for s in SAMPLE_STAFF}
protected_indices = [
    i for i, s in enumerate(SAMPLE_STAFF)
    if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"
]

spinner_msg = (
    f"🔁 Auto-tighten 模式：最多跑 {max_rounds} 輪 SA..."
    if use_feedback
    else f"🧮 SA 退火運算中（最多 {iters} 次迭代）..."
)

# 健康度 toggle 透過 weight_overrides 把兩條健康規則的權重壓 0 來停用
base_overrides = {} if use_health else {
    "health_deficit_per_point": 0,
    "health_floor_breach": 0,
}

with st.spinner(spinner_msg):
    try:
        if use_feedback:
            # auto-tighten 路徑：每輪都重新疊加 health overrides + auto-tighten overrides
            # 把 base_overrides 透過 monkey-patching weight_overrides 起手值的方式注入
            # （run_sa_with_feedback 內部會自己疊加加重的 overrides；這裡作為初始值）
            from scheduler import run_sa as _run_sa_raw, run_sa_with_feedback as _wrap
            # 簡單做法：feedback loop 跑完後不影響 health overrides，因為 health 沒在
            # JS_TO_SA_MAP 裡所以 auto-tighten 不會碰它。在 run_sa_with_feedback 開頭
            # 傳入初始 overrides 即可。
            result = run_sa_with_feedback(
                year=year, month=month,
                nurses=nurses, staff_data=SAMPLE_STAFF,
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
            )
    except ValueError as e:
        st.error(f"❌ Pre-flight 攔截：{e}")
        st.stop()

stats = result["stats"]
schedule_dict = _schedule_to_dict(result["schedule"])
violations = check_labor_law_compliance(schedule_dict, SAMPLE_STAFF, year, month)
health = calculate_team_health(schedule_dict, stats["num_days"])

# ============================================================
# 頂部三大指標
# ============================================================
m1, m2, m3, m4 = st.columns(4)

penalty_color = "normal" if stats["final_penalty"] == 0 else "inverse"
m1.metric(
    "SA 內部罰分",
    stats["final_penalty"],
    delta=f"第 {stats['best_iteration']}/{stats['max_iterations']} 次迭代",
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
