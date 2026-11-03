import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-compact-test-"));
process.env.PI_COMPACT_DIR = tmp;
const prodLog = path.join(os.homedir(), ".pi/agent/pi-compact.log");
const prodLogBefore = existsSync(prodLog) ? statSync(prodLog).mtimeMs : null;

const { summarize, SECTIONS, Fallback, archivePath, dataDir, taskBrief, HARD_CAP, BRIEF_CAP, MAIN_BRIEF_CAP, serializeForSummary, SUMMARY_PROFILE, checkStructure, insertBrief } = await import("../src/summary.ts");
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

describe("data directory", () => {
  test("uses the host agent directory unless PI_COMPACT_DIR overrides it", () => {
    const compactDir = process.env.PI_COMPACT_DIR, agentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
      expect(dataDir()).toBe(compactDir!);
      delete process.env.PI_COMPACT_DIR;
      expect(dataDir()).toBe(process.env.PI_CODING_AGENT_DIR!);
    } finally {
      process.env.PI_COMPACT_DIR = compactDir;
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
    }
  });
});

describe("summarize", () => {
  test("normal: 8 sections, archive pointer, low reasoning, previous summary archived", async () => {
    const i = input([reply(snapshot())]);
    const out = await summarize(i);
    expect(out.compaction.summary).toContain("## Next Steps");
    expect(out.compaction.summary).toContain(`Older details: ${archivePath(i.sessionId)}`);
    expect(calls[0].opts).toMatchObject({ maxTokens: 12288, reasoning: "low", cacheRetention: "none" });
    expect(readFileSync(archivePath(i.sessionId), "utf8")).toContain("OLD SUMMARY");
  });
  test("restorable pointer block, still exactly 8 headings", async () => {
    const i = input([reply(snapshot())]);
    const out = await summarize(i);
    expect(out.compaction.summary).toContain("read_tool_result(entryId, offset, limit)");
    expect(out.compaction.summary).toContain(archivePath(i.sessionId));
    expect(out.compaction.summary.split("\n").filter(l => l.startsWith("## ")).length).toBe(8);
  });
  test("failed attempts never append previous summaries", async () => {
    for (const failure of ["model", "structure", "over-cap", "abort", "length"]) {
      const big = snapshot("word ".repeat(8000));
      const ac = new AbortController();
      const i = input([reply(snapshot())], { signal: ac.signal });
      // Keep an existing archive too: failures must not duplicate its sections.
      await summarize(i);
      const before = readFileSync(archivePath(i.sessionId), "utf8");
      i.complete = async () => {
        if (failure === "model") throw new Error("model failed");
        if (failure === "abort") ac.abort();
        return reply(failure === "structure" ? "bad structure" : failure === "over-cap" ? big : snapshot(), failure === "length" ? "length" : "stop");
      };
      expect(await summarize(i).then(() => false, () => true)).toBe(true);
      expect(readFileSync(archivePath(i.sessionId), "utf8")).toBe(before);
    }
  });
  test("archive write failure reuses the model text without any pointer", async () => {
    const dir = process.env.PI_COMPACT_DIR;
    process.env.PI_COMPACT_DIR = "/dev/null/blocked";
    try {
      const i = input([reply(snapshot())]);
      const out = await summarize(i);
      expect(calls).toHaveLength(1);
      expect(out.compaction.summary).toContain("not archived (write failed)");
      expect(out.compaction.summary).not.toContain(archivePath(i.sessionId));
      expect(out.tokens).toBeLessThanOrEqual(HARD_CAP);
    } finally { process.env.PI_COMPACT_DIR = dir; }
  });
  test("an earlier archive remains addressable with no previous summary this time", async () => {
    const i = input([reply(snapshot()), reply(snapshot())]);
    await summarize(i);
    i.preparation.previousSummary = undefined as any;
    expect((await summarize(i)).compaction.summary).toContain(archivePath(i.sessionId));
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
  test("non-reasoning model gets no reasoning option; virtual model does", async () => {
    await summarize(input([reply(snapshot())], { model: { ...model, reasoning: false } }));
    expect(calls[0].opts.reasoning).toBeUndefined();
    await summarize(input([reply(snapshot())], { model: { ...model, api: "pi-virtual", reasoning: undefined } }));
    expect(calls[0].opts.reasoning).toBe("low");
  });
  test("model without a context window uses the session window instead of failing capacity", async () => {
    await fails(summarize(input([reply(snapshot())], { model: { ...model, contextWindow: 0 }, contextWindow: 16000 })), "capacity");
    const out = await summarize(input([reply(snapshot())], { model: { ...model, contextWindow: 0 }, contextWindow: 128000 }));
    expect(out.compaction.summary).toContain("## Goal");
  });
});

describe("serializeForSummary", () => {
  test("prefixes and blank-line separation match pi's conversation format", () => {
    const text = serializeForSummary([
      user("hello"),
      { role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", name: "read", arguments: { path: "/a.ts" } }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] },
    ]);
    expect(text).toBe("[User]: hello\n\n[Assistant]: working\n\n[Assistant tool calls]: read(path=/a.ts)\n\n[Tool result]: file body");
  });
  test("only tight caps user text, keeping authorizations at both ends", () => {
    const long = `AUTHORIZED START${"u".repeat(10000)}DO NOT PUSH`;
    expect(serializeForSummary([user(long)], "full")).toBe(`[User]: ${long}`);
    const tight = serializeForSummary([user(long)], "tight");
    expect(tight).toContain(`[+${long.length - 4000} chars of user text omitted]`);
    expect(tight).toContain("AUTHORIZED START");
    expect(tight.endsWith("DO NOT PUSH")).toBe(true);
  });
  test("assistant text is capped per profile, thinking is dropped", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "t".repeat(9000) }] };
    const full = serializeForSummary([msg], "full"), tight = serializeForSummary([msg], "tight");
    expect(full).not.toContain("secret reasoning");
    expect(full).toContain(`[+${9000 - SUMMARY_PROFILE.full.text} chars]`);
    expect(tight).toContain(`[+${9000 - SUMMARY_PROFILE.tight.text} chars]`);
    expect(tight.length).toBeLessThan(full.length);
  });
  test("toolCall args are capped; command gets its own bigger cap; objects are stringified first", () => {
    const msg = { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "c".repeat(2000), edits: [{ oldText: "o".repeat(900) }] } }] };
    const full = serializeForSummary([msg], "full");
    expect(full).toContain(`[+${2000 - SUMMARY_PROFILE.full.command} chars]`);
    expect(full).toContain(`[+${JSON.stringify([{ oldText: "o".repeat(900) }]).length - SUMMARY_PROFILE.full.args} chars]`);
    expect(serializeForSummary([msg], "tight")).toContain(`[+${2000 - SUMMARY_PROFILE.tight.command} chars]`);
  });
  test("tool results keep head and tail, with the dropped middle marked", () => {
    const body = `HEAD${"m".repeat(1000)}TAIL`;
    const text = serializeForSummary([{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: body }] }]);
    expect(text.startsWith("[Tool result]: HEADmmm")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toContain(`[+${body.length - SUMMARY_PROFILE.full.resultHead - SUMMARY_PROFILE.full.resultTail} chars]`);
  });
  test("short tool results are untouched", () => {
    expect(serializeForSummary([{ role: "toolResult", content: "small" }])).toBe("[Tool result]: small");
  });
  test("projected roles (bashExecution, custom) survive via convertToLlm", () => {
    const projected = [{ role: "user", content: "hi" }, { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 }, { role: "custom", content: "injected note" }];
    const text = serializeForSummary(convertToLlm(projected));
    expect(text).toContain("Ran `ls`");
    expect(text).toContain("a\nb");
    expect(text).toContain("injected note");
  });
  test("no messages -> empty string", () => {
    expect(serializeForSummary([])).toBe("");
  });
  test("unknown roles are dropped", () => {
    expect(serializeForSummary([{ role: "system", content: "sys prompt" }, user("hi")])).toBe("[User]: hi");
  });
  test("assistant with only tool calls emits no [Assistant]: line", () => {
    const text = serializeForSummary([{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/a" } }] }]);
    expect(text).toBe("[Assistant tool calls]: read(path=/a)");
  });
  test("toolCall without arguments renders name()", () => {
    expect(serializeForSummary([{ role: "assistant", content: [{ type: "toolCall", name: "ls", arguments: undefined }] }])).toBe("[Assistant tool calls]: ls()");
  });
  test("truncation never leaves a lone surrogate", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const shapes = ["a".repeat(9000), "汉字".repeat(4000), `x${"🙂".repeat(400)}`, "🙂a".repeat(500), `${"y".repeat(400)} ${"🙂".repeat(200)}`];
    for (const profile of ["full", "tight"] as const) for (const text of shapes) {
      const tool = serializeForSummary([{ role: "toolResult", content: [{ type: "text", text }] }], profile);
      const assistant = serializeForSummary([{ role: "assistant", content: [{ type: "text", text }] }], profile);
      const arg = serializeForSummary([{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: text, edits: [text] } }] }], profile);
      expect(lone.test(tool + assistant + arg)).toBe(false);
    }
  });
});

