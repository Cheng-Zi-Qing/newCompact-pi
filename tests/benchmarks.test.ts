// Benchmarks built from real upstream issues about context compaction. Each test names its source issue.
// They assert our behavior, not the reporter's: a red test here means our plugin has the reported problem.
import { beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertToLlm, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { hostModules } from "../scripts/host-modules.mjs";
const { serializeConversation } = await import(path.join(hostModules(), "@earendil-works/pi-coding-agent/dist/core/compaction/utils.js"));

process.env.PI_COMPACT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-compact-bench-"));
const compact = (await import("../extensions/compact.ts")).default;
const { usageDelay } = await import("../extensions/compact.ts");
const prunerMod = await import("../extensions/tool-result-pruner.ts");
const pruner = prunerMod.default, replay = prunerMod.replay;
const { summarize, archivePath, Fallback, HARD_CAP, SECTIONS, serializeForSummary } = await import("../src/summary.ts");
const { textTokens } = await import("../src/estimate.ts");
const { compactionLine, effectiveContextTokens, usageInputs } = await import("../src/usage.ts");
const { resetStates, stateOf } = await import("../src/guard.ts");

usageDelay.ms = 0;
beforeEach(resetStates);

const snapshot = SECTIONS.map(s => `## ${s}\nok`).join("\n\n");
const withFill = (fill: string) => SECTIONS.map(s => `## ${s}\n${fill}`).join("\n\n");
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const model = (contextWindow?: number) => ({ id: "m", provider: "p", api: "openai-responses", reasoning: true, contextWindow, maxTokens: 16384 });
const user = (text: string, timestamp = 1) => ({ role: "user", content: text, timestamp });
const assistant = (total: number, content: any[] = [{ type: "text", text: "done" }]) => ({ role: "assistant", content,
  api: "openai-responses", provider: "p", model: "m", stopReason: "stop", timestamp: 1,
  usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost } });
const toolResult = (text: string, id = "t1") => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 2 });
const toolCall = (id = "t1") => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "cat big" } }],
  api: "openai-responses", provider: "p", model: "m", stopReason: "stop", timestamp: 1, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost } });

// Minimal version of tests/extensions.test.ts's fakePi/session/turnEnd, plus a mutable settings object.
// `replies` lets a test script the model turn by turn; the default is a valid 8-section snapshot.
function harness(window = 200_000, config: any = {}, replies: any[] = []) {
  const sm = SessionManager.inMemory("/tmp");
  const handlers: Record<string, Function[]> = {};
  const seen: any[] = [];
  let calls = 0;
  const pi: any = { on: (name: string, handler: Function) => (handlers[name] ??= []).push(handler),
    registerTool() {}, registerCommand() {}, appendEntry: mock(),
    getSettings: () => config, getActiveTools: () => ["read_tool_result"] };
  const ctx: any = { cwd: "/tmp", model: model(window),
    sessionManager: { getHeader: () => sm.getHeader(), getBranch: () => sm.getBranch(), getEntry: (id: string) => sm.getEntry(id),
      getSessionId: () => sm.getSessionId(), getSessionFile: () => undefined },
    getContextUsage: () => ({ contextWindow: window }), signal: new AbortController().signal,
    modelRegistry: { streamSimple: (m: any, c: any, o: any) => { seen.push({ model: m, context: c, options: o });
      const reply = replies.length ? replies.shift() : { stopReason: "stop", content: [{ type: "text", text: snapshot }] };
      return { result: async () => (calls++, reply) }; } },
    abort: mock(), isIdle: () => true, compact: mock(), ui: { notify: mock(), setStatus: mock() } };
  pruner(pi); compact(pi);
  // Same two-handler loop as tests/boundary.test.ts: pruner drafts, then compact sees its edits.
  async function boundary(entries: any[] = []) {
    for (const handler of handlers.turn_end) {
      const preview = replay(ctx, entries);
      const result = await handler({ outcome: "completed", entries, context: { contextEntries: preview.buildSessionProjection().entries } }, ctx);
      if (result?.entries) entries = result.entries;
    }
    return entries;
  }
  const preparation = (text: string, tokensBefore = 1000) => ({ messagesToSummarize: [user(text)], turnPrefixMessages: [],
    firstKeptEntryId: "aaaaaaaa", tokensBefore, fileOps: {} });
  const beforeCompact = (reason: string, prep: any, signal = new AbortController().signal) =>
    handlers.session_before_compact[0]({ reason, signal, branchEntries: [], preparation: prep }, ctx);
  // pi emits this on every aborted/failed compaction attempt (manual and automatic paths alike).
  const compactFailed = (event: any = { aborted: true, reason: "threshold", fromExtension: true, errorMessage: undefined }) =>
    handlers.session_compact_failed[0](event, ctx);
  return { sm, ctx, pi, handlers, boundary, beforeCompact, compactFailed, preparation, seen, calls: () => calls };
}
const logText = () => readFileSync(path.join(process.env.PI_COMPACT_DIR!, "pi-compact.log"), "utf8");
const logFor = (sessionId: string) => logText().split("\n").filter(l => l.includes(`session=${sessionId}`)).join("\n");

