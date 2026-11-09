import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseEnv } from "../airtable/provision.mjs";
import { bindDefinition, formatPlan, installPaths, marketplaceAppEnvKey, matchesInstall, parseArgs, planInstall, readBindingEnv, readName, runInstall, selectWorkflows, validateChoices } from "./install.mjs";

const skillRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = {
  workflows: [
    { slug: "agency-report", scope: "organization" },
    { slug: "agency-audit", scope: "organization" },
    { slug: "monitor-warm-up", scope: "namespace" },
    { slug: "manual-webhook", scope: "namespace", provision: false },
  ],
};

test("org install selects every organization workflow", () => {
  const slugs = selectWorkflows(fixture, { scope: "org" }).map((row) => row.slug);
  assert.deepEqual(slugs, ["agency-report", "agency-audit"]);
});

test("namespace install skips provision:false", () => {
  const slugs = selectWorkflows(fixture, { scope: "namespace" }).map((row) => row.slug);
  assert.deepEqual(slugs, ["monitor-warm-up"]);
  assert.equal(slugs.includes("manual-webhook"), false);
});

test("parseArgs and validateChoices accept a namespace install without a record id", () => {
  const parsed = parseArgs(["--namespace", "ns-1"]);
  const choices = validateChoices(parsed);
  assert.equal(choices.namespaceId, "ns-1");
  assert.equal(Object.hasOwn(choices, "recordId"), false);
  assert.throws(() => validateChoices(parseArgs(["--namespace", ""])), /namespace id/);
  assert.throws(() => parseArgs(["--namespace", "ns-1", "--registrar", "dynadot"]), /unknown argument --registrar/);
  assert.throws(() => parseArgs(["--namespace", "ns-1", "--lead-provider", "apollo"]), /unknown argument --lead-provider/);
  const org = validateChoices(parseArgs(["--org"]));
  assert.equal(org.scope, "org");
  assert.equal(org.namespaceId, "");
});

test("formatPlan names create versus update without secret values", () => {
  const plan = planInstall({
    manifest: fixture,
    choices: { scope: "org" },
    install: { workflows: { "agency-report": "workflows/wf-existing" } },
  });
  const text = formatPlan(plan);
  assert.match(text, /workflow agency-report update/);
  assert.match(text, /workflow agency-audit create/);
  assert.equal(text.includes("script "), false);
  assert.equal(text.includes("sl_key"), false);
});

const definitionWith = (key, operation) => ({ displayName: "Onboard", definition: { steps: [{ id: "n1", call: { installedApp: { installation: key, operation }, args: { baseId: { literal: "AIRTABLE_BASE_ID" } } } }] } });

