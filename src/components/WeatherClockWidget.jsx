import React, { useEffect, useRef, useState } from 'react';
import {
  Sun, Cloud, Cloudy, CloudRain, CloudDrizzle, CloudSnow,
  CloudLightning, CloudFog, MapPin, ChevronDown,
} from 'lucide-react';
import './WeatherClockWidget.css';

// 登入頁右上角的「天氣 + 時鐘」widget
// - 城市可由使用者切換（auto = 用 IP 推測；或手選台灣主要城市）
// - 天氣圖示可點切換手動覆蓋（auto / 晴 / 多雲 / …）
// - 時鐘每秒更新
// - 天氣 10 分鐘 refresh 一次
//
// 環境變數：VITE_OPENWEATHER_API_KEY  （在 OpenWeatherMap 免費註冊後取得）

const TAIWAN_CITIES = [
  { value: 'auto',                label: '自動偵測 (IP)' },
  { value: 'Taipei,TW',           label: '台北' },
  { value: 'New Taipei City,TW',  label: '新北' },
  { value: 'Taoyuan,TW',          label: '桃園' },
  { value: 'Taichung,TW',         label: '台中' },
  { value: 'Tainan,TW',           label: '台南' },
  { value: 'Kaohsiung,TW',        label: '高雄' },
  { value: 'Keelung,TW',          label: '基隆' },
  { value: 'Hsinchu,TW',          label: '新竹' },
  { value: 'Chiayi,TW',           label: '嘉義' },
  { value: 'Hualien,TW',          label: '花蓮' },
  { value: 'Taitung,TW',          label: '台東' },
];

// 手動覆蓋選項：點圖示時依序循環
const OVERRIDE_OPTIONS = [
  { value: 'auto',     label: '自動',  icon: Sun, },         // auto 不真的用 Sun，只是占位 — render 時看 weather
  { value: 'sunny',    label: '晴',    icon: Sun, },
  { value: 'cloudy',   label: '多雲',  icon: Cloudy, },
  { value: 'overcast', label: '陰',    icon: Cloud, },
  { value: 'rain',     label: '雨',    icon: CloudRain, },
  { value: 'drizzle',  label: '毛毛雨', icon: CloudDrizzle, },
  { value: 'storm',    label: '雷雨',  icon: CloudLightning, },
  { value: 'snow',     label: '雪',    icon: CloudSnow, },
  { value: 'fog',      label: '霧',    icon: CloudFog, },
];

// OpenWeatherMap weather id → 我們的內部分類
function classifyOwm(id) {
  if (id >= 200 && id < 300) return 'storm';
  if (id >= 300 && id < 400) return 'drizzle';
  if (id >= 500 && id < 600) return 'rain';
  if (id >= 600 && id < 700) return 'snow';
  if (id >= 700 && id < 800) return 'fog';
  if (id === 800)            return 'sunny';
  if (id > 800)              return id <= 802 ? 'cloudy' : 'overcast';
  return 'cloudy';
}

