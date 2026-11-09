#!/usr/bin/env node
/**
 * Install workflow definitions for this skill via sl api workflows.
 * Installs each marketplace app from <KEY>_MARKETPLACE_APP_ID in environment/{namespaceId}.env (org.env for --org).
 * Reads permissionDigest and the API-key connection with sl marketplace apps get, creates the installation, and reads installationId from that response.
 * When the app declares one installation API-key connection, <KEY>_API_KEY is set with sl marketplace connections set-api-key. The API key is never printed.
 * Saleslumen Emails declares no connection, so that installation is created and set-api-key is not called.
 * Rewrites each bare installation key to installations/{id} and the AIRTABLE_BASE_ID literal from airtable/.env.
 * A missing marketplace app id fails before any sl call. A missing API key fails after the app is read and before the installation is created. Never prints env values.
 * Does not create Apps Script projects, vault secrets, or start executions.
 * Creates a workflow, an immutable revision, and deploys that revision. A rerun adds another revision and deploys it.
 * Creates every event trigger declared in manifest.json for a workflow. A listed trigger whose event type is not declared is deleted. A rerun keeps each matching declared event type.
 * Schedule triggers stay with the operator.
 * Usage:
 *   node scripts/install.mjs --org [--dry-run]
 *   node scripts/install.mjs --namespace {id} [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../airtable/provision.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPES = new Set(["org", "namespace"]);
const asString = (value) => (value === undefined || value === null ? "" : String(value).trim());
const loadJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const installPaths = (root, { scope, namespaceId }) => {
  const base = join(root, "environment");
  const airtableEnv = join(root, "airtable", ".env");
  if (asString(scope) === "org") return { install: join(base, "org.install.json"), env: join(base, "org.env"), airtableEnv };
  const id = asString(namespaceId);
  if (!id) throw new Error("INSTALL_SCOPE_INVALID: --namespace requires a namespace id");
  if (id === "org") throw new Error("INSTALL_SCOPE_INVALID: namespace id cannot be org");
  return { install: join(base, `${id}.install.json`), env: join(base, `${id}.env`), airtableEnv };
};

const envToken = (key) => key.toUpperCase().replace(/-/g, "_");
export const marketplaceAppEnvKey = (key) => `${envToken(key)}_MARKETPLACE_APP_ID`;
export const apiKeyEnvKey = (key) => `${envToken(key)}_API_KEY`;
export const BASE_LITERAL = "AIRTABLE_BASE_ID";
const WORKFLOW_NAME = /^workflows\/[A-Za-z0-9_-]+$/;
const RESOURCE_NAME = /^workflows\/[A-Za-z0-9_-]+(?:\/(?:revisions|triggers)\/[A-Za-z0-9_-]+)?$/;
export const PACK_EVENT_TYPES = new Set(["TRIGGER_EVENT_THREAD_LABEL_ADDED", "TRIGGER_EVENT_MESSAGE_REPLIED"]);
export const triggerKey = (workflow, eventType) => `${asString(workflow)}::${asString(eventType)}`;
export const readTriggerState = (existingTriggers, manifestTriggers) => {
  const stored = existingTriggers && typeof existingTriggers === "object" ? existingTriggers : {};
  const out = {};
  (manifestTriggers || []).forEach((trigger) => {
    const workflow = asString(trigger.workflow);
    const eventType = asString(trigger.eventType);
    const nested = stored[workflow] && typeof stored[workflow] === "object" ? stored[workflow] : null;
    const id = nested ? asString(nested[eventType]) : "";
    out[triggerKey(workflow, eventType)] = RESOURCE_NAME.test(id) ? id : "";
  });
  return out;
};
export const writeTriggerState = (triggerIds) => {
  const byWorkflow = {};
  Object.entries(triggerIds).forEach(([key, id]) => {
    if (!id) return;
    const sep = key.indexOf("::");
    if (sep < 0) return;
    const workflow = key.slice(0, sep);
    const eventType = key.slice(sep + 2);
    if (!byWorkflow[workflow]) byWorkflow[workflow] = {};
    byWorkflow[workflow][eventType] = id;
  });
  return byWorkflow;
};

const walkSteps = (steps, visit) => {
  (steps || []).forEach((step) => {
    visit(step);
    walkSteps(step.for_each?.steps, visit);
    (step.parallel?.branches || []).forEach((branch) => walkSteps(branch.steps, visit));
  });
};

const bindLiteral = (value, env) => {
  if (value === BASE_LITERAL) {
    const bound = asString(env[BASE_LITERAL]);
    if (!bound) throw new Error(`INSTALL_BINDING_MISSING: ${BASE_LITERAL}`);
    return bound;
  }
  if (Array.isArray(value)) return value.map((item) => bindLiteral(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, bindLiteral(item, env)]));
  return value;
};

export const installationKeys = (entries, documents) => {
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  entries.forEach((entry) => (entry.installations || []).forEach(add));
  documents.forEach((document) => walkSteps(document.definition?.steps, (step) => {
    const key = asString(step.call?.installedApp?.installation);
    if (!key) return;
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`INSTALL_BINDING_INVALID: call ${step.id} installation must be a bare key`);
    add(key);
  }));
  return keys;
};

export const bindDefinition = (definition, env, installationIds) => {
  const copy = structuredClone(definition);
  walkSteps(copy.steps, (step) => {
    const app = step.call?.installedApp;
    if (!app) return;
    const key = asString(app.installation);
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`INSTALL_BINDING_INVALID: call ${step.id} installation must be a bare key`);
    const installationId = asString(installationIds[key]);
    if (!installationId) throw new Error(`INSTALL_BINDING_MISSING: ${marketplaceAppEnvKey(key)}`);
    app.installation = `installations/${installationId}`;
    if (step.call.args) step.call.args = bindLiteral(step.call.args, env);
  });
  return copy;
};

export const requireAppCredentials = (keys, env) => {
  keys.forEach((key) => {
    if (!asString(env[marketplaceAppEnvKey(key)])) throw new Error(`INSTALL_BINDING_MISSING: ${marketplaceAppEnvKey(key)}`);
  });
};

export const apiKeyConnectionKey = (app, key) => {
  const requirements = app && app.connectionRequirements;
  const connections = requirements && Array.isArray(requirements.connections) ? requirements.connections : null;
  if (!connections) throw new Error("INSTALL_SL_OUTPUT: missing connectionRequirements");
  const apiKeys = connections.filter((row) => row && row.kind === "API_KEY");
  if (!apiKeys.length) return "";
  const connectionKey = asString(apiKeys[0] && apiKeys[0].key);
  if (apiKeys.length !== 1 || apiKeys[0].authorizationMode !== "INSTALLATION" || !connectionKey) throw new Error(`INSTALL_BINDING_INVALID: ${key} API key connection`);
  return connectionKey;
};

export const readInstallEnv = (path) => {
  if (!existsSync(path)) throw new Error(`INSTALL_ENV_MISSING: copy the matching environment/*.env.example to ${path}`);
  return parseEnv(readFileSync(path, "utf8"));
};

/** Marketplace app ids and API keys come from the scope's env file. The Airtable base id comes from airtable/.env. */
export const readBindingEnv = (paths) => {
  const env = readInstallEnv(paths.env);
  if (!existsSync(paths.airtableEnv)) throw new Error("INSTALL_ENV_MISSING: copy airtable/.env.example to airtable/.env");
  const airtable = parseEnv(readFileSync(paths.airtableEnv, "utf8"));
  return { ...env, [BASE_LITERAL]: airtable[BASE_LITERAL] };
};

