"""
權重自動學習 + 跨月補償（概念驗證）

真實系統：每月班表公布後，請護理師填 0-10 滿意度（或從換班申請、抱怨紀錄推估）。
本 POC 沒有真實回饋，所以用一組「隱藏的真實偏好」模擬回饋：

    sat_n = 10 − Σ_k θ_{n,k} · f_{n,k} + 雜訊
    θ_{n,k} = 族群平均 θ*_k × 個人差異（lognormal）

學習器只看得到 (特徵, 滿意度)，看不到 θ —— 看它能否把權重學回來。

方法：帶先驗的非負最小平方（逐月累積資料）
    min_θ≥0  ||Xθ − y||² + ρ ||θ − θ_prior||²
    y = 10 − sat（觀測到的不滿度）
ρ 項讓「本月沒人碰到的特徵」（零變異 → 無法辨識）維持先驗，而不是亂飄。
"""

import math
import random
from typing import Dict, List

import numpy as np

from model import FEATURES


# 族群平均的「真實」權重 —— 只有模擬器知道，學習器看不到
TRUE_THETA = {
    "wish_high_miss":   3.0,
    "wish_normal_miss": 1.0,
    "nights":           0.35,
    "isolated_off":     0.8,
    "weekend_work":     0.25,
    "shift_switch":     0.5,
    "streak6":          1.2,
}

PRIOR = {k: 1.0 for k in FEATURES}   # 第一個月什麼都不知道 → 全部權重 1


def make_true_preferences(staff_ids: List[str], seed: int, spread: float = 0.35) -> Dict[str, Dict[str, float]]:
    rng = random.Random(seed)
    return {sid: {k: TRUE_THETA[k] * math.exp(rng.gauss(0, spread)) for k in FEATURES}
            for sid in staff_ids}


def simulate_feedback(feats: Dict[str, Dict[str, int]], true_prefs, seed: int, noise: float = 0.5) -> Dict[str, float]:
    rng = random.Random(seed)
    return {sid: 10 - sum(true_prefs[sid][k] * f[k] for k in FEATURES) + rng.gauss(0, noise)
            for sid, f in feats.items()}


def true_satisfaction(feats, true_prefs) -> Dict[str, float]:
    """不含雜訊的真實滿意度 —— 只用於評估，不給學習器"""
    return {sid: 10 - sum(true_prefs[sid][k] * f[k] for k in FEATURES) for sid, f in feats.items()}


class WeightLearner:
    def __init__(self, prior: Dict[str, float] = None, rho: float = 2.0):
        self.prior = np.array([(prior or PRIOR)[k] for k in FEATURES], dtype=float)
        self.rho = rho
        self.X: List[List[float]] = []
        self.y: List[float] = []

    def observe(self, feats: Dict[str, Dict[str, int]], sats: Dict[str, float]):
        for sid, f in feats.items():
            self.X.append([f[k] for k in FEATURES])
            self.y.append(10 - sats[sid])

    def fit(self) -> Dict[str, float]:
        if not self.X:
            return dict(zip(FEATURES, self.prior))
        X, y = np.array(self.X), np.array(self.y)
        A = X.T @ X + self.rho * np.eye(len(FEATURES))
        rhs = X.T @ y + self.rho * self.prior
        theta = np.linalg.solve(A, rhs)
        if (theta < 0).any():
            # 投影梯度補正非負（暖啟動自封閉解）
            theta = np.clip(theta, 0, None)
            step = 1.0 / (2 * np.linalg.eigvalsh(A).max())
            for _ in range(5000):
                theta = np.clip(theta - step * 2 * (A @ theta - rhs), 0, None)
        # 下限 0.05：避免某項被學成 0 後 CP-SAT 完全不在乎（例如從沒人連上 6 天）
        return {k: max(0.05, float(v)) for k, v in zip(FEATURES, theta)}


def compensation_multipliers(history: List[Dict[str, float]], alpha: float = 0.6,
                             decay: float = 0.5, lo: float = 0.5, hi: float = 2.0) -> Dict[str, float]:
    """
    history: 每月 {sid: 觀測到的不滿度 (10 − sat)}，舊 → 新
    近期被犧牲越多（不滿度高於團隊平均）→ 乘數越大 → 本月 CP-SAT 越優先照顧他。
    """
    if not history:
        return {}
    ids = history[-1].keys()
    acc = {sid: 0.0 for sid in ids}
    w = 1.0
    for month in reversed(history):
        for sid in ids:
            acc[sid] += w * month.get(sid, 0.0)
        w *= decay
    mean = sum(acc.values()) / len(acc)
    if mean <= 1e-9:
        return {sid: 1.0 for sid in ids}
    return {sid: min(hi, max(lo, 1 + alpha * (acc[sid] - mean) / mean)) for sid in ids}
