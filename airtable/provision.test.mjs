import assert from "node:assert/strict";
import test from "node:test";
import { formatPlan, loadCatalog, planSchema, readCatalog } from "./schema.mjs";
import { applyPlan, parseEnv, requireRegistryEnv } from "./provision.mjs";

const catalog = loadCatalog({
  tables: [
    { name: "Namespaces", description: "Namespaces", fields: [{ name: "Name", type: "singleLineText" }, { name: "Namespace ID", type: "singleLineText" }] },
    { name: "Email Accounts", description: "Senders", fields: [{ name: "Email", type: "singleLineText" }, { name: "Namespace ID", type: "singleLineText" }] },
  ],
});

test("planSchema creates a missing table and adds missing fields", () => {
  const plan = planSchema([{ id: "tblNamespaces", name: "Namespaces", fields: [{ name: "Name" }] }], catalog);
  assert.equal(plan.tables[0].action, "ensure-fields");
  assert.equal(plan.tables[0].tableId, "tblNamespaces");
  assert.deepEqual(plan.tables[0].fieldsToCreate.map((spec) => spec.name), ["Namespace ID"]);
  assert.equal(plan.tables[1].action, "create-table");
  assert.equal(plan.tables[1].name, "Email Accounts");
  assert.equal(plan.tables[1].fieldsToCreate.length, 2);
});

test("planSchema creates every table when the base has none of them", () => {
  const plan = planSchema([{ id: "tbl1", name: "Table 1", fields: [] }], catalog);
  assert.deepEqual(plan.tables.map((table) => table.action), ["create-table", "create-table"]);
});

test("a renamed catalog table is planned as a new table", () => {
  const renamed = loadCatalog({
    tables: [{ name: "Accounts", description: "Namespaces", fields: [{ name: "Name", type: "singleLineText" }] }],
  });
  const plan = planSchema([{ id: "tblNamespaces", name: "Namespaces", fields: [{ name: "Name" }] }], renamed);
  assert.equal(plan.tables[0].name, "Accounts");
  assert.equal(plan.tables[0].action, "create-table");
});

test("loadCatalog rejects a duplicate name, a bad primary field, and a missing choice", () => {
  assert.throws(() => loadCatalog({ tables: [{ name: "Namespaces", fields: [{ name: "Name", type: "number" }] }] }), /primary field/);
  assert.throws(() => loadCatalog({
    tables: [
      { name: "Namespaces", fields: [{ name: "Name", type: "singleLineText" }] },
      { name: "Namespaces", fields: [{ name: "Name", type: "singleLineText" }] },
    ],
  }), /duplicate table/);
  assert.throws(() => loadCatalog({
    tables: [{ name: "Namespaces", fields: [{ name: "Name", type: "singleLineText" }, { name: "Plane", type: "singleSelect", options: { choices: [] } }] }],
  }), /needs choices/);
});

test("the pack catalog uses Namespaces, Domains, Email Accounts, and Truly Inbox", () => {
  const pack = readCatalog();
  assert.deepEqual(pack.map((table) => table.name), ["Namespaces", "Domains", "Email Accounts", "Exceptions"]);
  const text = JSON.stringify(pack);
  assert.equal(text.includes("Truly Inbox Workspace ID"), true);
  assert.equal(text.includes("Zapmail Workspace ID"), true);
  assert.equal(text.includes("Saleslumen Emails Account ID"), true);
  assert.equal(text.includes("Saleslumen Namespace ID"), true);
  assert.equal(text.includes("Saleslumen Campaign ID"), false);
  assert.equal(text.includes('"Namespace ID"'), false);
  assert.equal(text.includes('"Emails Account ID"'), false);
  assert.equal(text.includes('"Mailbox Workspace ID"'), false);
  assert.equal(text.includes('"Campaign ID"'), false);
  assert.equal(text.includes("Cloudflare Account ID"), false);
  assert.equal(text.includes("Mailbox Plane"), false);
  assert.equal(text.includes("TrulyInbox"), false);
});

test("formatPlan names the table and does not include a token", () => {
  const text = formatPlan(planSchema([], catalog));
  assert.match(text, /table Namespaces create-table/);
  assert.match(text, /table Email Accounts create-table/);
  assert.equal(text.includes("pat"), false);
  assert.equal(text.includes("Bearer"), false);
});

test("requireRegistryEnv rejects a missing token without echoing values", () => {
  assert.throws(() => requireRegistryEnv({ AIRTABLE_BASE_ID: "app123" }), /AIRTABLE_PAT_MISSING/);
  const registry = requireRegistryEnv({ AIRTABLE_PAT: "secret-token", AIRTABLE_BASE_ID: "app123" });
  assert.equal(registry.baseId, "app123");
  assert.equal(registry.tableName, undefined);
});

test("parseEnv ignores comments and blank lines", () => {
  const env = parseEnv("# note\n\nAIRTABLE_PAT=pat-1\nAIRTABLE_BASE_ID=\"app-1\"\n");
  assert.equal(env.AIRTABLE_PAT, "pat-1");
  assert.equal(env.AIRTABLE_BASE_ID, "app-1");
});

test("applyPlan creates a missing table and adds a missing field", async () => {
  const calls = [];
  const plan = planSchema([{ id: "tblNamespaces", name: "Namespaces", fields: [{ name: "Name" }] }], catalog);
  await applyPlan({
    plan,
    baseId: "app123",
    client: {
      async createField(baseId, tableId, spec) {
        calls.push(["field", baseId, tableId, spec.name]);
      },
      async createTable(baseId, body) {
        calls.push(["table", baseId, body.name, body.fields.length]);
      },
    },
  });
  assert.deepEqual(calls[0], ["field", "app123", "tblNamespaces", "Namespace ID"]);
  assert.deepEqual(calls[1], ["table", "app123", "Email Accounts", 2]);
});