export const matchesInstall = (entry, choices) => {
  if (asString(entry.provision) === "false" || entry.provision === false) return false;
  const scope = asString(entry.scope) === "organization" ? "org" : asString(entry.scope);
  return scope === choices.scope;
};

export const selectWorkflows = (manifest, choices) => {
  const workflows = Array.isArray(manifest.workflows) ? manifest.workflows : [];
  return workflows.filter((entry) => matchesInstall(entry, choices));
};

const parseJsonObject = (text) => {
  const raw = asString(text);
  if (!raw) throw new Error("INSTALL_SL_OUTPUT: empty sl --json output");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("INSTALL_SL_OUTPUT: sl --json output is not JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }
};

export const readName = (payload) => {
  const obj = payload && typeof payload === "object" ? payload : {};
  const nested = obj.workflow && typeof obj.workflow === "object" ? obj.workflow : obj;
  const name = asString(nested.name || obj.name);
  if (!RESOURCE_NAME.test(name)) throw new Error("INSTALL_SL_OUTPUT: missing name");
  return name;
};

export const parseArgs = (argv) => {
  const args = { scope: "", namespaceId: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--dry-run") args.dryRun = true;
    else if (part === "--org") args.scope = "org";
    else if (part === "--namespace") {
      args.scope = "namespace";
      args.namespaceId = asString(argv[i + 1]);
      i += 1;
    } else if (part.startsWith("--namespace=")) {
      args.scope = "namespace";
      args.namespaceId = asString(part.slice("--namespace=".length));
    } else throw new Error(`INSTALL_ARGS_INVALID: unknown argument ${part}`);
  }
  return args;
};

export const validateChoices = (args) => {
  if (!SCOPES.has(args.scope)) throw new Error("INSTALL_SCOPE_INVALID: use --org or --namespace {id}");
  if (args.scope === "org") return { ...args, namespaceId: "" };
  if (!asString(args.namespaceId)) throw new Error("INSTALL_SCOPE_INVALID: --namespace requires a namespace id");
  return args;
};

const loadExisting = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  return loadJson(path);
};

