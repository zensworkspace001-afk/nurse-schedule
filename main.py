import math
import calendar
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional, Any
from ortools.sat.python import cp_model
import uvicorn

# ==========================================
# 1. 定義 API 資料結構 (Pydantic Models)
# ==========================================
class ScheduleRequest(BaseModel):
    year: int
    month: int
    nurses: List[str]               # 員工名單，例如 ["N01", "N02", "N03"...]
    protected_indices: List[int]    # 孕婦或實習生在名單中的 Index，例如 [0, 2]
    daily_reqs: Dict[int, int]      # 預設各班別人數，例如 {1: 5, 2: 4, 3: 3}
    custom_rules: Optional[List[Dict[str, Any]]] = [] # 接收 LLM 解析的自然語言規則

# 建立 FastAPI 實例
app = FastAPI(title="護理排班最佳化引擎地端 API")

# ==========================================
# 2. 輔助函式：計算所需保底人力 (系統評估用)
# ==========================================
def calculate_required_nurses(daily_reqs, num_days, buffer_rate=1.15):
    daily_total_shifts = sum(daily_reqs.values())
    monthly_total_shifts = daily_total_shifts * num_days
    min_days_off = math.ceil(num_days / 7.0)
    max_work_days = num_days - min_days_off
    theoretical_min = monthly_total_shifts / max_work_days
    return math.ceil(theoretical_min * buffer_rate)

