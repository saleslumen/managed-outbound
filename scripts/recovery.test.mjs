import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const load = (name) => JSON.parse(readFileSync(join(root, name), "utf8")).definition;
const index = (definition) => {
  const steps = new Map();
  const walk = (list) => (list || []).forEach((step) => {
    steps.set(step.id, step);
    walk(step.for_each?.steps);
    (step.parallel?.branches || []).forEach((branch) => walk(branch.steps));
  });
  walk(definition.steps);
  return steps;
};
const literal = (value) => value?.literal;
const text = (step) => JSON.stringify(step);
const nameservers = ["pns61.cloudns.net", "pns62.cloudns.com", "pns63.cloudns.net", "pns64.cloudns.uk"];

test("registerDomain has no failure catch and the purchase is recorded before nameservers", () => {
  ["provision-google-infrastructure.json", "provision-microsoft-infrastructure.json"].forEach((name) => {
    const steps = index(load(name));
    const register = steps.get("register_domain");
    assert.equal(register.call.installedApp.operation, "registerDomain");
    assert.equal(register.call.onError, undefined);
    assert.equal(register.next, "close_dynadot_exception");
    assert.equal(steps.get("close_dynadot_exception").next, "record_dynadot_domain");
    assert.equal(steps.get("record_dynadot_domain").next, "upsert_namespace");
    assert.equal(steps.get("upsert_namespace").next, "set_nameservers");
    assert.equal(literal(steps.get("record_dynadot_domain").call.args.tableIdOrName), "Domains");
    assert.deepEqual(literal(steps.get("record_dynadot_domain").call.args.performUpsert).fieldsToMergeOn, ["Domain"]);
    assert.match(text(steps.get("close_dynadot_exception")), /:provision:dynadot:/);
    assert.match(text(steps.get("record_dynadot_domain")), /execution\.namespace/);
  });
});

test("provisioning waits twelve hours twice and joins the connection with the export", () => {
  ["provision-google-infrastructure.json", "provision-microsoft-infrastructure.json"].forEach((name) => {
    const definition = load(name);
    const steps = index(definition);
    const waits = [...steps.values()].filter((step) => step.wait).map((step) => step.wait.duration);
    assert.deepEqual(waits, ["43200s", "43200s"]);
    assert.equal(steps.get("connect_domain").next, "wait_domain_dns");
    assert.equal(steps.get("add_domain_forwarding").next, "close_zapmail_exception");
    assert.equal(steps.get("close_zapmail_exception").next, "assign_mailboxes");
    assert.equal(steps.get("record_assigned_mailbox").next, "wait_mailbox");
    assert.equal(steps.get("wait_mailbox").next, "list_mailboxes");
    const split = steps.get("close_mailbox_exception_split");
    assert.deepEqual(Object.keys(split.parallel).filter((key) => ["all", "branches"].includes(key)).sort(), ["all", "branches"]);
    assert.deepEqual(split.parallel.branches.map((branch) => branch.id), ["main", "async"]);
    assert.match(text(split.parallel.branches[1]), /exportMailboxes/);
    assert.equal(split.next, undefined);
    assert.equal(definition.steps.at(-1).id, "close_mailbox_exception_split");
    split.parallel.branches.forEach((branch) => {
      branch.steps.filter((step) => step.call).forEach((step) => {
        assert.ok(step.call.onError, `${name} ${step.id} must catch so the other branch is not cancelled`);
        assert.equal(branch.local.includes(`${step.id}_error:`), true);
        const target = branch.steps.find((item) => item.id === step.call.onError.next);
        const outcome = target && target.assign && target.assign.assignments.find((row) => row.path === "local.outcome");
        if (outcome) assert.notEqual(outcome.value.literal, "saleslumen_connected");
      });
    });
    assert.equal(JSON.stringify(definition).includes("startWarmup"), false);
    assert.equal(JSON.stringify(definition).includes("saleslumen-campaigns"), false);
  });
});

