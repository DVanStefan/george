# GEOrge

Standalone GEO measurement product.

## What It Includes

- GEO dashboard at `/` and `/geo`
- Org-scoped dashboard routes (for example `/vancouver` and `/vancouver/geo`)
- GEO batch APIs (`/api/geo/*`)
- Firestore-backed batch persistence
- Scheduled cloud runner (`src/geo-scheduled-run.js`)
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
npm run geo:migrate:firestore
```

## Production Notes

- Cloud Run service should serve this app only.
- Cloud Run Job `dv-geo-scheduled-run` executes the scheduled GEO batch runner.
- Cloud Scheduler triggers the job on cron.
