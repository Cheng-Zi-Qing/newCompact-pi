// Standing regression test: rerun after every pi upgrade. Compares our public-API estimator with pi's internal one.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateProjectedTokens } from "../src/estimate.ts";

const internalPath = path.join(os.homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js");
const { estimateProjectedContextTokens: internal } = await import(internalPath);
const internalSM = (await import(path.join(path.dirname(internalPath), "../session-manager.js"))).SessionManager;

function compare(entries: any[]) {
  const ours = SessionManager.inMemory("/tmp", undefined, structuredClone(entries));
  const theirs = internalSM.inMemory("/tmp", undefined, structuredClone(entries));
  return [estimateProjectedTokens(ours.buildSessionProjection(), ours.getBranch()),
    internal(theirs.buildSessionProjection(), theirs.getBranch()).tokens];
}

const header = { type: "session", version: 3, id: "01a00000-0000-7000-8000-000000000000", timestamp: "2026-10-29T00:00:00.000Z", cwd: "/tmp" };
let n = 0;
const id = () => (++n).toString(16).padStart(8, "0");
function chain(items: any[]) {
  let parent: string | null = null;
  return [header, ...items.map(item => { const e = { id: id(), parentId: parent, timestamp: "2026-10-29T00:00:00.000Z", ...item }; parent = e.id; return e; })];
}
const user = (t: string) => ({ type: "message", message: { role: "user", content: t, timestamp: 1 } });
const usage = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const asst = (t: string, total: number, stopReason = "stop") => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }], usage: usage(total), stopReason, api: "x", provider: "x", model: "x", timestamp: 2 } });

describe("estimateProjectedTokens matches pi internal", () => {
  const cases: Record<string, any[]> = {
    "no usage": chain([user("hello world ".repeat(50))]),
    "valid usage + trailing": chain([user("a"), asst("b", 5000), user("trailing ".repeat(100))]),
    "zero usage": chain([user("a"), asst("b", 0)]),
    "error usage": chain([user("a"), asst("b", 9000, "error"), user("c")]),
    "aborted usage": chain([user("a"), asst("b", 9000, "aborted")]),
  };
  for (const [name, entries] of Object.entries(cases)) test(name, () => { const [a, b] = compare(entries); expect(a).toBe(b); expect(a).toBeGreaterThan(0); });

  test("context_edit after usage invalidates it", () => {
    const entries = chain([user("a"), { type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) }], isError: false, timestamp: 2 } }, asst("b", 50000)]);
    const tool = entries[2];
    let parent = entries.at(-1).id;
    entries.push({ type: "context_edit", id: id(), parentId: parent, timestamp: "2026-10-29T00:00:00.000Z", targetId: tool.id, replacement: { content: [{ type: "text", text: "short" }] } });
    const [a, b] = compare(entries);
    expect(a).toBe(b);
    expect(a).toBeLessThan(50000);
  });

  // Real data: the newest local session files, if any (skipped on machines without pi sessions).
  const sessionsRoot = process.env.PI_SESSIONS_DIR ?? path.join(os.homedir(), ".pi/agent/sessions");
  const realFiles = existsSync(sessionsRoot) ? readdirSync(sessionsRoot, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => readdirSync(path.join(sessionsRoot, d.name)).filter(f => f.endsWith(".jsonl")).map(f => path.join(sessionsRoot, d.name, f)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 5) : [];
  test.skipIf(realFiles.length === 0)("newest real sessions on disk", () => {
    for (const f of realFiles) {
      // A live session may be mid-append; drop an incomplete trailing line.
      const entries = readFileSync(f, "utf8").split("\n").flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
      const [a, b] = compare(entries);
      expect(a).toBe(b);
    }
  });
});
