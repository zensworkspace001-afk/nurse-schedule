// ============================================================================
// LoginPanel (員工登入介面)
// ============================================================================
import React, { useState } from 'react';

const LoginPanel = ({ onLogin, staffData }) => {
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    setError('');

    // --- 模擬驗證邏輯 ---
    
    // 1. 超級管理員 (阿長/護理長)
    if (employeeId === 'admin' && password === 'admin') {
      onLogin({ id: 'ADMIN', name: '護理長', role: 'admin' });
      return;
    }

    // 2. 一般員工驗證 (比對 staffData)
    // 假設密碼預設是 "1234" 或是跟工號一樣 (為了測試方便)
    const staff = staffData.find(s => s.staff_id === employeeId || s.name === employeeId);
    
    if (staff) {
      // 這裡您可以自訂密碼規則，目前先設定輸入 '1234' 即可登入
      if (password === '1234') {
        onLogin({ id: staff.staff_id, name: staff.name, role: 'staff' });
      } else {
        setError('密碼錯誤 (預設密碼為 1234)');
      }
    } else {
      setError('找不到此工號或姓名');
    }
  };

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', // 漂亮的漸層背景
      fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    }}>
      <div style={{
        background: 'rgba(255, 255, 255, 0.95)',
        padding: '3rem',
        borderRadius: '20px',
        boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
        width: '100%',
        maxWidth: '400px',
        textAlign: 'center'
      }}>
        <h2 style={{ color: '#333', marginBottom: '0.5rem', fontSize: '1.8rem' }}>護理排班系統</h2>
        <p style={{ color: '#666', marginBottom: '2rem' }}>請輸入工號登入</p>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '1.5rem', textAlign: 'left' }}>
            <label style={{ display: 'block', color: '#555', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 'bold' }}>工號 / 姓名</label>
            <input 
              type="text" 
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="例如: D01 或 admin"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border 0.3s'
              }}
            />
          </div>

          <div style={{ marginBottom: '2rem', textAlign: 'left' }}>
            <label style={{ display: 'block', color: '#555', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 'bold' }}>密碼</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="預設: 1234"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {error && (
            <div style={{ 
              color: '#e74c3c', 
              background: '#fdecea', 
              padding: '10px', 
              borderRadius: '6px', 
              marginBottom: '1.5rem',
              fontSize: '0.9rem' 
            }}>
              ⚠️ {error}
            </div>
          )}

          <button 
            type="submit" 
            style={{
              width: '100%',
              padding: '14px',
              background: '#667eea',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1.1rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 4px 6px rgba(102, 126, 234, 0.3)',
              transition: 'transform 0.1s'
            }}
            onMouseDown={(e) => e.target.style.transform = 'scale(0.98)'}
            onMouseUp={(e) => e.target.style.transform = 'scale(1)'}
          >
            登入系統
          </button>
        </form>

        <div style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1rem', fontSize: '0.8rem', color: '#999' }}>
          系統管理員登入：admin / admin
        </div>
      </div>
    </div>
  );
};