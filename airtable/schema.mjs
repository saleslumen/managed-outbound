import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIELD_TYPES = new Set(["singleLineText", "multilineText", "number", "checkbox", "singleSelect"]);
const asString = (value) => (value === undefined || value === null ? "" : String(value).trim());
const fieldNames = (table) => new Set((Array.isArray(table && table.fields) ? table.fields : []).map((field) => asString(field.name)));

export const loadCatalog = (raw) => {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const tables = parsed && Array.isArray(parsed.tables) ? parsed.tables : null;
  if (!tables || !tables.length) throw new Error("AIRTABLE_CATALOG_INVALID: tables must be a non-empty array");
  const names = new Set();
  return tables.map((table, index) => {
    const name = asString(table && table.name);
    if (!name) throw new Error(`AIRTABLE_CATALOG_INVALID: tables[${index}] name is required`);
    if (names.has(name)) throw new Error(`AIRTABLE_CATALOG_INVALID: duplicate table ${name}`);
    names.add(name);
    const fields = Array.isArray(table.fields) ? table.fields : [];
    if (!fields.length) throw new Error(`AIRTABLE_CATALOG_INVALID: ${name} needs at least one field`);
    const seen = new Set();
    const specs = fields.map((field, fieldIndex) => {
      const fieldName = asString(field && field.name);
      const type = asString(field && field.type);
      if (!fieldName) throw new Error(`AIRTABLE_CATALOG_INVALID: ${name} fields[${fieldIndex}] name is required`);
      if (seen.has(fieldName)) throw new Error(`AIRTABLE_CATALOG_INVALID: duplicate field ${fieldName} on ${name}`);
      seen.add(fieldName);
      if (!FIELD_TYPES.has(type)) throw new Error(`AIRTABLE_CATALOG_INVALID: ${name}.${fieldName} has unknown type ${type}`);
      if (fieldIndex === 0 && type !== "singleLineText") {
        throw new Error(`AIRTABLE_CATALOG_INVALID: ${name} primary field must be singleLineText`);
      }
      const spec = { name: fieldName, type };
      if (type === "singleSelect") {
        const choices = field.options && Array.isArray(field.options.choices) ? field.options.choices : [];
        const named = choices.map((choice) => ({ name: asString(choice && choice.name) })).filter((choice) => choice.name);
        if (!named.length) throw new Error(`AIRTABLE_CATALOG_INVALID: ${name}.${fieldName} needs choices`);
        spec.options = { choices: named };
      }
      if (type === "number" && field.options && field.options.precision !== undefined) {
        spec.options = { precision: field.options.precision };
      }
      if (type === "checkbox" && field.options) spec.options = field.options;
      return spec;
    });
    return { name, description: asString(table.description), fields: specs };
  });
};

export const readCatalog = () => loadCatalog(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tables.json"), "utf8"));

const missingFields = (table, specs) => specs.filter((spec) => !fieldNames(table).has(spec.name));

export const planSchema = (remoteTables, catalog = readCatalog()) => {
  const remote = Array.isArray(remoteTables) ? remoteTables : [];
  const tables = catalog.map((table) => {
    const existing = remote.find((row) => asString(row && row.name) === table.name);
    if (!existing) {
      return { name: table.name, description: table.description, action: "create-table", tableId: "", fields: table.fields, fieldsToCreate: table.fields };
    }
    return {
      name: table.name,
      description: table.description,
      action: "ensure-fields",
      tableId: asString(existing.id),
      fields: table.fields,
      fieldsToCreate: missingFields(existing, table.fields),
    };
  });
  return { tables };
};

export const formatPlan = (plan) => {
  const lines = [`airtable provision tables=${plan.tables.length}`];
  plan.tables.forEach((table) => {
    lines.push(`  table ${table.name} ${table.action} fields=${table.fieldsToCreate.length}`);
    table.fieldsToCreate.forEach((spec) => lines.push(`    field ${spec.name}`));
  });
  return lines.join("\n");
};
