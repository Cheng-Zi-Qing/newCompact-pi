import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-compact-test-"));
process.env.PI_COMPACT_DIR = tmp;
const prodLog = path.join(os.homedir(), ".pi/agent/pi-compact.log");
const prodLogBefore = existsSync(prodLog) ? statSync(prodLog).mtimeMs : null;

const { summarize, SECTIONS, Fallback, archivePath, taskBrief, HARD_CAP } = await import("../src/summary.ts");
const { textTokens } = await import("../src/estimate.ts");

const model = { id: "m", provider: "p", api: "openai-responses", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
const snapshot = (fill = "ok") => SECTIONS.map(s => `## ${s}\n${fill}`).join("\n\n");
const reply = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
const user = (t: string) => ({ role: "user", content: t, timestamp: 1 });

let calls: any[];
function input(replies: any[], over: any = {}) {
  calls = [];
  return {
    preparation: { messagesToSummarize: [user("do the thing")], turnPrefixMessages: [], firstKeptEntryId: "aaaaaaaa", tokensBefore: 90000,
      previousSummary: "OLD SUMMARY", fileOps: { read: new Set(["/r2"]), written: new Set(["/w2"]), edited: new Set() } },
    branchEntries: [], signal: new AbortController().signal, model, sessionId: `s${Math.random()}`, isSubagent: false, budget: 6000,
    complete: async (_m: any, ctx: any, opts: any) => { calls.push({ ctx, opts }); return replies.shift(); },
    ...over,
  };
}
const fails = async (p: Promise<any>, why: string) => { const e = await p.then(() => null, e => e); expect(e).toBeInstanceOf(Fallback); expect(e.message).toBe(why); };

describe("summarize", () => {
  test("normal: 8 sections, archive pointer, low reasoning, previous summary archived", async () => {
    const i = input([reply(snapshot())]);
    const out = await summarize(i);
    expect(out.compaction.summary).toContain("## Next Steps");
    expect(out.compaction.summary).toContain(`Older details: ${archivePath(i.sessionId)}`);
    expect(calls[0].opts).toMatchObject({ maxTokens: 12288, reasoningEffort: "low", cacheRetention: "none" });
    expect(readFileSync(archivePath(i.sessionId), "utf8")).toContain("OLD SUMMARY");
  });
  test("stop:length -> fallback", async () => { await fails(summarize(input([reply(snapshot(), "length")])), "stop:length"); });
  test("missing / reordered section -> fallback", async () => {
    await fails(summarize(input([reply(snapshot().replace("## Key Decisions", "## Decisions"))])), "structure");
    const swapped = [...SECTIONS].reverse().map(s => `## ${s}\nx`).join("\n");
    await fails(summarize(input([reply(swapped)])), "structure");
  });
  test("over 8k -> one condense call succeeds", async () => {
    const out = await summarize(input([reply(snapshot("word ".repeat(8000))), reply(snapshot())]));
    expect(calls.length).toBe(2);
    expect(out.condensed).toBe(true);
    expect(out.tokens).toBeLessThanOrEqual(HARD_CAP);
  });
  test("condense still over -> fallback", async () => {
    const big = snapshot("word ".repeat(8000));
    await fails(summarize(input([reply(big), reply(big)])), "over-cap");
  });
  test("aborted signal -> fallback, no archive", async () => {
    const ac = new AbortController(); ac.abort();
    const i = input([reply(snapshot())], { signal: ac.signal });
    await fails(summarize(i), "aborted");
    expect(existsSync(archivePath(i.sessionId))).toBe(false);
  });
  test("capacity -> fallback without calling the model", async () => {
    const i = input([reply(snapshot())], { model: { ...model, contextWindow: 16000 } });
    await fails(summarize(i), "capacity");
    expect(calls.length).toBe(0);
  });
  test("file lists inherit previous compaction details (even fromHook)", async () => {
    const branchEntries = [{ type: "compaction", fromHook: true, details: { readFiles: ["/r1"], modifiedFiles: ["/m1"] } }];
    const out = await summarize(input([reply(snapshot())], { branchEntries }));
    expect(out.compaction.details).toEqual({ readFiles: ["/r1", "/r2"], modifiedFiles: ["/m1", "/w2"] });
  });
  test("archive appends across compactions", async () => {
    const sessionId = "same-session";
    await summarize(input([reply(snapshot())], { sessionId }));
    const i = input([reply(snapshot())], { sessionId });
    i.preparation.previousSummary = "SECOND";
    await summarize(i);
    const text = readFileSync(archivePath(sessionId), "utf8");
    expect(text.indexOf("OLD SUMMARY")).toBeLessThan(text.indexOf("SECOND"));
  });
  test("non-reasoning model gets no reasoningEffort", async () => {
    await summarize(input([reply(snapshot())], { model: { ...model, reasoning: false } }));
    expect(calls[0].opts.reasoningEffort).toBeUndefined();
  });
});

describe("subagent task brief", () => {
  const entries = (brief: string) => [{ type: "message", id: "11111111", message: user(brief) }];
  test("brief kept verbatim in Goal", async () => {
    const brief = "Implement X in /a/b.ts; run bun test; do not push.";
    const out = await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries(brief) }));
    const goal = out.compaction.summary.split("## Authorization")[0];
    expect(goal).toContain(brief);
  });
  test("subagent normal budget: other sections get 4800, not 6000", async () => {
    await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries("t") }));
    expect(calls[0].ctx.systemPrompt).toContain("<= 4800 tokens");
    expect(calls[0].ctx.systemPrompt).toContain("Authorization & Constraints: 300");
  });
  test("long brief on a persisted session: head + entry pointer", () => {
    const text = taskBrief(entries("长任务说明".repeat(2000)), "/s/file.jsonl")!;
    expect(text).toContain("[truncated; full brief: /s/file.jsonl entry 11111111]");
    expect(textTokens(text)).toBeLessThan(2200);
  });
  test("long brief on an in-memory session: kept whole", () => {
    const brief = "长任务说明".repeat(500);
    expect(taskBrief(entries(brief), undefined)).toContain(brief);
  });
  test("tight 3k budget: brief untouched, prompt budget shrinks", async () => {
    const brief = "brief ".repeat(300).trim();
    const out = await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries(brief), budget: 3000 }));
    expect(out.compaction.summary).toContain(brief);
    expect(calls[0].ctx.systemPrompt).toContain("<= 2400 tokens");
  });
});

afterAll(() => {
  const now = existsSync(prodLog) ? statSync(prodLog).mtimeMs : null;
  expect(now).toBe(prodLogBefore);
});
