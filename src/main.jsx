import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx' // 確保這裡有引入 App
import './index.css' // 如果原本有這行

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)