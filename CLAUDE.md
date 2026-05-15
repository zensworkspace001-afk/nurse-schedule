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

## Environment Variables

All keys live in Vercel dashboard (Settings > Environment Variables). For local dev, `.env.local` is pulled via `vercel env pull`:
- `VITE_FIREBASE_*` — Firebase client SDK config (6 keys)
- `GEMINI_API_KEY` — Google Gemini AI
- `RESEND_API_KEY` — Email service
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Firebase Admin SDK (backend only)
- `CRON_SECRET` — Vercel Cron job authentication
- `FIELD_ENC_KEY` — **AES-256-GCM master key for field-level encryption** (base64-encoded 32 bytes). Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Lose this and all encrypted fields are unrecoverable** — back it up offline. Used by `api/secure-field.js` and `scripts/migrate-encrypt.js`.

## Architecture

**Full-stack web app** for nursing shift scheduling at a Taiwan hospital. React/Vite frontend + Vercel serverless backend. All persistent state in Firebase Firestore. UI text is Traditional Chinese (繁體中文).

### Frontend (`src/`)

**Styling convention:** Each component has a co-located `.css` file using BEM naming (e.g. `.publish__header`, `.staff-mgmt__row--inactive`). Only truly dynamic values (runtime-computed colors) remain as inline styles. Do not add new inline styles — use CSS classes. Modals/overlays use glassmorphism (`backdrop-filter: blur()`, `rgba` backgrounds) with fade-in/fade-out CSS animations (closing state + `setTimeout` for deferred unmount).

`src/App.jsx` — Root `NurseSchedulingSystem` component. Owns all top-level state (staffData, schedule, finalizedSchedule, violations, etc.), Firebase `onSnapshot` subscriptions, cloud read/write engines (2s debounce), and core business logic: `handleStaffScheduleUpdate`, `calculateAndNotifyNextStaff`, `handlePushToHistory`, `handleSaveAndPublish`. Routes to `ManagerInterface` (admin) or `StaffDashboard` (staff) based on role.

`src/constants.js` — Shared constants and pure functions. All compliance logic lives here: `SHIFT_TYPES`, `LABOR_LAW_RULES`, `calculateAnnualLeave`, `checkLaborLawCompliance`, `checkSkillMixSafety`, `calculateScheduleRisks`. Import from here — do not duplicate.

`src/api/database.js` — All Firestore CRUD: `subscribeToSettings`, `subscribeToStaff` (admin), `subscribeToStaffPublic` (staff colleagues view), `subscribeToMyStaffPrivate` (staff own row), `subscribeToSchedule`, `saveGlobalSettings`, `saveGlobalStaff` (batch-writes the three staff docs), `saveMonthlySchedule`, `updateStaffSchedule`, `saveArchiveReport`, `subscribeToArchiveReports`, `clearArchiveReports`, `backupScheduleToArchive`, `buildStaffPublicProjection`. Also exports `auth` and `db` Firebase instances.

**Component hierarchy:**
- `App.jsx` → `LoginPanel` (unauthenticated) | `ManagerInterface` (admin) | `ProfileWizard` (staff first-login, gated by `profile_completed !== true`) | `StaffDashboard` (staff)
- `ManagerInterface` → tab router for: `RequirementsPanel`, `StaffManagementPanel`, `SchedulePanel`, `PublishPanel`, `ScheduleReviewPanel`, `StatisticsPanel`, `AccessLogPanel` (稽核日誌 — admin-only viewer for `access_logs`)

**Key components:**
- `SchedulePanel` — AI-powered schedule generation workspace with Gemini chat, drag-to-assign, and conflict detection
- `PublishPanel` — Publish schedule for staff to claim; supports single/bulk unassign of staff
- `ScheduleReviewPanel` — Historical schedule viewer, payroll settlement engine (base salary + OT + night bonus + level bonus 進階加給), health score calculator, Excel export
- `StatisticsPanel` — Nurse-to-patient ratio monitoring (Taiwan 衛福部 regulations), AI cross-month analytics, agentic turn radar
- `StaffDashboard` — Staff self-service: 4-step shift selection wizard, turn-based access control, password change

**Shift types:** D (day 07-16), E (evening 15-00), N (night 23-08), OFF, RG (例假/statutory rest), RC (休息日), 支援 (support), 事假, 病假, 特休.