test("runInstall installs the app, sets the API key, then deploys a revision", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-service-install-test-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows/onboard.json"), JSON.stringify(definitionWith("airtable", "updateRecords")));
  const calls = [];
  const secret = "vendor-secret";
  const runSl = (args) => {
    calls.push(args);
    if (args.includes("apps") && args.includes("get")) return { permissionDigest: "sha256:abc", connectionRequirements: { connections: [{ kind: "API_KEY", key: "base", authorizationMode: "INSTALLATION" }] } };
    if (args.includes("installations") && args.includes("create")) {
      calls.body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      return { installationId: "inst-airtable" };
    }
    if (args.includes("set-api-key")) {
      calls.connectionKey = args[args.indexOf("set-api-key") + 1];
      calls.apiKey = readFileSync(args[args.indexOf("--api-key-file") + 1], "utf8");
      return { outcome: "READY" };
    }
    if (args.includes("/v1/workflows") && args.includes("POST") && !args.some((part) => String(part).includes("revisions") || String(part).includes("deploy"))) {
      calls.workflow = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      return { name: "workflows/wf-1" };
    }
    if (args.some((part) => String(part).includes("/revisions"))) {
      calls.revision = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      return { name: "workflows/wf-1/revisions/r1" };
    }
    return {};
  };
  const result = runInstall({
    root,
    manifest: {
      workflows: [{ slug: "agency-report", name: "Onboard", scope: "organization", file: "workflows/onboard.json" }],
    },
    choices: { scope: "org" },
    env: { AIRTABLE_MARKETPLACE_APP_ID: "app-airtable", AIRTABLE_API_KEY: secret, AIRTABLE_BASE_ID: "appBase" },
    runSl,
  });
  assert.equal(result.workflowIds["agency-report"], "workflows/wf-1");
  assert.deepEqual(calls.body, { installation: { appId: "app-airtable", scopeType: "ORGANIZATION" }, permissionDigest: "sha256:abc" });
  assert.equal(calls.connectionKey, "base");
  assert.equal(calls.apiKey, secret);
  assert.equal(JSON.stringify(calls).includes(secret), false);
  assert.equal(calls.workflow.displayName, "Onboard");
  assert.equal(calls.revision.definition.steps[0].call.installedApp.installation, "installations/inst-airtable");
  assert.equal(calls.revision.definition.steps[0].call.args.baseId.literal, "appBase");
  const getAt = calls.findIndex((row) => row.includes("apps") && row.includes("get"));
  const createAt = calls.findIndex((row) => row.includes("installations") && row.includes("create"));
  const keyAt = calls.findIndex((row) => row.includes("set-api-key"));
  const workflowAt = calls.findIndex((row) => row.includes("/v1/workflows") && row.includes("POST"));
  assert.equal(getAt < createAt && createAt < keyAt && keyAt < workflowAt, true);
  assert.equal(calls.some((row) => row.includes("--namespace")), false);
  assert.equal(calls.some((row) => row.includes("script")), false);
  assert.equal(calls.some((row) => row.includes("publish") || row.includes("activate")), false);
  assert.equal(calls.some((row) => row.some((part) => String(part).includes(":deploy"))), true);
  const install = JSON.parse(readFileSync(join(root, "environment/org.install.json"), "utf8"));
  assert.equal(install.workflows["agency-report"], "workflows/wf-1");
  rmSync(root, { recursive: true, force: true });
});

test("runInstall creates Saleslumen Emails without set-api-key", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-service-install-test-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows/mail.json"), JSON.stringify({ displayName: "Mail", definition: { steps: [{ id: "n1", call: { installedApp: { installation: "saleslumen-emails", operation: "listAccounts" } } }] } }));
  const calls = [];
  const runSl = (args) => {
    calls.push(args);
    if (args.includes("apps") && args.includes("get")) return { permissionDigest: "sha256:emails", connectionRequirements: { connections: [] } };
    if (args.includes("installations") && args.includes("create")) {
      calls.body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      return { installationId: "inst-emails" };
    }
    if (args.includes("/v1/workflows") && args.includes("POST")) return { name: "workflows/wf-1" };
    if (args.some((part) => String(part).includes("/revisions"))) return { name: "workflows/wf-1/revisions/r1" };
    return {};
  };
  runInstall({
    root,
    manifest: { workflows: [{ slug: "mail", name: "Mail", scope: "namespace", file: "workflows/mail.json" }] },
    choices: { scope: "namespace", namespaceId: "ns-1" },
    env: { SALESLUMEN_EMAILS_MARKETPLACE_APP_ID: "app-emails" },
    runSl,
  });
  assert.deepEqual(calls.body, { installation: { appId: "app-emails", scopeType: "NAMESPACE", namespaceId: "ns-1" }, permissionDigest: "sha256:emails" });
  assert.equal(calls.some((row) => row.includes("set-api-key")), false);
  assert.equal(calls.some((row) => row[0] === "--json" && row[1] === "--namespace" && row[2] === "ns-1"), true);
  calls.length = 0;
  assert.throws(() => runInstall({
    root,
    manifest: { workflows: [{ slug: "mail", name: "Mail", scope: "namespace", file: "workflows/mail.json" }] },
    choices: { scope: "namespace", namespaceId: "ns-1" },
    env: { SALESLUMEN_EMAILS_MARKETPLACE_APP_ID: "app-emails", SALESLUMEN_EMAILS_API_KEY: "not-a-key" },
    runSl,
  }), (error) => error.message === "INSTALL_BINDING_INVALID: SALESLUMEN_EMAILS_API_KEY");
  assert.equal(calls.some((row) => row.includes("installations") || row.includes("set-api-key")), false);
  rmSync(root, { recursive: true, force: true });
});

