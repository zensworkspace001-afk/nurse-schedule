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

**CP-SAT engine (separate Python microservice):**

```bash
pip install -r requirements.txt   # ortools + fastapi + firebase-admin
uvicorn main1:app --reload --port 8000
```

Then set `VITE_CPSAT_URL=http://localhost:8000` in `.env.local` so SchedulePanel's 「CP-SAT 最佳化」 button hits the local instance instead of the deployed one. See `CPSAT_DEPLOY.md` for Render/Railway/Fly.io deployment.

## Environment Variables

All keys live in Vercel dashboard (Settings > Environment Variables). For local dev, `.env.local` is pulled via `vercel env pull`:
- `VITE_FIREBASE_*` — Firebase client SDK config (6 keys)
- `GEMINI_API_KEY` — Google Gemini AI
- `RESEND_API_KEY` — Email service
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Firebase Admin SDK (backend only)
- `CRON_SECRET` — Vercel Cron job authentication
- `FIELD_ENC_KEY` — **AES-256-GCM master key for field-level encryption** (base64-encoded 32 bytes). Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Lose this and all encrypted fields are unrecoverable** — back it up offline. Used by `api/secure-field.js` and `scripts/migrate-encrypt.js`.
- `VITE_CPSAT_URL` — Public URL of the CP-SAT microservice (e.g. `https://nurse-schedule-s0ro.onrender.com`). Read by `SchedulePanel` to call the optimizer. **Must also be added to `vercel.json` CSP `connect-src`** or production browser will block the fetch.