export const planInstall = ({ manifest, choices, install }) => {
  const selected = selectWorkflows(manifest, choices);
  if (!selected.length) throw new Error("INSTALL_PLAN_EMPTY: no workflows match these choices");
  const existingWorkflows = install && install.workflows && typeof install.workflows === "object" ? install.workflows : {};
  return {
    scope: choices.scope,
    namespaceId: asString(choices.namespaceId),
    workflows: selected.map((entry) => asString(entry.slug)),
    existingWorkflowIds: Object.fromEntries(selected.map((entry) => {
      const stored = asString(existingWorkflows[asString(entry.slug)]);
      return [asString(entry.slug), WORKFLOW_NAME.test(stored) ? stored : ""];
    })),
  };
};

export const formatPlan = (plan) => {
  const who = plan.scope === "org" ? "org" : plan.namespaceId;
  const lines = [`install plan scope=${plan.scope} id=${who} workflows=${plan.workflows.length}`];
  plan.workflows.forEach((slug) => {
    lines.push(`  workflow ${slug} ${plan.existingWorkflowIds[slug] ? "update" : "create"}`);
  });
  return lines.join("\n");
};

const defaultRunSl = (args) => {
  const result = spawnSync("sl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sl exited ${result.status}: ${asString(result.stderr || result.stdout).slice(0, 200)}`);
  }
  return parseJsonObject(result.stdout);
};

