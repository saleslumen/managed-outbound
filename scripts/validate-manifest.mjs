#!/usr/bin/env node
/**
 * Validate the managed-service manifest and workflow definitions.
 * Usage: node scripts/validate-manifest.mjs [--apps <marketplace-script checkout>]
 * With --apps, every call operation must be a function defined by that installation's app directory.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["call", "assign", "switch", "wait", "awaitSignal", "parallel", "for_each", "callWorkflow", "return", "fail", "end"];
const SCOPE_CATEGORY = { namespace: "client_product", organization: "control_plane" };
const APP_DIRS = { "saleslumen-emails": "saleslumen-emails" };
const MERGE_FIELDS = {
  Namespaces: ["Saleslumen Namespace ID"],
  Domains: ["Domain"],
  "Email Accounts": ["Email"],
  Exceptions: ["Key"],
};
const NAMESPACE_WORKFLOWS = [
  "provision-google-infrastructure",
  "provision-microsoft-infrastructure",
  "monitor-warm-up",
  "monitor-sender-health",
  "process-campaign-replies",
];
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const errors = [];
const loadJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
};
const appsRoot = argValue("--apps") ? resolve(argValue("--apps")) : "";
if (process.argv.includes("--apps") && !appsRoot) errors.push("--apps requires a path");
if (appsRoot && !existsSync(appsRoot)) errors.push(`--apps path does not exist: ${appsRoot}`);
const tables = loadJson(join(root, "airtable/tables.json")).tables;
const tableFields = new Map(tables.map((table) => [table.name, new Map(table.fields.map((field) => [field.name, field]))]));
const appDefines = (key, operation) => {
  const dir = join(appsRoot, APP_DIRS[key] || key);
  if (!existsSync(dir)) return false;
  const pattern = new RegExp(`^\\s*(async\\s+)?function\\s+${operation}\\s*\\(`, "m");
  return readdirSync(dir).filter((name) => name.endsWith(".js")).some((name) => pattern.test(readFileSync(join(dir, name), "utf8")));
};
const literalOf = (value) => (value && Object.hasOwn(value, "literal") ? value.literal : undefined);
const walkSteps = (steps, visit) => {
  (steps || []).forEach((step) => {
    visit(step);
    walkSteps(step.for_each?.steps, visit);
    (step.parallel?.branches || []).forEach((branch) => walkSteps(branch.steps, visit));
  });
};

const checkDefinition = (slug, document) => {
  const definition = document.definition;
  if (!definition || !Array.isArray(definition.steps)) {
    errors.push(`${slug}: file must be a display name and a definition`);
    return new Set();
  }
  const text = JSON.stringify(definition);
  if (/"nodes"|"connections"|"installationId"|\$vars|\{\{/.test(text)) errors.push(`${slug}: definition still uses a graph or a template`);
  const keys = new Set();
  const checkBlock = (steps, where) => {
    const seen = new Set();
    (steps || []).forEach((step) => {
      if (!IDENT.test(step.id || "")) errors.push(`${slug}: step id ${step.id} in ${where} must match ^[a-z][a-z0-9_]{0,62}$`);
      if (seen.has(step.id)) errors.push(`${slug}: duplicate step id ${step.id} in ${where}`);
      seen.add(step.id);
      const present = KINDS.filter((kind) => step[kind] !== undefined);
      if (present.length !== 1) errors.push(`${slug}: step ${step.id} must have one kind`);
      if (step.call) {
        const app = step.call.installedApp;
        const key = app?.installation || "";
        if (!/^[a-z0-9-]+$/.test(key) || !app.operation) errors.push(`${slug}: call ${step.id} must name a bare installation key and an operation`);
        else {
          keys.add(key);
          if (appsRoot && !appDefines(key, app.operation)) errors.push(`${slug}: call ${step.id} calls ${key}.${app.operation}, which the app does not define`);
          if (key === "airtable") checkAirtable(slug, step);
        }
        if (app?.operation === "registerDomain" && step.call.onError) errors.push(`${slug}: registerDomain has no failure catch`);
        if (["startWarmup", "listAccounts"].includes(app?.operation) && slug.startsWith("provision-")) errors.push(`${slug}: provisioning does not call ${app.operation}`);
      }
      if (step.wait && !/^\d+s$/.test(step.wait.duration || "")) errors.push(`${slug}: wait ${step.id} duration must be seconds`);
      if (step.for_each) checkBlock(step.for_each.steps, step.id);
      (step.parallel?.branches || []).forEach((branch) => {
        if (!IDENT.test(branch.id || "")) errors.push(`${slug}: branch ${branch.id} must be a step id`);
        checkBlock(branch.steps, `${step.id}.${branch.id}`);
      });
      if (step.parallel && !step.parallel.all) errors.push(`${slug}: parallel ${step.id} waits for every branch`);
    });
  };
  checkBlock(definition.steps, "root");
  if (slug.startsWith("provision-")) {
    const waits = [];
    walkSteps(definition.steps, (step) => {
      if (step.wait) waits.push(step.wait.duration);
    });
    if (waits.filter((duration) => duration === "43200s").length !== 2) errors.push(`${slug}: provisioning waits 12 hours twice`);
    const split = definition.steps.find((step) => step.parallel);
    if (!split?.parallel?.branches?.some((branch) => JSON.stringify(branch).includes("exportMailboxes"))) errors.push(`${slug}: export runs in a parallel branch`);
  }
  return keys;
};

const checkAirtable = (slug, step) => {
  const args = step.call.args || {};
  if (literalOf(args.baseId) !== "AIRTABLE_BASE_ID") errors.push(`${slug}: call ${step.id} base id must be the AIRTABLE_BASE_ID literal`);
  const table = literalOf(args.tableIdOrName);
  const fields = tableFields.get(table);
  if (!fields) {
    errors.push(`${slug}: call ${step.id} uses unknown table ${table}`);
    return;
  }
  if (step.call.installedApp.operation === "listRecords") {
    const formula = args.filterByFormula?.expr || "";
    const merge = MERGE_FIELDS[table][0];
    if (!formula.includes(`{${merge}}`) || !formula.includes("execution.namespace") || literalOf(args.maxRecords) !== 1) errors.push(`${slug}: call ${step.id} must read one ${table} row for this namespace`);
    return;
  }
  if (step.call.installedApp.operation !== "updateRecords") {
    errors.push(`${slug}: call ${step.id} uses unsupported Airtable operation ${step.call.installedApp.operation}`);
    return;
  }
  if (JSON.stringify(literalOf(args.performUpsert)?.fieldsToMergeOn) !== JSON.stringify(MERGE_FIELDS[table])) errors.push(`${slug}: call ${step.id} must upsert ${table} on ${MERGE_FIELDS[table].join(", ")}`);
  if ("typecast" in args) errors.push(`${slug}: call ${step.id} must not set typecast`);
  const records = JSON.stringify(args.records || {});
  if (records.includes("auth_url") || records.includes("oauthLink")) errors.push(`${slug}: call ${step.id} writes an OAuth link to Airtable`);
  if (!records.includes("execution.namespace")) errors.push(`${slug}: call ${step.id} must write the namespace from execution.namespace`);
  const encoded = records;
  fields.forEach((field, name) => {
    if (field.type !== "singleSelect") return;
    const choices = field.options.choices.map((choice) => choice.name);
    const found = [...encoded.matchAll(new RegExp(`"${name}": "([^"]+)"`, "g"))].map((match) => match[1]);
    found.filter((value) => !choices.includes(value)).forEach((value) => errors.push(`${slug}: call ${step.id} writes ${name} "${value}" outside its choices`));
  });
};

const manifest = loadJson(join(root, "manifest.json"));
const workflows = Array.isArray(manifest.workflows) ? manifest.workflows : [];
const slugs = new Set();
workflows.forEach((entry) => {
  const slug = entry.slug;
  if (!slug || slugs.has(slug)) errors.push(`workflow slug missing or duplicated: ${slug}`);
  slugs.add(slug);
  if (SCOPE_CATEGORY[entry.scope] !== entry.category) errors.push(`${slug}: scope ${entry.scope} requires category ${SCOPE_CATEGORY[entry.scope]}`);
  const file = join(root, entry.file || "");
  if (!entry.file || !existsSync(file)) {
    errors.push(`${slug}: missing file ${entry.file}`);
    return;
  }
  const document = loadJson(file);
  if (document.displayName !== entry.name) errors.push(`${slug}: display name "${document.displayName}" != manifest name "${entry.name}"`);
  const text = readFileSync(file, "utf8");
  if (/publish|activate|\{\{installations|\{\{settings/.test(text)) errors.push(`${slug}: file still names publish, activate, or a template binding`);
  const used = checkDefinition(slug, document);
  const listed = new Set(entry.installations || []);
  [...used].filter((key) => !listed.has(key)).forEach((key) => errors.push(`${slug}: definition uses installation ${key} not listed in the manifest`));
  [...listed].filter((key) => !used.has(key)).forEach((key) => errors.push(`${slug}: manifest lists installation ${key} the definition never calls`));
  const input = document.definition?.input || "";
  (entry.requiredInputs || []).forEach((name) => {
    if (!IDENT.test(name)) errors.push(`${slug}: required input ${name} must be snake_case`);
    if (!input.includes(`${name}:`)) errors.push(`${slug}: required input ${name} is not an input field`);
  });
  const eventDriven = (manifest.triggers || []).some((trigger) => trigger.workflow === slug);
  if ((entry.requiredInputs || []).length === 0 && !eventDriven && input !== "object{}") errors.push(`${slug}: a schedule workflow takes an empty object`);
  if (eventDriven && input !== "any") errors.push(`${slug}: an event workflow takes the event payload`);
});
const PACK_EVENT_TYPES = new Set(["TRIGGER_EVENT_THREAD_LABEL_ADDED", "TRIGGER_EVENT_MESSAGE_REPLIED"]);
const triggerPairs = new Set();
const triggersByWorkflow = new Map();
(manifest.triggers || []).forEach((trigger) => {
  if (!trigger || !PACK_EVENT_TYPES.has(trigger.eventType) || !workflows.some((entry) => entry.slug === trigger.workflow)) {
    errors.push("manifest triggers must be TRIGGER_EVENT_THREAD_LABEL_ADDED or TRIGGER_EVENT_MESSAGE_REPLIED on a workflow in this pack");
    return;
  }
  const pair = `${trigger.workflow}::${trigger.eventType}`;
  if (triggerPairs.has(pair)) errors.push(`duplicate trigger ${trigger.eventType} for ${trigger.workflow}`);
  triggerPairs.add(pair);
  if (!triggersByWorkflow.has(trigger.workflow)) triggersByWorkflow.set(trigger.workflow, new Set());
  triggersByWorkflow.get(trigger.workflow).add(trigger.eventType);
  const entry = workflows.find((row) => row.slug === trigger.workflow);
  if ((entry.requiredInputs || []).length) errors.push(`${trigger.workflow}: an event trigger supplies the payload, not requiredInputs`);
});
const replyEvents = triggersByWorkflow.get("process-campaign-replies") || new Set();
if (!replyEvents.has("TRIGGER_EVENT_THREAD_LABEL_ADDED") || !replyEvents.has("TRIGGER_EVENT_MESSAGE_REPLIED")) {
  errors.push("process-campaign-replies must declare TRIGGER_EVENT_THREAD_LABEL_ADDED and TRIGGER_EVENT_MESSAGE_REPLIED");
}
NAMESPACE_WORKFLOWS.forEach((slug) => {
  if (!workflows.some((entry) => entry.slug === slug && entry.scope === "namespace")) errors.push(`missing namespace workflow ${slug}`);
});
workflows.filter((entry) => !NAMESPACE_WORKFLOWS.includes(entry.slug)).forEach((entry) => errors.push(`unexpected workflow ${entry.slug}`));
if (!Array.isArray(manifest.triggers)) errors.push("manifest triggers must be an array");
if (manifest.platformBoundary?.orgTemplatePlusNamespaceHeader !== false) errors.push("platformBoundary.orgTemplatePlusNamespaceHeader must be false");
["environment/org.env.example", "environment/namespace.env.example", "airtable/.env.example", "scripts/install.mjs", "airtable/schema.mjs", "airtable/provision.mjs"].forEach((rel) => {
  if (!existsSync(join(root, rel))) errors.push(`missing ${rel}`);
});

if (errors.length) {
  console.error("validate-manifest FAILED");
  errors.forEach((line) => console.error(`  ERROR: ${line}`));
  process.exit(1);
}
console.log(`validate-manifest OK (${workflows.length} workflows${appsRoot ? ", operations checked" : ""})`);