test("bindDefinition rewrites a bare installation key to the installation resource", () => {
  const definition = { steps: [{ id: "lookup", call: { installedApp: { installation: "dynadot", operation: "getDomainInfo" }, args: { a: { literal: 1 } } } }] };
  const bound = bindDefinition(definition, {}, { dynadot: "inst-dynadot" });
  assert.equal(bound.steps[0].call.installedApp.installation, "installations/inst-dynadot");
  assert.equal(definition.steps[0].call.installedApp.installation, "dynadot");
  assert.equal(marketplaceAppEnvKey("saleslumen-emails"), "SALESLUMEN_EMAILS_MARKETPLACE_APP_ID");
});

test("bindDefinition replaces the AIRTABLE_BASE_ID literal from the binding env", () => {
  const definition = { steps: [{ id: "upsert", call: { installedApp: { installation: "airtable", operation: "updateRecords" }, args: { baseId: { literal: "AIRTABLE_BASE_ID" }, records: { expr: "execution.namespace" } } } }] };
  const bound = bindDefinition(definition, { AIRTABLE_BASE_ID: "appBase" }, { airtable: "inst-at" });
  assert.equal(bound.steps[0].call.args.baseId.literal, "appBase");
  assert.equal(bound.steps[0].call.args.records.expr, "execution.namespace");
  assert.equal(definition.steps[0].call.args.baseId.literal, "AIRTABLE_BASE_ID");
  assert.throws(() => bindDefinition(definition, {}, { airtable: "inst-at" }), (error) => error.message === "INSTALL_BINDING_MISSING: AIRTABLE_BASE_ID");
});

test("readBindingEnv takes app credentials from the scope env and AIRTABLE_BASE_ID from airtable/.env", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-service-install-test-"));
  mkdirSync(join(root, "environment"), { recursive: true });
  mkdirSync(join(root, "airtable"), { recursive: true });
  writeFileSync(join(root, "airtable/.env"), "AIRTABLE_PAT=pat\nAIRTABLE_BASE_ID=appOrg\n");
  writeFileSync(join(root, "environment/org.env"), "AIRTABLE_MARKETPLACE_APP_ID=app-org\nAIRTABLE_API_KEY=org-key\n");
  writeFileSync(join(root, "environment/ns-1.env"), "AIRTABLE_MARKETPLACE_APP_ID=app-ns\nAIRTABLE_API_KEY=ns-key\nAIRTABLE_BASE_ID=appIgnored\n");
  const env = readBindingEnv(installPaths(root, { scope: "namespace", namespaceId: "ns-1" }));
  assert.equal(env.AIRTABLE_MARKETPLACE_APP_ID, "app-ns");
  assert.equal(env.AIRTABLE_API_KEY, "ns-key");
  assert.equal(env.AIRTABLE_BASE_ID, "appOrg");
  assert.equal(Object.hasOwn(env, "AIRTABLE_PAT"), false);
  const orgEnv = readBindingEnv(installPaths(root, { scope: "org" }));
  assert.equal(orgEnv.AIRTABLE_MARKETPLACE_APP_ID, "app-org");
  assert.equal(orgEnv.AIRTABLE_API_KEY, "org-key");
  assert.equal(orgEnv.AIRTABLE_BASE_ID, "appOrg");
  rmSync(root, { recursive: true, force: true });
});

