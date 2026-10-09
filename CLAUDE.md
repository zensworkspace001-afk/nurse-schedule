# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (localhost:5173)
npm run build        # Build frontend → dist/
npm run lint         # ESLint checks
npm run preview      # Preview production build
npm run electron:build  # Build desktop app → dist-electron/
npm run test:e2e     # Run Playwright end-to-end tests (headless chromium)
npm run test:e2e:ui  # Playwright UI runner
npm run test:e2e:report  # Open the last HTML report
```

**Testing:** Playwright specs live in `tests/e2e/`. The config auto-starts `npm run dev` and reuses it locally. Tests hit the real Vercel/Firebase backend, so provide credentials via env:

```bash
TEST_STAFF_ID=n001 TEST_STAFF_PW=yourpw npm run test:e2e        # all specs
TEST_STAFF_ID=n001 TEST_STAFF_PW=yourpw npx playwright test tests/e2e/login.spec.js  # single file
npx playwright test -g "wrong password"                          # by title
```

Specs call `test.skip(...)` when creds are missing, so CI without secrets still passes cleanly. Traces, screenshots, and videos are retained only on failure under `test-results/`.

Dev server proxies `/api/*` requests to `https://nurse-schedule-bachelor.vercel.app` (configured in `vite.config.js`), so local frontend connects to the production Vercel serverless backend.

**Scheduling microservice (`main1.py` SA + `cpsat_service.py` CP-SAT; separate Python service on Cloud Run):**

```bash
pip install -r requirements.txt   # fastapi, pydantic v1, firebase-admin, ortools (Docker image uses Python 3.12)
uvicorn main1:app --reload --port 8000
python local_test/hybrid/test_cpsat_service.py   # endpoint tests with fake token + fake Firestore store (needs httpx)
```

Point the frontend at a local instance with `VITE_SCHEDULE_ENGINE_URL=http://localhost:8000` in `.env.local`. Locally, Firebase Admin init logs an error unless `FIREBASE_*` key env vars are set — expected; authenticated endpoints then 401, so use the test script for logic. Deploy (Cloud Run, project `scheduling-systembachelor`, `asia-east1`, service `nurse-schedule-engine`, runs as dedicated SA `schedule-engine@…` holding only `roles/datastore.user`):

```bash
gcloud run deploy nurse-schedule-engine --source . --region asia-east1 --project scheduling-systembachelor \
  --service-account schedule-engine@scheduling-systembachelor.iam.gserviceaccount.com \
  --cpu 2 --memory 2Gi --cpu-boost --min-instances 0 --max-instances 2 --concurrency 1 --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars "^@^FIREBASE_PROJECT_ID=scheduling-systembachelor@CPSAT_WORKERS=2@ALLOWED_ORIGINS=http://localhost:5173,https://nurse-schedule-bachelor.vercel.app" --quiet
```

`--source .` uploads only what `.gcloudignore` whitelists (and Docker only what `.dockerignore` whitelists) — a new file the service needs must be added to **both** plus a `COPY` in `Dockerfile`. Claude Code's auto mode blocks production deploys, so the user runs this themselves. `CPSAT_DEPLOY.md` covers the older Render/Railway/Fly.io setup (Render still hosts the legacy SA instance).

**`.env.local`** holds the six public `VITE_FIREBASE_*` web-client values plus `VITE_SCHEDULE_ENGINE_URL` (normally via `vercel env pull`; the Vercel CLI is not installed by default). `npm run dev` logs a dependency-scan error for `cannon-es` from `public/sphere-drop.html` — harmless, unrelated to the app.

**MySQL (optional — `access_logs` hybrid storage):**

The app is Firestore-first, but the audit log (`access_logs`) can optionally live in MySQL instead — it's append-only, has no real-time UI, and benefits from SQL filtering/aggregation. This is a deliberate polyglot-persistence split: cold/queryable data → MySQL, hot/real-time data (schedules, selection turns, staff) → Firestore. MySQL is **off by default**; nothing connects unless you opt in.

```bash
# 1) create the table (any MySQL 8 instance — local, PlanetScale, Railway, RDS…)
mysql -u USER -p DBNAME < sql/access_logs.sql

# 2) point the backend at it (Vercel env, or .env.local)
#    DATABASE_URL=mysql://user:pass@host:3306/dbname   (or MYSQL_HOST/USER/PASSWORD/DATABASE)
#    ACCESS_LOG_BACKEND=both     # dual-write during transition; flip to `mysql` after backfill

# 3) backfill existing Firestore rows (dry-run → commit)
node --env-file=.env.local scripts/migrate-access-logs-to-mysql.js
node --env-file=.env.local scripts/migrate-access-logs-to-mysql.js --commit
```

Writer is `api/_lib/accessLog.js` (`writeAccessLog`, signature unchanged so its ~13 callers need no edits); reader is `admin-user.js` action `list-access-logs` (folded in rather than a new function — Vercel Hobby's 12-function limit is full). `AccessLogPanel` fetches that endpoint instead of subscribing to Firestore (loses live updates — acceptable for an audit log).

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: a `lint` job (`npm ci && npm run lint`), then an `e2e` job (needs `lint` to pass first) that installs Playwright's Chromium and runs `npm run test:e2e` against the deployed Vercel/Firebase backend using repo secrets (`VITE_FIREBASE_*`, `TEST_STAFF_ID`/`TEST_STAFF_PW`, `TEST_ADMIN_ID`/`TEST_ADMIN_PW`). Specs `test.skip()` themselves when creds are missing, so a fork without secrets still passes. Playwright report + failure traces are uploaded as artifacts (14-day retention).

## Environment Variables

All keys live in Vercel dashboard (Settings > Environment Variables). For local dev, `.env.local` is pulled via `vercel env pull`:
- `VITE_FIREBASE_*` — Firebase client SDK config (6 keys)
- `GEMINI_API_KEY` — Google Gemini AI
- `RESEND_API_KEY` — Email service
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Firebase Admin SDK (backend only)
- `CRON_SECRET` — Vercel Cron job authentication
- `FIELD_ENC_KEY` — **AES-256-GCM master key for field-level encryption** (base64-encoded 32 bytes). Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Lose this and all encrypted fields are unrecoverable** — back it up offline. Used by `api/secure-field.js` and `scripts/migrate-encrypt.js`.
- `VITE_SCHEDULE_ENGINE_URL` — Cloud Run scheduling engine (staffing estimate, leave wishes, CP-SAT direct assignment), read by `src/api/scheduleEngine.js`; falls back to the hardcoded Cloud Run URL when unset. **Must also be in `vercel.json` CSP `connect-src`** (it is) or the production browser blocks the fetch.
- `VITE_CPSAT_URL` — **Legacy.** URL of the Render-hosted SA instance; the frontend no longer reads it since the SA button was replaced (see Scheduling Engines).
- `ACCESS_LOG_BACKEND` — selects where `api/_lib/accessLog.js` reads/writes audit rows: `firestore` (default — unset behaves exactly as before), `mysql`, or `both` (dual-write during a transition; reads prefer MySQL). Part of the hybrid/polyglot-persistence split where cold/append-only `access_logs` can live in MySQL while hot real-time data (schedules, turns, staff) stays in Firestore. See **MySQL (optional, access_logs only)** below.
- `DATABASE_URL` **or** `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` (+ optional `MYSQL_POOL_SIZE`, default 3) — MySQL connection for `api/_lib/mysql.js`. Only needed when `ACCESS_LOG_BACKEND` includes `mysql`; otherwise no MySQL connection is ever opened.
- `MYSQL_SSL` / `MYSQL_SSL_CA` (optional) — TLS for the MySQL connection. Cloud MySQL (PlanetScale/Aiven/Railway/RDS…) goes over the public internet and effectively requires TLS; local MySQL (Laragon) neither supports nor needs it. `getPool()` **auto-decides when `MYSQL_SSL` is unset**: localhost/127.0.0.1 → no TLS, remote host → TLS with cert verification — so a public-CA cloud provider works by just filling `DATABASE_URL`. Override with `MYSQL_SSL=true|require|strict` (verify), `relaxed|no-verify` (encrypt, skip verify — self-signed/test), or `false|off` (disable). `MYSQL_SSL_CA` = inline PEM for a private CA (e.g. AWS RDS bundle; `\n` escapes are unescaped); setting it implies verify.

**Scheduling microservice env vars** (set on Cloud Run / Render, NOT Vercel): on Cloud Run **no Firebase key is needed** — `_init_firebase()` uses the service account (ADC) when `K_SERVICE` is set and no `FIREBASE_PRIVATE_KEY`/`FIREBASE_SERVICE_ACCOUNT` is present; Render still uses `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`. `ENGINE_TIME_BUDGET` (per-request compute budget in seconds, default 110 — estimate + solve stop and report instead of hitting Cloud Run's 300 s timeout, which otherwise leaves the cut request computing in the background and starving the next one; generation never runs the staffing search — it reuses a cached estimate if present, otherwise only applies the max-headcount trim, then a feasibility-only solve with wishes pinned (≤60% of the remaining budget) supplies a legal starting schedule that `solve_cpsat(hint=…)` can only improve on, so a result comes back whenever one is found in time), `ALLOWED_ORIGINS` (CORS whitelist — Vercel *preview* domains are not on it, so previews get CORS-blocked), `CPSAT_WORKERS` (CP-SAT threads, default `os.cpu_count()`), `WISH_CHECK_SECONDS` (leave-wish feasibility check time limit, default 20), `ADMIN_EMAIL` (default `admin@hospital.com`), `RATE_LIMIT_PER_MIN` (default 5, shared in-memory buckets), `SA_MAX_ITERATIONS` (legacy SA, default 50000).

## Architecture

**Full-stack web app** for nursing shift scheduling at a Taiwan hospital. React/Vite frontend + Vercel serverless backend. All persistent state in Firebase Firestore. UI text is Traditional Chinese (繁體中文).

### Frontend (`src/`)

**Styling convention:** Each component has a co-located `.css` file using BEM naming (e.g. `.publish__header`, `.staff-mgmt__row--inactive`). Only truly dynamic values (runtime-computed colors) remain as inline styles. Do not add new inline styles — use CSS classes. Modals/overlays use glassmorphism (`backdrop-filter: blur()`, `rgba` backgrounds) with fade-in/fade-out CSS animations (closing state + `setTimeout` for deferred unmount).

`src/App.jsx` — Root `NurseSchedulingSystem` component. Owns all top-level state (staffData, schedule, finalizedSchedule, violations, etc.), Firebase `onSnapshot` subscriptions, cloud read/write engines (2s debounce), and core business logic: `handleStaffScheduleUpdate`, `calculateAndNotifyNextStaff`, `handlePushToHistory`, `handleSaveAndPublish`. Routes to `ManagerInterface` (admin) or `StaffDashboard` (staff) based on role.

`src/constants.js` — Shared constants and pure functions. All compliance logic lives here: `SHIFT_TYPES`, `LABOR_LAW_RULES`, `calculateAnnualLeave`, `checkLaborLawCompliance`, `checkSkillMixSafety`, `calculateScheduleRisks`. Import from here — do not duplicate.

`src/api/scheduleEngine.js` — `fetch` wrappers for the Cloud Run engine (`estimateStaffing`, `submitLeaveWish`, `generateCpsatSchedule`); attaches the Firebase ID token and surfaces the backend's `detail` message as the thrown error.

`src/api/database.js` — All Firestore CRUD: `subscribeToSettings`, `subscribeToStaff` (admin), `subscribeToStaffPublic` (staff colleagues view), `subscribeToMyStaffPrivate` (staff own row), `subscribeToSchedule`, `saveGlobalSettings`, `saveGlobalStaff` (batch-writes the three staff docs), `saveMonthlySchedule`, `updateStaffSchedule`, `saveArchiveReport`, `subscribeToArchiveReports`, `clearArchiveReports`, `backupScheduleToArchive`, `buildStaffPublicProjection`, plus leave-wish helpers (`saveLeaveWishSettings`, `subscribeToLeaveWishCounts`, `subscribeToMyLeaveWish`, `subscribeToLeaveWishEntries` — read-only; writes go through the engine). Also exports `auth` and `db` Firebase instances.

**Component hierarchy:**
- `App.jsx` → `LoginPanel` (unauthenticated) | `ManagerInterface` (admin) | `ProfileWizard` (staff first-login, gated by `profile_completed !== true`) | `StaffDashboard` (staff)
- Public routes (registered in `main.jsx`, no auth required): `/activate` (ActivatePage), `/privacy-notice` (PrivacyNoticePage)
- `ManagerInterface` → tab router for: `StaffManagementPanel` (also hosts `AnnouncementEditor`), `LeaveWishPanel` (tab「人力與預假」, the default tab; `/requirements` redirects here — it embeds `RequirementsPanel` as a collapsible「⓪ 病房設定」section: bed count + hospital level + ratios are the single source of the 衛福部 nurse-patient legal floor and the default daily `requirements` used by SchedulePanel, LeaveWishPanel and StatisticsPanel), `SchedulePanel`, `PublishPanel`, `ScheduleReviewPanel`, `StatisticsPanel`, `AccessLogPanel` (稽核日誌 — admin-only viewer for `access_logs`)

**Key components:**
- `SchedulePanel` — Schedule generation workspace: **「CP-SAT 直接指派排班」** (`handleCpsatAssign` → Cloud Run `/cpsat/generate_schedule`; result keyed by **real staff IDs**, loaded into the draft via `onGenerateSchedule`, then published with 「儲存並發布」), manual cell edits, Excel export, and a Gemini Q&A chat box (`handleUserChat`, advice only — it no longer generates schedules). Daily demand = the month's `Settings.leaveWish.reqs` if leave wishes were opened for that month (wish feasibility was checked against those numbers), else `max(requirements, computeDailyRequirements(bedConfig))` — **either way raised to `legalDailyFloor(bedCount, hospitalLevel)`** (with a confirm warning when the leave-wish numbers were below it; `LeaveWishPanel` also refuses to open a window below the floor, showing it next to the D/E/N inputs). The old 「SA 最佳化排班」 and Gemini 「生成 AI 班表」 (anonymous D-slot patterns for staff to claim) buttons were removed.
- `LeaveWishPanel` — Admin 人力與預假: ⓪ ward settings (embedded `RequirementsPanel`, collapsed by default) → staffing estimate (engine) → per-day quota (default = participants − daily minimum demand) → open/close via `Settings.leaveWish` → live per-day counts and submitted/pending lists.
- `LeaveWishPicker` — Staff 4-day leave-wish calendar shown while `Settings.leaveWish.open`; mounted at the top of `StaffDashboard` (wishes open before publication). Full days are disabled; the engine's 409 reason is shown on rejection.
- `PublishPanel` — The published (finalized) schedule: cell edits sync to `Schedules` + `SchedulesPublic`, compliance / risk side panels, 「結算並封存至歷史區」. Staff column shows `avatar_thumb` next to name.
- `ScheduleReviewPanel` — Historical schedule viewer, payroll settlement engine (base salary + OT + night bonus + level bonus 進階加給), health score calculator, Excel export. Staff name columns include avatars.
- `StatisticsPanel` — Nurse-to-patient ratio monitoring (Taiwan 衛福部 regulations), AI cross-month analytics. (The agentic-turn radar / AI decision history panels were removed — CP-SAT direct assignment has no turns; `SelectionTurn` / `AI_Decision_Logs` are still written by the claim-mode relay.)
- `StaffDashboard` — Staff self-service, read-only: leave-wish picker, the staff's own month calendar once published (「班表尚未發布」/「本月沒有排入班次」 otherwise), password change, clickable avatar opens `AvatarEditModal`. Guard 2 (deactivated) gets password access only, no avatar edit; guard 3 (long leave / maternity) shows a pause notice.
- `AvatarEditModal` — Circular 220×220 crop frame with zoom slider + pan drag + wheel zoom; saves both 220×220 main + 64×64 thumbnail; runs BlazeFace (via `src/utils/faceDetect.js`) for soft face-detection check (warning + override checkbox, never hard block).
- `ProfileWizard` — First-login flow with 3 steps; step 1 gates the form behind a PDPA §8 consent flow that requires opening `/privacy-notice` in a new tab, scrolling to bottom, then checking 同意. Persists `pdpa_consented_at` + `pdpa_notice_version` to staffData for audit.
- `PrivacyNoticePage` — Standalone public route showing the full PDPA §8 notice in 10 sections. 「我已詳閱完畢」 button is disabled until scrolled to bottom; click writes `localStorage.pdpa_read_v1` so ProfileWizard (other tab) can detect via `storage` event + tab focus refresh.

**Shift types:** D (day 07-16), E (evening 15-00), N (night 23-08), OFF, RG (例假/statutory rest), RC (休息日), 支援 (support), 事假, 病假, 特休.

**Labor law compliance** (Taiwan 勞基法) via `checkLaborLawCompliance` in `constants.js`. Per-staff `special_status` flips between two regimes:

- `Standard` — §30(1): ≤8h/day, ≤40h/week
- `BiWeekly` — §30(2): ≤10h/day, ≤48h/week (2 weeks redistributed to ≤80h total)

Both regimes share: 46h/month OT cap, 11h min shift interval, max 6 consecutive workdays (七休一), max 6 work days between RG (例假) — **counts only working days, not RC/OFF/leave** per 勞動部 105.10.07 函. Forbidden sequences (E→D, N→D, N→E), maternity protection (孕/哺乳 禁夜班), and 4-week rest aggregates (≥4 RG, ≥8 RG+RC) apply to both. The post-AI 七休一 normalizer in `SchedulePanel` and `StaffDashboard`'s read-time check are defence-in-depth duplicates that ensure even broken AI patterns don't lock staff.

The naming `BiWeekly` matches §30(2) only; **§30-1 four-week flexible** (which would allow 12-day RG intervals + 12 consecutive workdays) is intentionally NOT implemented — if needed, add a new `special_status: 'FourWeek'` enum, do NOT reuse `BiWeekly`.

**Staff levels:** N0/N1 = junior; N2/N3/N4 = senior. `checkSkillMixSafety` warns when a shift has no senior (N2+) or leader present. Each level has a configurable monthly bonus (`levelBonus` in Settings): N0=0, N1=1000, N2=2000, N3=3200, N4=5000 by default.

**Default schedule month:** Defaults to next month (e.g. March → April). If December, rolls to January of next year. Persisted in `localStorage`.

### Backend (`api/`)

Vercel serverless functions:

| File | Purpose |
|------|---------|
| `gemini.js` | AI chat — requires Firebase Bearer token |
| `analyze-excel.js` | Analyzes uploaded CSV/Excel using Gemini Flash |
| `sendEmail.js` | Sends email via Resend |
| `admin-user.js` | Admin-only multiplex (Bearer token + admin email). `body.action` switches: `'sync'` bulk-creates Firebase Auth accounts with `disabled:true` + random throwaway password and issues activation tokens / activation emails (no more hardcoded `123456`); `'reset'` issues a `purpose:'reset'` token and sends the same `/activate?token=...` link; `'delete-staff'` permanently offboards (transaction: archive avatar+name+date+actor to `ex_staff/{id}`, remove from `NurseApp/Staff` array, recompute `StaffPublic`, delete `StaffPrivate/{id}`; then disables Firebase Auth and writes `access_logs` action=`delete-staff`). All three actions share the activation-token lifecycle in `_lib/activationToken.js`. (Merged from former `sync-accounts.js` + `reset-password.js` to stay under Vercel Hobby plan's 12-function limit.) |
| `activate-account.js` | Public endpoint. Three uses via `body.action`. **(no action)** link-style activate/reset — `POST {token, newPassword}` → verifies token, enforces strength, **rejects reuse of a previously-used password** (`password_history`), sets password via Admin SDK; `purpose:'activation'` also flips `disabled:false`. **`'request-reset'`** — self-service forgot-password step 1: `{staffId, email}`, only proceeds if **both 工號 + registered email match** (else generic reply, no enumeration), issues a 6-digit OTP (`password_reset_otp`, 10-min TTL, 5-attempt cap, sha256-hashed) and emails it. **`'verify-reset-otp'`** — step 2: `{staffId, code}` → verifies OTP, generates a temp password, sets it via Admin SDK, revokes old sessions, flags `must_change_password:true` on the staff docs, returns the temp password (shown on screen). CSRF + per-IP rate limit on every branch. |
| `complete-profile.js` | Authenticated endpoint (staff Firebase token). Modes via `body.mode`: `'first'` (default) — first-login flow, fills name/gender/tenure/孕哺/大夜/encrypted PII (idNumber, bankAccount, phone) + `pdpa_consented_at` audit timestamp, sets `profile_completed: true`, logs `action='encrypt'`. `'update'` — post-login self-service for basic fields and avatar (`avatar`, `avatar_thumb`); all fields optional, only patches what's provided, does NOT touch encrypted PII or `profile_completed`, logs `action='update-profile'` with the list of changed fields. `'change-password'` — `{newPassword}`; used by the forced-change gate (after temp-password login). Sets the password server-side via Admin SDK (no client reauth needed — caller just authenticated), **rejects reuse of a previously-used password** (`password_history`), clears the `must_change_password` flag, logs `action='update-profile'` with `fields:['password']` (never the password itself). All modes batch-write the three staff docs (Staff + StaffPublic + StaffPrivate). Admin cannot use this endpoint. |
| `log-login.js` | Login auditing multiplex. `body.success: true` requires Bearer token, writes `access_logs` action `'login'` (per-uid 10/min). `body.success: false` is unauthenticated (auth just failed by definition); IP-rate-limited 10/min, records `action='login-failure'` plus attempted email + Firebase error code in `extra`. (Merged from former `log-login.js` + `log-login-failure.js` to stay under Vercel Hobby plan's 12-function limit.) |
| `auto-settle.js` | Monthly payroll settlement; supports `?targetDate` for testing, `?force=true` to force |
| `cron/check-timeout.js` | Runs daily (Vercel Cron `0 0 * * *`); PDPA retention sweep only (`access_logs`, `AI_Decision_Logs`, `archive_reports`, `pending_activation`). The name is historical — it used to advance the claim turn after a 24h timeout; kept because `vercel.json` and the frontend health check point at it. |
| `secure-field.js` | Field-level encryption gateway: `action: encrypt \| decrypt \| batchDecrypt \| logAiAccess`. Verifies Firebase token, applies RBAC (admin sees all; staff sees only own UID), writes audit row to `access_logs`. Requires `FIELD_ENC_KEY`. |

**Shared middleware (`api/_lib/`):** Security utilities imported by the serverless functions — `csrf.js` (origin allowlist validation), `rateLimit.js` (in-memory per-user rate limiter, 1-min window), `sanitize.js` (HTML sanitizer stripping `<script>`, event attrs, `javascript:` URLs), `crypto.js` (AES-256-GCM encrypt/decrypt; ciphertext format `{ct, iv, tag, v}`), `accessLog.js` (reads/writes audit rows — fire-and-forget, never blocks business logic; backend selectable via `ACCESS_LOG_BACKEND` = Firestore/MySQL/both, also exports `readAccessLogs` used by `admin-user.js` action `list-access-logs`), `mysql.js` (lazy `mysql2` connection pool — only opened when `ACCESS_LOG_BACKEND` includes mysql; see `sql/access_logs.sql` for the table), `activationToken.js` (issue/verify/consume one-time tokens for account activation and password reset; stores sha256 hash, 24h TTL), `resetOtp.js` (self-service forgot-password OTP: issue/verify/consume 6-digit codes + temp-password generator; sha256-hashed, 10-min TTL, 5-attempt cap), `passwordHistory.js` (password-reuse prevention: salted scrypt hashes of the last N passwords; `assertPasswordNotReused` / `recordPassword` / `clearPasswordHistory`).

### Firestore Schema

```
NurseApp/Settings          — global app config (shiftOptions, priorityConfig, requirements, bedConfig, baseSalary*, levelBonus, publishedDate,
                             leaveWish: { open, year, month, reqs:{D,E,N}, quota, days_per_person } — admin-written leave-wish switch)
NurseApp/Staff             — { staffData: [...], healthStats: [...] }   admin-only read
                             staffData[*] sensitive fields (encrypted blob): idNumber*, bankAccount*, phone*
                             staffData[*].profile_completed: true once the staff has filled the first-login wizard
                             staffData[*].pdpa_consented_at + pdpa_notice_version: PDPA §8 audit timestamps
                             staffData[*].avatar: 220×220 WebP base64 data URL (~20-30 KB) — full size for admin views
                             staffData[*].avatar_thumb: 64×64 WebP base64 data URL (~3-5 KB) — used in shift cards
NurseApp/StaffPublic       — { staffData: [{staff_id,name,level,is_leader,is_active,avatar_thumb}, ...] }   any authed user reads
                             sanitized projection — no PII/health/financial. Only avatar_thumb (not full avatar) is included
                             to stay under Firestore's 1 MiB single-doc limit (~100 staff × 4 KB thumb ≈ 400 KB). Mirrored
                             on every saveGlobalStaff. Single definition in shared/staffProjection.js, imported by the
                             frontend, both APIs and the scripts; `npm run lint` fails if a copy reappears.
StaffPrivate/{id}          — top-level collection; full row for a single staff   admin or matching staff uid reads
                             same shape as a single element of NurseApp/Staff.staffData
                             (top-level rather than NurseApp/StaffPrivate/* because Firestore doc paths must be even segments)
Schedules/{YYYY_M}         — { schedule: {...}, finalizedSchedule: {...} }   admin-only read
                             full content including raw 事假/病假/特休 leave types
SchedulesPublic/{YYYY_M}   — { finalizedSchedule: {... masked ...} }   any authed user reads
                             same shape but 事假/病假/特休 cells replaced by 'OFF';
                             mirrored on every saveMonthlySchedule / updateStaffSchedule
archive_reports/{YYYY_M}   — { year, month, schedule_backup, backedUpAt, note, csv? }
SelectionTurn/{YYYY_M}, SelectionProgress/{YYYY_M}, AI_Decision_Logs — legacy data from the removed claim flow; nothing reads or writes them any more (AI_Decision_Logs is still purged by the retention sweep)
pending_activation/{sha256(token)} — server-only; { uid, email, purpose: 'activation'|'reset', expiresAt, createdAt }
password_reset_otp/{staffIdLower} — server-only; self-service forgot-password OTP. { codeHash(sha256), uid, staffId, email, attempts, expiresAt, createdAt }. 10-min TTL, 5-attempt cap, one active per staff (later request overwrites). Written/read by api/_lib/resetOtp.js via api/activate-account.js request-reset / verify-reset-otp. firestore.rules denies all client access.
password_history/{staffIdLower} — server-only; password-reuse prevention. { staffId, entries:[{salt, hash(scrypt), at}], updatedAt }. Keeps last N (PASSWORD_HISTORY_SIZE, default 5) salted scrypt hashes — NOT sha256 (passwords are low-entropy). Checked + appended on every user-chosen password set (activate-account link flow + complete-profile change-password); NOT recorded for system temp passwords. Cleared on offboarding (admin-user delete-staff). See api/_lib/passwordHistory.js. Denied to all clients (even the owner).
staffData[*].must_change_password: true — set by verify-reset-otp when a temp password is issued; App.jsx routes staff to ForcedPasswordChange until cleared by complete-profile change-password
access_logs                — audit trail; { ts, actor:{uid,email}, action:'decrypt'|'encrypt'|'ai-access'|'ai-access-blocked'|'update-profile'|'delete-staff'|'login'|'login-failure'|'relock', target:{kind,id}, fields:[], ip, ua, extra? }
                             ai-access-blocked: written when api/gemini.js detectSensitivePii catches身分證/手機 in prompt and refuses to forward to Google.
LeaveWishes/{YYYY_M}       — { counts:{"1":n,...}, quota, version, updatedAt } — per-day headcount only (no names); any authed user reads
LeaveWishes/{YYYY_M}/entries/{staffId} — { staff_id, days:[1-indexed], submittedAt } — owner + admin read
                             Both written ONLY by the engine (/leave_wishes/submit, Admin SDK); rules deny all client writes.
ex_staff/{staff_id}        — 離職員工歸檔 (admin-only read)。{ staff_id, name, email, level, tenure_years, avatar, avatar_thumb, had_avatar, deleted_at, deleted_by:{uid,email} }
                             由 /api/admin-user action='delete-staff' 寫入。
                             刻意不複製加密 PII (idNumber/bankAccount/phone) — 離職應一併銷毀。
```

**Encrypted fields (marked `*` above):** stored as `{ ct, iv, tag, v: 1 }` AES-256-GCM blobs. Read/write goes through `/api/secure-field`, never directly. UI uses `<EncryptedField>` (click-to-decrypt, 30s auto-relock). Migration: `node scripts/migrate-encrypt.js` (dry-run) → `--commit` (actual write).

**Firestore security rules** live in `firestore.rules` at the repo root. Deploy via Firebase Console paste (CLI deploy lacks IAM perms in this project). The rules are the canonical access-control source — when in doubt about who can read/write a path, check `firestore.rules` rather than inferring from the schema above.

**Staff data three-doc split (PDPA §6 compliance):** the original single `NurseApp/Staff` doc was readable by any authenticated user, leaking colleagues' is_pregnant_or_nursing / leave_status / accumulated_ot etc. Now split into three: full doc admin-only, public sanitized projection for colleague-name lookups, per-staff private doc for own sensitive data. The frontend `saveGlobalStaff` and the backend `api/complete-profile.js` both batch-write all three to keep them in sync. To migrate existing deployments: `node scripts/migrate-staff-public.js` (dry-run) → `--commit`. Run **before** deploying the new firestore.rules so staff don't see empty data during the gap.

**Firebase Auth UID realignment:** older Auth accounts (pre `admin-user.js` unification) carry a random 28-char UID instead of the matching `staff_id`. Firestore rule `match /StaffPrivate/{staffId}` requires `request.auth.uid == staffId`, so those staff get permission-denied on their private row. To fix existing deployments: `node --env-file=.env.local scripts/migrate-realign-auth-uid.js` (dry-run) → `--commit`. The script deletes each misaligned Auth user, recreates with `uid: staff_id`, and issues a new activation token — affected staff need to re-activate from email. Add `--skip-email` to print tokens to stdout instead of sending.

### Field-Level Encryption Setup (one-time)

```bash
# 1) Generate master key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 2) Add to Vercel env vars (Production + Preview + Development)
#    FIELD_ENC_KEY=<paste base64 string>

# 3) Pull to local
vercel env pull

# 4) Migrate existing plaintext fields (dry-run first!)
node scripts/migrate-encrypt.js              # preview
node scripts/migrate-encrypt.js --commit     # actually write
```

**⚠️ Key loss = data loss:** if `FIELD_ENC_KEY` is rotated or lost, all existing ciphertext is permanently unrecoverable. Back the key up offline before deployment.

**This already happened once:** the Vercel `FIELD_ENC_KEY` was replaced on 2026-06-02 (~07:04–07:17 UTC); everything encrypted before that (`Settings.baseSalary`, the PII of N001/N002/N031/N032/N034) fails with `Unsupported state or unable to authenticate data`. If the old key turns up, `scripts/reencrypt-from-old-key.js` (reads `OLD_FIELD_ENC_KEY` + `ADMIN_PASSWORD` from `.env.local`; dry-run by default, `--commit` writes, ciphertext backup to `~/nurse-schedule-backups/`) decrypts locally with the old key, re-encrypts through production `/api/secure-field`, and patches `NurseApp/Settings`, `NurseApp/Staff` and `StaffPrivate/{id}`.

### Scheduling flow (claim flow removed 2026-10)

護理長在「人力與預假」開放 / 截止預假 → 「排班工作桌」按 CP-SAT 直接指派排班 → 檢視 / 微調草稿 → 「儲存並發布」（寫 `Schedules/{ym}` + `SchedulesPublic/{ym}` 與 `Settings.publishedDate = {year, month}`）→ 員工在首頁檢視自己的整月班表。

The former claim flow — Gemini anonymous D-slot patterns, staff taking turns to claim them, the AI relay that picked whose turn was next (`api/auto-relay.js`, `calculateAndNotifyNextStaff`), the claim endpoint (`api/claim-schedule.js`), 拔除釋出 on the publish page, the statistics turn radar, and the cron's 24h force-skip — was removed in full. `publishedDate.assignMode` is no longer written. Old schedules may still contain `D001`-style rows; the tables just label them 待認領.

### CP-SAT Engine (`cpsat_service.py` + `local_test/hybrid/model.py`) — current scheduling path

**Single source of truth:** the engine is `local_test/hybrid/model.py`; the `Dockerfile` copies it into the image as `cpsat_model.py`, and `cpsat_service.py` falls back to importing it from `local_test/hybrid/` when run locally. **Editing `model.py` changes production on the next deploy** — no hand-port step (unlike `scheduler.py` ↔ `main1.py`). `cpsat_service.py` exposes a `build_router(verify_token, rate_limit, store_factory)` mounted by `main1.py`; Firestore access is isolated in `FirestoreStore` so tests inject a fake store.

| Endpoint | Who | Behaviour |
|---|---|---|
| `POST /cpsat/staffing_estimate` | admin | `staffing_range()` checks the **current team size first** (45 s cap — the answer the admin actually needs), then walks **down** to find the minimum while checks stay FEASIBLE (stops at the first UNKNOWN → `approx`, shown as「最少不超過 N」); only if the team is infeasible does it walk **up** (never past max, where extra staff can't reach `min_work_days`). Each check is feasibility-only (no soft-feature vars). max = `max_headcount()` = `Σ(req+MAX_OVERSTAFF)×days ÷ (min_work_days+1)` (the +1 leaves slack: at the exact theoretical cap every shift is full and everyone works exactly 20 days, and CP-SAT couldn't find even a wish-free schedule in 100 s at 24 nurses for D3/E3/N4; leave-wish submission uses the same capped team as generation, keeping earlier registrants first by `firstSubmittedAt`); `adjust_headcount()` refuses below min (lower bound in the message = the contiguous proven-infeasible prefix only, so over-staffing infeasibility is never reported as "need ≥ N"), drops trailing Standard nurses above max. Cached in-process by (month, reqs, team composition); a run cut by the time budget is not cached but its progress is (`_staffing_partial`) and the next call resumes. |
| `POST /cpsat/generate_schedule` | admin | **409 while that month's `Settings.leaveWish` is still open** (a schedule generated before closing would miss later "guaranteed" wishes; `SchedulePanel` offers to close the window first, and `LeaveWishPanel` warns before re-opening a month that already has a published direct schedule). Registered leave wishes are **hard** constraints (falls back to soft only if that is infeasible, flagged `wishes_hard:false`); returns the same `{status, solver_status, schedule:[cells], stats}` shape as SA. |
| `POST /leave_wishes/submit` | staff | Checks open window, caller on roster, exactly `days_per_person` distinct in-month days, per-day quota, then `check_wishes_feasible()` (all accepted wishes pinned as hard; UNKNOWN treated as infeasible); commits with an optimistic `version` transaction and retries up to 3× on concurrent writes. **Accepted ⇒ guaranteed** at generation time. |

Model (`Problem` fields are the knobs): hard = 勞基法 (weekly cap 5 / BiWeekly 6 + ≤10 per 2 weeks, RG gap ≤6 work days, RG ≥4, RG+RC ≥8, ≤27 work days, 11h forbidden sequences), coverage `req ≤ n ≤ req+MAX_OVERSTAFF(2)`, protected (孕哺/Student) D-only, one work-shift type per calendar week (`one_shift_per_week`), `max_consec_work=5` (stricter than legal 6 so health stays 100), ≤3 consecutive nights, `post_night_rest=2` (Knauth & Hornberger 2003), `min_work_days=20`. Soft (weighted, scaled ×10 to integers): `FEATURES` (wishes, nights, isolated off, weekend work, shift switch, streak6) + `backward_weight` (D→E→N forward rotation, Czeisler 1982) + `mix2_weight`/`mix3_weight` (monthly shift-type mixing) + `fairness`×max individual cost + `senior_weight` (each day×shift with no N2+/leader on it — mirrors the frontend `checkSkillMixSafety` warning; soft, not hard, so a senior-poor team still gets a schedule and the leave-wish feasibility check, which builds its own weight-free `Problem`, stays exact; `stats.senior_gaps` reports what's left; `solve_cpsat` first minimises the gap count alone for ~time_limit/5 and pins it as an upper bound, because inside the weighted objective the parallel search often stopped with gaps left). Generation weights are tiered so lower priorities can't add up past higher ones: senior 30 > wish 20 > mix2 6 (mix3 18) > backward 3 > isolated 2 > nights/weekend 0.3 (wishes are pinned hard at generation anyway). `eligible_staff()` must pass `level`/`is_leader` through for this to work. Pre-checks `monthly_workday_shortfall` / `weekly_staffing_shortfall` return instant human-readable INFEASIBLE reasons (CP-SAT alone can take minutes to prove infeasibility due to staff symmetry). `solve_cpsat(hint=…)` pins the hint via an assumption to get a complete solution + exact score, then searches with `objective ≤ hint` and returns the hint (`HINT_KEPT`) if nothing better is found — a partial `add_hint` on `x` alone was ignored by the parallel search. **When `senior_weight > 0` the senior phase starts from the caller's hint and its solution replaces it**, so `HINT_KEPT` / `hint_value` then refer to that phase's schedule, not the caller's. A pinned hint coming back INFEASIBLE sets `hint_rejected` and logs a warning — it means the weight-free and weighted models disagree on hard constraints (a bug; the old `t2 ≥ Σused − 1` mix encoding silently banned using all three shift types in a month because `t2` is boolean, so mix3 was a hard ban rather than its intended penalty; `test_cpsat_service.py` now guards the invariant). Before that fix, the wish feasibility check (weight-free model, no such ban) could accept wishes the generator couldn't honour; "accepted ⇒ guaranteed" only holds from that fix on. Measured on the 14-staff sample: per-date quota of `staff − daily demand` is necessary but **not sufficient** (6 night-eligible nurses off the same 4 weekdays is infeasible under quota), hence the per-submission feasibility check (~1–2 s).

### SA Optimization Engine (`main1.py`) — legacy

**Status:** the frontend no longer calls SA (its button was replaced by CP-SAT direct assignment); `POST /generate_schedule` is kept for the old flow. Note it only verifies a Firebase token — any logged-in staff can call it (rate-limited), unlike the admin-gated CP-SAT endpoints. The anonymize-and-claim flow and the `clampDailyRequirementsToFeasibleBand` clamp described below are no longer wired into `SchedulePanel`.

Independent Python microservice (FastAPI + simulated annealing). Lives at repo root but **not deployed by Vercel** (see CSP/`.vercelignore` note). Complementary to the Gemini flow:

- **Gemini path** (`api/gemini.js`): LLM generates anonymous `pattern` strings → frontend assigns virtual D-slot IDs → staff claim via agentic turn. Output is non-deterministic, retried up to 5 times client-side to pass the daily-headcount filter.
- **SA path** (`main1.py`): TLPS membrane representation + **L3 Focused** simulated annealing. Each day's assignments live in **5 "membranes"** — D/E/N plus **RG (例假) and RC (休息日)** split out (so §36's「兩 RG 之間 ≤ 6 工作日」can be checked precisely instead of collapsing all rest into one `O`). Greedy rotation init + shift-specialization (each nurse keeps one work type all month). Mutation operators: antiport (single-cell), block antiport (3/7-day), month_swap, week_rotation, plus a **Focused layer** (red/green nurse classification by personal penalty, tabu list, targeted fix functions per dominant violation, adaptive thaw on stagnation). The SA computes assignments to real `staff_id` internally (needs identities for protected-list E/N bans), but the **frontend anonymizes the result into virtual D-slots and routes through `onGenerateSchedule` — identical to the Gemini path — so staff claim via agentic turn rather than the schedule being directly finalized.** `run_sa()` is kept byte-for-byte in sync with `local_test/scheduler.py` (same seed → same schedule); port changes there first, then copy the function across.


**Daily-demand feasible-band clamp (`clampDailyRequirementsToFeasibleBand` in `constants.js`; formerly applied in SchedulePanel before building the SA payload — now unused by the frontend):** the per-shift `daily_reqs` started as `max(admin ratio, legal floor)` — derived from *beds*, ignoring the *eligible-staff count*. Empirically (local_test sweep), pushing the daily total too high for the staff on hand makes the SA `INFEASIBLE` — the HARD overwork rules (七休一, 週工時) bind at roughly **`work_days ≈ num_days − 11`** per nurse, which is *also* the soft `work_days_below` threshold, so that point is simultaneously the soft floor and the hard ceiling. The clamp therefore caps the daily total at `feasibleMax = floor(staffCount × (numDays − 11) / numDays)` (constant `SA_FEASIBLE_WORKDAY_MARGIN = 11`, mirrors the SA `work_days` rule), never below the legal ratio floor total. It only ever **trims down** (raising the total breaks feasibility — verified: total 10 for 14 staff = INFEASIBLE, total 7–9 = feasible), and trims **proportionally across D/E/N** (not all from D — cutting D alone shrinks the D pool and overworks D specialists, since the SA allocates pools by req proportion; e.g. `D8E3N3→D5E2N2`, a proven-feasible shape, not `D3E3N3`). If the legal floor itself exceeds `feasibleMax` (genuinely under-staffed), the floor wins and a `⚠️ 建議增補人力` note is surfaced (the schedule will be INFEASIBLE — hire more). The adjustment note shows in both the confirm dialog and the chat message.

SA penalty function encodes hard rules with high weight (連續上班 >6 天 = 2000, 連續大夜 >3 天 = 1000, forbidden N→D/N→E/E→D = 1000, post-night-not-off = 2000, protected staff on E/N = 500000, FORCE_OFF/FORCE_WORK violation = 1000000, personal health floor breach = 50000) plus stricter-than-law custom rules (RG/RC each ∈ [4,5], monthly work days range, weekly RG+RC rhythm, mixed-work-shift ban = 5000) and soft preferences (isolated rest, OT 6th-day). The file name remains `main1.py` (Render/Dockerfile reference it) — the previous CP-SAT implementation has been replaced.

**Two-phase TLPS acceptance (Sharif et al. 2026 — 禁止/不理想/理想 三類模式):** the penalty keys are partitioned by `HARD_PENALTY_KEYS` (module-level frozenset, duplicated identically in both files) into **hard constraints** (the subset that maps to JS `checkLaborLawCompliance` violations — see `JS_TO_SA_MAP` — plus coverage `daily_demand_unmet`, legal ratio floor `ratio_below_legal`, and admin `custom_rule_violation`) vs **soft constraints** (everything else — the stricter-than-law custom rules + preferences). The SA loop runs in two phases: **(1) Feasibility** — acceptance compares only the hard subtotal (`_hard_of(breakdown)`), driving all *prohibited patterns* to 0 (soft is free to drift); **(2) Optimization** — entered the iteration hard hits 0; from then on any move that re-introduces hard > 0 is **hard-rejected** (feasibility is never given back), and standard Boltzmann annealing minimizes the soft remainder, upgrading *undesirable* → *desirable* patterns. `best` is tracked lexicographically by `(hard, total)`. Early stop fires only in the optimization phase when `current_p < OPTIMAL_THRESHOLD`.

`solver_status`: **`INFEASIBLE`** when `stats.hard_penalty > 0` (still has prohibited patterns — never passes JS compliance), **`OPTIMAL`** when hard == 0 and soft < `OPTIMAL_THRESHOLD` (default 1000), **`FEASIBLE`** when hard == 0 but soft above threshold (legal, just not ideal). New stats: `hard_penalty`, `soft_penalty`, `feasibility_reached`/`feasibility_iteration`, `final_phase`, and the paper's headline metric `desirable_pattern_count` / `undesirable_pattern_count` / `prohibited_pattern_count` (+ the `*_nurses` id lists). **`stats.hard_penalty === 0` is the real compliance criterion (= 0 JS violations), not `final_penalty === 0`** — `final_penalty`/`soft_penalty` stay > 0 whenever stricter-than-law custom rules remain.

**Tiered desirability (法遵+健康=理想) + DP-aware polish:** literal "0 hard + 0 soft" patterns are effectively unreachable for a 31-day month under the 15-rule soft set (over-staff → soft quota rules fire for everyone; under-staff → hard fatigue rules fire), so a pattern counts as **desirable** when it has **0 hard violations AND 0 `HEALTH_CRITICAL_SOFT_KEYS`** (another module-level frozenset, identical in both files: `consecutive_night_4`, `post_night_not_off_2`, `consecutive_work_pair`, `overtime_6th_day_pay`, `isolated_off_n`, `health_floor_breach`, `health_deficit_per_point`). The stricter-than-law custom quota/rhythm/cosmetic prefs (work_days·RG·RC ranges, weekly rhythm, isolated D/E rest, rest clustering) are **tolerated** — they still count in `soft_penalty` but do not demote a nurse below *desirable*. The per-nurse three-tier split (`prohibited`/`undesirable`/`desirable`) and `_dp_count` both use this health-critical subset. To **maximize** DP count there's a dedicated `dp_polish_mutation` (run in the focused branch at probability `dp_polish_prob`, default 0.35, only in the optimization phase): it picks the nurse closest to desirable (0 hard, lowest *health-critical* penalty), routes its dominant health-critical violation through `TARGETED_FIX` (the `fix_consecutive_rest` op was added for the most common residual). Crucially the `best`-tracking tiebreaker is `(hard, total, -dp_count)` — total-neutral DP-creating moves only get saved because of the `-dp_count` term. Tunables: `dp_aware` (default True), `dp_polish_prob`, `dp_polish_pool`. Measured effect on the 14-staff demo: DP-aware ON lifts desirable count (e.g. seed 1: 6→9/14, seed 42: 5→8/14), never lower.

⚠️ **No mathematical compliance guarantee** — unlike the prior CP-SAT version, SA may still return `solver_status='INFEASIBLE'` (hard_penalty > 0) if the feasibility phase never converges. `stats.violation_breakdown` itemizes which rules were broken; admin must manually review or re-run.

Service exposes `GET /` (landing), `GET /health` (no auth), `POST /generate_schedule` (Firebase Bearer token required, 5/min/uid rate limit), `GET /docs` (Swagger UI for testing). See `CPSAT_DEPLOY.md` for full deployment + integration steps.

### Local Test Harness (`local_test/`)

Pure-Python (stdlib only, Python 3.9+, **no Firebase/Render/FastAPI**) offline mirror of three production pieces, for fast iteration + cross-validation of the SA algorithm and compliance rules. **Most recent commits land here first** (`feat(local-test): …`).

```bash
python local_test/run_demo.py                                          # default sample (10 staff, 2026/5)
python local_test/run_demo.py --year 2026 --month 6 --d 4 --e 3 --n 2  # custom daily reqs
python local_test/run_demo.py --iters 30000 --seed 42                  # longer run, reproducible
```

`run_demo.py` runs all three and prints SA stats + violation breakdown + per-staff health. Each module is independently importable (`run_sa`, `check_labor_law_compliance`, `calculate_health_score`):

| Module | Hand-ported from |
|---|---|
| `scheduler.py` | `main1.py` `generate_schedule()` |
| `compliance.py` | `src/constants.js` `checkLaborLawCompliance` |
| `health.py` | `src/components/PublishPanel.jsx` `calculateHealthScore` |

`local_test/hybrid/` (needs `ortools`, see `local_test/requirements.txt`) holds the CP-SAT engine itself (`model.py`, deployed — see CP-SAT Engine), `learning.py` + `run_hybrid.py` (multi-month simulation learning soft weights from simulated satisfaction feedback, with cross-month compensation), and `test_cpsat_service.py`. The Streamlit panel (`streamlit run local_test/dashboard.py`) replaces any SA result with a CP-SAT schedule when it has compliance violations or mixed-shift weeks, never auto-trims below the CP-SAT legal minimum headcount, and passes `violations` + `shift_mix=True` to `health.py` (test-panel-only deductions; without those args `health.py` still matches `PublishPanel`). Streamlit reruns don't reload imported modules — restart it after editing `health.py`/`scheduler.py`/`model.py`.

**Sync invariant:** these are hand-maintained ports, not imports. When you change the production scheduler / compliance / health logic, update the matching `local_test/*.py` or cross-validation silently drifts. Intended workflow: iterate here + verify with `--seed 42`, then port the change back to production. Known intentional relaxation: SA emits a single rest type `O`, so `compliance.py` treats `O` as a wildcard RG (looser than production's RG/RC split).

### Auth Flow

Three-layer security: (1) frontend route guard on session token, (2) zero-trust state validation (is_active, leave_status, turn ownership), (3) RBAC — admin (`admin@hospital.com`) vs staff roles. Backend APIs verify Firebase ID tokens via Bearer header.

**`staff_id ↔ email` convention (load-bearing invariant):** Firebase Auth has no concept of staff IDs. The system bridges them via `${staff_id.toLowerCase()}@hospital.com` — used by both the frontend login form (`src/components/LoginPanel.jsx:51` constructs the email from typed staff_id) and the backend account creator (`api/admin-user.js:144` creates the Auth account with this exact email). Any code path that creates a Firebase Auth account MUST use this pattern; an account with a different email exists in Auth but is unreachable via the login form. Admin is the lone exception: `admin@hospital.com` (no staff_id prefix).

**First-login PDPA gate:** When `profile_completed === false`, App.jsx routes to `ProfileWizard` instead of `StaffDashboard`. Step 1 of the wizard blocks the form behind a PDPA §8 consent — the staff must click through to `/privacy-notice` (new tab), scroll to the bottom (localStorage flag `pdpa_read_v1` set there), then tick the agreement checkbox. The consent timestamp is persisted to `staffData[*].pdpa_consented_at`. Notice version bumps (`v1 → v2 …`) force everyone to re-consent.

**Self-service password reset (忘記密碼):** Login page → 「忘記密碼？」 opens `ForgotPasswordModal` (3 steps): (1) enter 工號 + registered email → `activate-account action='request-reset'` (only sends if both match; generic reply otherwise); (2) enter the 6-digit OTP emailed to them → `action='verify-reset-otp'` returns a system temp password (shown on screen) and flags `must_change_password`; (3) the temp password is pre-filled back into the login form. On login with the temp password, App.jsx routes to `ForcedPasswordChange` (gates ahead of the ProfileWizard gate) until they set a new password via `complete-profile mode='change-password'`. New passwords (here, the link-reset flow, and activation) are checked against `password_history` so a previously-used password is rejected. This is the self-service complement to the admin-triggered `admin-user action='reset'` link flow — both ultimately set the password via Admin SDK.

**Offboarding (永久離職):** Admin clicks 🗑 on a staff row in StaffManagementPanel → calls `/api/admin-user action='delete-staff'`. Backend runs a Firestore transaction: snapshot `staff_id/name/email/level/tenure/avatar/avatar_thumb` into `ex_staff/{id}` with `deleted_at` + `deleted_by`, remove from `NurseApp/Staff` array, rebuild StaffPublic, delete StaffPrivate. Then disables Firebase Auth + revokes tokens (non-fatal — logs warning if fails). Writes `access_logs` action=`delete-staff`. **Encrypted PII (idNumber/bankAccount/phone) is intentionally NOT copied to ex_staff** — offboarding should destroy ciphertext too, otherwise the org keeps a key-management burden for someone who's gone.

### PHP / Laravel Backend Migration POC (`php-backend/`)

A runnable Laravel 13 app at the repo root, sitting alongside the Node backend — a parallel implementation of the Vercel `api/*` endpoints used to validate a potential migration off serverless Node. **Not deployed**; production still runs the Node `api/*` on Vercel. Excluded from Vercel build via `.vercelignore`.

Strategy: only the backend API moves to PHP; the React frontend + Firestore + Firebase Auth + real-time `onSnapshot` subscriptions stay (PHP can't provide server push).

```bash
cd php-backend
composer install              # vendor/ is gitignored, ~760MB
cp .env.example .env
php artisan key:generate
# Fill FIREBASE_*, FIELD_ENC_KEY, RESEND_API_KEY, CRON_SECRET from your .env.local
php artisan serve --port=8000
```

**Ported (green batch, end-to-end verified against real Firebase):** `sendEmail`, `activate-account`, `log-login` + shared layer (`FieldCrypto`, `Sanitizer`, `Csrf`, `RateLimit`, `Firebase`, `ActivationToken`, `AccessLog`).
**Pending:** middle batch (`complete-profile`, `auto-settle`, `cron/check-timeout`), hard batch (`gemini`, `analyze-excel`, `admin-user`). (`claim-schedule` / `auto-relay` were removed from the Node backend in 2026-10; their PHP ports are now dead code.)

**Three non-obvious things that bite when working here:**

1. **kreait `createFirestore()` does NOT pass the service account to the underlying `FirestoreClient`** — it falls back to ADC and fails. `app/Support/Firebase.php` bypasses kreait's Firestore wrapper and constructs `FirestoreClient` directly with `['credentials' => $serviceAccount, 'transport' => ...]`. Auth still uses kreait normally. Note `google/cloud-firestore` v2 uses the `'credentials'` option key, not v1's `'keyFile'`.

2. **Windows ZTS PHP + grpc → ACCESS_VIOLATION on first request.** Even with `php_grpc.dll` correctly installed and `php -m` showing grpc loaded, the first real Firestore call segfaults (`0xC0000005`). Default `FIRESTORE_TRANSPORT=rest` works on every platform with identical SDK API; Linux production may set `FIRESTORE_TRANSPORT=grpc` for HTTP/2 + protobuf speed.

3. **Crypto envelope must match Node byte-for-byte.** `FieldCrypto::encrypt/decrypt` wraps the plaintext in a `{t, v}` JSON envelope before AES-GCM (mirroring `api/_lib/crypto.js` `serialize()`). **`FIELD_ENC_KEY` must be the same key as the Node backend** or PHP cannot decrypt existing Firestore ciphertext.

**Rate limiting differs from Node:** Node uses an in-process `Map`; PHP-FPM is request-per-process so `app/Support/RateLimit.php` uses Laravel's `RateLimiter` facade (cache-backed). Multi-instance deployments need `CACHE_STORE=redis`, otherwise per-instance counters defeat the limiter.

**`.env` editing gotcha:** vlucas/phpdotenv processes `\n` escapes in double-quoted values as actual newlines, which breaks the parser mid-PEM. Wrap `FIREBASE_PRIVATE_KEY` in single quotes (PEM stays as literal `\n` strings; `Firebase::factory()` does the `str_replace('\\n', "\n", $pk)` itself, matching Node behavior). Pasting a multi-line PEM unquoted leaves orphan lines that phpdotenv also chokes on — strip them.

## Deployment

Vercel auto-deploys on push to `main`. `vercel.json` configures the daily cron and rewrites all `/api/*` routes plus SPA fallback to `index.html`.

`vercel.json` also ships a strict Content-Security-Policy whitelisting Firebase, Google APIs, OpenWeatherMap, jsDelivr, **tfhub.dev + www.kaggle.com + storage.googleapis.com** (BlazeFace model weights), and **both scheduling-service URLs** (Render SA + Cloud Run engine). **Adding any new external script, API, or image source requires updating the `Content-Security-Policy` header in `vercel.json`** — otherwise it works locally but is silently blocked in production.

`.vercelignore` excludes `main1.py`, `cpsat_service.py`, `requirements.txt`, `Dockerfile`, `.dockerignore`, `.gcloudignore`, `CPSAT_DEPLOY.md`, and `php-backend/` from the Vercel build context. Without this, Vercel auto-detects `requirements.txt` or `php-backend/composer.json` and tries to install Python/PHP toolchains, which is irrelevant work that slows down the frontend deploy. Keep the files in git so Render/Railway/PHP hosts can pull them.

### Removed scratch files

The old scratch/sandbox files (`server/`, `my-app/`, `1.PY`, `main.py`, `consequence.ipynb`, `yolov8n.pt`, `ui-template/` + design `.zip`, `markdown.md`, `001.txt`, `.qoder/`, `src/backup.js`, `src/App.css`) were deleted in 2026-10. The real Python services are only `main1.py` + `cpsat_service.py` (scheduling microservice) and `local_test/` (engine source + test harness). **`1.PY` and `src/backup.js` contained a hard-coded Gemini API key and this repo is public** — that key must be revoked in Google AI Studio (deleting the files doesn't remove it from git history). `.gitignore` covers `__pycache__/` — never commit `.pyc`.

### `labor-law-compliance/` — Standalone Compliance-Checker Sub-Project

A separate, self-contained React/Vite web app living in this repo but otherwise unrelated to the main build — it has its own `package.json`/`node_modules`/git history-independent lifecycle and is excluded from the Vercel build via `.vercelignore` (same pattern as `my-app/`, `php-backend/`). Run it with `cd labor-law-compliance && npm install && npm run dev` (port 5174, separate from the main app's 5173).

`src/compliance/rules.js` is a **manually-maintained copy** (not an import) of the compliance functions from the main app's `src/constants.js` (`checkLaborLawCompliance`, `computeProximityWarnings`, `checkSkillMixSafety`, `calculateScheduleRisks`, ratio/legal-floor helpers) — the `lucide-react` icon dependency was dropped from `SHIFT_TYPES`. It is a pure client-side tool: paste staff/schedule JSON, no backend or Firebase. **If you change compliance logic in `src/constants.js`, this copy will silently drift** — port the change manually if it matters here. See `labor-law-compliance/README.md` for the data format and known limitations.

### Diagnostic & Repair Scripts

Beyond the migrations referenced above, `scripts/` also holds diagnostic helpers — `check-staff-data.js` / `restore-staff-from-private.js` for staff-doc integrity, `list-firestore-usage.js` for read-volume audits, and `fix-uid-keyed-schedule.js` / `migrate-schedule-public.js` for schedule-doc repair. All accept `--commit` to write; default is dry-run.

## Linting Notes

ESLint flat config (`eslint.config.js`) has a custom `no-unused-vars` rule: variables starting with an uppercase letter or `_` are ignored (`varsIgnorePattern: '^[A-Z_]'`). This allows unused React component imports (e.g. icon components passed as props) and intentionally unused `_` variables.
