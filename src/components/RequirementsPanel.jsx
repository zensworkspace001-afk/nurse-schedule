import React, { useEffect } from 'react';
import './RequirementsPanel.css';

// ============================================================================
// 3. NurseSchedulingSystem (主元件)
// ============================================================================
const RequirementsPanel = ({
  requirements, setRequirements,
  bedConfig, setBedConfig, // ★ 接收從雲端與最高層傳來的狀態
  selectedYear, setSelectedYear, selectedMonth, setSelectedMonth,
  onSaveSchedule
}) => {

  // ★ 解構目前的設定值 (若無則給預設值防呆)
  const { bedCount, ratioD, ratioE, ratioN } = bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 };

  const dailyD = Math.ceil(bedCount / ratioD);
  const dailyE = Math.ceil(bedCount / ratioE);
  const dailyN = Math.ceil(bedCount / ratioN);

  // ★ 當病床與護病比變更時，即時更新「人力需求結果」，並準備觸發雲端自動存檔
  useEffect(() => {
    setRequirements({
       D: dailyD, E: dailyE, N: dailyN,
       optimalD: Math.ceil(dailyD * 1.4), optimalE: Math.ceil(dailyE * 1.4), optimalN: Math.ceil(dailyN * 1.4)
    });
  }, [bedCount, ratioD, ratioE, ratioN, setRequirements]);

  // ★ 統一更新 Config 的小幫手
  const updateBedConfig = (field, value) => {
      setBedConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="requirements-panel">
      <h2 className="requirements-panel__title">人力需求與排班設定</h2>

      <div className="requirements-panel__settings">
        <div className="requirements-panel__bed-group">
            <label className="requirements-panel__bed-label">
              病床數: <span className="requirements-panel__bed-count">{bedCount}</span>
            </label>
            <input
              type="range" min="0" max="100" value={bedCount}
              onChange={e => updateBedConfig('bedCount', Number(e.target.value))} // ★ 改用新函式
              className="requirements-panel__slider"
            />
        </div>

        <div className="requirements-panel__shifts">
            {/* 早班 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--day">
                <div className="requirements-panel__shift-count">{dailyD} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>早班 1 :</span>
                   <input type="number" value={ratioD} onChange={e => updateBedConfig('ratioD', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
            </div>

            {/* 小夜 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--evening">
                <div className="requirements-panel__shift-count">{dailyE} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>小夜 1 :</span>
                   <input type="number" value={ratioE} onChange={e => updateBedConfig('ratioE', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
            </div>

            {/* 大夜 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--night">
                <div className="requirements-panel__shift-count">{dailyN} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>大夜 1 :</span>
                   <input type="number" value={ratioN} onChange={e => updateBedConfig('ratioN', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};

export default RequirementsPanel;
