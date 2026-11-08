/* eslint-disable @typescript-eslint/no-explicit-any */
/** Source-only VM regression. Never import a product module, boot a dashboard,
 *  load env files, inspect homes/DBs, or install a network/process fixture.
 * Run: node --import tsx src/scripts/regression/_read-missing-return-ui-child.ts
 * Mutation lives in VM source strings only; product/helper files are never written.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const virtual = source("../../../packages/dashboard/js/virtualization.js");
const history = source("../../../packages/dashboard/js/history-render.js");
const drawer = source("../../../packages/dashboard/js/background-drawer.js");
const mini = source("./_mini-dom.ts");
const ko = JSON.parse(source("../../../locales/ko.json"));
const missingText = ko["stream.read.missing"];
assert.equal(typeof missingText, "string");

// Parse declarations, never evaluate the enclosing product script or its imports.
const declaration = (text: string, name: string): string => {
  const file = ts.createSourceFile("product.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      matches.push("const " + node.getText(file) + ";");
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, "unique source declaration: " + name);
  return matches[0]!;
};
const miniBoundary = mini.indexOf("export const DASH_JS =");
assert.ok(miniBoundary > 0);
const miniOnly = mini.slice(0, miniBoundary).replace(/^import .*;\r?\n/gm, "");
assert.ok(!/\bimport\b|\brequire\s*\(/.test(miniOnly.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
const miniCtx: any = vm.createContext({ exports: {}, queueMicrotask, URLSearchParams });
vm.runInContext(ts.transpileModule(miniOnly, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, miniCtx, { timeout: 1000, filename: "mini-dom-only.vm.js" });

const names = {
  virtual: ["buildOutputBlock", "buildReadBlock", "wireReadToggle", "buildToolOutputBlock", "buildActivityLine"],
  history: ["buildHistStepLine"],
  drawer: ["applyDurationBadge", "markStepRunning", "clearStepRunning", "annotateToolDuration", "toggleWorkerStepRich", "ensureStepExpandable", "handleWorkerActivity"],
};
const original = [...names.virtual.map(n => declaration(virtual, n)), ...names.history.map(n => declaration(history, n)), ...names.drawer.map(n => declaration(drawer, n))].join("\n");
const boot = (productSource = original): any => {
  const dom = miniCtx.exports.makeDomContext();
  const context = vm.createContext(dom.ctx);
  // All dependencies are synthetic. No process, require, fetch, sockets, fs, or
  // module loader is exposed to the product function VM.
  const code = `
    const i18n = (key, params = {}) => { let s = catalog[key] || key; for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v)); return s; };
    const activityByStep = new Map(), jobCards = new Map();
    const stepKey = (tk, seq) => tk + ':' + seq;
    const stream = document.createElement('div'); document.body.appendChild(stream);
    const skillStepInfo = () => null, buildFileRefActions = () => null, isSpawnStep = () => false;
    const buildDiffBlock = () => { throw Error('unexpected diff dependency'); };
    const buildDetailBlock = () => { throw Error('unexpected detail dependency'); };
    const onToggleClick = (el, fn) => el.addEventListener('click', fn);
    const fmtDur = String, fmtElapsed = String, fmtAgo = String;
    const BG_STATUS = { running: 'running' }, doingText = () => 'Read';
    const setJobModel = () => {}, updateChev = () => {}, scheduleAgentsRender = () => {}, scheduleProjectAgentsRender = () => {};
    const ensureJobCard = id => { if (!jobCards.has(id)) { const stepsEl = document.createElement('div'); document.body.appendChild(stepsEl); jobCards.set(id, { stepsEl, seenSteps: new Set(), status: 'running' }); } return jobCards.get(id); };
    const appendJobStep = (entry, line) => entry.stepsEl.appendChild(line);
    ${productSource}
    globalThis.api = { buildReadBlock, buildActivityLine, buildHistStepLine, annotateToolDuration,
      handleWorkerActivity, toggleWorkerStepRich, ensureStepExpandable, wireReadToggle,
      activityByStep, jobCards, stepKey, stream };
  `;
  dom.ctx.catalog = ko;
  vm.runInContext(code, context, { timeout: 1000, filename: "actual-product-functions.vm.js" });
  return { ...dom, ...dom.ctx.api, dispatch: miniCtx.exports.dispatch, makeEvent: miniCtx.exports.makeEvent };
};
const checks: { name: string; ok: boolean; error?: string }[] = [];
const check = async (name: string, fn: () => any): Promise<void> => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (e) { checks.push({ name, ok: false, error: String(e) }); }
};
const payload = (threadKey = "main", seq = 1): any => ({ threadKey, seq, kind: "tool", label: "Read", file: { path: "/synthetic/source.txt" } });
const output = { text: "LATE_RETURN", read: { kind: "text", startLine: 7, returnedLineCount: 1 } };
const isMissing = (el: any): void => {
  assert.ok(el.textContent.includes(missingText), "must show actual localized missing-return explanation");
  assert.equal(el.querySelectorAll(".act-read-num").length, 0, "no invented line numbers");
  assert.ok(!el.textContent.includes(ko["stream.read.snapshot"]), "missing is not an observed snapshot");
};
const seedMain = (h: any): any => { const p = payload(); h.activityByStep.set(h.stepKey(p.threadKey, p.seq), p); const line = h.buildActivityLine(p); h.stream.appendChild(line); return line; };
const seedWorker = (h: any, prefix = "worker"): any => {
  const p = { ...payload(prefix + ":qa"), ts: 1 };
  h.activityByStep.set(h.stepKey(p.threadKey, p.seq), p);
  assert.equal(h.handleWorkerActivity(p, "synthetic"), true);
  return h.jobCards.get("qa").stepsEl.querySelector(".bg-step");
};

await check("direct missing fallback (localized, not a fabricated snapshot)", () => isMissing(boot().buildReadBlock(undefined)));
await check("main pending has no fabricated missing record even on click", () => {
  const h = boot(), line = seedMain(h); line.click();
  assert.equal(line.querySelector(".act-output"), null);
  assert.ok(!line.textContent.includes(missingText));
});
await check("main completion without duration creates fallback and marks stored complete", () => {
  const h = boot(), line = seedMain(h); h.annotateToolDuration(payload());
  isMissing(line); assert.equal(h.activityByStep.get("main:1")._readComplete, true);
  assert.equal(line.querySelectorAll(".act-output").length, 1);
});
await check("completed main reconstruction uses _readComplete without duration", () => isMissing(boot().buildActivityLine({ ...payload(), _readComplete: true })));
await check("history missing always explains absence", () => isMissing(boot().buildHistStepLine(payload())));
await check("main delayed actual output replaces fallback, preserves one block", () => {
  const h = boot(), line = seedMain(h); h.annotateToolDuration(payload());
  h.annotateToolDuration({ ...payload(), output });
  assert.ok(line.textContent.includes("LATE_RETURN")); assert.ok(!line.textContent.includes(missingText));
  assert.equal(line.querySelectorAll(".act-output").length, 1);
  assert.equal(line.querySelector(".act-read-num").textContent, "7");
});
for (const prefix of ["worker", "agent"]) {
  await check(prefix + " pending has no missing body or expandable affordance", () => {
    const h = boot(), line = seedWorker(h, prefix); line.click();
    assert.equal(line.querySelector(".act-output"), null); assert.ok(!line._expandable);
  });
  await check(prefix + " completion-only without duration enables lazy fallback", () => {
    const h = boot(), line = seedWorker(h, prefix); h.annotateToolDuration(payload(prefix + ":qa"));
    assert.equal(line._readComplete, true); assert.equal(line._expandable, true);
    assert.equal(line.querySelector(".act-output"), null); line.click(); isMissing(line);
  });
  await check(prefix + " durationless end clears observed running marker", () => {
    const h = boot(), line = seedWorker(h, prefix); assert.ok(line.classList.contains("bg-step-running"));
    h.annotateToolDuration(payload(prefix + ":qa"));
    assert.ok(!line.classList.contains("bg-step-running"), "completed Read must stop running indicator");
    assert.equal(line.querySelector(".dur-badge.running"), null);
  });
  await check(prefix + " delayed output replaces already-open fallback", () => {
    const h = boot(), line = seedWorker(h, prefix); h.annotateToolDuration(payload(prefix + ":qa")); line.click();
    h.annotateToolDuration({ ...payload(prefix + ":qa"), output });
    assert.ok(line.textContent.includes("LATE_RETURN"), "open fallback must update without collapse/reopen");
    assert.ok(!line.textContent.includes(missingText)); assert.equal(line.querySelectorAll(".act-output").length, 1);
  });
}
await check("main Enter/Space keyboard toggle plus aria state", async () => {
  const h = boot(), line = seedMain(h); h.annotateToolDuration(payload());
  for (const key of ["Enter", " "]) {
    const before = line.classList.contains("expanded");
    h.dispatch(line, h.makeEvent("keydown", { key })); await Promise.resolve();
    assert.notEqual(line.classList.contains("expanded"), before);
    assert.equal(line.getAttribute("aria-expanded"), String(!before));
  }
});
await check("worker Enter/Space keyboard lazy toggle plus aria state", async () => {
  const h = boot(), line = seedWorker(h); h.annotateToolDuration(payload("worker:qa"));
  for (const key of ["Enter", " "]) {
    const before = line.classList.contains("expanded");
    h.dispatch(line, h.makeEvent("keydown", { key })); await Promise.resolve();
    assert.notEqual(line.classList.contains("expanded"), before);
    assert.equal(line.getAttribute("aria-expanded"), String(!before));
  }
});

// A real-source, memory-only guard removal, followed by fresh original-source boot.
// If baseline is already broken, do not mislabel mutation as a valid red/green proof.
let mutation: any;
try {
  isMissing(boot().buildReadBlock(undefined));
  const guard = "const missing = !output;";
  assert.ok(original.includes(guard), "mutation anchor must exist exactly in product source");
  const mutant = original.replace(guard, "const missing = false;");
  let red = false;
  try { isMissing(boot(mutant).buildReadBlock(undefined)); } catch { red = true; }
  assert.ok(red, "missing guard mutation must be caught");
  isMissing(boot(original).buildReadBlock(undefined));
  mutation = { baseline: "green", missingGuardRestoredInMemory: "red", restoreOriginal: "green", productWrites: 0 };
} catch (e) {
  mutation = { baselineOrProof: "failed", error: String(e), productWrites: 0 };
}
const ok = checks.every(c => c.ok) && mutation.restoreOriginal === "green";
console.log(JSON.stringify({ ok, scope: "actual source declarations + unchanged MiniDOM transpiled into VM only", productModuleImports: false, runtimeBoots: 0, envOrCredentialOrDbReads: 0, checks, mutation }, null, 2));
if (!ok) process.exitCode = 1;
