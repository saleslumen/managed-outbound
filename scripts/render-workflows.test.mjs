import assert from "node:assert/strict";
import test from "node:test";
import { bezierPath, calculateColumnNodePositions, calculateWorkflowLayout, projectBlock, renderWorkflowHtml } from "./render-workflows.mjs";

const assets = { icons: { switch: ["M0 0h24v24H0z"], parallel: ["M0 0h24v24H0z"] } };

test("layout places start left of the first step and centers a switch over its cases", () => {
  const definition = { steps: [
    { id: "choose", switch: { cases: [{ when: "true", next: "yes" }], default: "no" } },
    { id: "yes", return: { value: { literal: "yes" } } },
    { id: "no", return: { value: { literal: "no" } } },
  ] };
  const projected = projectBlock(definition.steps);
  const linked = projectBlock([
    { id: "choose", next: "yes", switch: { cases: [{ when: "true", next: "yes" }], default: "no" } },
    { id: "yes", return: { value: { literal: "yes" } } },
    { id: "no", return: { value: { literal: "no" } } },
  ]);
  assert.equal(projected.transitions.some((transition) => transition.from === "choose" && transition.role === "next"), false);
  assert.equal(linked.transitions.some((transition) => transition.from === "choose" && transition.role === "next"), false);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.deepEqual(positions.get("__start"), { x: 0, y: 60 });
  assert.deepEqual(positions.get("choose"), { x: 250, y: 60 });
  assert.deepEqual(positions.get("yes"), { x: 500, y: 0 });
  assert.deepEqual(positions.get("no"), { x: 500, y: 120 });
});

test("converging forward paths place the shared target after every predecessor", () => {
  const projected = projectBlock([
    { id: "choose", switch: { cases: [{ when: "true", next: "join" }], default: "read_first" } },
    { id: "read_first", call: {}, next: "validate" },
    { id: "validate", assign: { assignments: [] }, next: "join" },
    { id: "join", call: {} },
  ]);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.ok(positions.get("join").x > positions.get("choose").x);
  assert.ok(positions.get("join").x > positions.get("validate").x);
});

test("acyclic jumps to earlier-listed steps keep all targets after their predecessors", () => {
  const projected = projectBlock([
    { id: "choose", switch: { cases: [{ when: "true", next: "later" }], default: "earlier" } },
    { id: "earlier", call: {}, next: "done" },
    { id: "later", assign: { assignments: [] }, next: "earlier" },
    { id: "done", return: { value: { literal: "done" } } },
  ]);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.ok(positions.get("earlier").x > positions.get("later").x);
  assert.ok(positions.get("done").x > positions.get("earlier").x);
});

test("a call catch hangs beside the success step instead of across the canvas", () => {
  const projected = projectBlock([
    { id: "send", call: { onError: { next: "recover" } }, next: "saved" },
    { id: "saved", return: { value: { literal: "ok" } } },
    { id: "recover", return: { value: { literal: "failed" } } },
  ]);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.equal(projected.transitions.some((transition) => transition.from === "send" && transition.to === "recover" && transition.role === "error"), true);
  assert.equal(projected.transitions.some((transition) => transition.from === "saved" && transition.to === "recover"), false);
  assert.ok(positions.get("saved").y < positions.get("recover").y);
  assert.equal(positions.get("saved").x, positions.get("recover").x);
});

test("parallel branches and the following step occupy distinct lanes", () => {
  const projected = projectBlock([
    { id: "split", parallel: { all: {}, branches: [
      { id: "first", steps: [{ id: "first_step", call: {} }] },
      { id: "second", steps: [{ id: "second_step", call: {} }] },
    ] } },
    { id: "after", return: { value: { literal: "done" } } },
  ]);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  const lanes = projected.transitions.filter((transition) => transition.from === "split").map((transition) => positions.get(transition.to));
  assert.equal(lanes.length, 3);
  assert.equal(lanes.every((position) => position.x > positions.get("split").x), true);
  assert.equal(new Set(lanes.map((position) => position.y)).size, 3);
});

test("end finishes its block and does not continue", () => {
  const projected = projectBlock([
    { id: "split", parallel: { all: {}, branches: [{ id: "main", steps: [
      { id: "saved", assign: { assignments: [{ path: "local.outcome", value: { literal: "ok" } }] }, next: "finish" },
      { id: "finish", next: "other", end: {} },
      { id: "other", assign: { assignments: [{ path: "local.outcome", value: { literal: "no" } }] } },
    ] }] } },
  ]);
  assert.equal(projected.steps.some((step) => step.id === "finish" && step.kind === "end"), true);
  assert.equal(projected.transitions.some((transition) => transition.from === "finish"), false);
  assert.equal(projected.transitions.some((transition) => transition.from === "saved" && transition.to === "finish"), true);
});

test("layout places the for-each body under the step that follows the loop", () => {
  const definition = { steps: [
    { id: "each", for_each: { items: { literal: [] }, item_name: "row", steps: [{ id: "loop", return: { value: { literal: "row" } } }] }, next: "after" },
    { id: "after", return: { value: { literal: "done" } } },
  ] };
  const projected = projectBlock(definition.steps);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.ok(positions.get("after").y < positions.get("loop").y);
});

test("backward loop edges stay visible without turning the forward layout into a cycle", () => {
  const projected = projectBlock([
    { id: "list_page", call: {}, next: "more_pages" },
    { id: "more_pages", switch: { cases: [{ when: "has_more", next: "next_page" }], default: "complete" } },
    { id: "next_page", assign: { assignments: [] }, next: "list_page" },
    { id: "complete", return: { value: { literal: "done" } } },
  ]);
  const loop = projected.transitions.find((transition) => transition.from === "next_page" && transition.to === "list_page");
  assert.ok(loop);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  assert.ok(positions.get("complete").x > positions.get("more_pages").x);
  assert.ok(positions.get("list_page").x < positions.get("next_page").x);
});

