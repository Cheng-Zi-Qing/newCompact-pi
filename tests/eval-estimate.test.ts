import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { evaluateFiles, loadModelWindows, quantile } from "../scripts/eval-estimate.ts";
import { calibrationForBranch, contextDiagnostics, effectiveContextTokens } from "../src/usage.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "context-eval-"));
  const manager = SessionManager.inMemory(root);
  const modelChange: any = manager.getEntry(manager.appendModelChange("test", "calibrated"));
  modelChange.contextWindow = 128_000;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const assistant = (input: number) => manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "calibrated", stopReason: "stop", timestamp: 1,
    content: [{ type: "text", text: "done" }], usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost } } as any);
  manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  let input = 100;
  assistant(input);
  let edited: string | undefined;
  for (let i = 0; i < 8; i++) {
    const cjk = i % 2 === 0;
    const id = manager.appendMessage({ role: "user", content: (cjk ? "中" : "x").repeat(1000), timestamp: 1 });
    if (!edited && cjk) edited = id;
    input += cjk ? 1500 : 500;
    assistant(input);
  }
  manager.appendContextEdit(edited!, null);
  manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
  const before = manager.getBranch();
  input -= 1499;
  assistant(input);
  const file = join(root, "synthetic.jsonl");
  writeFileSync(file, [manager.getHeader(), ...manager.getBranch()].map(e => JSON.stringify(e)).join("\n") + "\n");
  return { file, before, manager };
}