const WeatherClockWidget = () => {
  const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY;
  const [city, setCity] = useState(() => localStorage.getItem('weatherCity') || 'auto');
  const [override, setOverride] = useState(() => localStorage.getItem('weatherOverride') || 'auto');
  const [weather, setWeather] = useState(null);
  const [now, setNow] = useState(new Date());
  const [showCityPicker, setShowCityPicker] = useState(false);
  const [err, setErr] = useState(null);
  const refreshTimerRef = useRef(null);

  // 時鐘 — 每秒一次
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // localStorage 同步
  useEffect(() => { localStorage.setItem('weatherCity', city); }, [city]);
  useEffect(() => { localStorage.setItem('weatherOverride', override); }, [override]);

  // 天氣 — city 改變時重抓，每 10 分鐘 refresh
  useEffect(() => {
    if (!apiKey) {
      setErr('未設定 VITE_OPENWEATHER_API_KEY');
      return;
    }
    let cancelled = false;

    async function fetchWeather() {
      try {
        let lat, lon, displayName;

        if (city === 'auto') {
          // IP 定位 — ipapi.co 免費無 key
          const ipRes = await fetch('https://ipapi.co/json/');
          if (!ipRes.ok) throw new Error('IP 定位失敗');
          const ipData = await ipRes.json();
          lat = ipData.latitude;
          lon = ipData.longitude;
          displayName = ipData.city || ipData.region || '所在地';
        } else {
          // 用 OWM 的 geocoding 把城市字串轉座標
          const geoRes = await fetch(
            `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${apiKey}`,
          );
          if (!geoRes.ok) throw new Error('地理查詢失敗');
          const geoData = await geoRes.json();
          if (!geoData.length) throw new Error('找不到城市');
          lat = geoData[0].lat;
          lon = geoData[0].lon;
          displayName = TAIWAN_CITIES.find(c => c.value === city)?.label || city.split(',')[0];
        }

        const wRes = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=zh_tw`,
        );
        if (!wRes.ok) throw new Error(`OWM ${wRes.status}`);
        const wData = await wRes.json();
        if (cancelled) return;

        setWeather({
          temp: Math.round(wData.main.temp),
          feels: Math.round(wData.main.feels_like),
          desc: wData.weather?.[0]?.description || '',
          owmId: wData.weather?.[0]?.id ?? 800,
          city: displayName,
        });
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }

    fetchWeather();
    refreshTimerRef.current = setInterval(fetchWeather, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(refreshTimerRef.current);
    };
  }, [city, apiKey]);

  // 計算當下要顯示哪個圖示 — 手動 override 優先
  const effectiveCategory = override !== 'auto'
    ? override
    : (weather ? classifyOwm(weather.owmId) : 'cloudy');

  const Icon = OVERRIDE_OPTIONS.find(o => o.value === effectiveCategory)?.icon || Cloud;
  const label = OVERRIDE_OPTIONS.find(o => o.value === effectiveCategory)?.label || '—';

  const handleIconCycle = () => {
    const idx = OVERRIDE_OPTIONS.findIndex(o => o.value === override);
    const next = OVERRIDE_OPTIONS[(idx + 1) % OVERRIDE_OPTIONS.length];
    setOverride(next.value);
  };

  const formatTime = (d) => {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
  const formatDate = (d) => {
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 (週${week})`;
  };

  return (
    <div className="weather-clock">
      <div className="weather-clock__row weather-clock__row--weather">
        <button
          className="weather-clock__icon-btn"
          onClick={handleIconCycle}
          title={`點切換顯示（目前：${override === 'auto' ? '自動' : label}）`}
        >
          <Icon size={28} />
        </button>
        <div className="weather-clock__weather-info">
          <div className="weather-clock__temp">
            {weather ? `${weather.temp}°` : '—'}
          </div>
          <div className="weather-clock__desc">
            {override !== 'auto'
              ? `${label}（手動）`
              : (weather?.desc || (err ? '無法載入' : '載入中…'))}
          </div>
        </div>
      </div>

      <div className="weather-clock__row weather-clock__row--location">
        <button
          className="weather-clock__city-btn"
          onClick={() => setShowCityPicker(s => !s)}
          title="點切換城市"
        >
          <MapPin size={11} />
          <span>{weather?.city || (city === 'auto' ? '偵測中…' : city.split(',')[0])}</span>
          <ChevronDown size={11} />
        </button>
        {showCityPicker && (
          <ul className="weather-clock__city-list" role="menu">
            {TAIWAN_CITIES.map(opt => (
              <li
                key={opt.value}
                className={`weather-clock__city-item${city === opt.value ? ' weather-clock__city-item--active' : ''}`}
                onClick={() => { setCity(opt.value); setShowCityPicker(false); }}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="weather-clock__divider" />

      <div className="weather-clock__row weather-clock__row--clock">
        <div className="weather-clock__time">{formatTime(now)}</div>
        <div className="weather-clock__date">{formatDate(now)}</div>
      </div>
    </div>
  );
};

export default WeatherClockWidget;
