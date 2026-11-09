# Commands

Run these from the skill root.

## Create a namespace

```bash
sl auth login
sl resources namespaces create --input FILE
```

`FILE` is `{ "requestId": "<uuid>", "name": "...", "description": "..." }`. The CLI requires `requestId` and does not generate one. A `202` prints the operation. Retry the same file.

## Install the pack

```bash
node scripts/install.mjs --namespace {namespaceId} --dry-run
node scripts/install.mjs --namespace {namespaceId}
```

`install.mjs` reads `<KEY>_MARKETPLACE_APP_ID` from `environment/{namespaceId}.env`. It reads the permission digest and the API-key connection with `sl marketplace apps get`, creates the installation, and rewrites the bare key to `installations/{id}`. When the app declares one installation API-key connection, it sets `<KEY>_API_KEY` on that connection. Saleslumen Emails is `SALESLUMEN_EMAILS_MARKETPLACE_APP_ID` and declares no connection. The `AIRTABLE_BASE_ID` literal comes from `airtable/.env`.

It then creates each workflow, creates a revision, and deploys it. It creates every event trigger declared in `manifest.json`, deletes a listed trigger whose event type is not declared, and records each trigger name by event type.

`--dry-run` prints the plan and checks every marketplace app id without calling `sl`. A missing marketplace app id stops before any `sl` call. A missing API key stops after the app is read and before the installation is created. The error names only the missing key.

Start a run:

```bash
sl --json --namespace ID api workflows /v1/workflows/{workflow}/executions -X POST --input FILE
```

The body is `{ "input": { ... } }`. Field names are the snake_case inputs in `manifest.json`.

Create a schedule for Monitor warm up and Monitor sender health:

```bash
sl --json --namespace ID api workflows /v1/workflows/{workflow}/triggers -X POST --input FILE
```

`FILE` is `{ "kind": "KIND_SCHEDULE", "enabled": true, "cron": "...", "timeZone": "..." }`.

## Keys

`environment/org.env` and `environment/{namespaceId}.env` use the same key names. Each file holds that scope's marketplace app ids and API keys. `airtable/.env` holds `AIRTABLE_PAT` and `AIRTABLE_BASE_ID` for `node airtable/provision.mjs`. The marketplace Airtable key is `AIRTABLE_API_KEY` in the scope env. Do not commit `environment/*.env` or `airtable/.env`.

## Check the catalog

```bash
node scripts/validate-manifest.mjs
node scripts/validate-manifest.mjs --apps CHECKOUT
```

With `--apps`, every call operation must be a function in that marketplace checkout.

## Preview a workflow

```bash
node scripts/render-workflows.mjs
node scripts/render-workflows.mjs workflows/monitor-warm-up.json
```

This writes one HTML page and one PNG per workflow under `previews/`. The PNG files are checked in. The HTML files stay local.

Each step is an 80px circle with an outlined MUI icon, a curved kind label, and a caption. Edges are cubic beziers from the right of a step to the left of the next. A parallel branch is dashed. The PNG is cropped to the canvas with a 40px margin. Playwright and `@mui/icons-material` are installed in this skill (`npm install`, then `npx playwright install chromium`). Manrope is loaded from Google Fonts.