describe("capacity degrade", () => {
  const big = () => ({ role: "assistant", content: [{ type: "text", text: "y".repeat(5000) }] });
  const flood = (n: number) => ({ preparation: { messagesToSummarize: [user("go"), ...Array.from({ length: n }, big)], turnPrefixMessages: [],
    firstKeptEntryId: "aaaaaaaa", tokensBefore: 90000, previousSummary: "OLD SUMMARY", fileOps: {} } });
  test("a huge user paste cannot fit full but fits tight with an omission marker", async () => {
    const paste = `allow edits${"x".repeat(2_000_000)}do not push`;
    const i = input([reply(snapshot())], { preparation: { messagesToSummarize: [user(paste)], turnPrefixMessages: [],
      firstKeptEntryId: "aaaaaaaa", tokensBefore: 500_000 }, model });
    const out = await summarize(i);
    expect(out.compressed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.messages[0].content[0].text).toContain("chars of user text omitted]");
    expect(calls[0].ctx.messages[0].content[0].text).toContain("do not push");
  });
  test("full over capacity, tight fits -> one call, compressed flag, no fallback", async () => {
    const i = input([reply(snapshot())], { ...flood(100), model: { ...model, contextWindow: 120000 } });
    const out = await summarize(i);
    expect(out.compressed).toBe(true);
    expect(calls.length).toBe(1);
    // tight truncated the 5000-char texts at 1200 chars, i.e. the second profile was the one sent
    expect(calls[0].ctx.messages[0].content[0].text).toContain(`[+${5000 - SUMMARY_PROFILE.tight.text} chars]`);
    expect(out.compaction.summary).toContain("## Goal");
  });
  test("both profiles over capacity -> fallback without calling the model", async () => {
    const i = input([reply(snapshot())], { ...flood(1000), model: { ...model, contextWindow: 120000 } });
    await fails(summarize(i), "capacity");
    expect(calls.length).toBe(0);
  });
  test("full fits -> compressed stays false", async () => {
    const out = await summarize(input([reply(snapshot())], { model }));
    expect(out.compressed).toBe(false);
  });
  test("no window on either the model or the session -> no capacity fallback", async () => {
    const out = await summarize(input([reply(snapshot())], { model: { ...model, contextWindow: undefined }, contextWindow: undefined }));
    expect(out.compressed).toBe(false);
    expect(out.compaction.summary).toContain("## Next Steps");
  });
  test("tight then condense: compressed stays true", async () => {
    const out = await summarize(input([reply(snapshot("word ".repeat(8000))), reply(snapshot())], { ...flood(100), model: { ...model, contextWindow: 120000 } }));
    expect(calls.length).toBe(2);
    expect(out.compressed).toBe(true);
    expect(out.condensed).toBe(true);
  });
});

