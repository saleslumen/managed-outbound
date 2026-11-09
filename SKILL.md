---
name: managed-service
description: >-
  Saleslumen Managed Outbound Operator. Operate cold email on Saleslumen.
  Use when you onboard a namespace, provision mail, monitor warm
  up or sender health, or process replies. Campaigns and leads stay outside
  this pack. Providers are Airtable, Dynadot, Zapmail, Truly Inbox,
  OpenRouter.
compatibility: >-
  Runs with sl. Workflow files are in workflows/. manifest.json lists them.
  Saleslumen does not load manifest.json. Skill commands live in scripts/.
metadata:
  version: "0.1.0"
  product: saleslumen
  title: Saleslumen Managed Outbound Operator
---

# Saleslumen Managed Outbound Operator

You operate cold email on Saleslumen. Workflows run in a namespace. The organization owns that namespace.

Create a namespace and install workflows with `sl`. The definitions are in `workflows/`. `manifest.json` lists each workflow, its file, and its `requiredInputs`. Saleslumen does not load that file. `node scripts/validate-manifest.mjs` reads it.

## Terms

| Term | Means |
|------|-------|
| Operator | The person. You do not read `environment/*.env`. |
| Organization | The Saleslumen organization. |
| Namespace | Where the workflows run. |
| Warm up | The mailbox warm up period. Write `warm up`. The file name is `monitor-warm-up.json`. |

## Providers

Connect these once:

- **Saleslumen** — workflows, campaigns, namespaces, mailbox connections, and thread replies.
- **Airtable** — the registry.
- **Dynadot** — domain registration and CloudNS nameservers.
- **Zapmail** — Google and Microsoft domain connection, forwarding, mailboxes, and export to Truly Inbox.
- **Truly Inbox** — warm up.
- **OpenRouter** — the reply text on an Interested label add or a later campaign reply while Interested remains.

## Files

| Path | What it holds |
|------|----------------|
| `airtable/` | The Namespaces, Domains, Email Accounts, and Exceptions catalog in `tables.json`. |
| `workflows/*.json` | One workflow definition. `node scripts/install.mjs` binds its installations, creates a revision, and deploys it. |
| `environment/org.env` | Marketplace app ids and API keys for `node scripts/install.mjs --org`. Same keys as the namespace env file. |
| `environment/{namespaceId}.env` | That namespace's marketplace app ids and API keys. The installer creates each installation. |
| `airtable/.env` | The Airtable token and base id. `node airtable/provision.mjs` reads both. `node scripts/install.mjs` binds the base id. Never read `airtable/.env` or `environment/*.env`. |
| `manifest.json` | The workflow list. |

A call runs an installed app. The definition stores that installation as a bare key such as `airtable`. `node scripts/install.mjs` reads `<KEY>_MARKETPLACE_APP_ID`, asks `sl` for the app's permission digest and API-key connection, creates the installation, and rewrites the key to `installations/{id}`. When that app declares one installation API-key connection, `<KEY>_API_KEY` is written there. Saleslumen Emails is `SALESLUMEN_EMAILS_MARKETPLACE_APP_ID` and declares no connection. An organization install is one installation for the whole organization. A namespace install is a different installation in each namespace. The installation id is not an env field.

## Workflow pack

| Workflow | File |
|----------|------|
| Provision Google infrastructure | `workflows/provision-google-infrastructure.json` |
| Provision Microsoft infrastructure | `workflows/provision-microsoft-infrastructure.json` |
| Monitor warm up | `workflows/monitor-warm-up.json` |
| Monitor sender health | `workflows/monitor-sender-health.json` |
| Process campaign replies | `workflows/process-campaign-replies.json` |