test("benchmark claude-code#7502: first compaction has no archive pointer", async () => {
  const sessionId = "bench-7502-first";
  const out = await summarize({
    preparation: { messagesToSummarize: [user("do the thing")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa", tokensBefore: 90_000 },
    branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId, isSubagent: false, budget: 6000,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
  });
  expect(out.compaction.summary).not.toContain(archivePath(sessionId));
  expect(out.compaction.summary).not.toContain("Older details:");
  expect(existsSync(archivePath(sessionId))).toBe(false);
});

test("benchmark claude-code#7502: second compaction names an archive that exists", async () => {
  // claude-code#7502 (2025-09-12, 39👍): auto-compaction dropped the history with no warning and no way back.
  const sessionId = "bench-7502";
  const i = {
    preparation: { messagesToSummarize: [user("do the thing")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
      tokensBefore: 90_000, previousSummary: undefined as string | undefined, fileOps: {} },
    branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId, isSubagent: false, budget: 6000,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
  };
  const first = await summarize(i);
  i.preparation.previousSummary = first.compaction.summary;
  const out = await summarize(i);
  const archive = archivePath(sessionId);
  expect(out.compaction.summary).toContain(archive);                                   // the snapshot names where the history went
  expect(out.compaction.summary).toContain("read_tool_result(entryId, offset, limit)"); // and how to reopen pruned results
  expect(existsSync(archive)).toBe(true);
  expect(readFileSync(archive, "utf8")).toContain(first.compaction.summary);                       // the dropped snapshot is really there
});

test("benchmark claude-code#66144: context past 100% of the window still snapshots", async () => {
  // claude-code#66144 (2026-06-08, 25👍): at 100% of the window auto-compaction stopped firing and the session wedged.
  // 160 messages x 5000 chars: ~160k tokens at the full profile, ~48k at tight, against a 200k window.
  const messages = Array.from({ length: 160 }, () => ({ role: "assistant", content: [{ type: "text", text: "y".repeat(5000) }] }));
  let calls = 0;
  const out = await summarize({
    preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
      tokensBefore: 210_000, previousSummary: "OLD SUMMARY", fileOps: {} },
    branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId: "bench-66144", isSubagent: false, budget: 6000,
    complete: async () => (calls++, { stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
  });
  expect(out.compaction.tokensBefore).toBe(210_000); // the anchor really is past the window
  expect(out.compressed).toBe(true);                 // degraded to the tight profile instead of giving up
  expect(calls).toBe(1);                             // one model call: the degrade is not a retry
  expect(out.compaction.summary).toContain("## Goal");
});

test("benchmark claude-code#18211: manual compaction over capacity never cancels", async () => {
  // claude-code#18211 (2026-01-14, 25👍): /compact answered "conversation too long" and auto-compaction was dead too.
  const over = harness(16_000);
  over.sm.appendMessage(user("go") as any);
  // Even tight cannot fit the fixed output/safety reserve in this small window.
  const cancelable = await over.beforeCompact("manual", over.preparation("x".repeat(2_000_000)));
  expect(cancelable).not.toEqual({ cancel: true });
  expect(cancelable).toBeUndefined();                      // pi's native summary takes over, the run is not cancelled
  expect(logText()).toContain("result=fallback:capacity");

  const fits = harness(200_000);
  fits.sm.appendMessage(user("go") as any);
  const out = await fits.beforeCompact("manual", fits.preparation("short request"));
  expect(out.compaction.summary).toContain("## Goal");     // when it can summarize, manual compaction still works
  expect(fits.calls()).toBe(1);
});

test("benchmark codex#4106: compaction.enabled=false keeps manual working", async () => {
  // codex#4106 (2025-09-23, 138👍): thresholds were hardcoded, couldn't be turned off, and compaction folded away live context.
  const config: any = { compaction: { enabled: false, keepRecentTokens: 1000 } };
  const f = harness(200_000, config);
  f.sm.appendMessage(user("task") as any);
  f.sm.appendMessage(assistant(190_000) as any);
  expect(await f.boundary()).toEqual([]);   // boundary turn_end stays out of the way
  f.handlers.agent_end[0]({}, f.ctx);
  await new Promise(r => setTimeout(r, 20));
  expect(f.ctx.compact).not.toHaveBeenCalled(); // and so does the usage fallback
  expect(f.handlers.session_before_compact.length).toBe(1);
  const manual = await f.beforeCompact("manual", f.preparation("short request"));
  expect(manual.compaction.summary).toContain("## Goal"); // /compact still works: opt-out is about automation only
  const enabled = harness(200_000, { compaction: { enabled: true, keepRecentTokens: 1000 } });
  enabled.sm.appendMessage(user("task") as any);
  enabled.sm.appendMessage(assistant(190_000) as any);
  enabled.sm.appendMessage(user("t".repeat(8_000)) as any);
  expect((await enabled.boundary()).map(e => e.type)).toContain("compaction");
  expect(enabled.calls()).toBe(1);
});

test("benchmark opencode#8140: triggerRatio 0.5 compacts at half the window", async () => {
  // opencode#8140 (2026-01-13, 82👍): users wanted earlier compaction / a capped context and the ratio was not configurable.
  const config: any = { compaction: { enabled: true, keepRecentTokens: 1000 } };
  const f = harness(200_000, config);
  f.sm.appendMessage(user("Original task") as any);
  f.sm.appendMessage(assistant(105_000, [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]) as any);
  for (let i = 0; i < 3; i++) f.sm.appendMessage(toolResult("o".repeat(30_000)) as any);
  const total = effectiveContextTokens(f.sm.getBranch(), f.sm.buildSessionProjection());
  expect(total).toBeGreaterThan(100_000); // > 50% of a 200k window
  expect(total).toBeLessThan(160_000);    // < the default 80% line
  expect(await f.boundary()).toEqual([]); // same session, default 0.8: nothing to do
  expect(logText()).toContain("result=boundary-skip:small");
  config.piCompact = { triggerRatio: 0.5 };
  const entries = await f.boundary();
  expect(entries.map(e => e.type)).toContain("compaction"); // now it compacts, well before pi's own line
  expect(logText()).toContain("limit=100000");
});

test("benchmark crush#472: an aborted compaction writes no archive", async () => {
  // crush#472 (6👍): the compaction session hung.
  const ac = new AbortController();
  ac.abort();
  const sessionId = "bench-472-aborted";
  const aborted = summarize({
    preparation: { messagesToSummarize: [user("go")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
      tokensBefore: 90_000, previousSummary: "OLD SUMMARY", fileOps: {} },
    branchEntries: [], signal: ac.signal, model: model(200_000), sessionId, isSubagent: false, budget: 6000,
    complete: async () => { throw new Error("must not be called"); },
  });
  const error = await aborted.then(() => null, (e: any) => e);
  expect(error).toBeInstanceOf(Fallback);
  expect(error.message).toBe("aborted");
  expect(existsSync(archivePath(sessionId))).toBe(false);
});

test("benchmark crush#472: an aborted compaction releases the guard", async () => {
  // Real timing: pi emits session_compact_failed{aborted:true} after an aborted attempt (manual L2344, auto L2633),
  // and our handler clears the attempt and the compacting flag. The session must not stay wedged afterwards.
  const f = harness(200_000, { compaction: { keepRecentTokens: 1000 } });
  f.sm.appendMessage(user("task") as any);
  const ac = new AbortController();
  ac.abort();
  expect(await f.beforeCompact("threshold", f.preparation("hi"), ac.signal)).toBeUndefined();
  expect(stateOf(f.sm.getSessionId()).compacting).toBe(false); // cleared by our own catch, before pi's event arrives
  f.compactFailed({ aborted: true, reason: "manual", fromExtension: true, errorMessage: undefined });
  expect(stateOf(f.sm.getSessionId()).compacting).toBe(false);
  expect(stateOf(f.sm.getSessionId()).attempt).toBeUndefined(); // released by session_compact_failed
  f.sm.appendMessage(assistant(190_000) as any);
  f.sm.appendMessage(user("t".repeat(8_000)) as any); // past keepRecentTokens, so the anchor is summarized away
  const entries = await f.boundary();
  expect(entries.map(e => e.type)).toContain("compaction"); // the session is not wedged
});

test("benchmark crush#2382: low-value tool noise is pruned before it reaches the summary", async () => {
  // crush#2382 (5👍): long sessions carry tool noise that must be trimmed before it costs context.
  const f = harness(100_000, { compaction: { keepRecentTokens: 1000 } });
  const body = `HEAD-LINE-${"m".repeat(60_000)}-TAIL-LINE`;
  f.sm.appendMessage(user("go") as any);
  f.sm.appendMessage(toolCall() as any);
  for (let i = 0; i < 6; i++) f.sm.appendMessage(toolResult(`IDX${i}-${body}`, `t${i}`) as any);
  f.sm.appendMessage(user("next") as any);
  const before = f.sm.buildSessionProjection();
  const edits = await f.handlers.turn_end[0]({ outcome: "completed", entries: [], context: { contextEntries: before.entries } }, f.ctx);
  expect(edits.entries.map((e: any) => e.type)).toEqual(["context_edit"]);
  const prunedManager = replay(f.ctx, edits.entries);
  const prunedProjection = prunedManager.buildSessionProjection();
  const pruned = prunedProjection.messages.filter((m: any) => m.role === "toolResult")[0];
  const text = pruned.content[0].text;
  expect(text).toContain("[tool_result pruned; raw entry ");
  expect(text).toContain("use read_tool_result]");        // pointer to the raw text survives
  expect(text).toContain("HEAD-LINE-mmm");                 // head kept
  expect(text.endsWith("-TAIL-LINE")).toBe(true);          // tail kept
  expect(text).not.toContain("m".repeat(5000));            // the middle bulk is gone
  // What reaches the summarizer: no bulk, and no growth. The capped profile already cut tool results to 400 chars,
  // so pruning buys ~nothing here (measured: 1 token) — its saving is in the live context below.
  const originalInput = textTokens(serializeForSummary(convertToLlm(before.messages), "full"));
  const prunedInput = textTokens(serializeForSummary(convertToLlm(prunedProjection.messages), "full"));
  // The pruned marker carries its own entry id, which now counts as a dense line and survives the cut; pruning
  // must still not inflate the summarizer input beyond that address.
  expect(prunedInput).toBeLessThanOrEqual(originalInput + 25);
  expect(prunedInput).toBeLessThanOrEqual(textTokens(serializeConversation(convertToLlm(prunedProjection.messages))) * 0.7);
  const live = (branch: any[], projection: any) => effectiveContextTokens(branch, projection);
  expect(live(prunedManager.getBranch(), prunedProjection)).toBeLessThan(live(f.sm.getBranch(), before) - 10_000); // the real saving
});

// ---------------------------------------------------------------------------------------------------------------
// Second batch: issues filed against compaction plugins themselves.
// ---------------------------------------------------------------------------------------------------------------

test("benchmark billion-context#5536: a failed archive write still returns the snapshot", async () => {
  // billion-context#5536: a storage fault silently disabled compaction and everything fell back to the native summary.
  const dir = process.env.PI_COMPACT_DIR!;
  process.env.PI_COMPACT_DIR = "/dev/null/blocked"; // mkdir fails with ENOTDIR
  try {
    const out = await summarize({
      preparation: { messagesToSummarize: [user("go")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
        tokensBefore: 90_000, previousSummary: "OLD SUMMARY", fileOps: {} },
      branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId: "bench-5536", isSubagent: false, budget: 6000,
      complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
    });
    expect(out.compaction.summary).toContain("## Goal");                 // a snapshot without an archive beats no snapshot
    expect(out.compaction.summary).not.toContain("Older details");       // and it does not point at a missing file
    expect(out.compaction.summary).toContain("not archived");
    expect(out.compaction.summary).toContain("read_tool_result(entryId, offset, limit)"); // pruner pointers are unrelated
    expect(existsSync(archivePath("bench-5536"))).toBe(false);
  } finally { process.env.PI_COMPACT_DIR = dir; }
  const out = await summarize({
    preparation: { messagesToSummarize: [user("go")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
      tokensBefore: 90_000, previousSummary: "OLD SUMMARY", fileOps: {} },
    branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId: "bench-5536-ok", isSubagent: false, budget: 6000,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
  });
  expect(out.compaction.summary).toContain(`Older details: ${archivePath("bench-5536-ok")}`); // writable dir keeps the pointer
});

test("benchmark billion-context#5534: compaction never writes summary text into tool call arguments", async () => {
  // billion-context#5534: an emergency fold put summary text into tool_calls.arguments and polluted the session for good.
  const f = harness(200_000, { compaction: { keepRecentTokens: 1000 } });
  f.sm.appendMessage(user("Original task") as any);
  f.sm.appendMessage(toolCall() as any);
  f.sm.appendMessage(toolResult("o".repeat(30_000)) as any);
  f.sm.appendMessage(assistant(190_000) as any);
  const drafts = await f.boundary();
  const compactionEntry = drafts.find((e: any) => e.type === "compaction");
  expect(compactionEntry.summary).toContain("## Goal");
  for (const draft of drafts) { // apply the drafts the way the host does
    if (draft.type === "context_edit") f.sm.appendContextEdit(draft.targetId, draft.replacement);
    else f.sm.appendCompaction(draft.summary, draft.firstKeptEntryId, draft.tokensBefore, draft.details, true, draft.usage);
  }
  const blocks = [...f.sm.getBranch(), ...f.sm.buildSessionProjection().messages]
    .flatMap((x: any) => (x.message ?? x).content ?? [])
    .filter((b: any) => b?.type === "toolCall");
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(typeof block.arguments).toBe("object");                       // still an object, not a string blob
    expect(JSON.parse(JSON.stringify(block.arguments))).toEqual(block.arguments); // round-trips through strict JSON
    expect(JSON.stringify(block.arguments)).not.toContain("## ");        // no snapshot text leaked into arguments
  }
  expect(JSON.stringify(drafts.filter((d: any) => d.type !== "compaction"))).not.toContain("## ");
});

test("benchmark billion-context#5531: repeated compaction keeps the snapshot bounded", async () => {
  // billion-context#5531: compaction leaked and the context climbed to 350k tokens.
  const huge = withFill("word ".repeat(20_000)); // ~25k tokens: far past HARD_CAP
  let previous = "OLD SUMMARY";
  const sizes: number[] = [];
  for (let generation = 0; generation < 5; generation++) {
    const replies = [{ stopReason: "stop", content: [{ type: "text", text: huge }] },
      { stopReason: "stop", content: [{ type: "text", text: snapshot }] }];
    const out = await summarize({
      preparation: { messagesToSummarize: [user("go")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
        tokensBefore: 90_000, previousSummary: previous, fileOps: {} },
      branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId: "bench-5531", isSubagent: false, budget: 6000,
      complete: async () => replies.shift(),
    });
    expect(out.condensed).toBe(true);         // the oversized reply was condensed, never committed as-is
    expect(out.tokens).toBeLessThanOrEqual(HARD_CAP);
    sizes.push(out.tokens);
    previous = out.compaction.summary;
  }
  expect(sizes.every(size => size <= HARD_CAP)).toBe(true);
  const archive = readFileSync(archivePath("bench-5531"), "utf8");
  expect(archive.match(/^# Archived /gm)).toHaveLength(5);
});

test("benchmark billion-context#5538: a stale estimate must not disable preflight compaction", async () => {
  // billion-context#5538: the preflight compared an uncalibrated text estimate and never fired on a 1.86M payload.
  const f = harness(200_000, { compaction: { keepRecentTokens: 100 } });
  f.sm.appendMessage(user("task") as any);
  f.sm.appendMessage(assistant(190_000) as any);       // provider reported the real size
  f.sm.appendMessage(user("t".repeat(1_000)) as any);  // text only looks like a few hundred tokens
  const branch = f.sm.getBranch();
  const textOnly = branch.reduce((n, e: any) => n + (e.message ? estimateTokens(e.message) : 0), 0);
  const total = effectiveContextTokens(branch, f.sm.buildSessionProjection());
  expect(textOnly).toBeLessThan(1_000);
  expect(total).toBeGreaterThan(compactionLine(200_000, 16_384)); // past the preflight line despite the tiny text
  expect((await f.boundary()).map(e => e.type)).toContain("compaction");
});

test("benchmark billion-context#5542: every degradation is observable in the log", async () => {
  // billion-context#5542: generation resets and swallowed execution tails were invisible in the logs.
  const huge = withFill("word ".repeat(20_000));
  const cases: Array<[string, any[]]> = [
    ["capacity", []], ["over-cap", [{ stopReason: "stop", content: [{ type: "text", text: huge }] }, { stopReason: "stop", content: [{ type: "text", text: huge }] }]],
    ["structure", [{ stopReason: "stop", content: [{ type: "text", text: "no headings" }] }]],
    ["stop:length", [{ stopReason: "length", content: [] }]],
  ];
  for (const [expected, replies] of cases) {
    const f = harness(expected === "capacity" ? 16_000 : 200_000, { compaction: { keepRecentTokens: 1000 } }, replies);
    f.sm.appendMessage(user("go") as any);
    const prep = expected === "capacity" ? f.preparation("x".repeat(2_000_000)) : f.preparation("short request");
    expect(await f.beforeCompact("manual", prep)).toBeUndefined();
    expect(logFor(f.sm.getSessionId())).toContain(`result=fallback:${expected}`);
  }
});

test("benchmark billion-context#5527: compaction is triggerable at a low ratio", async () => {
  // billion-context#5527: compress could not be triggered at all; the ratio knob must also reach manual /compact.
  const f = harness(200_000, { compaction: { keepRecentTokens: 1000 }, piCompact: { triggerRatio: 0.5 } });
  f.sm.appendMessage(user("task") as any);
  f.sm.appendMessage(assistant(5_000) as any);
  const { total, window, reserve, ratio } = usageInputs(f.pi, f.ctx);
  expect(total).toBeLessThan(10_000);                       // nowhere near any automatic line
  expect(ratio).toBe(0.5);
  expect(compactionLine(window, reserve, ratio)).toBe(100_000);
  expect(await f.boundary()).toEqual([]);                   // the automatic path stays quiet at this size
  const out = await f.beforeCompact("manual", f.preparation("short request"));
  expect(out.compaction.summary).toContain("## Goal");      // but /compact is always triggerable
});

test("benchmark pi-prefix-cache-compaction#2: the summary call uses the session model registry", async () => {
  // pi-prefix-cache-compaction#2: its own HTTP layer bypassed the registry and got 401s.
  const f = harness(200_000, { compaction: { keepRecentTokens: 1000 } });
  f.sm.appendMessage(user("task") as any);
  expect((await f.beforeCompact("manual", f.preparation("short request"))).compaction).toBeDefined();
  const call = f.seen[0];
  expect(call.model).toBe(f.ctx.model);                     // the same object the session runs on
  expect(call.model.id).toBe(f.ctx.model.id);
  expect(call.model.provider).toBe(f.ctx.model.provider);
  expect(Object.keys(call.options).sort()).toEqual(["cacheRetention", "maxTokens", "reasoning", "signal"]);
  for (const banned of ["fetch", "baseUrl", "baseURL", "apiKey", "headers", "client"]) expect(call.options).not.toHaveProperty(banned);
});

test("benchmark pi-compaction-control#1: env overrides reach the archive path", async () => {
  // pi-compaction-control#1: hardcoded ~/.pi/agent/settings.json ignored PI_CODING_AGENT_DIR, so it silently did nothing.
  const dir = process.env.PI_COMPACT_DIR!;
  const sessionId = "bench-control-1";
  expect(archivePath(sessionId).startsWith(dir)).toBe(true);
  const out = await summarize({
    preparation: { messagesToSummarize: [user("go")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa",
      tokensBefore: 90_000, previousSummary: "OLD SUMMARY", fileOps: {} },
    branchEntries: [], signal: new AbortController().signal, model: model(200_000), sessionId, isSubagent: false, budget: 6000,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: snapshot }] }),
  });
  expect(out.compaction.summary).toContain(archivePath(sessionId));
  expect(readFileSync(path.join(dir, "compaction-archive", `${sessionId}.md`), "utf8")).toContain("OLD SUMMARY");
});
