# Workflows

One file per workflow. Write `warm up` in prose. The file is `monitor-warm-up.json`.

| Workflow | File |
|----------|------|
| Provision Google infrastructure | `provision-google-infrastructure.json` |
| Provision Microsoft infrastructure | `provision-microsoft-infrastructure.json` |
| Monitor warm up | `monitor-warm-up.json` |
| Monitor sender health | `monitor-sender-health.json` |
| Process campaign replies | `process-campaign-replies.json` |

## Definitions

Each file is an input schema, variables, and ordered steps. A call names an installed app with a bare key such as `airtable` and one of that app's operations. `scripts/install.mjs` rewrites that key to `installations/{id}` and replaces the `AIRTABLE_BASE_ID` literal from `airtable/.env`. Call arguments follow the vendor's API contract. A call result is written to that step's result path.

A root `return` carries the completion reason. A loop iteration or a parallel branch writes `local.outcome` and finishes with `end`, so the other iterations and the other branch continue. Airtable writes are `updateRecords` upserts. The namespace is `execution.namespace`.

A schedule workflow takes `object{}`. Process campaign replies takes the event payload as `input`. A call that changes vendor state catches the failure and opens an Exceptions row. `registerDomain` has no catch. A wait of 12 hours is `43200s`.

The Saleslumen connection and the Truly Inbox export are the two branches of one `parallel` step with `all`. Both branches finish before the run ends, and a caught error in one does not cancel the other. The run ends with an empty execution result. `node scripts/validate-manifest.mjs` checks these rules.

## Provision Google infrastructure and Provision Microsoft infrastructure

One run provisions one domain and one mailbox. The first required input is `namespace_name`. Another inbox is another run.

Invalid input records one Airtable Exceptions row and ends before any infrastructure-provider call. A later valid run closes that row before `registerDomain`. The key is `{namespaceId}:provision:google:input` or `{namespaceId}:provision:microsoft:input`.

`registerDomain` buys the domain for one year with privacy `full` on every run and has no catch. A failed purchase writes nothing to Airtable. Success closes the Dynadot Exceptions row, records the lowercase hostname on Domains, writes the Namespaces row with `Status` `onboarding` and the Zapmail workspace id, and sets nameservers to `pns61.cloudns.net`, `pns62.cloudns.com`, `pns63.cloudns.net`, and `pns64.cloudns.uk`. Truly Inbox Workspace ID stays with the operator. The run does not set it.

A failed `setNameservers` opens an Exceptions row with Detail `setNameservers:` plus the error reason. `connectDomains` then adds the domain. The run waits 12 hours and reads the domain with `listDomains`. A missing domain opens the Zapmail exception with Detail `domainMissing` and ends. Status `ACTIVE` calls `addDomainForwarding` to `example.com`, closes the Zapmail exception, and assigns the mailbox. `PENDING`, `IN_PROGRESS`, and any other status open that exception with Detail `domainStatus:` plus the status and end.

The Zapmail exception key is `{namespaceId}:provision:zapmail:{lowercase domain}`. It also opens when `connectDomains`, `listDomains`, or `addDomainForwarding` fails.

Assign writes the Email Accounts row as `provisioning`. The run waits 12 hours and reads the mailboxes with `listMailboxes`. A listed mailbox records `Zapmail Mailbox ID` and closes the mailbox exception. A mailbox that is not listed opens that row with Detail `mailboxMissing` and ends. The mailbox exception key is `{namespaceId}:provision:mailbox:{email}`. It also opens when assign or the mailbox read fails. Other provision keys follow `{namespaceId}:provision:<step>:<domain or email>`.

The connection and the export then run together. Google calls `addGoogleClientId` first. Both definitions then run `createOauthConnection`, `createCustomOAuth`, and `getOauthConnection`, and upsert `Saleslumen Emails Account ID`. That upsert does not write Email Accounts `Status` or `Truly Inbox Account ID`. The export branch calls `exportMailboxes` and does not list Truly Inbox. Provisioning does not set warm up.

After the purchase, a vendor call that changes state catches the failure into an open Exceptions upsert. Detail is `<operation>:<error reason>`. Google `addGoogleClientId` has no documented read, so a later run that reaches it calls it again.

## Monitor warm up

Monitor warm up takes no inputs. It reads the Namespaces row for this namespace and uses `Truly Inbox Workspace ID`. It lists Truly Inbox accounts with `outreachReadiness` `ready` and `deliverabilityMin` 85, one page of 100. A longer page ends `trulyinbox_list_truncated`. It keeps accounts whose `emailAddress` is set and whose `deliverabilityRate` is 85 or above, and matches them to Saleslumen email accounts in `ACTIVE` or `PAUSED`.

