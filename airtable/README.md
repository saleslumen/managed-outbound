# Airtable

This directory owns the organization registry. Create the tables once per organization. Workflows upsert rows. They do not create tables.

`tables.json` names the tables and fields. Change a table by editing its `name`. The first field is the Airtable primary field and must be `singleLineText`. `schema.mjs` checks the file and plans the Airtable API calls. `node scripts/validate-manifest.mjs` fails when a definition writes a table or field that `tables.json` does not declare, or a literal `Status` outside its choices.

The pack uses four tables. A Saleslumen id is named with the product. A Zapmail id is named with Zapmail. A Truly Inbox id is named with Truly Inbox. Every row carries `Saleslumen Namespace ID`. Build one Airtable view per namespace by filtering on it.

Copy `airtable/.env.example` to `airtable/.env`, set `AIRTABLE_PAT` and `AIRTABLE_BASE_ID`, then run this from the skill root. `scripts/install.mjs` replaces that same `AIRTABLE_BASE_ID` literal in every definition.

```bash
node airtable/provision.mjs --dry-run
node airtable/provision.mjs
```

The token needs `data.records:read`, `data.records:write`, and `schema.bases:write`. The command creates any listed table that is missing and adds missing fields. It does not rename a table, change a field's type, or delete a field that already exists. Make those changes in Airtable. A new `name` creates a new table. It does not create a namespace row, print the token, or bind the Saleslumen Airtable installation. The provision workflows create that row from the execution namespace.

## Namespaces

One row per namespace, upserted on `Saleslumen Namespace ID` (`execution.namespace`). Fields are `Name`, `Saleslumen Namespace ID`, `Status` (`onboarding`, `active`), `Zapmail Workspace ID`, and `Truly Inbox Workspace ID`.

Provision Google infrastructure and Provision Microsoft infrastructure write `Name` from `namespace_name`, `Status` `onboarding`, and `Zapmail Workspace ID`. `Truly Inbox Workspace ID` stays with the operator. The run does not set it. Set `Status` to `active` when sending starts. Namespaces is the id-to-name directory.

## Domains

One row per hostname Dynadot owns for a namespace, upserted on `Domain`. The hostname is lowercase. `Saleslumen Namespace ID` says which namespace it was bought for.

Provision Google infrastructure and Provision Microsoft infrastructure write the row after `registerDomain` succeeds, before nameservers are set. A failed purchase writes nothing. Several Zapmail mailboxes can share one domain row. The row has no status and no DNS columns. The pack does not release the domain.

## Email Accounts

One row per sender email address, upserted on `Email`. Fields are `Domain` (the same lowercase hostname), `Zapmail Mailbox ID`, `Saleslumen Emails Account ID`, `Truly Inbox Account ID`, and `Status` (`provisioning`, `sending`, `degraded`). `Saleslumen Emails Account ID` is also the Saleslumen Campaigns sender id.

Assign writes `Status` `provisioning`. The Saleslumen connection writes `Saleslumen Emails Account ID` and does not write `Truly Inbox Account ID`. Monitor warm up writes `Truly Inbox Account ID` and `Status` `sending` when a ready account is recorded. Monitor sender health writes `Status` `degraded` when it pauses an account.

## Exceptions

The operator queue, upserted on `Key`. Fields are `Key`, `Saleslumen Namespace ID`, `Workflow`, `Kind` (`provisioning`, `sender`, `reply`), `Subject`, `Email`, `Domain`, `Detail`, and `Status` (`open`, `closed`). `Workflow` names the definition. Filter `Status` = `open` and group by `Kind` or `Workflow`.

A workflow that changes vendor state writes an open row when that call fails. `Detail` on that failure is `<operation>:<error reason>`. Keys are `{namespace}:provision:<step>:<domain or email>`, `{namespace}:sender:<emails account id>`, and `{namespace}:reply:<inbound message id or thread id>`.

Saleslumen Campaigns and Saleslumen Emails stay in Saleslumen. CRM automation is not configured. Airtable stores the namespace, the Dynadot domain, the Zapmail mailbox, and the operator queue. Workflow run history is the run record.
