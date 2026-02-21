const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001; // 後端跑在 3001 port

// Middleware
app.use(cors()); // 允許跨網域請求 (讓 React 3000 port 可以連線)
app.use(bodyParser.json());

// 模擬資料庫檔案路徑
const DB_FILE = path.join(__dirname, 'db.json');

// 初始化資料庫 (如果檔案不存在，建立預設資料)
if (!fs.existsSync(DB_FILE)) {
  const initialData = {
    staff: [],      // 員工資料
    history: [],    // 歷史班表
    preferences: {}, // 員工偏好
    schedule: {}    // 產生的班表
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// 讀取資料的輔助函式
const readDB = () => {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
};

// 寫入資料的輔助函式
const writeDB = (data) => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// ================= API 路由 =================

// 1. 取得所有員工資料
app.get('/api/staff', (req, res) => {
  const db = readDB();
  res.json(db.staff);
});

// 2. 更新/儲存員工資料
app.post('/api/staff', (req, res) => {
  const db = readDB();
  db.staff = req.body; // 預期前端傳來完整的員工陣列
  writeDB(db);
  res.json({ message: '員工資料更新成功' });
});

// 3. 取得排班歷史
app.get('/api/history', (req, res) => {
  const db = readDB();
  res.json(db.history);
});

// 4. 提交/更新員工偏好
app.post('/api/preferences', (req, res) => {
  const { staffId, preference } = req.body;
  const db = readDB();
  db.preferences[staffId] = preference;
  writeDB(db);
  res.json({ message: '偏好儲存成功' });
});

// 5. 取得所有偏好 (管理者用)
app.get('/api/preferences', (req, res) => {
  const db = readDB();
  res.json(db.preferences);
});

// 6. 儲存排班結果
app.post('/api/schedule', (req, res) => {
  const db = readDB();
  db.schedule = req.body;
  writeDB(db);
  res.json({ message: '班表儲存成功' });
});

// 7. 取得排班結果
app.get('/api/schedule', (req, res) => {
  const db = readDB();
  res.json(db.schedule);
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`後端伺服器運行中：http://localhost:${PORT}`);
});