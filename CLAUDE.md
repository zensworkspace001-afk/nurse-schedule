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
```

Dev server proxies `/api/*` requests to `nurse-schedule-bachelor.vercel.app` (the production Vercel backend), so local frontend connects to real serverless functions.

## Environment Variables

Required in `.env.local`:
- `VITE_FIREBASE_*` — Firebase client SDK config (6 keys)
- `GEMINI_API_KEY` — Google Gemini AI
- `RESEND_API_KEY` — Email service
- `FIREBASE_SERVICE_ACCOUNT` — JSON string of service account (backend only)
- `CRON_SECRET` — Vercel Cron job authentication

## Architecture

**Full-stack web app** for nursing shift scheduling at a Taiwan hospital. Frontend is React/Vite; backend is Vercel serverless functions. All persistent state lives in Firebase Firestore.

### Frontend (`src/`)

`src/App.jsx` is the main component (~268KB) containing the admin dashboard — monthly calendar grid, tabs for Schedule / Staff / Rules / Analysis / Archive. It uses Firebase `onSnapshot` listeners for real-time sync.

`src/constants.js` — canonical home for shared logic: `SHIFT_TYPES`, `LABOR_LAW_RULES`, `calculateAnnualLeave`, `checkLaborLawCompliance`, `checkSkillMixSafety`, `calculateScheduleRisks`. **Note:** `App.jsx` still contains its own inline copies of these (migration in progress) — prefer `constants.js` for any new work and when touching the duplicates.

`src/api/database.js` — all Firestore read/write operations.

`src/components/StaffDashboard.jsx` — staff self-service UI; shift selection wizard, turn-radar, and password-change modal.

`src/components/RequirementsPanel.jsx` — bed-count / nurse-to-patient ratio config panel; derives daily D/E/N headcount requirements.

`src/components/LoginPanel.jsx` — login UI (replaces `src/LoginPanel.js`).

`src/backup.js` — legacy backup of the old monolithic App.jsx; not imported anywhere.

**Shift types:** D (day 07:00-16:00), E (evening 15:00-00:00), N (night 23:00-08:00), OFF, RG (例假, statutory rest), RC (休息日), 支援 (support).

**Labor law compliance** (Taiwan 勞基法) is enforced client-side via `checkLaborLawCompliance` in `constants.js`: max 40h/week, 46h/month OT, 11h min rest between shifts, max 6 consecutive days, forbidden sequences (E→D, N→D, N→E), maternity protection (E/N banned for pregnant/nursing staff), RG interval rule (≤6 days between statutory rest days, ≤12 for BiWeekly staff).

**Staff levels:** N0/N1 = junior; N2/N3/N4 = senior. `checkSkillMixSafety` warns when any D/E/N shift has no N2+ or leader on duty.

### Backend (`api/`)

Vercel serverless functions:

| File | Purpose |
|------|---------|
| `gemini.js` | AI chat — requires Firebase Bearer token |
| `analyze-excel.js` | Analyzes uploaded CSV/Excel using Gemini Flash |
| `sendEmail.js` | Sends email via Resend |
| `sync-accounts.js` | Bulk-creates Firebase Auth accounts (`{id}@hospital.com`, pw: `123456`) |
| `reset-password.js` | Admin resets staff password; requires `admin@hospital.com` token |
| `auto-settle.js` | Monthly payroll settlement — generates CSV, archives to Firestore; supports `?targetDate` for testing |
| `cron/check-timeout.js` | Runs daily (Vercel Cron `0 0 * * *`); auto-advances the agentic turn if staff hasn't selected within 24h |

### Firestore Schema

```
NurseApp/Settings          — global app config
NurseApp/Staff             — { staffData: [...] } employee roster
NurseApp/HistoryData       — work history per employee
Schedules/{YYYY_M}         — { finalizedSchedule, violations }
archive_reports/{YYYY_M}   — { csv, timestamp, schedule_backup }
SelectionTurn/{YYYY_M}     — { active_staff_id, updatedAt }
```

### Agentic Turn System

Staff select their own shifts in a managed queue. `SelectionTurn` tracks whose turn it is. `cron/check-timeout.js` auto-advances after 24 hours. Admins can also manually advance the turn.

### Auth Flow

Three-layer security: (1) frontend route guard on session token, (2) zero-trust state check (is_active, leave_status, turn ownership), (3) RBAC — admin (`admin@hospital.com`) vs staff roles. Backend APIs verify Firebase ID tokens via Bearer header.

## Deployment

Vercel auto-deploys on push to `main`. `vercel.json` configures the daily cron and rewrites all `/api/*` routes plus SPA fallback to `index.html`.
