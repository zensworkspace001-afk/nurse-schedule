import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'; // Import BrowserRouter for routing
import App from './App.jsx' // 確保這裡有引入 App
import LiquidTogglePreview from './pages/LiquidTogglePreview.jsx'
import ActivatePage from './components/ActivatePage.jsx'
import './index.css' // 如果原本有這行

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/liquid-toggle" element={<LiquidTogglePreview />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)