# ==========================================
# 3. 核心 API 端點：產生班表
# ==========================================
@app.post("/generate_schedule")
def generate_schedule(req: ScheduleRequest):
    year, month = req.year, req.month
    _, num_days = calendar.monthrange(year, month)
    num_nurses = len(req.nurses)
    
    # 建立求解器模型
    model = cp_model.CpModel()

    # 班別定義：0=休假(O), 1=白班(D), 2=小夜(E), 3=大夜(N)
    off_shift = 0
    work_shifts = [1, 2, 3]
    num_shifts = 4
    
    # 建立核心決策變數：work[(護理師索引, 天數, 班別)] = 0 或 1
    work = {}
    for n in range(num_nurses):
        for d in range(num_days):
            for s in range(num_shifts):
                work[(n, d, s)] = model.NewBoolVar(f'w_n{n}_d{d}_s{s}')

    # ==========================================
    # [前置處理] 整合 LLM 動態規則與預設需求
    # ==========================================
    # 建立一個二維字典來存儲「每一天、每一班」的最終目標人數
    target_reqs = {d: {s: req.daily_reqs.get(s, 0) for s in work_shifts} for d in range(num_days)}
    shift_mapping_reverse = {"D": 1, "E": 2, "N": 3, "O": 0}

    if req.custom_rules:
        for rule in req.custom_rules:
            try:
                day = int(rule["date"].split("-")[2])
                d = day - 1 # 轉為陣列 index
            except Exception:
                continue # 日期解析失敗則跳過

            action = rule.get("action")

            # 動態規則 A：修改特定日期的人力需求
            if action == "UPDATE_DEMAND":
                s = shift_mapping_reverse.get(rule.get("shift"))
                if s:
                    target_reqs[d][s] = rule.get("new_value")
            
            # 動態規則 B：強制某員工排休
            elif action == "FORCE_OFF":
                nurse_id = rule.get("nurse_id")
                try:
                    n = req.nurses.index(nurse_id)
                    model.Add(work[(n, d, off_shift)] == 1) # 強制休假變數為 True
                except ValueError:
                    pass # 找不到該員工則跳過

    # ==========================================
    # [硬限制區] 法遵與排班基本邏輯 (絕對不可違反)
    # ==========================================
    
    for n in range(num_nurses):
        # 1. 每天只能上一種班 (或休假)
        for d in range(num_days):
            model.AddExactlyOne([work[(n, d, s)] for s in range(num_shifts)])

        # 2. 兩班之間休息 11 小時 (N接D, N接E, E接D 皆違規)
        illegal_transitions = [(3, 1), (3, 2), (2, 1)]
        for d in range(num_days - 1):
            for (s_yesterday, s_today) in illegal_transitions:
                model.Add(work[(n, d, s_yesterday)] + work[(n, d + 1, s_today)] <= 1)

        # 3. 七休一 (滑動區間：連續 7 天內至少 1 天休假)
        for d in range(num_days - 6):
            model.Add(sum(work[(n, d + i, off_shift)] for i in range(7)) >= 1)

        # 4. 下大夜必須連休兩天
        for d in range(1, num_days - 1):
            was_night_yesterday = work[(n, d - 1, 3)]
            is_not_night_today = work[(n, d, 3)].Not()
            is_post_night_off = model.NewBoolVar(f'post_night_off_n{n}_d{d}')
            
            model.AddBoolAnd([was_night_yesterday, is_not_night_today]).OnlyEnforceIf(is_post_night_off)
            model.AddBoolOr([was_night_yesterday.Not(), work[(n, d, 3)]]).OnlyEnforceIf(is_post_night_off.Not())
            
            # 條件觸發時，今天與明天鎖死為休假
            model.AddImplication(is_post_night_off, work[(n, d, off_shift)])
            model.AddImplication(is_post_night_off, work[(n, d + 1, off_shift)])

        # 6. 四週變形工時：月休至少 8 天，且工作總天數不超過 27 天 (約 222 小時)
        model.Add(sum(work[(n, d, off_shift)] for d in range(num_days)) >= 8)
        model.Add(sum(work[(n, d, s)] for d in range(num_days) for s in work_shifts) <= 27)

    # 5. 母性保護與實習生條款 (強制禁止 E, N)
    for n in req.protected_indices:
        for d in range(num_days):
            model.Add(work[(n, d, 2)] == 0)
            model.Add(work[(n, d, 3)] == 0)

    # ==========================================
    # [軟限制區] 營運缺口扣分 + 健康分數防護網
    # ==========================================
    objective_penalties = []
    
    # A. 營運人力缺口懲罰 (依照預處理後的 target_reqs 進行配置)
    shortfall_weight = 100
    for d in range(num_days):
        for s in work_shifts:
            target = target_reqs[d][s]
            shortfall = model.NewIntVar(0, target, f'shortfall_d{d}_s{s}')
            nurses_on_shift = [work[(n, d, s)] for n in range(num_nurses)]
            
            model.Add(sum(nurses_on_shift) + shortfall == target)
            objective_penalties.append(shortfall * shortfall_weight)

    # B. 健康分數防護與懲罰
    for n in range(num_nurses):
        nurse_health_penalties = []
        
        # 規則：連續 4 大夜 (-5分)
        for d in range(num_days - 3):
            is_4_nights = model.NewBoolVar(f'4_nights_n{n}_d{d}')
            nights_window = [work[(n, d+i, 3)] for i in range(4)]
            model.Add(sum(nights_window) == 4).OnlyEnforceIf(is_4_nights)
            model.Add(sum(nights_window) < 4).OnlyEnforceIf(is_4_nights.Not())
            nurse_health_penalties.append(is_4_nights * 5)
            
        # 規則：連續 6 天上班 (-5分)
        for d in range(num_days - 5):
            is_6_work = model.NewBoolVar(f'6_work_n{n}_d{d}')
            offs_window = [work[(n, d+i, off_shift)] for i in range(6)]
            model.Add(sum(offs_window) == 0).OnlyEnforceIf(is_6_work)
            model.Add(sum(offs_window) > 0).OnlyEnforceIf(is_6_work.Not())
            nurse_health_penalties.append(is_6_work * 5)
            
        # ★ 防護網：個人總扣分不能超過 30 (保證每個人的健康度都在 70 分以上)
        total_nurse_penalty = sum(nurse_health_penalties)
        model.Add(total_nurse_penalty <= 30)
        
        # 加入總目標函數，讓模型盡量排出全員高分班表
        objective_penalties.append(total_nurse_penalty)

    # 設定目標：最小化(人力缺口 + 健康損耗)
    model.Minimize(sum(objective_penalties))

    # ==========================================
    # 4. 執行求解並格式化輸出
    # ==========================================
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0 # 運算時限 60 秒
    
    status = solver.Solve(model)
    
    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        shift_mapping = {0: 'O', 1: 'D', 2: 'E', 3: 'N'}
        schedule_result = []
        
        for n in range(num_nurses):
            nurse_id = req.nurses[n]
            for d in range(num_days):
                for s in range(num_shifts):
                    if solver.Value(work[(n, d, s)]) == 1:
                        schedule_result.append({
                            "nurse_id": nurse_id,
                            "date": f"{year}-{month:02d}-{d+1:02d}",
                            "shift": shift_mapping[s]
                        })
        
        return {
            "status": "success",
            "solver_status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
            "schedule": schedule_result
        }
    else:
        raise HTTPException(status_code=400, detail="運算失敗：條件過於嚴苛或人力嚴重不足，模型無法找到合規班表。")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)