describe("structure tolerance", () => {
  test("an extra unknown section is ignored", () => {
    expect(() => checkStructure(`${snapshot()}\n\n## Notes\nwhatever`)).not.toThrow();
  });
  test("headings inside a fenced code block do not count", () => {
    const text = snapshot().replace("## Key Decisions\nx", "## Key Decisions\n```\n## Goal\n## Notes\n```");
    expect(() => checkStructure(text)).not.toThrow();
    expect(() => checkStructure(snapshot("```\n## Goal\n```"))).not.toThrow();
  });
  test("trailing spaces and CRLF on headings are tolerated", () => {
    expect(() => checkStructure(SECTIONS.map(s => `## ${s}   \r\nx`).join("\r\n"))).not.toThrow();
  });
  test("a renamed section still falls back", () => {
    const text = snapshot().replace("## Key Decisions", "## Decisions");
    expect(() => checkStructure(text)).toThrow(Fallback);
  });
  test("a duplicated section counts once, so a missing one still falls back", () => {
    expect(() => checkStructure(snapshot() + `\n\n## Goal\nagain`)).not.toThrow();
    expect(() => checkStructure(snapshot().replace("## Next Steps", "## Goal"))).toThrow(Fallback);
  });
  test("a snapshot wrapped entirely in a code fence has no headings left", () => {
    expect(() => checkStructure(`\`\`\`markdown\n${snapshot()}\n\`\`\``)).toThrow(Fallback);
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
  test("snapshot under 8k but over after adding brief + pointer -> condense once, then succeed", async () => {
    const brief = "brief ".repeat(1200).trim(); // ~1.8k tokens, under the 2k brief cap (in-memory is capped too now)
    const raw = snapshot("word ".repeat(6400 / 8 * 4 / 5)); // ~6.4k tokens on its own
    const out = await summarize(input([reply(raw), reply(snapshot())], { isSubagent: true, branchEntries: entries(brief) }));
    expect(calls.length).toBe(2);
    expect(out.condensed).toBe(true);
    expect(out.compaction.summary).toContain(brief);
    expect(out.tokens).toBeLessThanOrEqual(HARD_CAP);
  });
  test("long brief on a persisted session: head + entry pointer", () => {
    const text = taskBrief(entries("长任务说明".repeat(2000)), "/s/file.jsonl")!;
    expect(text).toContain("[truncated; full brief: /s/file.jsonl entry 11111111]");
    expect(textTokens(text)).toBeLessThan(2200);
  });
  test("long brief on an in-memory session: truncated with an honest marker", () => {
    const brief = "长任务说明".repeat(3000);
    const text = taskBrief(entries(brief), undefined)!;
    expect(text).toContain("[truncated; in-memory session, full text is not addressable]");
    expect(text).not.toContain("full brief:");
    expect(textTokens(text)).toBeLessThanOrEqual(BRIEF_CAP + 100); // marker text is not budget
  });
  test("in-memory with a huge first message: one model call, no over-cap fallback", async () => {
    const brief = "长任务说明".repeat(3000);
    const out = await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries(brief) }));
    expect(calls.length).toBe(1);
    expect(out.condensed).toBe(false);
    expect(out.compaction.summary).toContain("## Next Steps");
  });
  test("insertBrief handles a Goal heading on the last line without a newline", () => {
    expect(insertBrief("## Goal", "BRIEF")).toBe("## Goal\nBRIEF\n\n");
    expect(insertBrief("## Goals\nx", "BRIEF")).toBe("## Goals\nx");
  });
  test("first user message with no text (image only) -> no brief block, snapshot still produced", async () => {
    const entries_ = [{ type: "message", id: "33333333", message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } }];
    expect(taskBrief(entries_, undefined)).toBeUndefined();
    const out = await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries_ }));
    expect(out.compaction.summary).not.toContain("Task brief (verbatim");
    expect(out.compaction.summary).toContain("## Goal");
  });
  test("insertBrief tolerates trailing spaces and CRLF", async () => {
    const brief = "verbatim brief";
    const raw = snapshot().replace("## Goal", "## Goal   ").replace(/\n/g, "\r\n");
    const out = await summarize(input([reply(raw)], { isSubagent: true, branchEntries: entries(brief) }));
    expect(out.compaction.summary).toContain(`## Goal\nTask brief (verbatim, from parent):`);
    expect(out.compaction.summary).toContain(brief);
  });
  test("tight 3k budget: brief untouched, prompt budget shrinks", async () => {
    const brief = "brief ".repeat(300).trim();
    const out = await summarize(input([reply(snapshot())], { isSubagent: true, branchEntries: entries(brief), budget: 3000 }));
    expect(out.compaction.summary).toContain(brief);
    expect(calls[0].ctx.systemPrompt).toContain("<= 2400 tokens");
  });
});