test("org.env.example has the same keys as namespace.env.example", () => {
  const keys = (name) => Object.keys(parseEnv(readFileSync(join(skillRoot, "environment", name), "utf8"))).sort();
  const names = keys("namespace.env.example");
  assert.deepEqual(keys("org.env.example"), names);
  assert.equal(names.some((key) => key.startsWith("INSTALLATION_")), false);
  assert.equal(names.includes("SALESLUMEN_EMAILS_MARKETPLACE_APP_ID"), true);
  assert.equal(names.includes("SALESLUMEN_EMAILS_API_KEY"), false);
  assert.equal(names.includes("AIRTABLE_API_KEY"), true);
  assert.equal(names.some((key) => key.endsWith("_CONNECTION_KEY")), false);
});

test("bindDefinition names the missing key without echoing values", () => {
  const definition = { steps: [{ id: "lookup", call: { installedApp: { installation: "dynadot", operation: "getDomainInfo" } } }] };
  assert.throws(() => bindDefinition(definition, {}, { zapmail: "secret-inst" }), (error) => error.message === "INSTALL_BINDING_MISSING: DYNADOT_MARKETPLACE_APP_ID");
  assert.throws(() => bindDefinition({ steps: [{ id: "raw", call: { installedApp: { installation: "installations/inst-1", operation: "op" } } }] }, {}, {}), /INSTALL_BINDING_INVALID/);
});

test("runInstall stops before creating an installation when the marketplace app id or API key is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-service-install-test-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows/a.json"), JSON.stringify({ displayName: "A", definition: { steps: [{ id: "n1", call: { installedApp: { installation: "airtable", operation: "op" } } }] } }));
  const calls = [];
  const manifest = { workflows: [{ slug: "a", name: "A", scope: "organization", file: "workflows/a.json" }] };
  const choices = { scope: "org" };
  const runSl = (args) => calls.push(args);
  assert.throws(() => runInstall({ root, manifest, choices, env: {}, runSl }), (error) => error.message === "INSTALL_BINDING_MISSING: AIRTABLE_MARKETPLACE_APP_ID");
  assert.equal(calls.length, 0);
  assert.throws(() => runInstall({
    root,
    manifest,
    choices,
    env: { AIRTABLE_MARKETPLACE_APP_ID: "app-airtable" },
    runSl: (args) => {
      calls.push(args);
      return { permissionDigest: "sha256:abc", connectionRequirements: { connections: [{ kind: "API_KEY", key: "base", authorizationMode: "INSTALLATION" }] } };
    },
  }), (error) => error.message === "INSTALL_BINDING_MISSING: AIRTABLE_API_KEY");
  assert.equal(calls.some((row) => row.includes("installations") || row.includes("set-api-key")), false);
  rmSync(root, { recursive: true, force: true });
});

test("matchesInstall treats organization scope as org", () => {
  assert.equal(matchesInstall({ scope: "organization" }, { scope: "org" }), true);
  assert.equal(matchesInstall({ scope: "namespace" }, { scope: "org" }), false);
});

test("readName accepts a workflow resource name", () => {
  assert.equal(readName({ name: "workflows/w1" }), "workflows/w1");
  assert.equal(readName({ name: "workflows/w1/revisions/r1" }), "workflows/w1/revisions/r1");
  assert.throws(() => readName({ id: "w2" }), /missing name/);
});

test("real manifest selects the namespace pack and no organization workflows", async () => {
  const { readFileSync: read } = await import("node:fs");
  const manifest = JSON.parse(read(join(skillRoot, "manifest.json"), "utf8"));
  assert.deepEqual(selectWorkflows(manifest, { scope: "org" }).map((row) => row.slug), []);
  assert.deepEqual(selectWorkflows(manifest, { scope: "namespace" }).map((row) => row.slug), [
    "provision-google-infrastructure",
    "provision-microsoft-infrastructure",
    "monitor-warm-up",
    "monitor-sender-health",
    "process-campaign-replies",
  ]);
});

