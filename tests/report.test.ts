import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "../scripts/report.mjs");
const run = (entries: any[]) => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "pi-compact-report-")), "s.jsonl");
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return execFileSync("node", [script, f], { encoding: "utf8" });
};
const compaction = { type: "compaction", timestamp: "2026-10-29T00:00:00.000Z", summary: "s", tokensBefore: 1, fromHook: true };
const asst = (total: number) => ({ type: "message", timestamp: "2026-10-29T00:00:01.000Z", message: { role: "assistant", stopReason: "stop", usage: { totalTokens: total, input: total, output: 0 } } });

test("missing post-compaction usage is reported as unknown, never as a pass", () => {
  expect(run([compaction])).toContain("firstTurnAfter<=55000:unknown");
});
test("known usage still passes / fails normally", () => {
  expect(run([compaction, asst(40_000)])).toContain("firstTurnAfter<=55000:true");
  expect(run([compaction, asst(70_000)])).toContain("firstTurnAfter<=55000:false");
});
