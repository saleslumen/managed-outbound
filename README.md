# Managed outbound

Cold email on Saleslumen. Workflows run in a namespace. The organization owns that namespace.

Campaigns sends the mail. This pack provisions one domain and one mailbox per run, watches warm up and sender health, and replies when a thread is labeled Interested or when a later campaign reply arrives while Interested remains on the thread. Leads are added in Campaigns. This pack does not import them.

Definitions are in [workflows/README.md](workflows/README.md). Registry fields are in [airtable/README.md](airtable/README.md). Commands are in [scripts/README.md](scripts/README.md).

## Providers

`node scripts/install.mjs` installs these from the Marketplace:

| Provider | What it does |
|----------|----------------|
| Airtable | Namespaces, Domains, Email Accounts, and Exceptions. |
| Dynadot | Domain registration and CloudNS nameservers. |
| Zapmail | Domain connection, forwarding, the mailbox, and export to Truly Inbox. |
| Truly Inbox | Warm up. |
| Saleslumen Emails | Mailbox connection and threads. No API key. |
| OpenRouter | Reply text for an Interested label add or a later Interested reply. |

## Install

Sign in with user OAuth, then create the namespace and install the pack.

```bash
sl auth login
sl resources namespaces create --input FILE
node scripts/install.mjs --namespace {namespaceId} --dry-run
node scripts/install.mjs --namespace {namespaceId}
```

`FILE` is `{ "requestId": "<uuid>", "name": "...", "description": "..." }`. The CLI requires `requestId` and does not generate one. A `202` prints the operation. Retry the same file.

Copy `environment/namespace.env.example` to `environment/{namespaceId}.env` and fill in the marketplace app ids and API keys. `--dry-run` prints the plan and does not call `sl`. A missing marketplace app id stops before any `sl` call. A missing API key stops after the app is read and before the installation is created.

The installer creates each installation, rewrites the bare key to `installations/{id}`, and sets the API key when the app declares one. Saleslumen Emails has no connection. It reads `AIRTABLE_BASE_ID` from `airtable/.env`. It then creates each workflow, creates a revision, and deploys it. It creates the `TRIGGER_EVENT_THREAD_LABEL_ADDED` and `TRIGGER_EVENT_MESSAGE_REPLIED` triggers on Process campaign replies.

An organization install uses `environment/org.env` and `node scripts/install.mjs --org`. The workflows in this pack are namespace-scoped. Pass `--namespace` when you run one. Omit it for an organization workflow. Sending a namespace header does not move an organization workflow into a namespace.

After install, create a schedule for Monitor warm up and Monitor sender health:

```bash
sl --json --namespace ID api workflows /v1/workflows/{workflow}/triggers -X POST --input FILE
```

`FILE` is `{ "kind": "KIND_SCHEDULE", "enabled": true, "cron": "...", "timeZone": "..." }`.

Start a run with `sl --json --namespace ID api workflows /v1/workflows/{workflow}/executions -X POST --input FILE`. The body is `{ "input": { ... } }`. Field names are the snake_case inputs in `manifest.json`.

## Workflows

| Workflow | File |
|----------|------|
| Provision Google infrastructure | `workflows/provision-google-infrastructure.json` |
| Provision Microsoft infrastructure | `workflows/provision-microsoft-infrastructure.json` |
| Monitor warm up | `workflows/monitor-warm-up.json` |
| Monitor sender health | `workflows/monitor-sender-health.json` |
| Process campaign replies | `workflows/process-campaign-replies.json` |

Write `warm up` in prose. The file is `monitor-warm-up.json`.

One provision run creates one inbox. The first required input is `namespace_name`. Another inbox is another run. Provisioning does not set Truly Inbox warm up. A workflow step that fails after the domain purchase opens an Exceptions row. CRM automation is not configured.

## What you still do

Once per organization:

1. In Airtable, create a base and a token with `data.records:read`, `data.records:write`, and `schema.bases:write`.
2. Copy `airtable/.env.example` to `airtable/.env`, set `AIRTABLE_PAT` and `AIRTABLE_BASE_ID`, and run `node airtable/provision.mjs`. That creates Namespaces, Domains, Email Accounts, and Exceptions.

Once per namespace, in Zapmail:

1. Create the workspace. Its id is the `zapmail_workspace_id` input.
2. Register the Truly Inbox login as a third-party account. Its id is the `trulyinbox_third_party_account_id` input.

Before each provision run, confirm the domain purchase. `registerDomain` buys the domain on every run. A failed purchase writes nothing to Airtable.

Create the campaign in Campaigns and leave it as a draft. After warm up, add the inbox and turn the campaign on. Add leads in Campaigns.

To stop sending, pause the campaigns in Campaigns and stop warm up on those mailboxes in Truly Inbox. Pausing a Saleslumen email account does not hold while Monitor warm up is deployed. That workflow resumes a paused account once Truly Inbox lists it as ready for outreach and its deliverability rate is 85 or above. Domains and mailboxes stay until someone removes them in Dynadot and Zapmail. This pack does not delete workflows.

## Layout

| Path | What it holds |
|------|----------------|
| `airtable/` | Registry schema and `provision.mjs`. |
| `workflows/` | One definition per workflow. |
| `manifest.json` | The list `node scripts/validate-manifest.mjs` reads. Saleslumen does not load it. |
| `environment/` | Marketplace app ids and API keys. Do not commit `environment/*.env`. |
| `scripts/` | `install.mjs`, `validate-manifest.mjs`, and `render-workflows.mjs`. |
| `previews/` | A PNG of each workflow. |