describe("main session first user message", () => {
  const entries = (request: string) => [{ type: "message", id: "22222222", message: user(request) }];
  test("first user message kept verbatim as context, not the current goal", async () => {
    const request = "Build X in /a/b.ts; run bun test; do not push.";
    const out = await summarize(input([reply(snapshot())], { isSubagent: false, branchEntries: entries(request) }));
    const goal = out.compaction.summary.split("## Authorization")[0];
    expect(goal).toContain("Session's first user message (verbatim; may be superseded by later requests):");
    expect(goal).toContain(request);
    expect(out.compaction.summary).not.toContain("Task brief (verbatim, from parent)");
  });
  test("no first user message -> no request block", async () => {
    const out = await summarize(input([reply(snapshot())], { isSubagent: false }));
    expect(out.compaction.summary).not.toContain("Session's first user message");
  });
  test("the verbatim request comes out of the snapshot budget, so no condense call", async () => {
    const request = "word ".repeat(1500).trim(); // ~1.9k tokens before the main-only 600-token cap
    const out = await summarize(input([reply(snapshot())], { isSubagent: false, branchEntries: entries(request) }));
    expect(calls.length).toBe(1);
    expect(out.condensed).toBe(false);
    expect(calls[0].ctx.systemPrompt).not.toContain("<= 6000 tokens");
    expect(calls[0].ctx.systemPrompt).toMatch(/Total budget: <= 5\d{3} tokens/);
    expect(calls[0].ctx.systemPrompt).toContain("Goal must state the CURRENT goal");
    const brief = taskBrief(entries(request), undefined, "main")!;
    expect(textTokens(brief)).toBeLessThanOrEqual(MAIN_BRIEF_CAP);
    expect(brief).toContain("[truncated;");
  });
});

