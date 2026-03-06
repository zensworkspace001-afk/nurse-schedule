%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#fff', 'edgeLabelBackground':'#fff', 'tertiaryColor': '#fff'}}}%%
graph TD
    %% 定義特殊節點樣式 (樣式需符合學術簡約風格)
    classDef startend fill:#333,stroke:#333,stroke-width:2px,color:#fff,font-weight:bold;
    classDef decision fill:#fff,stroke:#333,stroke-width:2px,color:#000,font-weight:bold;
    classDef process fill:#f4f4f4,stroke:#333,stroke-width:1px,color:#000;
    classDef block fill:#e74c3c,stroke:#c0392b,stroke-width:2px,color:#fff,font-weight:bold;
    classDef success fill:#2ecc71,stroke:#27ae60,stroke-width:2px,color:#fff,font-weight:bold;

    %% --- 流程開始 ---
    Start([使用者嘗試存取 URL]) ::: startend
    
    %% --- 第一層防護：前端路由守衛 (Frontend Route Guard) ---
    subgraph FG [🛡️ 第一層防護：路由守衛]
        CheckToken{檢查 Session<br/>Token 是否存在/合法?} ::: decision
    end

    Start --> FG
    CheckToken -- Invalid/No --> LoginUI[顯示登入介面] ::: process
    CheckToken -- Valid --> DirectJump[跳過登入, 執行狀態掃描] ::: process

    %% --- 憑證驗證 ---
    Input[使用者輸入帳號/密碼] ::: process
    LoginUI --> Input
    Input --> VerifyCreds{驗證憑證<br/>(Firebase Auth)} ::: decision
    VerifyCreds -- 失敗 --> ShowError[顯示錯誤訊息] ::: process
    ShowError --> LoginUI

    %% --- 第二層防護：零信任動態狀態檢驗 (Zero-Trust Validation) ---
    VerifyCreds -- 成功 --> GetProfile[提取員工完整 Profile data] ::: process
    DirectJump --> GetProfile

    subgraph ZT [🔒 第二層防護：零信任狀態掃描]
        CheckActive{is_active<br/>在職狀態?} ::: decision
        CheckLeave{leave_status<br/>離職/長假狀態?} ::: decision
        CheckTurn{Agentic Turn<br/>AI 選班發球權?} ::: decision
    end

    GetProfile --> CheckActive
    
    CheckActive -- Terminated/No --> Block离职[⛔ 阻斷存取<br/>顯示帳號無效] ::: block
    CheckActive -- Active/Yes --> CheckLeave
    
    CheckLeave -- LongLeave/On --> Block休假[⛔ 路由攔截<br/>導向休假專用畫面] ::: block
    CheckLeave -- Working/Off --> RBAC_Path[執行角色權限分流] ::: process

    %% --- 第三層防護：RBAC 存取控制 (Authorization Layer) ---
    subgraph RBAC [🔑 第三層防護：RBAC 模型]
        IdentifyRole{判定使用者角色<br/>(admin / staff)} ::: decision
    end

    RBAC_Path --> IdentifyRole
    
    IdentifyRole -- admin --> AdminUI([✅ 導向護理長管理後台]) ::: success
    IdentifyRole -- staff --> CheckTurn

    CheckTurn -- NotTurn/No --> Block等待[漏斗畫面<br/>等待交棒] ::: block
    CheckTurn -- IsTurn/Yes --> StaffUI([✅ 導向護理師自助選班介面]) ::: success

    %% --- 連接終點 ---
    Block离职 --> End([結束]) ::: startend
    Block休假 --> End
    Block等待 --> End
    AdminUI --> End
    StaffUI --> End