**CP-SAT microservice env vars** (set on Render/Railway/Fly.io, NOT Vercel): `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (mirror of Vercel values), `ALLOWED_ORIGINS` (CORS whitelist, comma-separated), `MAX_SOLVE_SECONDS` (default 60), `RATE_LIMIT_PER_MIN` (default 5).

## Architecture

**Full-stack web app** for nursing shift scheduling at a Taiwan hospital. React/Vite frontend + Vercel serverless backend. All persistent state in Firebase Firestore. UI text is Traditional Chinese (繁體中文).

### Frontend (`src/`)

**Styling convention:** Each component has a co-located `.css` file using BEM naming (e.g. `.publish__header`, `.staff-mgmt__row--inactive`). Only truly dynamic values (runtime-computed colors) remain as inline styles. Do not add new inline styles — use CSS classes. Modals/overlays use glassmorphism (`backdrop-filter: blur()`, `rgba` backgrounds) with fade-in/fade-out CSS animations (closing state + `setTimeout` for deferred unmount).

`src/App.jsx` — Root `NurseSchedulingSystem` component. Owns all top-level state (staffData, schedule, finalizedSchedule, violations, etc.), Firebase `onSnapshot` subscriptions, cloud read/write engines (2s debounce), and core business logic: `handleStaffScheduleUpdate`, `calculateAndNotifyNextStaff`, `handlePushToHistory`, `handleSaveAndPublish`. Routes to `ManagerInterface` (admin) or `StaffDashboard` (staff) based on role.

`src/constants.js` — Shared constants and pure functions. All compliance logic lives here: `SHIFT_TYPES`, `LABOR_LAW_RULES`, `calculateAnnualLeave`, `checkLaborLawCompliance`, `checkSkillMixSafety`, `calculateScheduleRisks`. Import from here — do not duplicate.

`src/api/database.js` — All Firestore CRUD: `subscribeToSettings`, `subscribeToStaff` (admin), `subscribeToStaffPublic` (staff colleagues view), `subscribeToMyStaffPrivate` (staff own row), `subscribeToSchedule`, `saveGlobalSettings`, `saveGlobalStaff` (batch-writes the three staff docs), `saveMonthlySchedule`, `updateStaffSchedule`, `saveArchiveReport`, `subscribeToArchiveReports`, `clearArchiveReports`, `backupScheduleToArchive`, `buildStaffPublicProjection`. Also exports `auth` and `db` Firebase instances.

**Component hierarchy:**
- `App.jsx` → `LoginPanel` (unauthenticated) | `ManagerInterface` (admin) | `ProfileWizard` (staff first-login, gated by `profile_completed !== true`) | `StaffDashboard` (staff)
- Public routes (registered in `main.jsx`, no auth required): `/activate` (ActivatePage), `/privacy-notice` (PrivacyNoticePage)
- `ManagerInterface` → tab router for: `RequirementsPanel`, `StaffManagementPanel`, `SchedulePanel`, `PublishPanel`, `ScheduleReviewPanel`, `StatisticsPanel`, `AccessLogPanel` (稽核日誌 — admin-only viewer for `access_logs`)

**Key components:**
- `SchedulePanel` — Schedule generation workspace with two AI engines side-by-side: **Gemini** (LLM, generates anonymous virtual D-slot patterns) and **CP-SAT** (Google OR-Tools, direct assignment to real staff_id, see CP-SAT section below). Both render via the same chat-style UI.
- `PublishPanel` — Publish schedule for staff to claim; supports single/bulk unassign of staff; staff column shows `avatar_thumb` next to name.
- `ScheduleReviewPanel` — Historical schedule viewer, payroll settlement engine (base salary + OT + night bonus + level bonus 進階加給), health score calculator, Excel export. Staff name columns include avatars.
- `StatisticsPanel` — Nurse-to-patient ratio monitoring (Taiwan 衛福部 regulations), AI cross-month analytics, agentic turn radar.
- `StaffDashboard` — Staff self-service: 4-step shift selection wizard, turn-based access control, password change, clickable avatar opens `AvatarEditModal`. Guards 3/4-pre/4 (long-leave, slot-claimed-out, not-your-turn) all mount a shared `dashboardHeader` with avatar + 修改密碼; guard 2 (deactivated) gets password access only, no avatar edit.
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
| `activate-account.js` | Public endpoint (token IS the auth). `POST {token, newPassword}` → verifies token, enforces strength, sets the password via Admin SDK; for `purpose: 'activation'` also flips `disabled: false`. CSRF + per-IP rate limit. |
| `complete-profile.js` | Authenticated endpoint (staff Firebase token). Two modes via `body.mode`: `'first'` (default) — first-login flow, fills name/gender/tenure/孕哺/大夜/encrypted PII (idNumber, bankAccount, phone) + `pdpa_consented_at` audit timestamp, sets `profile_completed: true`, logs `action='encrypt'`. `'update'` — post-login self-service for basic fields and avatar (`avatar`, `avatar_thumb`); all fields optional, only patches what's provided, does NOT touch encrypted PII or `profile_completed`, logs `action='update-profile'` with the list of changed fields. Both modes batch-write all three staff docs (Staff + StaffPublic + StaffPrivate). Admin cannot use this endpoint. |
| `log-login.js` | Login auditing multiplex. `body.success: true` requires Bearer token, writes `access_logs` action `'login'` (per-uid 10/min). `body.success: false` is unauthenticated (auth just failed by definition); IP-rate-limited 10/min, records `action='login-failure'` plus attempted email + Firebase error code in `extra`. (Merged from former `log-login.js` + `log-login-failure.js` to stay under Vercel Hobby plan's 12-function limit.) |
| `claim-schedule.js` | Authenticated endpoint (staff Firebase token). Body `{year, month, virtualSlotId}`. Runs a Firestore transaction: read `Schedules/{ym}.finalizedSchedule`, verify the virtual D-slot still exists and the actor hasn't already claimed for this month, then atomically delete the virtual slot key and write the same pattern under the actor's UID. Inside the same tx also writes a masked projection to `SchedulesPublic/{ym}` (事假/病假/特休 → OFF) so colleagues' privacy stays consistent. Admin and direct client writes to the schedule are blocked by rules — staff route through this endpoint, eliminating the vertical-escalation hole where any staff could overwrite a colleague's whole month. |
| `auto-settle.js` | Monthly payroll settlement; supports `?targetDate` for testing, `?force=true` to force |
| `cron/check-timeout.js` | Runs daily (Vercel Cron `0 0 * * *`); auto-advances agentic turn after 24h timeout |
| `auto-relay.js` | Triggered when an agentic turn is force-relayed; uses Gemini to pick the next staff and emails the warning + diagnostics. Accepts `CRON_SECRET` or a Firebase ID token. |
| `secure-field.js` | Field-level encryption gateway: `action: encrypt \| decrypt \| batchDecrypt \| logAiAccess`. Verifies Firebase token, applies RBAC (admin sees all; staff sees only own UID), writes audit row to `access_logs`. Requires `FIELD_ENC_KEY`. |

**Shared middleware (`api/_lib/`):** Security utilities imported by the serverless functions — `csrf.js` (origin allowlist validation), `rateLimit.js` (in-memory per-user rate limiter, 1-min window), `sanitize.js` (HTML sanitizer stripping `<script>`, event attrs, `javascript:` URLs), `crypto.js` (AES-256-GCM encrypt/decrypt; ciphertext format `{ct, iv, tag, v}`), `accessLog.js` (writes audit rows to Firestore `access_logs` collection — fire-and-forget, never blocks business logic), `activationToken.js` (issue/verify/consume one-time tokens for account activation and password reset; stores sha256 hash, 24h TTL).

### Firestore Schema

```
NurseApp/Settings          — global app config (shiftOptions, priorityConfig, requirements, bedConfig, baseSalary*, levelBonus, publishedDate)
NurseApp/Staff             — { staffData: [...], healthStats: [...] }   admin-only read
                             staffData[*] sensitive fields (encrypted blob): idNumber*, bankAccount*, phone*
                             staffData[*].profile_completed: true once the staff has filled the first-login wizard
                             staffData[*].pdpa_consented_at + pdpa_notice_version: PDPA §8 audit timestamps
                             staffData[*].avatar: 220×220 WebP base64 data URL (~20-30 KB) — full size for admin views
                             staffData[*].avatar_thumb: 64×64 WebP base64 data URL (~3-5 KB) — used in shift cards