Each match calls `updateWarmupSettings` with that workspace id, the account id, `warmupMaxLimit` 10, `timezone` `UTC`, and a schedule that enables every day from 00:00 to 23:59. A paused account is resumed after that write, marked `sending` with `Truly Inbox Account ID`, and its Exceptions row `{namespace}:sender:{account id}` is closed. An account that is already active is marked `sending` and is not resumed.

A failed warm-up write or resume opens that sender exception and completes that account. The other accounts continue. The result is `accounts_checked`, or `no_ready_accounts` when none match.

## Monitor sender health

Monitor sender health takes no inputs. It reads the same workspace id, then paginates every Truly Inbox account, the ready accounts (`outreachReadiness` `ready`, `deliverabilityMin` 85), and the warming accounts (`outreachReadiness` `warming`) in pages of 100, up to 10 pages (1,000 records) per inventory. Each inventory reads page 1, validates `pagination.total_pages`, then uses the engine's sequential `for_each` to read only the remaining pages and carry their projected account data forward. An inventory with more than 10 pages ends `trulyinbox_list_limit_exceeded`; a missing or inconsistent page response ends `trulyinbox_pagination_invalid`. It completes all three inventories before matching them to every Saleslumen email account or making sender changes. An account with no Truly Inbox mailbox, or a mailbox on the warming page whose status is not `DISCONNECTED`, ends `account_left`.

Any other account is healthy when it is on the ready page, its `deliverabilityRate` is 85 or above, its status is not `DISCONNECTED`, and the Emails state is `ACTIVE` or `PAUSED`. A healthy paused account is left paused. A healthy active account closes `{namespace}:sender:{account id}`.

A failing active account is set to `warmupMaxLimit` 20, `timezone` `UTC`, and that same every-day schedule, then paused, marked `degraded`, and that exception is opened. A failing account that is already paused is set the same way and left paused. Monitor warm up resumes it once it is on the ready page and the deliverability rate is 85 or above.

## Process campaign replies

Process campaign replies runs on `TRIGGER_EVENT_THREAD_LABEL_ADDED` and `TRIGGER_EVENT_MESSAGE_REPLIED`. The payload is `input`. A payload that is neither a label-added shape (`thread_id` + `label_id`) nor a replied shape (`thread_id` + `reply_message_id`) ends `event_missing` with no external work.

On label-added, any label name other than `Interested` ends `interested_ignored`. On message-replied, the workflow lists labels and continues only when an `Interested` label id is already in `user_label_ids`; otherwise it ends `interested_ignored`. Both interested paths reach the shared `reply already sent?` switch. A true `reply_sent_after_latest_inbound` ends `reply_already_sent`; when the field is absent, as on `MESSAGE_REPLIED`, it is treated as false.

The shared switch's default reads the thread. The latest inbound message is the last live message whose `sendSource` is absent, zero, or `MESSAGE_SEND_SOURCE_UNSPECIFIED`, and whose labels do not include `DRAFTS`. A later `MESSAGE_SEND_SOURCE_DIRECT` message ends `reply_already_sent`. No inbound message upserts an open Exceptions row keyed `{namespace}:reply:{threadId}` with Detail `reply_context_invalid:` plus the thread id and ends `reply_context_invalid`.

A found inbound message is read in full. The reply text is the decoded `text/plain` body, otherwise the decoded `text/html` body, otherwise the snippet. The contact address is the From header. The subject is the Subject header, prefixed with `Re: ` when it does not already begin that way, or `Re:` when the header is absent. `In-Reply-To` is the inbound `Message-ID`. `References` is the inbound References header with that `Message-ID` appended when it is not already present. The send `requestId` is the inbound message id. The outbound message id is that same UUID with its version nibble moved between `4` and `5`, so a retry addresses the same direct send.

Blank thread, account, trimmed sender address, contact email, `Message-ID`, or References, or an id that is not a UUID, upserts `{namespace}:reply:{inboundMessageId}` with Detail `reply_context_invalid:` plus the inbound message id and ends `reply_context_invalid`. That path does not call OpenRouter or send.

A complete context asks OpenRouter for the reply. The reply is the completion content as plain text. Empty reply text upserts that key with Detail `reply_text_missing:` plus the inbound message id and ends `reply_text_missing`. `sendMessage` sends as the inbound message's `accountId`, From the account `email_address`, on that `threadId`. A caught send failure upserts the same key with Detail `sendMessage:` plus the error reason and ends `send_reply_failed`. Success ends `reply_sent`. The reply body is not stored. CRM automation is not configured.
