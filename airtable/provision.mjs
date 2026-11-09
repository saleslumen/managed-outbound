#!/usr/bin/env node
/**
 * Ensure the organization Airtable base has every table in tables.json.
 * Does not create namespace rows, rename an existing table, bind a Saleslumen installation, or print secrets.
 * Usage: node airtable/provision.mjs [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPlan, planSchema } from "./schema.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asString = (value) => (value === undefined || value === null ? "" : String(value).trim());

export const parseEnv = (text) => {
  const env = {};
  String(text || "").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  });
  return env;
};

export const requireRegistryEnv = (env) => {
  const source = env && typeof env === "object" ? env : {};
  const pat = asString(source.AIRTABLE_PAT);
  const baseId = asString(source.AIRTABLE_BASE_ID);
  if (!pat) throw new Error("AIRTABLE_PAT_MISSING");
  if (!baseId) throw new Error("AIRTABLE_BASE_ID_MISSING");
  return { pat, baseId };
};

const airtableError = async (response) => {
  let type = "";
  try {
    const body = await response.json();
    type = asString(body && body.error && (body.error.type || body.error.message));
  } catch {
    type = "";
  }
  return new Error(`AIRTABLE_REQUEST_FAILED (${response.status})${type ? `: ${type}` : ""}`);
};

export const createAirtableClient = ({ pat, fetchImpl = fetch }) => {
  const request = async (path, method, body) => {
    const response = await fetchImpl(`https://api.airtable.com/v0${path}`, {
      method,
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await airtableError(response);
    return response.json();
  };
  return {
    async tables(baseId) {
      const payload = await request(`/meta/bases/${encodeURIComponent(baseId)}/tables`, "GET");
      return Array.isArray(payload.tables) ? payload.tables : [];
    },
    async createField(baseId, tableId, spec) {
      return request(`/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`, "POST", spec);
    },
    async createTable(baseId, body) {
      return request(`/meta/bases/${encodeURIComponent(baseId)}/tables`, "POST", body);
    },
  };
};

export const applyPlan = async ({ plan, baseId, client }) => {
  for (const table of plan.tables) {
    if (table.action === "create-table") {
      await client.createTable(baseId, { name: table.name, description: table.description, fields: table.fields });
      continue;
    }
    for (const spec of table.fieldsToCreate) {
      await client.createField(baseId, table.tableId, spec);
    }
  }
};

const main = async () => {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (process.argv.slice(2).some((part) => part !== "--dry-run")) {
    console.error("Usage: node airtable/provision.mjs [--dry-run]");
    process.exit(2);
  }
  const envPath = join(skillRoot, "airtable/.env");
  if (!existsSync(envPath)) {
    console.error("AIRTABLE_ENV_MISSING: copy airtable/.env.example to airtable/.env");
    process.exit(1);
  }
  let registry;
  try {
    registry = requireRegistryEnv(parseEnv(readFileSync(envPath, "utf8")));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const client = createAirtableClient({ pat: registry.pat });
  let plan;
  try {
    plan = planSchema(await client.tables(registry.baseId));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(formatPlan(plan));
  if (dryRun) return;
  try {
    await applyPlan({ plan, baseId: registry.baseId, client });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log("ok");
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
