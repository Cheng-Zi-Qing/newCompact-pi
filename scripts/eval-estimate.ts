#!/usr/bin/env bun
// Read-only replay. Usage: bun scripts/eval-estimate.ts [session.jsonl | directory ...]
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildSessionProjection, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateProjectedTokens } from "../src/estimate.ts";
import { calibratedTokens } from "../src/calibration.ts";
import { compactionLine, contextDiagnostics, reportedInput } from "../src/usage.ts";

const methods = ["P", "A", "AB"] as const;
type Method = typeof methods[number];
type LineScores = { falsePositive: number; falseNegative: number };
type Scores = { errors: number[]; knownWindow: number; lines: Record<"0.8" | "0.95", LineScores> };
function empty(): Record<Method, Scores> {
  const scores = (): Scores => ({ errors: [], knownWindow: 0,
    lines: { "0.8": { falsePositive: 0, falseNegative: 0 }, "0.95": { falsePositive: 0, falseNegative: 0 } } });
  return { P: scores(), A: scores(), AB: scores() };
}
const piRatio = { cjk: 0.25, other: 0.25, observations: 0, ready: false };
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
function summarize(scores: Record<Method, Scores>) {
  return Object.fromEntries(methods.map(method => {
    const row = scores[method], errors = row.errors.toSorted((a, b) => a - b);
    return [method, { n: errors.length, medianAbsPct: quantile(errors, 0.5), p90AbsPct: quantile(errors, 0.9),
      p95AbsPct: quantile(errors, 0.95), maxAbsPct: errors.at(-1) ?? null,
      wrongSide: row.knownWindow ? row.lines["0.8"].falseNegative + row.lines["0.8"].falsePositive : null,
      falsePositive: row.knownWindow ? row.lines["0.8"].falsePositive : null,
      falseNegative: row.knownWindow ? row.lines["0.8"].falseNegative : null,
      oldLine: row.knownWindow ? row.lines["0.95"] : null, knownWindow: row.knownWindow,
      unknownWindow: errors.length - row.knownWindow }];
  }));
}
function record(scores: Record<Method, Scores>, predictions: Record<Method, number>, actual: number, window?: number) {
  for (const method of methods) {
    const row = scores[method], predicted = predictions[method];
    row.errors.push(Math.abs(predicted - actual) / actual * 100);
    if (window !== undefined) {
      row.knownWindow++;
      for (const ratio of ["0.8", "0.95"] as const) {
        const line = compactionLine(window, 16384, Number(ratio));
        if (actual >= line && predicted < line) row.lines[ratio].falseNegative++;
        if (actual < line && predicted >= line) row.lines[ratio].falsePositive++;
      }
    }
  }
}
export async function sessionFiles(paths: string[], now = Date.now()): Promise<string[]> {
  const explicit = paths.length > 0;
  const files: string[] = [];
  async function visit(path: string) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isSymbolicLink() && (entry.isDirectory() || entry.name.endsWith(".jsonl"))) await visit(join(path, entry.name));
      }
    } else if (path.endsWith(".jsonl") && (explicit || info.mtimeMs >= now - 30 * 86400_000)) files.push(resolve(path));
  }
  for (const path of explicit ? paths : [join(homedir(), ".pi/agent/sessions")]) await visit(path);
  return [...new Set(files)].sort();
}
export async function loadModelWindows(file = join(homedir(), ".pi/agent/models.json")) {
  const windows = new Map<string, number>();
  const add = (provider: unknown, id: unknown, window: unknown) => {
    if (typeof provider === "string" && typeof id === "string" && Number.isSafeInteger(window) && (window as number) > 0) windows.set(`${provider}/${id}`, window as number);
  };
  // Built-in catalog only: no ModelRuntime/auth store, provider refresh, or network requests.
  const { getBuiltinProviders, getBuiltinModels } = await import(import.meta.resolve("@earendil-works/pi-ai/providers/all", join(getPackageDir(), "dist/index.js")));
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) add(model.provider, model.id, model.contextWindow);
  }
  const { stripJsonComments } = await import(join(getPackageDir(), "dist/utils/json.js"));
  const { stripBom } = await import(join(getPackageDir(), "dist/utils/text.js"));
  let config: any;
  try { config = JSON.parse(stripJsonComments(stripBom(await readFile(file, "utf8")))); }
  catch (error: any) { if (error.code === "ENOENT") return windows; throw new Error("Unable to parse model window metadata"); }
  // Never access, return, log or copy any other configuration field (including credentials).
  for (const [provider, value] of Object.entries(config.providers ?? {}) as Array<[string, any]>) {
    for (const model of value.models ?? []) add(provider, model.id, model.contextWindow ?? 128000);
    for (const [id, model] of Object.entries(value.modelOverrides ?? {}) as Array<[string, any]>) add(provider, id, model.contextWindow);
  }
  return windows;
}
// Recorded metadata takes priority over today's configured/built-in windows; unknown names are not guessed.
function recordedWindow(branch: any[], message: any): number | undefined {
  const valid = (value: any) => Number.isSafeInteger(value) && value > 0;
  if (valid(message.contextWindow)) return message.contextWindow;
  const match = (model: any) => model && valid(model.contextWindow) &&
    model.provider === message.provider && (model.modelId ?? model.model ?? model.id) === message.model;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "model_change" && match(e)) return e.contextWindow;
    if (e.type === "custom" && e.customType === "model-route-state") {
      for (const policy of Object.values(e.data?.policy ?? {})) {
        if (match(policy)) return (policy as any).contextWindow;
        if (match((policy as any)?.model)) return (policy as any).model.contextWindow;
      }
    }
  }
}
export async function evaluateFiles(files: string[], progress = (_line: string) => {}, windows: ReadonlyMap<string, number> = new Map()) {
  const start = performance.now();
  const groups = new Map<string, Record<Method, Scores>>();
  const group = (name: string) => { if (!groups.has(name)) groups.set(name, empty()); return groups.get(name)!; };
  for (const name of ["overall", "with_edits_after_anchor", "without_edits_after_anchor", "sessions_with_edits", "sessions_without_edits", "unknown_window"]) group(name);
  const models = new Map<string, { overall: Record<Method, Scores>; withEdits: Record<Method, Scores>; withoutEdits: Record<Method, Scores> }>();
  const counts = { files: files.length, bytes: 0, validUsage: 0, scored: 0, calibrated: 0, skippedAfterCompaction: 0,
    noAnchor: 0, skippedInvalidBranch: 0, invalidLines: 0, invalidFiles: 0 };
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const entries: any[] = [];
    const lines = createInterface({ input: createReadStream(files[fileIndex]), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { counts.invalidLines++; }
    }
    counts.bytes += (await stat(files[fileIndex])).size;
    if (entries[0]?.type !== "session") { counts.invalidFiles++; continue; }
    const manager = SessionManager.inMemory(entries[0].cwd ?? "/tmp", undefined, entries);
    const normalized = manager.getEntries();
    const positions = new Map(normalized.map((entry: any, index: number) => [entry.id, index]));
    const sessionHasEdits = normalized.some((entry: any) => entry.type === "context_edit");
    for (let index = 0; index < normalized.length; index++) {
      const entry: any = normalized[index];
      if (entry.type !== "message") continue;
      const actual = reportedInput(entry.message);
      if (actual === undefined) continue;
      counts.validUsage++;
      if (entry.parentId === undefined || (entry.parentId !== null && !manager.getEntry(entry.parentId))) { counts.skippedInvalidBranch++; continue; }
      const branch = entry.parentId === null ? [] : manager.getBranch(entry.parentId);
      if (branch.some((e: any) => (positions.get(e.id) ?? Infinity) >= index)) { counts.skippedInvalidBranch++; continue; }
      const projection = buildSessionProjection(branch);
      // All predictor inputs end at parentId: this response's usage/content never participates in its prediction or fit.
      const details = contextDiagnostics(branch, projection);
      if (!details.anchor) {
        if (branch.some((e: any) => e.type === "compaction")) { counts.skippedAfterCompaction++; continue; }
        counts.noAnchor++; // Initial requests are still scored: A and AB fall back to P, without future usage.
      }
      counts.scored++;
      if (details.applied) counts.calibrated++;
      const predictions = { P: estimateProjectedTokens(projection, branch, m => calibratedTokens(m, piRatio)),
        A: details.uncalibrated, AB: details.calibrated };
      const edits = details.anchor !== undefined && branch.slice(details.anchor.index + 1).some((e: any) => e.type === "context_edit");
      const key = `${entry.message.provider ?? "unknown"}/${entry.message.model ?? "unknown"}`;
      const window = recordedWindow(branch, entry.message) ?? windows.get(key);
      if (window === undefined) record(group("unknown_window"), predictions, actual);
      record(group("overall"), predictions, actual, window);
      record(group(edits ? "with_edits_after_anchor" : "without_edits_after_anchor"), predictions, actual, window);
      record(group(sessionHasEdits ? "sessions_with_edits" : "sessions_without_edits"), predictions, actual, window);
      if (!models.has(key)) models.set(key, { overall: empty(), withEdits: empty(), withoutEdits: empty() });
      const model = models.get(key)!;
      record(model.overall, predictions, actual, window);
      record(edits ? model.withEdits : model.withoutEdits, predictions, actual, window);
      if (counts.scored % 100 === 0) progress(`progress: file ${fileIndex + 1}/${files.length}, scored=${counts.scored}, bytes=${counts.bytes}`);
    }
    progress(`progress: files ${fileIndex + 1}/${files.length}, scored=${counts.scored}, bytes=${counts.bytes}`);
  }
  return { counts, elapsedSeconds: (performance.now() - start) / 1000,
    windowPolicy: "recorded metadata, then current models.json/built-in catalog; reserve=16384; ratios=0.8 and 0.95 (old line); comparisons use >=; unknown windows have a separate bucket",
    groups: Object.fromEntries([...groups].map(([name, scores]) => [name, summarize(scores)])),
    models: Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b)).map(([name, scores]) =>
      [name, { overall: summarize(scores.overall), withEdits: summarize(scores.withEdits), withoutEdits: summarize(scores.withoutEdits) }])) };
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const files = await sessionFiles(process.argv.slice(2));
  const windows = await loadModelWindows();
  console.log(JSON.stringify(await evaluateFiles(files, line => console.error(line), windows), null, 2));
}