Airtable is the registry. `node scripts/install.mjs` replaces the `AIRTABLE_BASE_ID` literal from `airtable/.env`; no run names the base. Definitions call the `airtable` installation's `updateRecords` as an upsert: Namespaces on `Saleslumen Namespace ID`, set from `execution.namespace`, Domains on the lowercase hostname, Email Accounts on `Email`, and Exceptions on `Key`. The operator creates the tables once per organization with `node airtable/provision.mjs`, from `airtable/tables.json`. [airtable/README.md](airtable/README.md) names every field. Every row carries `Saleslumen Namespace ID`. The operator builds one Airtable view per namespace by filtering on it. Namespaces is the id-to-name directory. The Namespaces row stores `Name`, `Status` (`onboarding`, `active`), `Zapmail Workspace ID`, and `Truly Inbox Workspace ID`. Provisioning writes `Name` from `namespace_name` and `Status` `onboarding`. It writes `Zapmail Workspace ID` and leaves `Truly Inbox Workspace ID` for the operator. Set `Status` to `active` when sending starts. Domains is what Dynadot bought for the namespace. Email Accounts is the Zapmail mailbox: the lowercase domain, `Zapmail Mailbox ID`, `Saleslumen Emails Account ID`, `Truly Inbox Account ID`, and the sender status (`provisioning`, `sending`, `degraded`). `Saleslumen Emails Account ID` is also the Saleslumen Campaigns sender id. Monitor warm up writes `Truly Inbox Account ID` when it records a ready account. Provisioning does not write that field. Exceptions is the operator queue. Filter `Status` = `open` and group by `Kind` or `Workflow`. Workflow run history is the run record. Airtable has no run table.

Saleslumen Workflows runs the pack. Saleslumen Campaigns holds campaigns, senders, sequences, and replies. Saleslumen Emails holds the mailbox connections and threads. Provision Google or Microsoft infrastructure provisions one domain and one mailbox per run. The first required input is `namespace_name`. Another inbox is another run. Invalid input records one Airtable Exceptions row and reaches no infrastructure-provider call. A later valid run closes that row before the purchase. `registerDomain` buys the domain on every run. A failed purchase writes nothing to Airtable. After a successful purchase the definition closes the Dynadot exception, records the hostname on Domains, writes the Namespaces row with `Status` `onboarding`, and sets CloudNS nameservers `pns61.cloudns.net`, `pns62.cloudns.com`, `pns63.cloudns.net`, and `pns64.cloudns.uk`. `connectDomains` adds the domain to Zapmail. The run waits 12 hours and reads the domain. `ACTIVE` sets forwarding to `example.com`, assigns the mailbox, waits 12 hours, and reads the mailboxes. The Saleslumen OAuth connection and the Zapmail export to Truly Inbox then run together. Both finish before the run ends, and a caught error in one does not cancel the other. The run ends with an empty execution result. Provisioning does not set Truly Inbox warm up. The operator keeps the default 20 emails a day. `PENDING`, `IN_PROGRESS`, a missing domain, and any other status open a Zapmail exception and end. A mailbox that is not listed opens a mailbox exception and ends. Every later vendor failure after the purchase opens an Exceptions row. `Workflow` names the definition. `Detail` is `<operation>:<error reason>`. OpenRouter writes the reply when Interested is added or when a later campaign reply arrives while Interested remains. Leads are added in Campaigns. CRM automation is intentionally unconfigured pending explicit owner, pipeline, and stage settings. Every app is its vendor's own API contract.

Provision Google infrastructure and Provision Microsoft infrastructure record the hostname on Domains after `registerDomain` succeeds, then set nameservers. The Zapmail exception, keyed `{namespaceId}:provision:zapmail:{lowercase domain}`, opens when the domain is missing, still `PENDING` or `IN_PROGRESS`, or any status other than `ACTIVE`, and when `connectDomains`, `listDomains`, or `addDomainForwarding` fails. It closes after forwarding to `example.com`. A mailbox exception keyed `{namespaceId}:provision:mailbox:{email}` opens when assign or the mailbox read fails, or the mailbox is not listed, and closes when the mailbox is listed. Other provision keys follow `{namespaceId}:provision:<step>:<domain or email>`. Invalid input uses `{namespaceId}:provision:google:input` or `{namespaceId}:provision:microsoft:input`. The Saleslumen connection writes `Saleslumen Emails Account ID`. It does not write `Truly Inbox Account ID` or Email Accounts `Status`. Assign writes `provisioning`. Google `addGoogleClientId` has no documented read, so a later run that reaches it calls it again.

