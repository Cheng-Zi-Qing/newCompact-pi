import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

process.env.PI_COMPACT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-compact-ext-"));
const pruner = (await import("../extensions/tool-result-pruner.ts")).default;
const compact = (await import("../extensions/compact.ts")).default;
const { isSubagent, usageDelay } = await import("../extensions/compact.ts");
usageDelay.ms = 0;
const tick = () => new Promise(r => setTimeout(r, 5));
const { SECTIONS } = await import("../src/summary.ts");
const { resetStates, stateOf } = await import("../src/guard.ts");

function fakePi(activeTools = ["read_tool_result"], settings: any = {}) {
  const handlers: Record<string, Function> = {}; const tools: Record<string, any> = {};
  return { handlers, tools, on: (n: string, h: Function) => { handlers[n] = h; }, registerTool: (t: any) => { tools[t.name] = t; },
    getActiveTools: () => activeTools, getSettings: () => settings } as any;
}
const model = { id: "m", provider: "p", api: "openai-responses", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
const toolResult = (text: string) => ({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 2 });

function session(msgs: any[], header: any = {}) {
  const sm = SessionManager.inMemory("/tmp");
  for (const m of msgs) sm.appendMessage(m);
  const h = { ...sm.getHeader(), ...header };
  return { sm, ctx: { cwd: "/tmp", model, sessionManager: { getHeader: () => h, getBranch: () => sm.getBranch(), getEntry: (id: string) => sm.getEntry(id),
    getSessionId: () => sm.getSessionId(), getSessionFile: () => undefined },
    getContextUsage: () => ({ contextWindow: 128000 }), ui: { notify: mock(), setStatus: mock() } } as any };
}
const turnEnd = (sm: any) => ({ outcome: "completed", entries: [], context: { contextEntries: sm.buildSessionProjection().entries } });

describe("tool-result pruner", () => {
  const big = "x".repeat(60_000);
  const many = () => [{ role: "user", content: "go", timestamp: 1 }, ...Array.from({ length: 10 }, () => toolResult(big)), { role: "user", content: "next", timestamp: 3 }];
  test("under threshold: no pruning", async () => {
    const pi = fakePi(); pruner(pi);
    const { sm, ctx } = session([{ role: "user", content: "go", timestamp: 1 }, toolResult(big), { role: "user", content: "n", timestamp: 3 }]);
    expect(await pi.handlers.turn_end(turnEnd(sm), ctx)).toBeUndefined();
  });
  test("over threshold: prunes earliest large results first", async () => {
    const pi = fakePi(); pruner(pi);
    const { sm, ctx } = session(many());
    const out = await pi.handlers.turn_end(turnEnd(sm), ctx);
    expect(out.entries.length).toBeGreaterThan(0);
    const firstTool = sm.getBranch().find((e: any) => e.message?.role === "toolResult");
    expect(out.entries[0].targetId).toBe(firstTool.id);
    expect(out.entries[0].replacement.content[0].text).toContain("use read_tool_result");
  });
  test("read_tool_result returns raw text", async () => {
    const pi = fakePi(); pruner(pi);
    const { sm, ctx } = session(many());
    const id = sm.getBranch().find((e: any) => e.message?.role === "toolResult").id;
    const r = await pi.tools.read_tool_result.execute("c", { entryId: id, offset: 0, limit: 100 }, undefined, undefined, ctx);
    expect(r.content[0].text).toBe("x".repeat(100));
    expect(r.details.totalCodepoints).toBe(60_000);
  });
  test("read_tool_result inactive (e.g. worker whitelist): no pruning", async () => {
    const pi = fakePi(["read", "bash"]); pruner(pi);
    const { sm, ctx } = session(many());
    expect(await pi.handlers.turn_end(turnEnd(sm), ctx)).toBeUndefined();
  });
});

describe("compact entry wiring", () => {
  const snapshot = SECTIONS.map(s => `## ${s}\nok`).join("\n\n");
  const event = (reason = "threshold") => ({ reason, signal: new AbortController().signal, branchEntries: [],
    preparation: { messagesToSummarize: [{ role: "user", content: "hi", timestamp: 1 }], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa", tokensBefore: 1, fileOps: {} } });
  function setup(reply: any, header: any = {}) {
    resetStates();
    const pi = fakePi(); compact(pi);
    const { ctx } = session([], header);
    ctx.modelRegistry = { complete: async () => reply };
    ctx.abort = mock();
    ctx.compact = mock();
    ctx.isIdle = () => true;
    return { pi, ctx };
  }
  test("success returns our compaction; model error falls back (undefined, not cancel)", async () => {
    let { pi, ctx } = setup({ stopReason: "stop", content: [{ type: "text", text: snapshot }] });
    expect((await pi.handlers.session_before_compact(event(), ctx)).compaction.summary).toContain("## Goal");
    ({ pi, ctx } = setup({ stopReason: "error", content: [] }));
    expect(await pi.handlers.session_before_compact(event(), ctx)).toBeUndefined();
  });
  test("main session rapid loop pauses via cancel + notice", async () => {
    const { pi, ctx } = setup({ stopReason: "stop", content: [{ type: "text", text: snapshot }] });
    for (let i = 0; i < 2; i++) { await pi.handlers.session_before_compact(event(), ctx); pi.handlers.session_compact({ reason: "threshold", compactionEntry: { summary: "s" }, fromExtension: true }, ctx); }
    expect(await pi.handlers.session_before_compact(event(), ctx)).toEqual({ cancel: true });
    expect(await pi.handlers.session_before_compact(event(), ctx)).toEqual({ cancel: true });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // warned once, not every turn
  });
  test("subagent loop aborts the run instead of pausing", async () => {
    const { pi, ctx } = setup({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }, { parentSession: "/p.jsonl" });
    for (let i = 0; i < 3; i++) { await pi.handlers.session_before_compact(event(), ctx); pi.handlers.session_compact({ reason: "threshold", compactionEntry: { summary: "s" }, fromExtension: true }, ctx); }
    expect(await pi.handlers.session_before_compact(event(), ctx)).toEqual({ cancel: true });
    expect(ctx.abort).toHaveBeenCalled();
  });
  test("agent_end triggers ctx.compact once usage crosses the configured reserve", async () => {
    const { pi, ctx } = setup(undefined);
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop", api: "x", provider: "p", model: "m", timestamp: 1,
      usage: { input: 120_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
    ctx.sessionManager.getBranch = () => sm.getBranch();
    pi.handlers.agent_end({}, ctx); await tick();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(stateOf(ctx.sessionManager.getSessionId()).usagePending).toBe(true);
    // Busy (pi still running / compacting): skip instead of aborting the in-flight work.
    resetStates(); ctx.isIdle = () => false;
    pi.handlers.agent_end({}, ctx); await tick();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    resetStates(); ctx.isIdle = () => true; stateOf(ctx.sessionManager.getSessionId()).compacting = true;
    pi.handlers.agent_end({}, ctx); await tick();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    // Native compaction already ran before agent_end: stale usage must not trigger again.
    resetStates();
    sm.appendCompaction("s", sm.getBranch()[0].id, 120_000, {}, true);
    pi.handlers.agent_end({}, ctx); await tick();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });
  test("subagent detection: parentSession header or non-main route role", () => {
    expect(isSubagent(session([], { parentSession: "/p" }).ctx)).toBe(true);
    const { sm, ctx } = session([]);
    expect(isSubagent(ctx)).toBe(false);
    sm.appendCustomEntry("model-route-state", { contextRole: "main" });
    expect(isSubagent(ctx)).toBe(false);
    sm.appendCustomEntry("model-route-state", { contextRole: "coder" });
    expect(isSubagent(ctx)).toBe(true);
  });
});