test("a domain that is not active opens the Zapmail exception and does not assign a mailbox", () => {
  ["provision-google-infrastructure.json", "provision-microsoft-infrastructure.json"].forEach((name) => {
    const steps = index(load(name));
    const active = steps.get("if_domain_active_after_dns").switch;
    const waiting = steps.get("if_domain_waiting_after_dns").switch;
    assert.equal(active.cases[0].when, 'vars.zapmail_domain_status == "ACTIVE"');
    assert.equal(active.cases[0].next, "add_domain_forwarding");
    assert.equal(active.default, "if_domain_waiting_after_dns");
    assert.match(waiting.cases[0].when, /PENDING/);
    assert.match(waiting.cases[0].when, /IN_PROGRESS/);
    assert.equal(waiting.cases[0].next, "open_domain_waiting");
    assert.equal(waiting.default, "open_domain_status_after");
    assert.equal(steps.get("if_zapmail_domain_after_dns").switch.default, "open_domain_missing");
    assert.equal(steps.get("open_domain_missing").next, "end_domain_missing");
    assert.equal(literal(steps.get("end_domain_missing").return.value), "zapmail_domain_missing");
    ["set_nameservers", "connect_domain", "list_zapmail_domain_after_dns", "add_domain_forwarding", "assign_mailboxes", "list_mailboxes"].forEach((id) => {
      const failure = steps.get(id).call.onError;
      assert.equal(steps.get(failure.next).call.args.records.expr.includes('"Status": "open"'), true, id);
    });
    assert.deepEqual(literal(steps.get("set_nameservers").call.args.nameserver_list), nameservers);
    assert.equal(literal(steps.get("add_domain_forwarding").call.args.forwardTo), "example.com");
  });
});

test("invalid provisioning input is rejected before a provider call", () => {
  ["provision-google-infrastructure.json", "provision-microsoft-infrastructure.json"].forEach((name) => {
    const definition = load(name);
    const steps = index(definition);
    const gate = steps.get("if_provision_input_valid").switch;
    assert.match(gate.cases[0].when, /input\.namespace_name/);
    assert.match(gate.cases[0].when, /input\.mailbox\.username/);
    assert.equal(gate.cases[0].next, "close_provision_input_exception");
    assert.equal(gate.default, "open_provision_input_exception");
    assert.equal(definition.steps[0].id, "if_provision_input_valid");
    const provider = [...steps.values()].filter((step) => ["dynadot", "zapmail"].includes(step.call?.installedApp?.installation));
    assert.equal(provider.some((step) => step.id === "open_provision_input_exception"), false);
  });
});

test("a ready paused account is set to 10 a day and then resumed", () => {
  const steps = index(load("monitor-warm-up.json"));
  const settings = steps.get("set_monitoring_warmup").call.args;
  assert.equal(settings.workspaceId.expr, "vars.trulyinbox_workspace_id");
  assert.equal(settings.id.expr, "ready_account.trulyInboxAccountId");
  assert.equal(literal(settings.warmupMaxLimit), 10);
  assert.equal(literal(settings.timezone), "UTC");
  assert.equal(literal(settings.schedule).length, 7);
  assert.equal(literal(settings.schedule)[0].dayOfWeek, 0);
  assert.equal(literal(settings.schedule)[6].enabled, true);
  const paused = steps.get("if_account_paused").switch;
  assert.equal(paused.cases[0].when, "ready_account.paused == true");
  assert.equal(paused.cases[0].next, "resume_account");
  assert.equal(paused.default, "record_sending_active");
  assert.equal(steps.get("foreach_ready_account").for_each.item_name, "ready_account");
  assert.deepEqual(literal(steps.get("list_trulyinbox_accounts").call.args.outreachReadiness), ["ready"]);
  assert.equal(literal(steps.get("list_trulyinbox_accounts").call.args.deliverabilityMin), 85);
  assert.match(text(steps.get("stash_ready_mailboxes")), /deliverabilityRate >= 85/);
  assert.equal(JSON.stringify(load("monitor-warm-up.json")).includes("saleslumen-campaigns"), false);
});

