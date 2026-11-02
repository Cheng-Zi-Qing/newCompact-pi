import { beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionProjection, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import compact, { ABORT_ENTRY, usageDelay } from "../extensions/compact.ts";
import pruner, { replay } from "../extensions/tool-result-pruner.ts";
import { effectiveContextTokens, usageInputs } from "../src/usage.ts";
import { estimateProjectedTokens } from "../src/estimate.ts";
import { prepareBoundaryCompaction } from "../src/boundary.ts";
import { committed, decide, resetStates, stateOf } from "../src/guard.ts";
import { SECTIONS } from "../src/summary.ts";

beforeEach(resetStates);
const root = mkdtempSync(join(tmpdir(), "compact-boundary-"));
const snapshot = SECTIONS.map(s => `## ${s}\nok`).join("\n\n");
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const assistant = (total: number, content: any[] = [{ type: "text", text: "done" }]) => ({ role: "assistant", content, api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
  usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost } });
function fixture(total = 965_689, toolSize = 60_000, sub = false, config: any = {}) {
  const manager = SessionManager.inMemory(root);
  if (sub) manager.appendCustomEntry("model-route-state", { contextRole: "coder" });
  manager.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
  manager.appendMessage(assistant(100, [{ type: "toolCall", id: "old", name: "bash", arguments: { command: "example" } }]) as any);
  const tool = manager.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "x".repeat(toolSize) }], isError: false, timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Recent ".repeat(1_000), timestamp: 1 });
  manager.appendMessage(assistant(total) as any);
  const handlers: Record<string, Function[]> = {};
  const complete = mock(async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }));
  const pi: any = { on: (name: string, handler: Function) => (handlers[name] ??= []).push(handler), registerTool() {}, registerCommand() {},
    getSettings: () => ({ compaction: { keepRecentTokens: 1000 }, ...config }), getActiveTools: () => ["read_tool_result"],
    appendEntry: mock((type: string, data: any) => manager.appendCustomEntry(type, data)) };
  const ctx: any = { cwd: root, model: { id: "test", provider: "test", api: "openai-completions", contextWindow: 1_000_000, reasoning: true },
    sessionManager: manager, getContextUsage: () => ({ contextWindow: 1_000_000 }), signal: new AbortController().signal,
    modelRegistry: { streamSimple: () => ({ result: complete }) }, abort: mock(), isIdle: () => true,
    compact: mock(), ui: { notify: mock(), setStatus: mock() } };
  pruner(pi); compact(pi);
  async function boundary(outcome = "completed", initial: any[] = []) {
    let entries = initial;
    for (const handler of handlers.turn_end) {
      const preview = replay(ctx, entries);
      const result = await handler({ outcome, entries, context: { contextEntries: preview.buildSessionProjection().entries } }, ctx);
      if (result?.entries) entries = result.entries;
    }
    return entries;
  }
  return { manager, tool, pi, ctx, complete, boundary, handlers };
}
function logText() { return readFileSync(join(process.env.PI_COMPACT_DIR!, "pi-compact.log"), "utf8"); }

