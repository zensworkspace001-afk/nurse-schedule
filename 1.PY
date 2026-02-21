import urllib.request
import json
import ssl

# ★★★ 請在此填入您的 API Key ★★★
API_KEY = "AIzaSyC93wpAHbYeKrfVgEAF9DkIFi2OAC33lJM" 

def list_and_test_models():
    # 步驟 1: 詢問 Google 有哪些模型可用 (List Models)
    list_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={API_KEY}"
    headers = {'Content-Type': 'application/json'}
    context = ssl._create_unverified_context()

    print("🔍 正在查詢您的 API Key 可用的模型列表...")
    
    try:
        req = urllib.request.Request(list_url, headers=headers, method='GET')
        with urllib.request.urlopen(req, context=context) as response:
            data = json.loads(response.read().decode('utf-8'))
            
        available_models = []
        print("\n📋 Google 回傳的模型清單：")
        
        if 'models' not in data:
            print("⚠️ 警告：回傳資料中沒有找到 'models' 欄位。")
            print(json.dumps(data, indent=2))
            return

        for model in data['models']:
            # 只找支援 'generateContent' (對話生成) 的模型
            if 'generateContent' in model.get('supportedGenerationMethods', []):
                name = model['name'] # 格式通常是 models/gemini-pro
                print(f"  - {name}")
                available_models.append(name)
        
        if not available_models:
            print("\n❌ 錯誤：您的帳號似乎沒有任何可用於「文字生成」的模型權限。")
            print("請確認 Google Cloud Console 中是否已啟用 'Generative Language API'。")
            return

        # 步驟 2: 自動挑選一個模型來測試
        # 優先順序：Flash -> Pro -> 任何其他
        selected_model = None
        for m in available_models:
            if 'flash' in m:
                selected_model = m
                break
        if not selected_model:
            for m in available_models:
                if 'gemini-pro' in m:
                    selected_model = m
                    break
        if not selected_model:
            selected_model = available_models[0]

        print(f"\n🎯 自動選擇測試模型：{selected_model}")
        
        # 步驟 3: 發送 Hello 測試
        # 注意：selected_model 已經包含 'models/' 前綴，不需要在 URL 中重複加
        # 網址格式修正：如果 selected_model 是 'models/gemini-1.5-flash'
        # URL 應該是 .../v1beta/models/gemini-1.5-flash:generateContent
        # 但有些 API 回傳的 name 已經包含 models/，我們直接接在 v1beta/ 後面即可，或者用 replace 處理
        
        clean_model_name = selected_model.replace("models/", "")
        generate_url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_model_name}:generateContent?key={API_KEY}"
        
        payload = {
            "contents": [{"parts": [{"text": "Say hello"}]}]
        }
        json_data = json.dumps(payload).encode('utf-8')
        
        print(f"🚀 正在發送測試請求到：{clean_model_name} ...")
        
        gen_req = urllib.request.Request(generate_url, data=json_data, headers=headers)
        with urllib.request.urlopen(gen_req, context=context) as gen_response:
            gen_result = gen_response.read().decode('utf-8')
            print("\n✅ 測試成功！您的 API 完全正常！")
            print("-" * 30)
            parsed = json.loads(gen_result)
            print("AI 回應：", parsed['candidates'][0]['content']['parts'][0]['text'])

    except urllib.error.HTTPError as e:
        print(f"\n❌ HTTP 錯誤 {e.code}:")
        print(e.read().decode('utf-8'))
    except Exception as e:
        print(f"\n❌ 發生未預期的錯誤: {e}")

if __name__ == "__main__":
    list_and_test_models()