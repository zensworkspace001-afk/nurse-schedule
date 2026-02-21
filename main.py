import cv2
import numpy as np
import pyaudio
import time
import threading
from ultralytics import YOLO

# --- 設定參數 ---
THRESHOLD_DB = 30        # 觸發分貝
CHUNK = 1024             # 音訊緩衝區大小
FORMAT = pyaudio.paInt16 # 音訊格式
CHANNELS = 1             # 單聲道
RATE = 44100             # 取樣率
COOLDOWN = 3             # 拍照冷卻時間 (秒)

# --- 初始化 ---
print("正在載入 AI 模型...")
model = YOLO('yolov8n.pt') 
audio = pyaudio.PyAudio()
cap = cv2.VideoCapture(0)  

# 設定字體
FONT = cv2.FONT_HERSHEY_SIMPLEX

def calculate_db(audio_data):
    # 將二進位數據轉換為整數陣列
    data = np.frombuffer(audio_data, dtype=np.int16)
    # 計算 RMS (均方根)
    rms = np.sqrt(np.mean(data**2))
    # 轉換為分貝 (需依麥克風靈敏度校正，這裡加 20 是為了讓數值好看一點)
    if rms > 0:
        db = 20 * np.log10(rms) + 20 
    else:
        db = 0
    return db

def detect_and_save(frame, current_db):
    print(f"🔊 觸發！({current_db:.1f} dB) 正在分析...")
    results = model(frame)
    
    # 這裡改成 0 (人) 方便您測試，若要抓車改回 [2, 3, 5, 7]
    target_classes = [ 2, 3, 5, 7, 39, 41, 67] 
    
    vehicle_detected = False
    
    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            if cls_id in target_classes:
                vehicle_detected = True
                # 畫出物件框
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
                label = f"{model.names[cls_id]} {box.conf[0]:.2f}"
                cv2.putText(frame, label, (x1, y1 - 10), FONT, 0.5, (0, 0, 255), 2)

    if vehicle_detected:
        filename = f"capture_{int(time.time())}.jpg"
        cv2.imwrite(filename, frame)
        print(f"📸 已存檔: {filename}")

def main_loop():
    last_trigger_time = 0
    
    stream = audio.open(format=FORMAT, channels=CHANNELS,
                        rate=RATE, input=True,
                        frames_per_buffer=CHUNK)

    print(f"系統啟動中... 對著麥克風大叫試試看！")

    try:
        while True:
            # 1. 讀取畫面
            ret, frame = cap.read()
            if not ret: break

            # 2. 讀取聲音並計算分貝
            data = stream.read(CHUNK, exception_on_overflow=False)
            db = calculate_db(data)

            # --- [新增功能] 決定文字顏色 ---
            if db > THRESHOLD_DB:
                text_color = (0, 0, 255) # 紅色 (警告)
                status_text = "WARNING!"
            else:
                text_color = (0, 255, 0) # 綠色 (正常)
                status_text = "Normal"

            # --- [新增功能] 將分貝數寫在畫面上 ---
            # 參數格式: 影像, 文字, 座標(x,y), 字體, 大小, 顏色, 粗細
            cv2.putText(frame, f"Noise Level: {int(db)} dB", (30, 50), 
                       FONT, 1.2, text_color, 3)
            
            # 顯示狀態文字
            cv2.putText(frame, f"Status: {status_text}", (30, 100), 
                       FONT, 0.8, text_color, 2)

            # 3. 判斷觸發 (與之前邏輯相同)
            current_time = time.time()
            if db > THRESHOLD_DB and (current_time - last_trigger_time) > COOLDOWN:
                last_trigger_time = current_time
                # 傳入 frame.copy() 避免繪圖影響到原始影像分析
                threading.Thread(target=detect_and_save, args=(frame.copy(), db)).start()

            # 4. 顯示視窗
            cv2.imshow('AI Noise Camera', frame)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    except KeyboardInterrupt:
        print("停止程式...")
    finally:
        stream.stop_stream()
        stream.close()
        audio.terminate()
        cap.release()
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main_loop()