test("measured captions and kind rings receive enough vertical space", () => {
  const positions = calculateColumnNodePositions([
    [
      { id: "invalid", top: 0, topInset: 10, bottomExtent: 163 },
      { id: "append", top: 120, topInset: 10, bottomExtent: 143 },
    ],
    [{ id: "neighbor", top: 0, topInset: 10, bottomExtent: 80 }],
  ]);
  const invalidBottom = positions.get("invalid") + 163;
  const appendTop = positions.get("append") - 10;
  assert.ok(appendTop - invalidBottom >= 16);
  assert.match(renderWorkflowHtml({ displayName: "Caption width", definition: { steps: [
    { id: "caption", assign: { assignments: [] }, label: "Accounts pagination response is invalid" },
  ] } }, assets), /\.caption \{ width: 140px;/);
});

test("preview uses Web Bezier control points and keeps labels at the curve midpoint", () => {
  assert.deepEqual(bezierPath(100, 20, 300, 100), {
    d: "M100,20 C200,20 200,100 300,100",
    labelX: 200,
    labelY: 60,
  });
  assert.deepEqual(bezierPath(300, 100, 100, 20), {
    d: "M300,100 C388.3883476483185,100 11.611652351681556,20 100,20",
    labelX: 200.00000000000003,
    labelY: 60,
  });
  const html = renderWorkflowHtml({ definition: { steps: [
    { id: "choose", switch: { cases: [{ when: "yes", next: "join" }], default: "other" } },
    { id: "other", call: {}, next: "join" },
    { id: "join", call: {} },
  ] } }, assets);
  assert.doesNotMatch(html, /data-target-offset|data-siblings|routeWorkflowEdge|chooseEdgeLabelPosition/);
});

test("preview renders step kinds, case labels, and a dashed parallel branch", () => {
  const html = renderWorkflowHtml({
    displayName: "Monitor warm up",
    definition: { steps: [
      { id: "choose", switch: { cases: [{ when: "ready", next: "yes" }], default: "no" } },
      { id: "yes", return: { value: { literal: "yes" } } },
      { id: "no", return: { value: { literal: "no" } } },
      { id: "fan", parallel: { all: {}, branches: [{ id: "main", steps: [{ id: "finish", return: { value: { literal: "ok" } } }] }] } },
    ] },
  }, assets);
  assert.match(html, /<title>Monitor warm up<\/title>/);
  assert.match(html, /class="circle">Start/);
  assert.match(html, /class="caption">Switch<\/div>/);
  const named = renderWorkflowHtml({ displayName: "Named", definition: { steps: [
    { id: "buy", label: "Register domain", call: {} },
    { id: "done", label: "Domain missing", return: { value: { literal: "missing" } } },
  ] } }, assets);
  assert.match(named, /class="caption">Register domain<\/div>/);
  assert.match(named, /class="circle compact">Return<\/div>/);
  assert.match(named, /class="caption">Domain missing<\/div>/);
  assert.match(html, /class="letter"[^>]*>S<\/span>/);
  assert.match(html, /<text[^>]*>Case 1<\/text>/);
  assert.match(html, /<text[^>]*>default<\/text>/);
  assert.match(html, /<rect x="-2" y="-4" rx="2" ry="2"/);
  assert.match(html, /class="circle compact">Return<\/div>/);
  assert.match(html, /stroke:#b1b1b7;stroke-dasharray:5,5/);
  const caught = renderWorkflowHtml({
    displayName: "Catch",
    definition: { steps: [
      { id: "send", call: { onError: { next: "recover" } }, next: "saved" },
      { id: "saved", return: { value: { literal: "ok" } } },
      { id: "recover", return: { value: { literal: "failed" } } },
    ] },
  }, assets);
  assert.match(caught, /data-from="send" data-to="recover" style="stroke:#d32f2f"/);
  assert.doesNotMatch(caught, /data-from="send" data-to="recover"[^>]*stroke-dasharray/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Manrope/);
  assert.doesNotMatch(html, /class="caption">Start<\/div>/);
  const fallbackTerminal = renderWorkflowHtml({ displayName: "Terminal fallback", definition: { steps: [
    { id: "done", return: { value: { literal: "done" } } },
  ] } }, assets);
  assert.match(fallbackTerminal, /class="caption">Return<\/div>/);
});

test("converging engine edges share the target handle as in Web", () => {
  const html = renderWorkflowHtml({ displayName: "Converging branches", definition: { steps: [
    { id: "first", switch: { cases: [{ when: "vars.ready == true", next: "join" }], default: "second" } },
    { id: "second", switch: { cases: [{ when: "vars.ready == true", next: "join" }], default: "join" } },
    { id: "join", return: { value: { literal: "done" } } },
  ] } }, assets);
  assert.match(html, /data-from="first" data-to="join"/);
  const incoming = [...html.matchAll(/<path data-edge="\d+" data-from="(?:first|second)" data-to="join"/g)];
  assert.equal(incoming.length, 3);
  assert.doesNotMatch(html, /data-target-offset/);
  assert.match(html, /class="letter"[^>]*>S<\/span>/);
  assert.match(html, /<text[^>]*>Case 1<\/text>/);
  assert.match(html, /<text[^>]*>default<\/text>/);
});