test("eval is read-only, predicts only prior branches, reports calibrated gains/edits/model/window counts", async () => {
  const f = fixture(), bytes = readFileSync(f.file);
  const progress: string[] = [];
  const report: any = await evaluateFiles([f.file], line => progress.push(line));
  expect(readFileSync(f.file).equals(bytes)).toBe(true);
  expect(report.counts.scored).toBe(10);
  expect(report.counts.noAnchor).toBe(1);
  expect(report.counts.calibrated).toBe(5);
  expect(report.groups.overall.AB.medianAbsPct).toBeLessThan(report.groups.overall.A.medianAbsPct);
  expect(report.groups.with_edits_after_anchor.AB.n).toBe(1);
  expect(report.groups.with_edits_after_anchor.AB.maxAbsPct).toBe(0);
  expect(report.groups.overall.AB.knownWindow).toBe(10);
  expect(report.groups.overall.AB.wrongSide).toBe(0);
  expect(report.models["test/calibrated"].overall.AB.n).toBe(10);
  expect(progress.length).toBeGreaterThan(0);
  const details = contextDiagnostics(f.before);
  expect(details.calibration.observations).toBe(8); // The response being predicted contributes no ninth observation.
  expect(details.calibration.cjk).toBeCloseTo(1.5);
  expect(details.calibration.other).toBeCloseTo(0.5);
  expect(effectiveContextTokens(f.before)).toBe(details.calibrated);
  expect(effectiveContextTokens(f.before)).not.toBe(details.uncalibrated);
  expect(JSON.stringify(details)).not.toContain("中");
  expect(JSON.stringify(details)).not.toContain('"done"');
});
test("eval follows parent branches, skips post-compaction no-anchor requests, and counts malformed trailing lines", async () => {
  const f = fixture();
  const branch = f.manager.getBranch();
  const user = branch.find((e: any) => e.type === "message" && e.message.role === "user")!;
  f.manager.appendCompaction("synthetic summary", user.id, 100, {}, true);
  f.manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "calibrated", content: [], stopReason: "stop", timestamp: 2,
    usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 200 } } as any);
  writeFileSync(f.file, [f.manager.getHeader(), ...f.manager.getBranch()].map(e => JSON.stringify(e)).join("\n") + '\n{"incomplete"');
  const report: any = await evaluateFiles([f.file]);
  expect(report.counts.skippedAfterCompaction).toBe(1);
  expect(report.counts.invalidLines).toBe(1);
  expect(report.counts.scored).toBe(10);
});
test("eval counts both false positives and false negatives around a recorded compaction line", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-line-eval-"));
  const manager = SessionManager.inMemory(root);
  const change: any = manager.getEntry(manager.appendModelChange("test", "line")); change.contextWindow = 32_000;
  const assistant = (input: number) => manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "line", content: [], stopReason: "stop", timestamp: 1,
    usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } } as any);
  manager.appendMessage({ role: "user", content: "start", timestamp: 1 }); assistant(15_000);
  manager.appendMessage({ role: "user", content: "x".repeat(10_000), timestamp: 1 }); assistant(15_500);
  manager.appendMessage({ role: "user", content: "next", timestamp: 1 }); assistant(17_000);
  const file = join(root, "line.jsonl");
  writeFileSync(file, [manager.getHeader(), ...manager.getBranch()].map(e => JSON.stringify(e)).join("\n"));
  const report: any = await evaluateFiles([file]);
  for (const method of ["P", "A", "AB"]) {
    expect(report.groups.overall[method].wrongSide).toBe(2);
    expect(report.groups.overall[method].falsePositive).toBe(1);
    expect(report.groups.overall[method].falseNegative).toBe(1);
  }
});
test("model metadata extraction returns only provider/id/window and includes built-in windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-window-eval-"));
  const file = join(root, "models.json");
  writeFileSync(file, JSON.stringify({ providers: { "test-meta": { apiKey: "SYNTHETIC_SECRET_NEVER_RETURN", baseUrl: "SYNTHETIC_URL_NEVER_RETURN",
    models: [{ id: "a", contextWindow: 128_000, extra: "SYNTHETIC_EXTRA_NEVER_RETURN" }], modelOverrides: { b: { contextWindow: 200_000 } } } } }));
  const bytes = readFileSync(file);
  const windows = await loadModelWindows(file);
  writeFileSync(file, '\ufeff// synthetic JSONC\n' + bytes.toString("utf8").replace(/}$/, ',}'));
  expect([...await loadModelWindows(file)]).toEqual([...windows]);
  writeFileSync(file, bytes);
  expect(windows.get("test-meta/a")).toBe(128_000);
  expect(windows.get("test-meta/b")).toBe(200_000);
  expect(windows.size).toBeGreaterThan(2);
  expect(JSON.stringify([...windows])).not.toContain("NEVER_RETURN");
  expect(readFileSync(file).equals(bytes)).toBe(true);
});
test("eval uses inclusive >= comparisons and separates unknown-window requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-inclusive-eval-"));
  const manager = SessionManager.inMemory(root);
  const assistant = (input: number) => manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "inclusive", content: [], stopReason: "stop", timestamp: 1,
    usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } } as any);
  manager.appendMessage({ role: "user", content: "start", timestamp: 1 }); assistant(80_000);
  manager.appendMessage({ role: "user", content: "", timestamp: 1 }); assistant(79_999);
  manager.appendMessage({ role: "user", content: "", timestamp: 1 }); assistant(80_000);
  const file = join(root, "inclusive.jsonl");
  writeFileSync(file, [manager.getHeader(), ...manager.getBranch()].map(e => JSON.stringify(e)).join("\n"));
  const report: any = await evaluateFiles([file], () => {}, new Map([["test/inclusive", 100_000]]));
  for (const method of ["P", "A", "AB"]) {
    expect(report.groups.overall[method].falsePositive).toBe(1);
    expect(report.groups.overall[method].falseNegative).toBe(2);
    expect(report.groups.overall[method].oldLine).toEqual({ falsePositive: 0, falseNegative: 0 });
  }
  const unknown: any = await evaluateFiles([file]);
  expect(unknown.groups.unknown_window.A.n).toBe(3);
  expect(unknown.groups.unknown_window.A.falseNegative).toBeNull();
});
test("calibration is deterministic and isolated across model/session prefixes; quantiles handle empty groups", () => {
  const a = fixture(), b = fixture();
  expect(calibrationForBranch(a.before)).toEqual(calibrationForBranch(b.before));
  const shorter = a.before.slice(0, 4);
  expect(calibrationForBranch(shorter).ready).toBe(false);
  expect(calibrationForBranch(a.before).ready).toBe(true);
  expect(calibrationForBranch(a.before, "other/model").observations).toBe(0);
  a.manager.appendModelChange("other", "model");
  const switched = contextDiagnostics(a.manager.getBranch());
  expect(switched.model).toBe("other/model");
  expect(switched.applied).toBe(false);
  expect(switched.calibrated).toBe(switched.uncalibrated);
  expect(quantile([], 0.9)).toBeNull();
  expect(quantile([0, 10], 0.5)).toBe(5);
});