describe("addressable pruned restore list", () => {
  const tool = (id: string) => ({ type: "message", id, message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "🙂".repeat(9000) }] } });
  const edit = (id: string) => ({ type: "context_edit", targetId: id, replacement: { content: [{ type: "text", text: `[tool_result pruned; raw entry ${id}; use read_tool_result]` }] } });
  const setup = (n = 25) => {
    const tools = Array.from({ length: n }, (_, j) => tool(`result-${j}`));
    const kept = tool("kept");
    return { branchEntries: [...tools, kept, ...tools.map(t => edit(t.id)), edit(kept.id)],
      preparation: { messagesToSummarize: tools.map(t => ({ ...t.message, ...edit(t.id).replacement })), turnPrefixMessages: [],
        firstKeptEntryId: kept.id, tokensBefore: 90000 } };
  };
  test("newest 20 summarized results are addressable, kept results excluded", async () => {
    const out = await summarize(input([reply(snapshot())], setup()));
    const text = out.compaction.summary;
    expect(text).toContain("pruned tool results listed below");
    expect(text).toContain("result-24 read 9000\nresult-23 read 9000");
    expect(text).toContain("result-5 read 9000\n+5 more");
    expect(text).not.toContain("result-4 read");
    expect(text).not.toContain("kept read");
    expect(text.split("\n").filter(l => l.startsWith("## "))).toHaveLength(8);
    expect(out.tokens).toBe(textTokens(text));
  });
  test("later reverted/replaced edits and results outside this summary range are excluded", async () => {
    const i = setup(4);
    i.branchEntries.push({ type: "context_edit", targetId: "result-3", replacement: null } as any,
      { type: "context_edit", targetId: "result-2", replacement: { content: [{ type: "text", text: "not pruned" }] } });
    i.branchEntries.unshift(tool("old"), edit("old"));
    i.branchEntries.push({ type: "compaction", firstKeptEntryId: "result-1" } as any);
    i.preparation.messagesToSummarize.push(tool("old").message);
    const text = (await summarize(input([reply(snapshot())], i))).compaction.summary;
    expect(text).toContain("result-1 read 9000");
    for (const id of ["result-0", "result-2", "result-3", "old", "kept"]) expect(text).not.toContain(`${id} read`);
  });
  test("no listed results: restore wording only covers markers still visible in kept messages", async () => {
    const text = (await summarize(input([reply(snapshot())]))).compaction.summary;
    expect(text).toContain("pruned tool-result markers still visible in kept messages");
    expect(text).not.toContain("pruned tool results listed below");
    expect(text).not.toContain("Pruned tool results (entryId");
  });
  test("restore list is charged to the assembled hard cap", async () => {
    const raw = snapshot("word ".repeat(7920 * 4 / 5 / 8));
    expect(textTokens(raw)).toBeLessThanOrEqual(HARD_CAP);
    const out = await summarize(input([reply(raw), reply(snapshot())], setup()));
    expect(out.condensed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(out.compaction.summary).toContain("result-24 read 9000");
    expect(out.tokens).toBeLessThanOrEqual(HARD_CAP);
  });
});

afterAll(() => {
  const now = existsSync(prodLog) ? statSync(prodLog).mtimeMs : null;
  expect(now).toBe(prodLogBefore);
});
