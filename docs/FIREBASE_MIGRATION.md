# Firebase Migration Guide

This repo now supports a server mode that can persist session data to Firestore.

## 1) Install runtime dependency

On your deploy environment:

```powershell
npm install firebase-admin
```

## 2) Configure environment

Required for Firestore mode:

```text
DATA_BACKEND=firestore
FIRESTORE_NAMESPACE=dv_agent
GOOGLE_APPLICATION_CREDENTIALS=/secrets/firebase-service-account.json
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
```

Optional strict mode:

```text
DATA_BACKEND_STRICT=true
```

## 3) Run service

```powershell
npm run server:start
```

Health endpoint:

`GET /health`

## 4) Cloud Run deployment pattern

1. Containerize app with `npm ci && npm run server:start`.
2. Inject env vars above.
3. Mount service account credentials or use workload identity.
4. Set Cloud Run health check to `/health`.
5. Route Firebase Hosting rewrites to Cloud Run service.

Repo stubs included:

- `firebase.json` (Hosting rewrite to Cloud Run service `dv-agent-command-center`)
- `.firebaserc.example` (project id template)

## 5) Data model (Firestore)

- `${FIRESTORE_NAMESPACE}_sessions/{sessionId}`
  - session metadata (`userRequest`, `overallScore`, `latestAssistant`, `updatedAt`, ...)
- `.../messages/{autoId}`
  - chat turns (`role`, `content`, `at`)
- `.../runs/{runId}`
  - latest run snapshots (`finalOutput`, `evaluation`, `pipeline`, ...)
- `.../runs/{runId}/steps/{idx}`
  - agent step details for dialogue timeline
