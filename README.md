# Jarvis Operations Center

Jarvis is an evidence-first operations service. The dashboard reads persisted
check results, task runs, notification receipts, and recovery audit records.
It never reports a configured dependency as healthy until a live check succeeds.

## Run locally

```bash
cp .env.example .env
npm run build
npm start
```

Open `http://localhost:8080`. For a VPS, use `docker compose up -d --build`.
Mount or retain the `jarvis-data` volume; it contains the evidence ledger.

## Before production

1. Configure real, read-only health URLs in `JARVIS_DEPENDENCIES_JSON`.
2. Configure a notification provider endpoint and record a provider delivery receipt.
3. Place the service behind HTTPS and authenticated access.
4. Keep `ALLOW_RECOVERY_ACTIONS=false` until a restart command, rollback plan, and operator approval process are in place.

No deployment, VPS, or notification provider is assumed by this repository.
