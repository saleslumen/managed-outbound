#!/usr/bin/env node
/**
 * Render workflow definitions to a preview page and a PNG.
 * Usage: node scripts/render-workflows.mjs [workflow.json ...]
 */
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_HEIGHT = 80;
const VERTICAL_SPACING = 40;
const LEVEL_SPACING = 250;
const CANVAS_PADDING = 40;
const START_ID = "__start";
const LABELS = { call: "Call", assign: "Assign", switch: "Switch", wait: "Wait", awaitSignal: "Wait for signal", parallel: "Parallel", for_each: "For each", callWorkflow: "Run workflow", return: "Return", fail: "Raise error", end: "End" };
const ICONS = { call: "TaskOutlined", assign: "SettingsOutlined", switch: "CallSplitOutlined", wait: "ScheduleOutlined", parallel: "AccountTreeOutlined", for_each: "LoopOutlined", return: "FlagOutlined", fail: "ErrorOutline", add: "Add" };
const KINDS = Object.keys(LABELS);
const MANROPE = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap";

export function workflowFiles(args = []) {
  if (args.length) return args.map((file) => resolve(file));
  return readdirSync(join(root, "workflows")).filter((name) => name.endsWith(".json")).sort().map((name) => join(root, "workflows", name));
}

const stepKind = (step) => KINDS.find((kind) => step[kind] !== undefined) || "";

