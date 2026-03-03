# GEOrge

Standalone GEO measurement product.

## What It Includes

- GEO dashboard at `/` and `/geo`
- Org-scoped dashboard routes (for example `/vancouver` and `/vancouver/geo`)
- GEO batch APIs (`/api/geo/*`)
- Firestore-backed batch persistence
- Scheduled cloud runner (`src/geo-scheduled-run.js`)
- Recovery watchdog runner (`src/geo-schedule-watchdog.js`)
- Auth with roles (`admin`, `member`), invite acceptance, and password reset requests
- Self-registration requests with admin approval queue

## Local Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `.env` values:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3-flash-preview
DATA_BACKEND=firestore
FIRESTORE_NAMESPACE=dv_agent
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

## Commands

```powershell
npm run server:start
npm run geo:run:scheduled
npm run geo:run:watchdog
npm run geo:migrate:firestore
```

## Production Notes

- Cloud Run service should serve this app only.
- Cloud Run Job `dv-geo-scheduled-run` executes the scheduled GEO batch runner.
- Cloud Scheduler triggers the job on cron.
- Cloud Run Job `dv-geo-schedule-watchdog` executes hourly recovery attempts if no completed daily batch exists.

## Environments

- Dev Hosting: `https://george-58c03-dev.web.app` (rewrites to Cloud Run service `dmo-geo-dev`)
- Prod Hosting: `https://george-58c03.web.app` (rewrites to Cloud Run service `dmo-geo`)
- Firebase/GCP project: `george-58c03`

### Deploy Workflow

1. Deploy backend to dev:
   - `npm run deploy:run:dev`
2. Deploy hosting to dev:
   - `npm run deploy:hosting:dev`
3. Validate on `https://george-geo-dev.web.app`
4. Promote to prod when ready:
   - `npm run deploy:run:prod`
   - `npm run deploy:hosting:prod`
