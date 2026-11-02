// One-off measurement: how much of the summary input the capped serializer saves on real sessions.
// usage: bun scripts/eval-serialize.ts <session.jsonl> [...]
import { readFileSync } from "node:fs";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { serializeForSummary } from "../src/summary.ts";
import { textTokens } from "../src/estimate.ts";

for (const file of process.argv.slice(2)) {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  // Converted first, exactly like summarize(): projected roles (bashExecution, custom, ...) must not be measured as absent.
  const msgs = convertToLlm(entries.filter(e => e.type === "message").map(e => e.message));
  const pi = textTokens(serializeConversation(msgs));
  const full = textTokens(serializeForSummary(msgs, "full"));
  const tight = textTokens(serializeForSummary(msgs, "tight"));
  const pct = (n: number) => `${Math.round((1 - n / pi) * 100)}%`;
  console.log(`${file.split("/").pop()!.slice(0, 24)}  msgs=${msgs.length}  pi=${pi}  full=${full} (-${pct(full)})  tight=${tight} (-${pct(tight)})`);
}