test("effective tokens retain the incident provider baseline after edits and add trailing messages", () => {
  const f = fixture();
  f.manager.appendContextEdit(f.tool, { content: [{ type: "text", text: "short" }] });
  f.manager.appendMessage({ role: "user", content: "new user ".repeat(1000), timestamp: 2 });
  const branch = f.manager.getBranch();
  const raw: any = branch.find(e => e.id === f.tool);
  const expected = 965_689 - (estimateTokens(raw.message) - estimateTokens({ ...raw.message, content: [{ type: "text", text: "short" }] }))
    + estimateTokens({ role: "user", content: "new user ".repeat(1000), timestamp: 2 } as any);
  expect(effectiveContextTokens(branch)).toBe(expected);
  expect(effectiveContextTokens(branch)).toBeGreaterThan(950_000);
  expect(estimateProjectedTokens(f.manager.buildSessionProjection(), branch)).toBeLessThan(20_000);
});
test("effective tokens count edited trailing messages once and use the baseline before repeated edits", () => {
  const f = fixture();
  const trailing = f.manager.appendMessage({ role: "toolResult", toolCallId: "next", toolName: "bash", content: [{ type: "text", text: "x".repeat(40_000) }], isError: false, timestamp: 2 });
  f.manager.appendContextEdit(trailing, { content: [{ type: "text", text: "small" }] });
  expect(effectiveContextTokens(f.manager.getBranch())).toBe(965_689 + estimateTokens(f.manager.buildSessionProjection().messages.at(-1)!));
  f.manager.appendContextEdit(f.tool, { content: [{ type: "text", text: "a".repeat(20_000) }] });
  f.manager.appendMessage(assistant(900_000) as any);
  f.manager.appendContextEdit(f.tool, { content: [{ type: "text", text: "b".repeat(12_000) }] });
  f.manager.appendContextEdit(f.tool, { content: [{ type: "text", text: "c".repeat(8_000) }] });
  expect(effectiveContextTokens(f.manager.getBranch())).toBe(897_000);
});
test("effective tokens fall back after compaction, omitted/invalid usage, or unknown edits", () => {
  const f = fixture();
  const invalid = [...f.manager.getBranch(), { type: "context_edit", id: "invalid", parentId: f.manager.getLeafId(), targetId: "unknown", replacement: null }];
  expect(effectiveContextTokens(invalid)).toBe(estimateProjectedTokens(buildSessionProjection(invalid), invalid));
  const latest = f.manager.getBranch().findLast((e: any) => e.type === "message" && e.message.role === "assistant")!;
  f.manager.appendContextEdit(latest.id, null);
  expect(effectiveContextTokens(f.manager.getBranch())).toBe(estimateProjectedTokens(f.manager.buildSessionProjection(), f.manager.getBranch()));
  f.manager.appendCompaction(snapshot, f.tool, 965_689, {}, true);
  expect(effectiveContextTokens(f.manager.getBranch())).toBe(estimateProjectedTokens(f.manager.buildSessionProjection(), f.manager.getBranch()));
});
for (const sub of [false, true]) test(`boundary compacts after pruning and refreshes the projection: sub=${sub}`, async () => {
  process.env.PI_COMPACT_DIR = root;
  const f = fixture(965_689, 60_000, sub);
  const entries = await f.boundary();
  expect(entries.map(e => e.type)).toEqual(["context_edit", "compaction"]);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(entries[1].summary).toContain("## Goal");
  if (sub) expect(entries[1].summary).toContain("Task brief (verbatim, from parent):");
  const projected = replay(f.ctx, entries);
  expect(effectiveContextTokens(projected.getBranch())).toBeLessThan(800_000);
  expect(stateOf(f.manager.getSessionId()).attempt).toBeUndefined();
  expect(stateOf(f.manager.getSessionId()).lastAutoSuccess).not.toBeNull();
  expect(logText()).toContain("limit=800000");
  expect(logText()).toContain("result=boundary-compact");
  for (const draft of entries) {
    if (draft.type === "context_edit") f.manager.appendContextEdit(draft.targetId, draft.replacement);
    else f.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, draft.tokensBefore, draft.details, true, draft.usage);
  }
  expect(await f.boundary()).toEqual([]);
  expect(f.complete).toHaveBeenCalledTimes(1);
});
test("pruning is performed but snapshot generation is skipped when pruning suffices", async () => {
  const f = fixture(810_000, 100_000);
  const entries = await f.boundary();
  expect(entries.map(e => e.type)).toEqual(["context_edit"]);
  expect(effectiveContextTokens(replay(f.ctx, entries).getBranch())).toBeLessThan(800_000);
  expect(f.complete).not.toHaveBeenCalled();
});
test("boundary guard pauses main and aborts subagents with the native marker/action", async () => {
  for (const sub of [false, true]) {
    const f = fixture(965_689, 100, sub);
    const s = stateOf(f.manager.getSessionId());
    for (let i = 0; i < 2; i++) { decide(s, "threshold", sub, Date.now()); committed(s, Date.now()); }
    expect(await f.boundary()).toEqual([]);
    expect(s.paused).toBe(true);
    expect(f.complete).not.toHaveBeenCalled();
    if (sub) {
      expect(f.pi.appendEntry).toHaveBeenCalledWith(ABORT_ENTRY, expect.objectContaining({ reason: "compression-loop" }));
      expect(f.ctx.abort).toHaveBeenCalledTimes(1);
    } else {
      expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(f.ctx.abort).not.toHaveBeenCalled();
    }
  }
});
test("boundary skips paused/busy/disabled/noncompleted/already-compacted states", async () => {
  for (const mode of ["paused", "busy", "in-flight", "disabled", "aborted", "error", "compacted"]) {
    const f = fixture(965_689, 100, false, mode === "disabled" ? { compaction: { enabled: false } } : {});
    const s = stateOf(f.manager.getSessionId());
    if (mode === "paused") s.paused = true;
    if (mode === "busy") decide(s, "threshold", false, Date.now());
    if (mode === "in-flight") { s.compacting = true; s.attempt = { reason: "threshold", streak: 0, at: Date.now() - 700_000 }; }
    const draft: any = { type: "compaction", summary: snapshot, firstKeptEntryId: f.tool, details: {} };
    await f.boundary(mode === "aborted" || mode === "error" ? mode : "completed", mode === "compacted" ? [draft] : []);
    expect(f.complete).not.toHaveBeenCalled();
  }
});
test("boundary snapshot failure returns no compaction and releases the guard attempt", async () => {
  const f = fixture(965_689, 100);
  f.complete.mockImplementation(async () => ({ stopReason: "length", content: [] }));
  expect(await f.boundary()).toEqual([]);
  expect(stateOf(f.manager.getSessionId()).attempt).toBeUndefined();
  expect(logText()).toContain("result=boundary-fallback:stop:length");
});
test("agent_end uses the shared line and rechecks effective tokens after queued edits", async () => {
  const savedDelay = usageDelay.ms;
  usageDelay.ms = 0;
  try {
    const trigger = fixture();
    trigger.handlers.agent_end[0]({}, trigger.ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(trigger.ctx.compact).toHaveBeenCalledTimes(1);
    expect(logText()).toContain("limit=800000 result=usage-trigger");
    const resolved = fixture(965_689, 1_000_000);
    resolved.handlers.agent_end[0]({}, resolved.ctx);
    resolved.manager.appendContextEdit(resolved.tool, { content: [{ type: "text", text: "short" }] });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(resolved.ctx.compact).not.toHaveBeenCalled();
    expect(logText()).toContain("result=usage-skip:resolved");
  } finally { usageDelay.ms = savedDelay; }
});
test("two failed boundary snapshots pause main and abort subagents on the next attempt", async () => {
  for (const sub of [false, true]) {
    const f = fixture(965_689, 100, sub);
    f.complete.mockImplementation(async () => ({ stopReason: "length", content: [] }));
    await f.boundary(); await f.boundary(); await f.boundary();
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(stateOf(f.manager.getSessionId()).paused).toBe(true);
    if (sub) {
      expect(f.pi.appendEntry).toHaveBeenCalledWith(ABORT_ENTRY, expect.objectContaining({ reason: "commit-failures" }));
      expect(f.ctx.abort).toHaveBeenCalledTimes(1);
    } else expect(f.ctx.abort).not.toHaveBeenCalled();
  }
});
test("invalid ratio uses default with one warning; valid custom ratio affects both boundaries", async () => {
  const invalid = fixture(700_000, 100, false, { piCompact: { triggerRatio: "0.7" } });
  await invalid.boundary(); await invalid.boundary();
  expect(invalid.ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(invalid.complete).not.toHaveBeenCalled();
  const custom = fixture(700_000, 60_000, true, { piCompact: { triggerRatio: 0.6 } });
  expect(usageInputs(custom.pi, custom.ctx).ratio).toBe(0.6);
  expect((await custom.boundary()).map(e => e.type)).toEqual(["context_edit", "compaction"]);
  expect(custom.ctx.ui.notify).not.toHaveBeenCalled();
});
test("public cut preparation matches native keepRecentTokens for edited/split/system/previous-summary shapes", async () => {
  const internalPath = join(process.env.HOME!, ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js");
  const { prepareCompaction } = await import(internalPath);
  const f = fixture();
  f.manager.appendContextEdit(f.tool, { content: [{ type: "text", text: "small" }] });
  f.manager.appendMessage({ role: "system", content: "Current system prompt ".repeat(50), timestamp: 2 } as any);
  const compare = () => {
    for (const keep of [100, 1000, 5000]) {
      const ours = prepareBoundaryCompaction(f.manager, keep, 965_689);
      const native = prepareCompaction(f.manager.getBranch(), { keepRecentTokens: keep });
      expect(ours?.firstKeptEntryId).toBe(native?.firstKeptEntryId);
      expect(ours?.messagesToSummarize).toEqual(native?.messagesToSummarize);
      expect(ours?.turnPrefixMessages).toEqual(native?.turnPrefixMessages);
    }
  };
  compare();
  const first = prepareBoundaryCompaction(f.manager, 100, 965_689)!;
  f.manager.appendCompaction(snapshot, first.firstKeptEntryId, 965_689, { readFiles: ["/previous"] }, true);
  f.manager.appendMessage({ role: "user", content: "New recent history ".repeat(1000), timestamp: 3 });
  f.manager.appendMessage(assistant(900_000) as any);
  compare();
  expect(prepareBoundaryCompaction(f.manager, 100, 900_000)?.previousSummary).toBe(snapshot);
});
