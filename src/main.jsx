import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'; // Import BrowserRouter for routing
import App from './App.jsx' // 確保這裡有引入 App
import LiquidTogglePreview from './pages/LiquidTogglePreview.jsx'
import ProfileWizardPreview from './pages/ProfileWizardPreview.jsx'
import ActivatePage from './components/ActivatePage.jsx'
import PrivacyNoticePage from './components/PrivacyNoticePage.jsx'
import './index.css' // 如果原本有這行

// /dev/* 預覽路由只在 dev 模式存在；production build 時 import.meta.env.DEV
// 為 false，整個 jsx 區塊會被 Vite tree-shake 掉，不會打包進 bundle。
const devRoutes = import.meta.env.DEV
  ? <Route path="/dev/profile-wizard" element={<ProfileWizardPreview />} />
  : null;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/liquid-toggle" element={<LiquidTogglePreview />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="/privacy-notice" element={<PrivacyNoticePage />} />
        {devRoutes}
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)