## Manual steps

Some setup has no API or needs a person's decision: creating the Zapmail workspace and Truly Inbox third-party account, confirming a domain purchase, and turning a campaign on. [README.md](README.md#what-you-still-do) lists every step and the run input it produces. Tell the operator which step is missing instead of working around it.

## Commands

Run these from the skill root.

```bash
sl auth login
sl resources namespaces create --input FILE
node airtable/provision.mjs
node scripts/install.mjs --namespace {namespaceId}
node scripts/render-workflows.mjs
```

`FILE` for namespace create is `{ "requestId": "<uuid>", "name": "...", "description": "..." }`. The CLI requires `requestId` and does not generate one. A `202` prints the operation; retry the same file. `node scripts/install.mjs` installs each app from `<KEY>_MARKETPLACE_APP_ID` in `environment/{namespaceId}.env`. It reads the app, and when the app declares one installation API-key connection it sets `<KEY>_API_KEY` on that connection. Saleslumen Emails is installed from `SALESLUMEN_EMAILS_MARKETPLACE_APP_ID` and declares no connection. The installer rewrites each bare installation key to `installations/{id}` and replaces the `AIRTABLE_BASE_ID` literal from `airtable/.env`. It then creates the workflow, creates an immutable revision, and deploys that revision. A rerun creates another revision and deploys it. A stored id from the previous workflows API is ignored. It creates the `TRIGGER_EVENT_THREAD_LABEL_ADDED` and `TRIGGER_EVENT_MESSAGE_REPLIED` triggers on Process campaign replies, deletes a listed trigger whose event type is not declared, and stores each trigger name by event type so a rerun does not create duplicates. Monitor warm up and Monitor sender health take no inputs. After install, create their schedules with `sl --json --namespace ID api workflows /v1/workflows/{workflow}/triggers -X POST --input FILE`, where `FILE` is `{ "kind": "KIND_SCHEDULE", "enabled": true, "cron": "...", "timeZone": "..." }`. A missing marketplace app id stops before any `sl` call. A missing API key stops after the app is read and before the installation is created. Confirm `sl auth status` shows `auth_mode: oauth`. Marketplace install and set-api-key require that user login. Start a run with `sl --json --namespace ID api workflows /v1/workflows/{workflow}/executions -X POST --input FILE`. The body is `{ "input": { ... } }` and the field names are the snake_case inputs in `manifest.json`.

`environment/org.env` and `environment/{namespaceId}.env` hold marketplace app ids and API keys. `airtable/.env` holds the Airtable token and base id used to create the base. The marketplace Airtable key is `AIRTABLE_API_KEY` in the namespace env. You do not open those files. `node scripts/render-workflows.mjs` writes a Playwright preview of each definition to `previews/`.

## Rules

1. Never read `environment/*.env`.
2. Pass `--namespace` for a namespace workflow. Omit it for an organization workflow. Sending a namespace header does not move an organization workflow into a namespace.
3. Pass the `requiredInputs` listed in `manifest.json` as the execution `input`. A workflow with none runs on a schedule and takes `{}`. The namespace is the workflow's namespace. Do not pass `namespace` or `recordId`.
4. Confirm before a purchase, a delete, or turning a campaign on. The agent creates the campaign, chooses accounts whose Email Accounts status is `sending`, and leaves the campaign as a draft. The operator turns it on.
5. To stop sending, pause the campaigns in Campaigns and stop warm up on those mailboxes in Truly Inbox. Do not rely on pausing a Saleslumen email account while Monitor warm up is deployed. That workflow resumes a paused account once Truly Inbox lists it as ready for outreach and its deliverability rate is 85 or above. Domains and mailboxes stay until someone removes them in Dynadot and Zapmail. This pack does not delete workflows.
