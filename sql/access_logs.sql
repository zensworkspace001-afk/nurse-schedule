-- 稽核日誌（access_logs）—— 混合式儲存裡搬到 MySQL 的第一張表。
--
-- 為什麼是它先搬：append-only（只新增、不修改）、無前端即時訂閱、
-- admin 要下「某人某時段所有 decrypt」這類篩選/統計查詢 —— SQL 完勝 Firestore。
--
-- 對應 Firestore `access_logs` doc 結構：
--   { ts, actor:{uid,email}, action, target:{kind,id}, fields:[], ip, ua, extra }
-- 巢狀的 actor / target 攤平成欄位（方便 WHERE / 索引），
-- 不定型的 fields / extra 用 JSON 欄位保留彈性。
--
-- 用法：
--   mysql -u USER -p DBNAME < sql/access_logs.sql
--   （或由 scripts/migrate-access-logs-to-mysql.js 自動執行 CREATE TABLE IF NOT EXISTS）

CREATE TABLE IF NOT EXISTS access_logs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- 毫秒精度，對齊 ISO timestamp
  actor_uid    VARCHAR(40),
  actor_email  VARCHAR(120),
  action       VARCHAR(30)  NOT NULL,   -- decrypt|encrypt|relock|ai-access|ai-access-blocked|update-profile|delete-staff|login|login-failure
  target_kind  VARCHAR(30),             -- staff|settings|archive...
  target_id    VARCHAR(64),
  fields       JSON,                    -- 被存取的欄位清單，如 ["idNumber","phone"]
  ip           VARCHAR(45),             -- 容納 IPv6
  ua           VARCHAR(255),
  extra        JSON,                    -- 動作相關的額外資訊
  INDEX idx_ts (ts),
  INDEX idx_actor_uid (actor_uid),
  INDEX idx_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