const uniqueViewId = (used, preferred) => {
  let id = preferred;
  let suffix = 1;
  while (used.has(id)) {
    id = `${preferred}:${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
};

/**
 * end, return, and fail draw no successor, including when next is set. The End node is the word End in the circle.
 * A switch draws only its cases and its default. Its own next is not an edge, and it does not fall through to the next step in the list.
 * onError is a solid edge. Only a parallel branch is dashed.
 */
export function projectBlock(steps) {
  const used = new Set([START_ID]);
  const projected = [{ id: START_ID, kind: "start", label: "Start" }];
  const transitions = [];
  const projectSteps = (block, entry) => {
    const viewIds = [];
    const authoredView = new Map();
    const localIds = new Set();
    (block || []).forEach((step, index) => {
      const authoredId = step.id ?? "";
      const validId = Boolean(authoredId) && authoredId !== START_ID && !localIds.has(authoredId);
      if (authoredId) localIds.add(authoredId);
      const id = uniqueViewId(used, validId ? authoredId : `__view:${index}`);
      const kind = stepKind(step) || "invalid";
      const authoredLabel = typeof step.label === "string" ? step.label.trim() : "";
      viewIds.push(id);
      if (validId) authoredView.set(authoredId, id);
      projected.push({ id, kind, label: kind === "invalid" ? "Invalid" : authoredLabel || LABELS[kind] || "Invalid", authoredLabel });
    });
    if (entry && viewIds[0]) transitions.push({ from: entry.source, to: viewIds[0], label: entry.label, role: entry.role });
    const resolve = (target) => (target ? authoredView.get(target) : undefined);
    (block || []).forEach((step, index) => {
      const id = viewIds[index];
      const kind = projected.find((item) => item.id === id)?.kind;
      const terminal = kind === "return" || kind === "fail" || kind === "end";
      const successor = terminal || kind === "switch" ? undefined : step.next ? resolve(step.next) : viewIds[index + 1];
      if (successor) {
        const role = kind === "for_each" ? "after" : "next";
        transitions.push({ from: id, to: successor, label: role === "after" ? "after" : "", role });
      }
      (step.switch?.cases || []).forEach((item, caseIndex) => {
        const target = resolve(item.next);
        const when = (item.when ?? "").trim();
        if (target) transitions.push({ from: id, to: target, label: when === "true" ? "True" : `Case ${caseIndex + 1}`, role: "case" });
      });
      const fallback = resolve(step.switch?.default);
      if (fallback) transitions.push({ from: id, to: fallback, label: "default", role: "default" });
      const caught = resolve(step.call?.onError?.next || step.awaitSignal?.onError?.next || step.parallel?.onError?.next || step.for_each?.onError?.next || step.callWorkflow?.onError?.next);
      if (caught) transitions.push({ from: id, to: caught, label: "error", role: "error" });
      if (kind === "parallel") {
        (step.parallel?.branches || []).forEach((branch) => {
          if (!branch.id) return;
          projectSteps(branch.steps || [], { source: id, role: "parallel", label: branch.id });
        });
      }
      if (kind === "for_each") projectSteps(step.for_each?.steps || [], { source: id, role: "loop", label: "loop" });
    });
  };
  projectSteps(steps || [], { source: START_ID, role: "entry", label: "" });
  return { steps: projected, transitions };
}

export function calculateWorkflowLayout(steps, transitions) {
  const positions = new Map();
  if (!steps.length) return positions;
  const children = new Map(steps.map((step) => [step.id, []]));
  transitions.forEach((transition) => {
    const list = children.get(transition.from);
    if (!list || !children.has(transition.to) || list.includes(transition.to)) return;
    list.push(transition.to);
  });
  const order = new Map(steps.map((step, index) => [step.id, index]));
  const edgeKey = (from, to) => `${from}\0${to}`;
  const backEdges = new Set();
  const visiting = new Set();
  const visited = new Set();
  const findBackEdges = (id) => {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) || []) {
      if (visiting.has(child)) backEdges.add(edgeKey(id, child));
      else findBackEdges(child);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) findBackEdges(step.id);

  const indegree = new Map(steps.map((step) => [step.id, 0]));
  for (const [from, targets] of children) {
    for (const to of targets) {
      if (!backEdges.has(edgeKey(from, to))) indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }
  const ready = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  const level = new Map([[START_ID, 0]]);
  while (ready.length) {
    const id = ready.shift();
    const depth = level.get(id);
    for (const child of children.get(id) || []) {
      if (backEdges.has(edgeKey(id, child))) continue;
      if (depth !== undefined) level.set(child, Math.max(level.get(child) ?? 0, depth + 1));
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
      }
    }
  }
  const height = (id, trail) => {
    if (trail.has(id)) return STEP_HEIGHT;
    const next = children.get(id) || [];
    if (!next.length) return STEP_HEIGHT;
    trail.add(id);
    const total = next.reduce((sum, child) => sum + height(child, trail), 0);
    trail.delete(id);
    return Math.max(STEP_HEIGHT, total + (next.length - 1) * VERTICAL_SPACING);
  };
  const place = (id, y, trail) => {
    if (positions.has(id) || trail.has(id)) return;
    trail.add(id);
    const depth = level.get(id) ?? 0;
    const next = (children.get(id) || []).filter((child) => level.has(child));
    if (!next.length) {
      positions.set(id, { x: depth * LEVEL_SPACING, y });
      trail.delete(id);
      return;
    }
    let cursor = y;
    const childTops = [];
    for (const child of next) {
      childTops.push({ id: child, y: cursor });
      cursor += height(child, new Set(trail)) + VERTICAL_SPACING;
    }
    const first = childTops[0].y;
    const last = childTops[childTops.length - 1];
    const lastBottom = last.y + height(last.id, new Set(trail));
    positions.set(id, { x: depth * LEVEL_SPACING, y: first + (lastBottom - first - STEP_HEIGHT) / 2 });
    for (const child of childTops) place(child.id, child.y, trail);
    trail.delete(id);
  };
  if (steps.some((step) => step.id === START_ID)) place(START_ID, 0, new Set());
  let overflow = 0;
  for (const step of steps) {
    if (positions.has(step.id)) continue;
    positions.set(step.id, { x: LEVEL_SPACING, y: overflow });
    overflow += STEP_HEIGHT + VERTICAL_SPACING;
  }
  return positions;
}

/** Reflow measured nodes within their existing columns, keeping their full footprints apart. */
export function calculateColumnNodePositions(columns, spacing = 16) {
  const measured = columns.map((column) => [...column].sort((left, right) => left.top - right.top));
  const heights = measured.map((column) => column.reduce((sum, node) => sum + node.topInset + node.bottomExtent, 0) + Math.max(0, column.length - 1) * spacing);
  const maxHeight = Math.max(0, ...heights);
  const positions = new Map();
  measured.forEach((column, columnIndex) => {
    let cursor = (maxHeight - heights[columnIndex]) / 2;
    for (const node of column) {
      positions.set(node.id, cursor + node.topInset);
      cursor += node.topInset + node.bottomExtent + spacing;
    }
  });
  return positions;
}

/** Keep the preview's right-to-left Bezier geometry aligned with the Web edge renderer. */
export function bezierPath(sx, sy, tx, ty) {
  const controlOffset = (distance) => distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance);
  const scx = sx + controlOffset(tx - sx);
  const tcx = tx - controlOffset(tx - sx);
  return {
    d: `M${sx},${sy} C${scx},${sy} ${tcx},${ty} ${tx},${ty}`,
    labelX: 0.125 * sx + 0.375 * scx + 0.375 * tcx + 0.125 * tx,
    labelY: 0.125 * sy + 0.375 * sy + 0.375 * ty + 0.125 * ty,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function loadAssets() {
  const iconsDir = join(root, "node_modules/@mui/icons-material");
  const icons = Object.fromEntries(Object.entries(ICONS).map(([key, name]) => {
    const source = readFileSync(join(iconsDir, `${name}.js`), "utf8");
    const paths = [...source.matchAll(/\bd: "([^"]+)"/g)].map((match) => match[1]);
    if (!paths.length) throw new Error(`No path data found in @mui/icons-material/${name}`);
    return [key, paths];
  }));
  return { icons };
}

function icon(paths, size) {
  return `<svg class="icon" viewBox="0 0 24 24" style="width:${size}px;height:${size}px">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
}

function curvedLabel(label) {
  const letters = label.split("");
  const radius = 50;
  const letterSpacing = 12;
  const totalAngularWidth = (((letters.length - 1) * letterSpacing) / radius) * (180 / Math.PI);
  const startAngle = -90 - totalAngularWidth / 2;
  const spans = letters.map((letter, index) => {
    const angle = (startAngle + ((index * letterSpacing) / radius) * (180 / Math.PI)) * (Math.PI / 180);
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    return `<span class="letter" style="transform:translate(${x - 4}px, ${y - 8}px) rotate(${angle + Math.PI / 2}rad)">${escapeHtml(letter)}</span>`;
  });
  return `<div class="ring">${spans.join("")}</div>`;
}

function edgeStyle(role) {
  if (role === "loop") return { stroke: "#2e7d32", dash: "", label: "#2e7d32" };
  if (role === "after") return { stroke: "#ed6c02", dash: "", label: "#ed6c02" };
  if (role === "case" || role === "default") return { stroke: "#ed6c02", dash: "", label: "rgba(0, 0, 0, 0.87)" };
  if (role === "error") return { stroke: "#d32f2f", dash: "", label: "#d32f2f" };
  if (role === "parallel") return { stroke: "#b1b1b7", dash: "5,5", label: "rgba(0, 0, 0, 0.87)" };
  return { stroke: "#b1b1b7", dash: "", label: "rgba(0, 0, 0, 0.87)" };
}

function renderStep(step, position, icons) {
  const terminal = step.kind === "return" || step.kind === "fail" || step.kind === "end" || step.kind === "start";
  const body = step.kind === "start" ? "Start" : step.kind === "return" ? "Return" : step.kind === "fail" ? "Raise error" : step.kind === "end" ? "End" : icons[step.kind] ? icon(icons[step.kind], 35) : escapeHtml(step.label);
  const ring = terminal || step.kind === "invalid" ? "" : curvedLabel(LABELS[step.kind] || step.label);
  const captionText = step.kind === "start" ? "" : step.authoredLabel || step.label;
  const caption = captionText ? `<div class="caption">${escapeHtml(captionText)}</div>` : "";
  const compact = step.kind === "return" || step.kind === "end";
  return `<div class="node" data-id="${escapeHtml(step.id)}" style="left:${position.x}px;top:${position.y}px"><div class="circle${compact ? " compact" : ""}">${body}${ring}</div>${caption}</div>`;
}

export function renderWorkflowHtml(document, assets) {
  const projected = projectBlock(document.definition?.steps || []);
  const positions = calculateWorkflowLayout(projected.steps, projected.transitions);
  const paths = projected.transitions.map((transition, index) => {
    const style = edgeStyle(transition.role);
    return `<path data-edge="${index}" data-from="${escapeHtml(transition.from)}" data-to="${escapeHtml(transition.to)}" style="stroke:${style.stroke}${style.dash ? `;stroke-dasharray:${style.dash}` : ""}"/>`;
  }).join("");
  const labels = projected.transitions.map((transition, index) => {
    if (!transition.label) return "";
    return `<g class="edge-label" data-edge="${index}"><rect x="-2" y="-4" rx="2" ry="2" style="fill:#fff;fill-opacity:0.8"/><text dy="0.3em" style="fill:${edgeStyle(transition.role).label};font-size:12px;font-weight:600">${escapeHtml(transition.label)}</text></g>`;
  }).join("");
  const cards = projected.steps.filter((step) => positions.has(step.id)).map((step) => renderStep(step, positions.get(step.id), assets.icons)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(document.displayName || "Workflow")}</title><link rel="stylesheet" href="${MANROPE}"><style>
    html { box-sizing: border-box; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; background: #F5F5F5; font-family: Manrope, sans-serif; }
    #canvas { position: absolute; left: 0; top: 0; }
    .edges { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
    .edges path { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .node { position: absolute; display: flex; flex-direction: column; align-items: center; }
    .circle { position: relative; display: flex; align-items: center; justify-content: center; min-width: 80px; min-height: 80px; padding: 12px 20px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.12); background: #fff; color: rgba(0, 0, 0, 0.87); font-size: 14px; font-weight: normal; }
    .circle.compact { width: 80px; height: 80px; padding: 0; }
    .icon { display: inline-block; flex-shrink: 0; fill: currentColor; }
    .ring { position: absolute; top: 50%; left: 50%; width: 100px; height: 100px; transform: translate(-50%, -50%); pointer-events: none; }
    .letter { position: absolute; left: 50%; top: 50%; width: 8px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 500; color: rgba(0, 0, 0, 0.6); text-align: center; }
    .caption { width: 140px; text-align: center; overflow-wrap: anywhere; color: rgba(0, 0, 0, 0.6); font-size: 11px; font-weight: 600; line-height: 1.66; letter-spacing: 0.03333em; }
  </style></head><body><div id="canvas"><svg class="edges">${paths}${labels}</svg>${cards}</div><script>
    const bezierPath = ${bezierPath.toString()};
    const calculateColumnNodePositions = ${calculateColumnNodePositions.toString()};
    function layoutPreview() {
      const canvas = document.getElementById("canvas");
      const origin = canvas.getBoundingClientRect();
      const columns = new Map();
      document.querySelectorAll(".node").forEach((node) => {
        const circle = node.querySelector(".circle").getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        const ring = node.querySelector(".ring")?.getBoundingClientRect();
        const letters = [...node.querySelectorAll(".ring .letter")].map((letter) => letter.getBoundingClientRect());
        const top = Math.min(bounds.top, ring?.top ?? bounds.top, ...letters.map((letter) => letter.top));
        const bottom = Math.max(bounds.bottom, ring?.bottom ?? bounds.bottom, ...letters.map((letter) => letter.bottom));
        const column = node.style.left;
        if (!columns.has(column)) columns.set(column, []);
        columns.get(column).push({ id: node.dataset.id, top: Number.parseFloat(node.style.top), topInset: circle.top - top, bottomExtent: bottom - circle.top });
      });
      const nodePositions = calculateColumnNodePositions([...columns.values()]);
      document.querySelectorAll(".node").forEach((node) => {
        node.style.top = nodePositions.get(node.dataset.id) + "px";
      });
      const circles = new Map([...document.querySelectorAll(".node")].map((node) => {
        const rect = node.querySelector(".circle").getBoundingClientRect();
        return [node.dataset.id, { left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, y: rect.top - origin.top + rect.height / 2 }];
      }));
      document.querySelectorAll(".edges path").forEach((path) => {
        const from = circles.get(path.dataset.from);
        const to = circles.get(path.dataset.to);
        const curve = bezierPath(from.right, from.y, to.left, to.y);
        path.setAttribute("d", curve.d);
        const label = document.querySelector(\`.edge-label[data-edge="\${path.dataset.edge}"]\`);
        if (!label) return;
        const text = label.querySelector("text");
        const background = label.querySelector("rect");
        const textBounds = text.getBBox();
        label.setAttribute("transform", \`translate(\${curve.labelX - textBounds.width / 2} \${curve.labelY - textBounds.height / 2})\`);
        text.setAttribute("y", textBounds.height / 2);
        background.setAttribute("width", textBounds.width + 4);
        background.setAttribute("height", textBounds.height + 8);
      });
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      document.querySelectorAll(".node, .edges path, .edge-label").forEach((element) => {
        const rect = element.getBoundingClientRect();
        bounds.minX = Math.min(bounds.minX, rect.left - origin.left);
        bounds.minY = Math.min(bounds.minY, rect.top - origin.top);
        bounds.maxX = Math.max(bounds.maxX, rect.right - origin.left);
        bounds.maxY = Math.max(bounds.maxY, rect.bottom - origin.top);
      });
      canvas.style.transform = \`translate(\${${CANVAS_PADDING} - bounds.minX}px, \${${CANVAS_PADDING} - bounds.minY}px)\`;
      document.documentElement.dataset.width = Math.ceil(bounds.maxX - bounds.minX + ${2 * CANVAS_PADDING});
      document.documentElement.dataset.height = Math.ceil(bounds.maxY - bounds.minY + ${2 * CANVAS_PADDING});
    }
    document.fonts.ready.then(layoutPreview);
  </script></body></html>`;
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require(join(root, "node_modules/playwright"));
  } catch {
    throw new Error("Playwright is not installed. From the skill root, run npm install and npx playwright install chromium.");
  }
}

async function renderFiles(files) {
  const playwright = loadPlaywright();
  const assets = loadAssets();
  const browser = await playwright.chromium.launch({ headless: true });
  const outDir = join(root, "previews");
  mkdirSync(outDir, { recursive: true });
  const written = [];
  try {
    const page = await browser.newPage();
    for (const file of files) {
      const document = JSON.parse(readFileSync(file, "utf8"));
      const htmlPath = join(outDir, `${basename(file, ".json")}.html`);
      const pngPath = join(outDir, `${basename(file, ".json")}.png`);
      writeFileSync(htmlPath, renderWorkflowHtml(document, assets));
      await page.goto(pathToFileURL(htmlPath).href);
      await page.waitForFunction(() => document.documentElement.dataset.height !== undefined);
      const size = await page.evaluate(() => ({ width: Number(document.documentElement.dataset.width), height: Number(document.documentElement.dataset.height) }));
      await page.setViewportSize(size);
      await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, ...size } });
      written.push(pngPath);
    }
  } finally {
    await browser.close();
  }
  return written;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const written = await renderFiles(workflowFiles(process.argv.slice(2)));
  written.forEach((file) => console.log(file));
}
