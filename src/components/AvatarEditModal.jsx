import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Save, Loader2, AlertCircle, CheckCircle2, Camera, Trash2, ZoomIn, ZoomOut, RotateCcw, ScanFace, UserX } from 'lucide-react';
import { auth } from '../api/database';
import { detectFace } from '../utils/faceDetect';
import './AvatarEditModal.css';

// 頭貼編輯器：圓形 200×200 裁切框，使用者可縮放（0.5x–3x）+ 拖曳平移定位，
// 確認時把目前裁切結果繪到 canvas → WebP base64 → POST /api/complete-profile mode='update'
//
// 為什麼自己刻不用 react-easy-crop：
//   - 專案沒這套 dep；加一套 ~30 KB 只為一個 modal 不划算
//   - 需求很單純（縮放 + 平移，固定正方形輸出），實作量約 100 行
//
// 數學：
//   baseScale = max(FRAME/naturalW, FRAME/naturalH)   // fit cover
//   displayScale = baseScale * userScale
//   裁切視窗中心在原圖座標 = (natW/2 - posX/displayScale, natH/2 - posY/displayScale)
//   裁切大小 = FRAME / displayScale
const FRAME = 220;            // 預覽框邊長（CSS px）
const OUTPUT = 220;           // 主頭貼輸出邊長（存 NurseApp/Staff + StaffPrivate）
const THUMB = 64;             // 縮圖邊長（存 NurseApp/StaffPublic 給同事看）
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('檔案讀取失敗'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('無法解析圖片'));
      img.onload = () => resolve(img);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const AvatarEditModal = ({ myStaffRow, onClose }) => {
  const [closing, setClosing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  // 載入的原圖（HTMLImageElement）；null 代表還沒選圖
  const [rawImage, setRawImage] = useState(null);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // BlazeFace 人臉偵測狀態：
  //   idle    = 尚未跑（沒選圖）
  //   loading = 正在 lazy load tfjs / 跑推論
  //   pass    = 偵測到人臉
  //   nopass  = 沒偵測到（但允許 override）
  //   error   = 偵測流程出錯（不擋上傳，視同 pass）
  const [faceState, setFaceState] = useState('idle');
  const [faceMeta, setFaceMeta] = useState(null);   // { count, topConfidence }
  const [bypassFaceCheck, setBypassFaceCheck] = useState(false);  // 使用者選擇略過偵測警告

  // 拖曳狀態
  const dragRef = useRef(null);  // { startX, startY, origX, origY }
  const fileRef = useRef(null);

  const hasExistingAvatar = !!myStaffRow?.avatar;

  // fit-cover 的基底縮放（不含使用者 scale）
  const baseScale = useMemo(() => {
    if (!rawImage) return 1;
    return Math.max(FRAME / rawImage.naturalWidth, FRAME / rawImage.naturalHeight);
  }, [rawImage]);

  const displayScale = baseScale * scale;

  // 把 pos 限制在「圖片永遠覆蓋裁切框」的範圍內
  const clampPos = (p, sclEff) => {
    if (!rawImage) return p;
    const imgW = rawImage.naturalWidth * sclEff;
    const imgH = rawImage.naturalHeight * sclEff;
    const maxX = Math.max(0, (imgW - FRAME) / 2);
    const maxY = Math.max(0, (imgH - FRAME) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, p.x)),
      y: Math.min(maxY, Math.max(-maxY, p.y)),
    };
  };

  // scale 改變時要重新 clamp 一次（縮小可能讓圖跑出框外）
  useEffect(() => {
    setPos((p) => clampPos(p, displayScale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScale]);

  const handlePickFile = () => fileRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type)) {
      setMsg({ type: 'error', text: '僅支援 PNG / JPG / WebP / GIF / BMP' });
      e.target.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setMsg({ type: 'error', text: '原始檔案需在 8 MB 以內' });
      e.target.value = '';
      return;
    }
    try {
      const img = await loadImageFromFile(file);
      setRawImage(img);
      setScale(1);
      setPos({ x: 0, y: 0 });
      setMsg({ type: '', text: '' });
      setBypassFaceCheck(false);

      // 觸發 BlazeFace 偵測（lazy load 第一次會有 1-2 秒延遲）
      // 失敗一律視為 pass（不擋上傳）— 不要因為 detection model 載不到就讓使用者卡住
      setFaceState('loading');
      setFaceMeta(null);
      try {
        const result = await detectFace(img);
        if (result.hasFace) {
          setFaceState('pass');
          setFaceMeta({ count: result.count, topConfidence: result.topConfidence });
        } else {
          setFaceState('nopass');
        }
      } catch (err) {
        console.warn('人臉偵測失敗，視同通過:', err);
        setFaceState('error');
      }
    } catch (err) {
      setMsg({ type: 'error', text: '圖片載入失敗：' + err.message });
    } finally {
      e.target.value = '';
    }
  };

  // 拖曳處理（mouse + touch 共用）
  const beginDrag = (clientX, clientY) => {
    if (!rawImage) return;
    dragRef.current = { startX: clientX, startY: clientY, origX: pos.x, origY: pos.y };
  };
  const moveDrag = (clientX, clientY) => {
    if (!dragRef.current) return;
    const dx = clientX - dragRef.current.startX;
    const dy = clientY - dragRef.current.startY;
    setPos(clampPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }, displayScale));
  };
  const endDrag = () => { dragRef.current = null; };

  const onMouseDown = (e) => { e.preventDefault(); beginDrag(e.clientX, e.clientY); };
  const onMouseMove = (e) => moveDrag(e.clientX, e.clientY);
  const onTouchStart = (e) => { const t = e.touches[0]; if (t) beginDrag(t.clientX, t.clientY); };
  const onTouchMove  = (e) => { const t = e.touches[0]; if (t) moveDrag(t.clientX, t.clientY); };

  // 滾輪縮放（在預覽框內滾動時）
  const onWheel = (e) => {
    if (!rawImage) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s + delta)));
  };

  const handleReset = () => { setScale(1); setPos({ x: 0, y: 0 }); };

  const handleClose = () => {
    if (submitting) return;
    setClosing(true);
    setTimeout(onClose, 300);
  };

  // 把同一塊裁切視窗繪成指定邊長的 data URL；同時產主圖 + 縮圖兩種尺寸
  const renderToDataURL = (size, quality = 0.82) => {
    if (!rawImage) return null;
    const sw = FRAME / displayScale;
    const sh = FRAME / displayScale;
    const cx = rawImage.naturalWidth / 2 - pos.x / displayScale;
    const cy = rawImage.naturalHeight / 2 - pos.y / displayScale;
    const sx = cx - sw / 2;
    const sy = cy - sh / 2;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(rawImage, sx, sy, sw, sh, 0, 0, size, size);

    // 先試 webp；不支援回 jpeg
    let out = canvas.toDataURL('image/webp', quality);
    if (!out || !out.startsWith('data:image/webp')) {
      out = canvas.toDataURL('image/jpeg', quality);
    }
    return out;
  };

  const post = async (body) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('登入逾期，請重新登入');
    const res = await fetch('/api/complete-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '伺服器拒絕請求');
    return data;
  };

  const handleSave = async () => {
    setMsg({ type: '', text: '' });
    if (!rawImage) {
      setMsg({ type: 'error', text: '請先選擇一張圖片' });
      return;
    }

    // Soft block：偵測結果是「沒人臉」且使用者尚未確認略過時，先擋下來。
    // 偵測中（loading）也擋一下，等結果出來。偵測失敗（error）視同 pass。
    if (faceState === 'loading') {
      setMsg({ type: 'error', text: '人臉偵測進行中，請稍候 1-2 秒...' });
      return;
    }
    if (faceState === 'nopass' && !bypassFaceCheck) {
      setMsg({
        type: 'error',
        text: '圖中未偵測到人臉。請使用「無人臉警示」區的按鈕確認後再存檔。',
      });
      return;
    }

    const fullDataUrl = renderToDataURL(OUTPUT, 0.82);
    // 縮圖品質拉高一點（0.85），給同事在班表上看的小頭像更清楚
    const thumbDataUrl = renderToDataURL(THUMB, 0.85);
    if (!fullDataUrl || !thumbDataUrl) {
      setMsg({ type: 'error', text: '圖片處理失敗' });
      return;
    }
    setSubmitting(true);
    try {
      await post({ mode: 'update', avatar: fullDataUrl, avatar_thumb: thumbDataUrl });
      setMsg({ type: 'success', text: '✅ 頭貼已更新' });
      setTimeout(() => { setClosing(true); setTimeout(onClose, 300); }, 1000);
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
      setSubmitting(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm('確定要移除目前的頭貼嗎？')) return;
    setMsg({ type: '', text: '' });
    setSubmitting(true);
    try {
      // 主圖與縮圖一併清除
      await post({ mode: 'update', avatar: '', avatar_thumb: '' });
      setMsg({ type: 'success', text: '✅ 頭貼已移除' });
      setTimeout(() => { setClosing(true); setTimeout(onClose, 300); }, 800);
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`avatedit__overlay${closing ? ' avatedit__overlay--closing' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      role="button"
      tabIndex={-1}
      aria-label="點空白處關閉"
    >
      <div className={`avatedit__modal${closing ? ' avatedit__modal--closing' : ''}`}>
        <button onClick={handleClose} className="avatedit__close" disabled={submitting}>
          <X size={14} />
        </button>

        <h3 className="avatedit__title"><Camera size={18} /> 編輯頭貼</h3>

        {/* 預覽框 */}
        <div
          className="avatedit__frame"
          style={{ width: FRAME, height: FRAME }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={endDrag}
          onWheel={onWheel}
        >
          {rawImage ? (
            <img
              src={rawImage.src}
              alt=""
              draggable={false}
              className="avatedit__img"
              style={{
                width: rawImage.naturalWidth * displayScale,
                height: rawImage.naturalHeight * displayScale,
                transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
              }}
            />
          ) : (
            <div className="avatedit__empty">
              {hasExistingAvatar ? (
                <img src={myStaffRow.avatar} alt="目前頭貼" className="avatedit__existing" />
              ) : (
                <Camera size={36} />
              )}
              <span>{hasExistingAvatar ? '目前頭貼（請選擇新圖以替換）' : '尚未選擇圖片'}</span>
            </div>
          )}
        </div>

        {/* 縮放控制 */}
        {rawImage && (
          <div className="avatedit__controls">
            <button type="button" className="avatedit__icon-btn" onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.1))} title="縮小" disabled={submitting}>
              <ZoomOut size={14} />
            </button>
            <input
              type="range"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={0.01}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="avatedit__slider"
              disabled={submitting}
            />
            <button type="button" className="avatedit__icon-btn" onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.1))} title="放大" disabled={submitting}>
              <ZoomIn size={14} />
            </button>
            <button type="button" className="avatedit__icon-btn" onClick={handleReset} title="重置" disabled={submitting}>
              <RotateCcw size={14} />
            </button>
          </div>
        )}

        {/* 人臉偵測狀態 banner — 只在已選圖時顯示 */}
        {rawImage && faceState !== 'idle' && (
          <div
            className={
              'avatedit__face avatedit__face--' +
              (faceState === 'loading' ? 'loading'
                : faceState === 'pass' ? 'pass'
                : faceState === 'nopass' ? 'nopass'
                : 'error')
            }
          >
            {faceState === 'loading' && (
              <><Loader2 size={14} className="avatedit__spin" /> 正在偵測圖中是否有人臉...</>
            )}
            {faceState === 'pass' && (
              <>
                <ScanFace size={14} />
                <span>
                  ✓ 已偵測到{faceMeta?.count > 1 ? ` ${faceMeta.count} 張` : ''}人臉
                  {faceMeta?.topConfidence ? `（信心度 ${Math.round(faceMeta.topConfidence * 100)}%）` : ''}
                </span>
              </>
            )}
            {faceState === 'nopass' && (
              <div className="avatedit__face-warn">
                <div className="avatedit__face-warn-msg">
                  <UserX size={14} /> 未偵測到人臉。確認這張圖能代表您嗎？
                </div>
                <label className="avatedit__face-bypass">
                  <input
                    type="checkbox"
                    checked={bypassFaceCheck}
                    onChange={(e) => setBypassFaceCheck(e.target.checked)}
                  />
                  <span>我確認要使用這張圖片</span>
                </label>
              </div>
            )}
            {faceState === 'error' && (
              <><AlertCircle size={14} /> 偵測模組載入失敗，已略過檢查。</>
            )}
          </div>
        )}

        <p className="avatedit__hint">
          {rawImage
            ? '可以拖曳圖片調整位置、用滑桿或滾輪調整大小。'
            : '系統會自動把選定的圖片裁成 220×220 圓形頭貼。'}
        </p>

        {/* 動作按鈕區 */}
        <div className="avatedit__actions">
          <input
            type="file"
            ref={fileRef}
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button type="button" onClick={handlePickFile} className="avatedit__btn avatedit__btn--ghost" disabled={submitting}>
            <Camera size={14} /> {rawImage ? '重新選擇' : '選擇圖片'}
          </button>
          {hasExistingAvatar && !rawImage && (
            <button type="button" onClick={handleRemove} className="avatedit__btn avatedit__btn--danger-ghost" disabled={submitting}>
              <Trash2 size={14} /> 移除頭貼
            </button>
          )}
        </div>

        {msg.text && (
          <div className={`avatedit__msg ${msg.type === 'error' ? 'avatedit__msg--error' : 'avatedit__msg--success'}`}>
            {msg.type === 'error' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />} {msg.text}
          </div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={
            submitting ||
            !rawImage ||
            faceState === 'loading' ||
            (faceState === 'nopass' && !bypassFaceCheck)
          }
          className={`avatedit__submit${submitting ? ' avatedit__submit--loading' : ''}${
            !rawImage || faceState === 'loading' || (faceState === 'nopass' && !bypassFaceCheck) ? ' avatedit__submit--disabled' : ''
          }`}
        >
          {submitting
            ? <><Loader2 size={14} className="avatedit__spin" /> 上傳中...</>
            : faceState === 'loading'
              ? <><Loader2 size={14} className="avatedit__spin" /> 等待偵測完成...</>
              : <><Save size={14} /> 儲存頭貼</>}
        </button>
      </div>
    </div>
  );
};

export default AvatarEditModal;
