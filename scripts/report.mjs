#!/usr/bin/env node
// Read-only: per-compaction stats for one session JSONL. Usage: node report.mjs <session.jsonl>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: report.mjs <session.jsonl>"); process.exit(2); }
const entries = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
const cjk = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const textTokens = s => { const c = s.match(cjk)?.length ?? 0; return c + Math.ceil((s.length - c) / 4); };
const total = u => u?.totalTokens || (u ? u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined);

const rows = [];
let prev;
entries.forEach((e, i) => {
  if (e.type !== "compaction") return;
  const next = entries.slice(i + 1).find(x => x.type === "message" && x.message.role === "assistant" && total(x.message.usage) > 0);
  const t = Date.parse(e.timestamp);
  rows.push({ time: e.timestamp.slice(0, 19), hook: e.fromHook ? "plugin" : "native", tokensBefore: e.tokensBefore,
    summaryTokens: textTokens(e.summary ?? ""), firstTurnAfter: total(next?.message.usage) ?? "unknown",
    gapSec: prev ? Math.round((t - prev) / 1000) : "-" });
  prev = t;
});
const truncated = entries.filter(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "length" && (e.message.usage?.output ?? 0) <= 16)
  .map(e => e.timestamp.slice(0, 19));
console.table(rows);
console.log(`compactions=${rows.length} length-truncations(output<=16)=${truncated.length}${truncated.length ? " at " + truncated.join(", ") : ""}`);
const s = rows.map(r => r.summaryTokens);
const monotonic = s.length >= 3 && s.slice(-3).every((v, i, a) => i === 0 || v > a[i - 1]);
console.log(`check: maxSummary=${Math.max(0, ...s)} (<=8000) firstTurnAfter<=55000:${rows.every(r => r.firstTurnAfter === "unknown" || r.firstTurnAfter <= 55000)} gaps>60s:${rows.every(r => r.gapSec === "-" || r.gapSec > 60)} last3Monotonic:${monotonic}`);
