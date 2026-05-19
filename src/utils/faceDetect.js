// 頭貼人臉偵測（BlazeFace via TensorFlow.js）
//
// 全部 dynamic import — 主 bundle 載入時 tfjs (~600 KB) 與 blazeface model (~400 KB)
// 都不會被打進去。只有當員工真的打開 AvatarEditModal 並選圖時才會 lazy load。
//
// 為什麼把 model 設成 module-scope singleton：
//   BlazeFace.load() 會抓 weight files 解碼 + warmup，第一次約 1-2 秒。後續所有
//   detect() 呼叫應該共用同一個 model instance，避免每次選圖都重抓。
//
// API 對外只暴露 detectFace(image)；由它內部負責 lazy load + 快取。
let _modelPromise = null;
let _tfReady = false;

async function ensureModel() {
  if (_modelPromise) return _modelPromise;

  _modelPromise = (async () => {
    // 1. 載入 TF.js core + WebGL backend
    //    用 dynamic import 是為了讓 Vite 把 tfjs 切成獨立 chunk
    const tf = await import('@tensorflow/tfjs');
    if (!_tfReady) {
      await tf.ready();              // 等 WebGL backend 初始化
      _tfReady = true;
    }

    // 2. 載入 BlazeFace 模型
    const blazeface = await import('@tensorflow-models/blazeface');
    const model = await blazeface.load({
      // maxFaces 設 5 — 我們只關心「有沒有臉」，但若使用者上傳合照也能正確判斷
      maxFaces: 5,
      // inputWidth/Height 用預設 128（BlazeFace 原生輸入大小）
    });

    return model;
  })();

  return _modelPromise;
}

/**
 * 偵測圖片中是否有人臉。
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @returns {Promise<{hasFace: boolean, count: number, topConfidence: number, biggestBox?: {x,y,w,h}}>}
 */
export async function detectFace(image) {
  const model = await ensureModel();

  // returnTensors=false 直接拿到 JS array，省去手動 dispose
  // input 可以是 <img>, <canvas>, ImageData, ImageBitmap 等
  const predictions = await model.estimateFaces(image, false);

  if (!predictions || predictions.length === 0) {
    return { hasFace: false, count: 0, topConfidence: 0 };
  }

  // BlazeFace 的 prediction 結構：
  //   { topLeft: [x1,y1], bottomRight: [x2,y2], landmarks: [[x,y]*6], probability: [0..1] }
  //   probability 是長度 1 的 array
  let topConfidence = 0;
  let biggestArea = 0;
  let biggestBox = null;

  for (const p of predictions) {
    const conf = Array.isArray(p.probability) ? p.probability[0] : p.probability;
    if (conf > topConfidence) topConfidence = conf;

    const w = p.bottomRight[0] - p.topLeft[0];
    const h = p.bottomRight[1] - p.topLeft[1];
    const area = w * h;
    if (area > biggestArea) {
      biggestArea = area;
      biggestBox = { x: p.topLeft[0], y: p.topLeft[1], w, h };
    }
  }

  return {
    hasFace: true,
    count: predictions.length,
    topConfidence,
    biggestBox,
  };
}

/**
 * 預載 model（給應用程式想在 idle 時 warmup 用，目前未串接）。
 */
export function warmupFaceModel() {
  ensureModel().catch(() => { /* 失敗就算了，detectFace 呼叫時會再試 */ });
}