NurseApp/StaffPublic       — { staffData: [{staff_id,name,level,is_leader,is_active,avatar_thumb}, ...] }   any authed user reads
                             sanitized projection — no PII/health/financial. Only avatar_thumb (not full avatar) is included
                             to stay under Firestore's 1 MiB single-doc limit (~100 staff × 4 KB thumb ≈ 400 KB). Mirrored
                             on every saveGlobalStaff. Build via buildStaffPublicProjection — keep in sync across all four
                             call sites: src/api/database.js, api/complete-profile.js, scripts/migrate-staff-public.js,
                             scripts/restore-staff-from-private.js.
StaffPrivate/{id}          — top-level collection; full row for a single staff   admin or matching staff uid reads
                             same shape as a single element of NurseApp/Staff.staffData
                             (top-level rather than NurseApp/StaffPrivate/* because Firestore doc paths must be even segments)
Schedules/{YYYY_M}         — { schedule: {...}, finalizedSchedule: {...} }   admin-only read
                             full content including raw 事假/病假/特休 leave types
SchedulesPublic/{YYYY_M}   — { finalizedSchedule: {... masked ...} }   any authed user reads
                             same shape but 事假/病假/特休 cells replaced by 'OFF';
                             mirrored on every saveMonthlySchedule / updateStaffSchedule / claim-schedule
archive_reports/{YYYY_M}   — { year, month, schedule_backup, backedUpAt, note, csv? }
SelectionTurn/{YYYY_M}     — { active_staff_id, updatedAt }
SelectionProgress/{YYYY_M} — { submitted_staff: [...] }
AI_Decision_Logs           — { timestamp, selected_staff, ai_logic, candidates_data }
pending_activation/{sha256(token)} — server-only; { uid, email, purpose: 'activation'|'reset', expiresAt, createdAt }
access_logs                — audit trail; { ts, actor:{uid,email}, action:'decrypt'|'encrypt'|'ai-access'|'ai-access-blocked'|'update-profile'|'delete-staff'|'login'|'login-failure'|'relock', target:{kind,id}, fields:[], ip, ua, extra? }
                             ai-access-blocked: written when api/gemini.js detectSensitivePii catches身分證/手機 in prompt and refuses to forward to Google.
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

### Agentic Turn System

Staff select shifts in a priority queue managed by AI (Gemini). `calculateAndNotifyNextStaff` in App.jsx builds a prompt with all candidate stats, calls Gemini to pick the most fatigued/deserving staff, writes to `SelectionTurn`, logs to `AI_Decision_Logs`, and sends email notification. Pregnant/nursing staff get absolute priority. `cron/check-timeout.js` auto-advances if no selection within 24h.

### CP-SAT Optimization Engine (`main1.py`)

Independent Python microservice (FastAPI + Google OR-Tools CP-SAT). Lives at repo root but **not deployed by Vercel** (see CSP/`.vercelignore` note). Complementary to the Gemini flow:

- **Gemini path** (`api/gemini.js`): LLM generates anonymous `pattern` strings → frontend assigns virtual D-slot IDs → staff claim via agentic turn. Output is non-deterministic, retried up to 5 times client-side to pass the daily-headcount filter.
- **CP-SAT path** (`main1.py`): Constraint solver computes mathematically optimal direct assignment to real `staff_id`. Output is deterministic (same input → same schedule), skips the claim flow, writes straight to `schedule` + `finalizedSchedule`.

`SchedulePanel` exposes both via side-by-side buttons (「生成 AI 班表」 purple, 「CP-SAT 最佳化」 teal). Admin chooses per generation.

CP-SAT model encodes: each-day-one-shift, illegal transitions (N→D/N→E/E→D), 七休一 (sliding 7-day window must contain off), post-night double off, 4-week ≥8 off + ≤27 work days, maternal/student E+N ban. Objective minimizes (shortfall × 100) + per-staff health penalties (consecutive-4-night −5, consecutive-6-work −5), with a per-staff penalty cap of 30 (guarantees ≥70 health score for everyone, may cause INFEASIBLE if conditions too strict).

Service exposes `GET /` (landing), `GET /health` (no auth), `POST /generate_schedule` (Firebase Bearer token required, 5/min/uid rate limit), `GET /docs` (Swagger UI for testing). See `CPSAT_DEPLOY.md` for full deployment + integration steps.

### Auth Flow

Three-layer security: (1) frontend route guard on session token, (2) zero-trust state validation (is_active, leave_status, turn ownership), (3) RBAC — admin (`admin@hospital.com`) vs staff roles. Backend APIs verify Firebase ID tokens via Bearer header.

**First-login PDPA gate:** When `profile_completed === false`, App.jsx routes to `ProfileWizard` instead of `StaffDashboard`. Step 1 of the wizard blocks the form behind a PDPA §8 consent — the staff must click through to `/privacy-notice` (new tab), scroll to the bottom (localStorage flag `pdpa_read_v1` set there), then tick the agreement checkbox. The consent timestamp is persisted to `staffData[*].pdpa_consented_at`. Notice version bumps (`v1 → v2 …`) force everyone to re-consent.

**Offboarding (永久離職):** Admin clicks 🗑 on a staff row in StaffManagementPanel → calls `/api/admin-user action='delete-staff'`. Backend runs a Firestore transaction: snapshot `staff_id/name/email/level/tenure/avatar/avatar_thumb` into `ex_staff/{id}` with `deleted_at` + `deleted_by`, remove from `NurseApp/Staff` array, rebuild StaffPublic, delete StaffPrivate. Then disables Firebase Auth + revokes tokens (non-fatal — logs warning if fails). Writes `access_logs` action=`delete-staff`. **Encrypted PII (idNumber/bankAccount/phone) is intentionally NOT copied to ex_staff** — offboarding should destroy ciphertext too, otherwise the org keeps a key-management burden for someone who's gone.

## Deployment

Vercel auto-deploys on push to `main`. `vercel.json` configures the daily cron and rewrites all `/api/*` routes plus SPA fallback to `index.html`.

`vercel.json` also ships a strict Content-Security-Policy whitelisting Firebase, Google APIs, OpenWeatherMap, jsDelivr, **tfhub.dev + www.kaggle.com + storage.googleapis.com** (BlazeFace model weights), and **the CP-SAT microservice URL**. **Adding any new external script, API, or image source requires updating the `Content-Security-Policy` header in `vercel.json`** — otherwise it works locally but is silently blocked in production.

`.vercelignore` excludes `main1.py`, `requirements.txt`, `Dockerfile`, and `CPSAT_DEPLOY.md` from the Vercel build context. Without this, Vercel auto-detects `requirements.txt` and runs `uv pip install`, which fails because ortools (~65MB wheel + libgomp native dep) doesn't fit in the 250MB unzipped lambda limit. Keep the files in git so Render/Railway can pull them.

### Legacy `server/` and `my-app/` Directories

The `server/` folder contains a legacy local Express dev server (port 3001) backed by a JSON file (`db.json`). This is **not used in production** — it predates the Vercel serverless + Firebase architecture. Ignore it for new development.

Likewise, `my-app/` is an unrelated scratch/sandbox directory with its own `node_modules` and configs. Ignore it for any work on the nurse-schedule app.

### Diagnostic & Repair Scripts

Beyond the migrations referenced above, `scripts/` also holds diagnostic helpers — `diagnose-relay.js` / `test-relay.js` for the agentic turn pipeline, `check-staff-data.js` / `restore-staff-from-private.js` for staff-doc integrity, `list-firestore-usage.js` for read-volume audits, and `fix-uid-keyed-schedule.js` / `migrate-schedule-public.js` for schedule-doc repair. All accept `--commit` to write; default is dry-run.

## Linting Notes

ESLint flat config (`eslint.config.js`) has a custom `no-unused-vars` rule: variables starting with an uppercase letter or `_` are ignored (`varsIgnorePattern: '^[A-Z_]'`). This allows unused React component imports (e.g. icon components passed as props) and intentionally unused `_` variables.
