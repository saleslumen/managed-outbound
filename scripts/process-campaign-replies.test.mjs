import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const definition = JSON.parse(readFileSync(join(root, "process-campaign-replies.json"), "utf8")).definition;
const steps = new Map();
const walk = (list) => (list || []).forEach((step) => {
  steps.set(step.id, step);
  walk(step.for_each?.steps);
  (step.parallel?.branches || []).forEach((branch) => walk(branch.steps));
});
walk(definition.steps);
const expr = (step) => JSON.stringify(step);

test("label-added and message-replied both reach the reply spine", () => {
  assert.equal(definition.input, "any");
  const event = steps.get("if_event").switch;
  assert.equal(event.cases.length, 2);
  assert.match(event.cases[0].when, /label_id/);
  assert.equal(event.cases[0].next, "get_label");
  assert.match(event.cases[1].when, /reply_message_id/);
  assert.equal(event.cases[1].next, "list_labels");
  assert.equal(event.default, "end_event_missing");
  assert.equal(steps.get("end_event_missing").return.value.literal, "event_missing");
  const label = steps.get("if_interested").switch;
  assert.match(label.cases[0].when, /Interested/);
  assert.equal(label.cases[0].next, "if_already_replied");
  assert.equal(label.default, "end_interested_ignored");
  assert.equal(steps.get("list_labels").call.installedApp.operation, "listLabels");
  assert.match(expr(steps.get("stash_interested")), /Interested/);
  assert.match(expr(steps.get("stash_interested")), /user_label_ids/);
  const replied = steps.get("if_interested_on_reply").switch;
  assert.equal(replied.cases[0].next, "if_already_replied");
  assert.equal(replied.default, "end_reply_interested_ignored");
  assert.equal(steps.get("end_interested_ignored").return.value.literal, "interested_ignored");
  assert.equal(steps.get("end_reply_interested_ignored").return.value.literal, "interested_ignored");
  const alreadyReplied = steps.get("if_already_replied").switch;
  assert.match(alreadyReplied.cases[0].when, /\?reply_sent_after_latest_inbound\.orValue\(false\)/);
  assert.equal(alreadyReplied.cases[0].next, "end_already_replied");
  assert.equal(alreadyReplied.default, "get_thread");
  assert.equal([...steps.values()].filter((step) => step.switch?.cases?.some((item) => item.next === "get_thread")).length, 0);
});

test("the reply is plain completion text sent on the inbound thread", () => {
  const write = steps.get("write_reply");
  assert.equal(write.call.installedApp.operation, "chatCompletions");
  assert.equal(JSON.stringify(write.call.args).includes("json_schema"), false);
  assert.match(JSON.stringify(write.call.args), /Return only the reply text/);
  const send = steps.get("send_reply");
  assert.equal(send.call.installedApp.operation, "sendMessage");
  const body = JSON.stringify(send.call.args);
  assert.match(body, /In-Reply-To/);
  assert.match(body, /References/);
  assert.match(body, /vars\.reply_base64/);
  assert.match(expr(steps.get("stash_reply")), /base64\.decode/);
  assert.match(expr(steps.get("stash_reply")), /text\/plain/);
  assert.match(expr(steps.get("read_reply")), /base64\.encode\(bytes\(/);
  assert.match(expr(steps.get("stash_reply")), /substring\(0, 14\)/);
});

test("a failed send opens one exception and Campaigns is not called", () => {
  assert.equal(steps.get("send_reply").call.onError.next, "record_send_exception");
  assert.match(expr(steps.get("record_send_exception")), /execution\.namespace/);
  assert.equal(JSON.stringify(definition).includes("saleslumen-campaigns"), false);
  assert.equal([...steps.values()].some((step) => step.call?.installedApp?.installation === "saleslumen-campaigns"), false);
});