const withInputFile = (body, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "managed-service-install-"));
  const inputPath = join(dir, "input.json");
  writeFileSync(inputPath, JSON.stringify(body));
  try {
    return fn(inputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const withSecretFile = (secret, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "managed-service-key-"));
  const keyPath = join(dir, "api-key");
  writeFileSync(keyPath, secret, { mode: 0o600 });
  try {
    return fn(keyPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const resolveInstallations = ({ keys, env, choices, runSl, slArgs }) => {
  const ids = {};
  keys.forEach((key) => {
    const appId = asString(env[marketplaceAppEnvKey(key)]);
    const app = runSl(slArgs(["marketplace", "apps", "get", appId]));
    const permissionDigest = asString(app.permissionDigest);
    if (!permissionDigest) throw new Error("INSTALL_SL_OUTPUT: missing permissionDigest");
    const connectionKey = apiKeyConnectionKey(app, key);
    const apiKey = asString(env[apiKeyEnvKey(key)]);
    if (connectionKey && !apiKey) throw new Error(`INSTALL_BINDING_MISSING: ${apiKeyEnvKey(key)}`);
    if (!connectionKey && apiKey) throw new Error(`INSTALL_BINDING_INVALID: ${apiKeyEnvKey(key)}`);
    const installation = { appId, scopeType: choices.scope === "org" ? "ORGANIZATION" : "NAMESPACE" };
    if (choices.scope === "namespace") installation.namespaceId = choices.namespaceId;
    const created = withInputFile({ installation, permissionDigest }, (inputPath) => runSl(slArgs(["marketplace", "installations", "create", "--input", inputPath])));
    const installationId = asString(created.installationId || (created.installation && created.installation.installationId));
    if (!installationId) throw new Error("INSTALL_SL_OUTPUT: missing installationId");
    ids[key] = installationId;
    if (connectionKey) withSecretFile(apiKey, (file) => runSl(slArgs(["marketplace", "connections", "set-api-key", connectionKey, "--installation", installationId, "--api-key-file", file])));
  });
  return ids;
};

export const runInstall = ({ root, manifest, choices, env, runSl = defaultRunSl }) => {
  const paths = installPaths(root, choices);
  const existingInstall = loadExisting(paths.install, {});
  const plan = planInstall({ manifest, choices, install: existingInstall });
  const entries = selectWorkflows(manifest, choices);
  const documents = entries.map((entry) => loadJson(join(root, asString(entry.file))));
  const keys = installationKeys(entries, documents);
  requireAppCredentials(keys, env);
  const slArgs = (parts) => {
    const args = ["--json"];
    if (choices.scope === "namespace") args.push("--namespace", choices.namespaceId);
    return args.concat(parts);
  };
  const installationIds = resolveInstallations({ keys, env, choices, runSl, slArgs });
  const bound = entries.map((entry, index) => ({
    slug: asString(entry.slug),
    displayName: asString(documents[index].displayName || entry.name),
    definition: bindDefinition(documents[index].definition, env, installationIds),
  }));
  const workflowIds = { ...plan.existingWorkflowIds };
  const existingTriggers = existingInstall.triggers && typeof existingInstall.triggers === "object" ? existingInstall.triggers : {};
  const triggerIds = readTriggerState(existingTriggers, manifest.triggers || []);
  const api = (method, path, body) => withInputFile(body, (inputPath) => runSl(slArgs(["api", "workflows", path, "-X", method, "--input", inputPath])));
  const writeState = () => {
    const install = {
      scope: choices.scope,
      workflows: Object.fromEntries(plan.workflows.filter((slug) => workflowIds[slug]).map((slug) => [slug, workflowIds[slug]])),
    };
    const triggers = writeTriggerState(triggerIds);
    if (Object.keys(triggers).length) install.triggers = triggers;
    if (choices.scope === "namespace") install.namespaceId = choices.namespaceId;
    writeJson(paths.install, install);
  };
  bound.forEach(({ slug, displayName, definition }) => {
    if (!workflowIds[slug]) {
      const created = api("POST", "/v1/workflows", { displayName });
      workflowIds[slug] = readName(created);
      writeState();
    }
    const revision = api("POST", `/v1/${workflowIds[slug]}/revisions`, { definition, changelog: "managed service install" });
    const revisionName = readName(revision);
    api("POST", `/v1/${workflowIds[slug]}:deploy`, { revision: revisionName });
    const declared = (manifest.triggers || []).filter((trigger) => asString(trigger.workflow) === slug);
    if (!declared.length) return;
    const listed = runSl(slArgs(["api", "workflows", `/v1/${workflowIds[slug]}/triggers`]));
    const rows = ((listed && listed.triggers) || []).filter((row) => row && RESOURCE_NAME.test(asString(row.name)));
    const wanted = new Set(declared.map((trigger) => asString(trigger.eventType)));
    rows.filter((row) => !wanted.has(asString(row.eventType))).forEach((row) => {
      runSl(slArgs(["api", "workflows", `/v1/${asString(row.name)}`, "-X", "DELETE"]));
    });
    const remaining = rows.filter((row) => wanted.has(asString(row.eventType)));
    declared.forEach((trigger) => {
      const eventType = asString(trigger.eventType);
      if (!PACK_EVENT_TYPES.has(eventType)) throw new Error(`INSTALL_TRIGGER_INVALID: ${slug} event type ${eventType} is not in this pack`);
      const key = triggerKey(slug, eventType);
      const matching = remaining.find((row) => asString(row.eventType) === eventType);
      const stored = asString(triggerIds[key]);
      const storedRow = remaining.find((row) => asString(row.name) === stored);
      if (stored && (!matching || asString(matching.name) !== stored) && storedRow) {
        runSl(slArgs(["api", "workflows", `/v1/${stored}`, "-X", "DELETE"]));
      }
      if (matching) triggerIds[key] = asString(matching.name);
      else triggerIds[key] = readName(api("POST", `/v1/${workflowIds[slug]}/triggers`, { kind: "KIND_EVENT", enabled: true, eventType }));
    });
    writeState();
  });
  writeState();
  return { paths, plan, workflowIds };
};

const main = () => {
  let args;
  try {
    args = validateChoices(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    console.error("Usage: node scripts/install.mjs --org [--dry-run]");
    console.error("       node scripts/install.mjs --namespace {id} [--dry-run]");
    process.exit(2);
  }
  const manifest = loadJson(join(skillRoot, "manifest.json"));
  const paths = installPaths(skillRoot, args);
  let plan;
  let env;
  try {
    plan = planInstall({
      manifest,
      choices: args,
      install: loadExisting(paths.install, {}),
    });
    env = readBindingEnv(paths);
    const entries = selectWorkflows(manifest, args);
    const documents = entries.map((entry) => loadJson(join(skillRoot, asString(entry.file))));
    requireAppCredentials(installationKeys(entries, documents), env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(formatPlan(plan));
  if (args.dryRun) return;
  try {
    const result = runInstall({ root: skillRoot, manifest, choices: args, env });
    console.log(`ok workflows=${result.plan.workflows.length}`);
    console.log("Start a run with sl api workflows POST /v1/workflows/{workflow}/executions. The Interested label-added and message-replied triggers are created here. Create a schedule trigger with kind KIND_SCHEDULE, a cron, and a timeZone.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