**Labor law compliance** (Taiwan 勞基法) via `checkLaborLawCompliance` in `constants.js`: max 40h/week, 46h/month OT, 11h min rest between shifts, max 6 consecutive days, forbidden sequences (E→D, N→D, N→E), maternity protection, RG interval rule (≤6 days, ≤12 for BiWeekly), and **七休一** (every 7-day window must contain at least one RG/RC day off). The 七休一 rule is also enforced post-AI in `SchedulePanel` and re-normalized at dashboard read-time as a defence-in-depth check.

**Staff levels:** N0/N1 = junior; N2/N3/N4 = senior. `checkSkillMixSafety` warns when a shift has no senior (N2+) or leader present. Each level has a configurable monthly bonus (`levelBonus` in Settings): N0=0, N1=1000, N2=2000, N3=3200, N4=5000 by default.

**Default schedule month:** Defaults to next month (e.g. March → April). If December, rolls to January of next year. Persisted in `localStorage`.

### Backend (`api/`)

Vercel serverless functions:

| File | Purpose |
|------|---------|
| `gemini.js` | AI chat — requires Firebase Bearer token |
| `analyze-excel.js` | Analyzes uploaded CSV/Excel using Gemini Flash |
| `sendEmail.js` | Sends email via Resend |
| `admin-user.js` | Admin-only multiplex (Bearer token + admin email). `body.action` switches: `'sync'` bulk-creates Firebase Auth accounts with `disabled:true` + random throwaway password and issues activation tokens / activation emails (no more hardcoded `123456`); `'reset'` issues a `purpose:'reset'` token and sends the same `/activate?token=...` link. Both share the activation-token lifecycle in `_lib/activationToken.js`. (Merged from former `sync-accounts.js` + `reset-password.js` to stay under Vercel Hobby plan's 12-function limit.) |
| `activate-account.js` | Public endpoint (token IS the auth). `POST {token, newPassword}` → verifies token, enforces strength, sets the password via Admin SDK; for `purpose: 'activation'` also flips `disabled: false`. CSRF + per-IP rate limit. |
| `complete-profile.js` | Authenticated endpoint (staff Firebase token). On first login the staff fills name / gender / tenure / 孕哺 / 大夜 / encrypted PII (idNumber, bankAccount, phone). Server validates, AES-encrypts the PII, writes the staff's row in `staffData`, sets `profile_completed: true`, and writes one `access_logs` row (action=`encrypt`). Admin cannot use this endpoint. |
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
NurseApp/StaffPublic       — { staffData: [{staff_id,name,level,is_leader,is_active}, ...] }   any authed user reads
                             sanitized projection — no PII, health, or financial fields. mirrored on every saveGlobalStaff.
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
access_logs                — audit trail; { ts, actor:{uid,email}, action:'decrypt'|'encrypt'|'ai-access', target:{kind,id}, fields:[], ip, ua, extra? }
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

### Auth Flow

Three-layer security: (1) frontend route guard on session token, (2) zero-trust state validation (is_active, leave_status, turn ownership), (3) RBAC — admin (`admin@hospital.com`) vs staff roles. Backend APIs verify Firebase ID tokens via Bearer header.

## Deployment

Vercel auto-deploys on push to `main`. `vercel.json` configures the daily cron and rewrites all `/api/*` routes plus SPA fallback to `index.html`.

`vercel.json` also ships a strict Content-Security-Policy whitelisting Firebase, Google APIs, OpenWeatherMap, and jsDelivr. **Adding any new external script, API, or image source requires updating the `Content-Security-Policy` header in `vercel.json`** — otherwise it works locally but is silently blocked in production.

### Legacy `server/` and `my-app/` Directories

The `server/` folder contains a legacy local Express dev server (port 3001) backed by a JSON file (`db.json`). This is **not used in production** — it predates the Vercel serverless + Firebase architecture. Ignore it for new development.

Likewise, `my-app/` is an unrelated scratch/sandbox directory with its own `node_modules` and configs. Ignore it for any work on the nurse-schedule app.

### Diagnostic & Repair Scripts

Beyond the migrations referenced above, `scripts/` also holds diagnostic helpers — `diagnose-relay.js` / `test-relay.js` for the agentic turn pipeline, `check-staff-data.js` / `restore-staff-from-private.js` for staff-doc integrity, `list-firestore-usage.js` for read-volume audits, and `fix-uid-keyed-schedule.js` / `migrate-schedule-public.js` for schedule-doc repair. All accept `--commit` to write; default is dry-run.

## Linting Notes

ESLint flat config (`eslint.config.js`) has a custom `no-unused-vars` rule: variables starting with an uppercase letter or `_` are ignored (`varsIgnorePattern: '^[A-Z_]'`). This allows unused React component imports (e.g. icon components passed as props) and intentionally unused `_` variables.
