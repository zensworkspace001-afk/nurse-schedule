import React, { useEffect } from 'react';
import AnnouncementEditor from './AnnouncementEditor';
import { RATIO_STANDARDS, legalDailyFloor, computeDailyRequirements } from '../constants';
import './RequirementsPanel.css';

// ============================================================================
// 3. NurseSchedulingSystem (主元件)
// ============================================================================
const RequirementsPanel = ({
  setRequirements,
  bedConfig, setBedConfig, // ★ 接收從雲端與最高層傳來的狀態
  currentUser, announcement,
}) => {

  // ★ 解構目前的設定值 (若無則給預設值防呆)
  const { bedCount, ratioD, ratioE, ratioN, hospitalLevel = 'MedicalCenter' } = bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 };

  // ★ 最終每日需求 = max(admin 自訂, 衛福部護病比法定下限)。admin 可調更嚴但不可更鬆。
  const { D: dailyD, E: dailyE, N: dailyN } = computeDailyRequirements(bedConfig || { bedCount, ratioD, ratioE, ratioN, hospitalLevel });
  // 法定下限（用來標示「哪一班是被護病比硬撐起來的，而非 admin 自填值」）
  const floor = legalDailyFloor(bedCount, hospitalLevel);
  const lvlName = (RATIO_STANDARDS[hospitalLevel] || RATIO_STANDARDS.MedicalCenter).name;
  const overriddenD = dailyD > Math.ceil(bedCount / ratioD);
  const overriddenE = dailyE > Math.ceil(bedCount / ratioE);
  const overriddenN = dailyN > Math.ceil(bedCount / ratioN);

  // ★ 當病床 / 護病比 / 醫院等級變更時，即時更新「人力需求結果」，並準備觸發雲端自動存檔
  useEffect(() => {
    setRequirements({
       D: dailyD, E: dailyE, N: dailyN,
       optimalD: Math.ceil(dailyD * 1.4), optimalE: Math.ceil(dailyE * 1.4), optimalN: Math.ceil(dailyN * 1.4)
    });
  }, [dailyD, dailyE, dailyN, setRequirements]);

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

        {/* ★ 醫院等級：決定衛福部三班護病比法定下限（醫學中心最嚴 1:6/1:9/1:11） */}
        <div className="requirements-panel__level-group">
            <label className="requirements-panel__level-label">醫院等級（護病比法定下限）：</label>
            <select
              value={hospitalLevel}
              onChange={e => updateBedConfig('hospitalLevel', e.target.value)}
              className="requirements-panel__level-select"
            >
              {Object.entries(RATIO_STANDARDS).map(([key, std]) => (
                <option key={key} value={key}>{std.name}（早 1:{std.D} / 小夜 1:{std.E} / 大夜 1:{std.N}）</option>
              ))}
            </select>
            <p className="requirements-panel__level-hint">
              依「{lvlName}」標準，每班最少人力為 早 {floor.D} / 小夜 {floor.E} / 大夜 {floor.N} 人。
              自填比值若低於此下限，系統會自動以法定下限為準。
            </p>
        </div>

        <div className="requirements-panel__shifts">
            {/* 早班 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--day">
                <div className="requirements-panel__shift-count">{dailyD} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>早班 1 :</span>
                   <input type="number" value={ratioD} onChange={e => updateBedConfig('ratioD', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
                {overriddenD && <div className="requirements-panel__floor-badge">⚖️ 已套用法定下限 {floor.D} 人</div>}
            </div>

            {/* 小夜 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--evening">
                <div className="requirements-panel__shift-count">{dailyE} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>小夜 1 :</span>
                   <input type="number" value={ratioE} onChange={e => updateBedConfig('ratioE', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
                {overriddenE && <div className="requirements-panel__floor-badge">⚖️ 已套用法定下限 {floor.E} 人</div>}
            </div>

            {/* 大夜 */}
            <div className="requirements-panel__shift-card requirements-panel__shift-card--night">
                <div className="requirements-panel__shift-count">{dailyN} 人</div>
                <div className="requirements-panel__shift-ratio">
                   <span>大夜 1 :</span>
                   <input type="number" value={ratioN} onChange={e => updateBedConfig('ratioN', Number(e.target.value))} className="requirements-panel__ratio-input" />
                </div>
                {overriddenN && <div className="requirements-panel__floor-badge">⚖️ 已套用法定下限 {floor.N} 人</div>}
            </div>
        </div>
      </div>

      <AnnouncementEditor announcement={announcement} currentUser={currentUser} />
    </div>
  );
};

export default RequirementsPanel;