test("sender health sets a failing sender back to 20 a day and pauses only an active account", () => {
  const steps = index(load("monitor-sender-health.json"));
  ["set_full_warmup", "set_full_warmup_while_paused"].forEach((id) => {
    const settings = steps.get(id).call.args;
    assert.equal(settings.workspaceId.expr, "vars.trulyinbox_workspace_id");
    assert.equal(literal(settings.warmupMaxLimit), 20);
    assert.equal(literal(settings.timezone), "UTC");
    assert.equal(literal(settings.schedule).length, 7);
  });
  assert.equal(steps.get("set_full_warmup").next, "pause_account");
  assert.equal(steps.get("set_full_warmup_while_paused").next, "end_sender_already_paused");
  assert.match(steps.get("if_sender_healthy").switch.cases[0].when, /deliverabilityRate >= 85/);
  assert.match(steps.get("if_leave_account").switch.cases[0].when, /warming == true/);
  assert.match(steps.get("if_leave_account").switch.cases[0].when, /unmapped == true/);
  assert.equal(steps.get("set_full_warmup").call.onError.next, "open_set_full_warmup_failed");
});

test("sender health paginates inventories with bounded forward-only engine loops", () => {
  const definition = load("monitor-sender-health.json");
  const steps = index(definition);
  const inventories = [
    { prefix: "accounts", result: "vars.list_trulyinbox_accounts", accumulator: "vars.trulyinbox_accounts", next: "list_ready_accounts_page_1" },
    { prefix: "ready_accounts", result: "vars.list_ready_accounts", accumulator: "vars.ready_account_emails", next: "list_warming_accounts_page_1" },
    { prefix: "warming_accounts", result: "vars.list_warming_accounts", accumulator: "vars.warming_account_emails", next: "stash_warmup_mailboxes" },
  ];
  for (const { prefix, result, accumulator, next } of inventories) {
    const pageOne = steps.get(`list_${prefix}_page_1`);
    const pageOneValidation = steps.get(`validate_${prefix}_page_1`).switch;
    const pageOneAppend = steps.get(`append_${prefix}_page_1`);
    const loop = steps.get(`foreach_${prefix}_pages`).for_each;
    assert.equal(pageOne.call.installedApp.installation, "trulyinbox");
    assert.equal(pageOne.call.args.page.literal, 1);
    assert.equal(literal(pageOne.call.args.limit), 100);
    assert.equal(pageOne.call.result, result);
    assert.match(pageOneValidation.cases[0].when, /pagination\.total_pages/);
    assert.match(pageOneValidation.cases[0].when, /\.orValue\(null\)/);
    assert.equal(steps.get(pageOneValidation.cases[0].next).return.value.literal, "trulyinbox_pagination_invalid");
    assert.match(pageOneValidation.cases[1].when, /> 10/);
    assert.equal(steps.get(pageOneValidation.cases[1].next).return.value.literal, "trulyinbox_list_limit_exceeded");
    assert.equal(pageOneValidation.default, pageOneAppend.id);
    assert.equal(pageOneAppend.assign.assignments[0].path, accumulator);
    assert.match(loop.items.expr, /\[2, 3, 4, 5, 6, 7, 8, 9, 10\]/);
    assert.match(loop.items.expr, /pagination\.total_pages/);
    assert.equal(loop.item_name, "page");
    assert.equal(loop.concurrency, 1);
    assert.equal(loop.result, `vars.${prefix}_page_results`);
    const listPage = loop.steps.find((step) => step.id === `list_${prefix}_page`);
    assert.equal(listPage.call.installedApp.operation, "listEmailAccounts");
    assert.equal(listPage.call.args.page.expr, "page");
    assert.equal(literal(listPage.call.args.limit), 100);
    const pageValidation = loop.steps.find((step) => step.id === `validate_${prefix}_page`).switch;
    assert.match(pageValidation.cases[0].when, /\.orValue\(null\)/);
    for (const id of [`mark_${prefix}_page_invalid`, `keep_${prefix}_page`]) {
      const assignments = loop.steps.find((step) => step.id === id).assign.assignments;
      assert.ok(assignments.some((assignment) => assignment.path === "local.page_response" && assignment.value.literal === null), `${id} must release the raw page response`);
    }
    const loopStep = steps.get(`foreach_${prefix}_pages`);
    assert.equal(loopStep.next, `validate_${prefix}_page_results`);
    const bodyPositions = new Map(loop.steps.map((step, position) => [step.id, position]));
    for (const source of loop.steps) {
      const targets = [source.next, source.switch?.default, ...(source.switch?.cases || []).map((item) => item.next)].filter(Boolean);
      for (const target of targets) {
        assert.ok(bodyPositions.get(target) > bodyPositions.get(source.id), `${source.id} must only point forward to ${target}`);
      }
    }
    assert.equal(steps.get(`validate_${prefix}_page_results`).switch.cases[0].next, `end_${prefix}_page_results_invalid`);
    assert.equal(steps.get(`end_${prefix}_page_results_invalid`).return.value.literal, "trulyinbox_pagination_invalid");
    assert.equal(steps.get(`append_${prefix}_pages`).assign.assignments[0].path, accumulator);
    assert.match(steps.get(`append_${prefix}_pages`).assign.assignments[0].value.expr, /\.flatten\(\)/);
    assert.ok(steps.get(`append_${prefix}_pages`).assign.assignments.some((assignment) => assignment.path === `vars.${prefix}_page_results` && Array.isArray(assignment.value.literal) && assignment.value.literal.length === 0));
    assert.ok(steps.get(`append_${prefix}_pages`).assign.assignments.some((assignment) => assignment.path === result && assignment.value.literal === null));
    assert.equal(steps.get(`append_${prefix}_pages`).next, next);
  }
  for (const prefix of ["ready_accounts", "warming_accounts"]) {
    const pageOne = steps.get(`append_${prefix}_page_1`).assign.assignments[0].value.expr;
    const page = steps.get(`foreach_${prefix}_pages`).for_each.steps.find((step) => step.id === `keep_${prefix}_page`).assign.assignments[0].value.expr;
    assert.match(pageOne, /map\(account, account\.emailAddress\.lowerAscii\(\)\)/);
    assert.match(page, /map\(account, account\.emailAddress\.lowerAscii\(\)\)/);
  }
  assert.match(steps.get("stash_warmup_mailboxes").assign.assignments[0].value.expr, /ready_account_emails\.exists\(email, email == account\.email\)/);
  assert.match(steps.get("stash_warmup_mailboxes").assign.assignments[0].value.expr, /warming_account_emails\.exists\(email, email == account\.email\)/);
  assert.match(steps.get("stash_senders").assign.assignments[0].value.expr, /"warming": row\.mailbox\[0\]\.warming == true/);
  assert.equal(definition.vars.ready_account_emails, "list<string>");
  assert.equal(definition.vars.warming_account_emails, "list<string>");
  const topLevel = definition.steps;
  const topLevelIndex = new Map(topLevel.map((step, position) => [step.id, position]));
  for (const source of topLevel) {
    const targets = [source.next, source.switch?.default, ...(source.switch?.cases || []).map((item) => item.next)].filter(Boolean);
    for (const target of targets) {
      assert.ok(topLevelIndex.get(target) > topLevelIndex.get(source.id), `${source.id} must only point forward to ${target}`);
    }
  }
  assert.equal(steps.get("stash_warmup_mailboxes").next, "list_emails_accounts");
  assert.equal(steps.get("list_emails_accounts").next, "stash_senders");
  assert.ok(topLevelIndex.get("append_warming_accounts_pages") < topLevelIndex.get("list_emails_accounts"));
  assert.ok(topLevelIndex.get("list_emails_accounts") < topLevelIndex.get("foreach_sender"));
  const mutationCalls = [...steps.values()].filter((step) => step.call && ["trulyinbox", "saleslumen-emails"].includes(step.call.installedApp.installation) && ["pauseAccount", "updateWarmupSettings", "resumeAccount", "updateAccount"].includes(step.call.installedApp.operation));
  assert.ok(mutationCalls.length > 0);
  assert.ok(mutationCalls.every((step) => step.id === "set_full_warmup" || step.id === "set_full_warmup_while_paused" || step.id === "pause_account" || step.id === "resume_account" || step.id === "record_degraded" || step.id.startsWith("record_")));
});