test("runInstall creates both reply triggers and deletes an undeclared event type", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-service-install-test-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "environment"), { recursive: true });
  writeFileSync(join(root, "workflows/replies.json"), JSON.stringify({ displayName: "Process campaign replies", definition: { input: "any", steps: [{ id: "done", return: { value: { literal: "done" } } }] } }));
  writeFileSync(join(root, "environment/ns-1.install.json"), JSON.stringify({ scope: "namespace", namespaceId: "ns-1", workflows: { "process-campaign-replies": "workflows/wf-1" }, triggers: {} }));
  const manifest = {
    workflows: [{ slug: "process-campaign-replies", name: "Process campaign replies", scope: "namespace", file: "workflows/replies.json" }],
    triggers: [
      { workflow: "process-campaign-replies", eventType: "TRIGGER_EVENT_THREAD_LABEL_ADDED" },
      { workflow: "process-campaign-replies", eventType: "TRIGGER_EVENT_MESSAGE_REPLIED" },
    ],
  };
  const calls = [];
  const created = [];
  const pathOf = (args) => args.find((part) => String(part).startsWith("/v1/")) || "";
  let listed = [{ name: "workflows/wf-1/triggers/trg-bounce", eventType: "TRIGGER_EVENT_MESSAGE_BOUNCED" }];
  let runSl = (args) => {
    calls.push(args);
    if (args.includes("DELETE")) {
      listed = listed.filter((row) => row.name !== pathOf(args).replace(/^\/v1\//, ""));
      return {};
    }
    if (pathOf(args).endsWith("/triggers") && args.includes("POST")) {
      const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      created.push(body);
      const name = `workflows/wf-1/triggers/trg-${created.length}`;
      listed = listed.concat([{ name, eventType: body.eventType }]);
      return { name };
    }
    if (pathOf(args).endsWith("/triggers")) return { triggers: listed };
    if (pathOf(args).includes("/revisions")) return { name: "workflows/wf-1/revisions/r1" };
    return {};
  };
  const choices = { scope: "namespace", namespaceId: "ns-1" };
  runInstall({ root, manifest, choices, env: {}, runSl });
  const install = JSON.parse(readFileSync(join(root, "environment/ns-1.install.json"), "utf8"));
  assert.deepEqual(install.triggers["process-campaign-replies"], {
    TRIGGER_EVENT_THREAD_LABEL_ADDED: "workflows/wf-1/triggers/trg-1",
    TRIGGER_EVENT_MESSAGE_REPLIED: "workflows/wf-1/triggers/trg-2",
  });
  assert.equal(calls.some((row) => pathOf(row) === "/v1/workflows/wf-1/triggers/trg-bounce" && row.includes("DELETE")), true);
  assert.deepEqual(created, [
    { kind: "KIND_EVENT", enabled: true, eventType: "TRIGGER_EVENT_THREAD_LABEL_ADDED" },
    { kind: "KIND_EVENT", enabled: true, eventType: "TRIGGER_EVENT_MESSAGE_REPLIED" },
  ]);
  calls.length = 0;
  created.length = 0;
  runSl = (args) => {
    calls.push(args);
    if (pathOf(args).endsWith("/triggers") && !args.includes("POST") && !args.includes("DELETE")) return { triggers: listed };
    if (pathOf(args).includes("/revisions")) return { name: "workflows/wf-1/revisions/r2" };
    return {};
  };
  runInstall({ root, manifest, choices, env: {}, runSl });
  assert.equal(calls.some((row) => row.includes("DELETE") || (pathOf(row).endsWith("/triggers") && row.includes("POST"))), false);
  assert.equal(calls.some((row) => pathOf(row).endsWith("/triggers")), true);
  rmSync(root, { recursive: true, force: true });
});
