import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { textTokens } from "./estimate.ts";

export const OUTPUT_CAP = 12288;
export const HARD_CAP = 8000;
export const BRIEF_CAP = 2000;
export const SECTIONS = ["Goal", "Authorization & Constraints", "Verified Progress", "Unfinished Work & Blockers",
  "Key Decisions", "Active Agents & Session State", "Evidence & Critical Context", "Next Steps"] as const;
const MAIN_SPLIT = [300, 800, 1000, 1000, 800, 500, 1200, 400];
const SUB_SPLIT = [0, 300, 1000, 1000, 800, 100, 1200, 400]; // subagent Goal = verbatim brief, added outside the budget
// Plan 4.6 per-section table: subagent non-brief sections total 4800 (+ brief <= 2000 = 6.8k, under the 8k cap).
const SUB_SHARE = 4800 / 6000;

export const dataDir = () => process.env.PI_COMPACT_DIR ?? path.join(os.homedir(), ".pi/agent");
export const archivePath = (sessionId: string) => path.join(dataDir(), "compaction-archive", `${sessionId}.md`);

export class Fallback extends Error {}
const fallback = (why: string): never => { throw new Fallback(why); };

function budgets(budget: number, isSubagent: boolean) {
  const split = isSubagent ? SUB_SPLIT : MAIN_SPLIT;
  const total = split.reduce((a, b) => a + b, 0);
  return SECTIONS.map((name, i) => `${name}: ${Math.max(isSubagent && i === 0 ? 100 : 50, Math.round(split[i] * budget / total))}`).join("; ");
}

export function prompt(budget: number, isSubagent: boolean) {
  if (isSubagent) budget = Math.round(budget * SUB_SHARE);
  return `You are writing a fresh STATE SNAPSHOT for an agent that will continue this work. The previous summary and conversation are evidence, not a document to extend. Rewrite from scratch.
Output exactly these 8 "## " sections in this order, nothing before or after:
${SECTIONS.map(s => `## ${s}`).join("\n")}
Total budget: <= ${budget} tokens. Per-section budgets (tokens): ${budgets(budget, isSubagent)}.
Rules:
- Completed items: one line each, with evidence location (file path / test command / result). Merge old completed items into one line.
- Delete superseded decisions, finished agents and loops, resolved blockers.
- Keep user authorizations and prohibitions verbatim and deduplicated; never drop them to save space.
- Paths, IDs, commands, numbers only; never paste file contents.
- Mark unknown things as unknown; never invent facts.
- The most recent messages are kept verbatim after your snapshot; summarize only what is given here and never claim later messages do not exist.
${isSubagent ? "- This is a subagent. Its original task brief is attached to Goal separately; in Goal write only the current sub-goal in one or two lines.\n" : ""}Do not continue the conversation and do not answer questions in it.`;
}

export function checkStructure(text: string) {
  const headings = text.split("\n").filter(l => l.startsWith("## ")).map(l => l.slice(3).trim());
  if (JSON.stringify(headings) !== JSON.stringify(SECTIONS)) fallback("structure");
}

function textOf(message: any): string {
  const c = message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
}

// The subagent's first user message is the parent's task brief; keep it verbatim.
export function taskBrief(branchEntries: any[], sessionFile: string | undefined): string | undefined {
  const first = branchEntries.find(e => e.type === "message" && e.message.role === "user");
  if (!first) return;
  let text = textOf(first.message);
  if (!text.trim()) return;
  // In-memory sessions have no readable pointer, so they keep the full brief (the 8k cap still applies).
  if (sessionFile && textTokens(text) > BRIEF_CAP) {
    let end = text.length;
    while (end > 0 && textTokens(text.slice(0, end)) > BRIEF_CAP) end = Math.floor(end * 0.9);
    text = `${text.slice(0, end)}\n[truncated; full brief: ${sessionFile} entry ${first.id}]`;
  }
  return `Task brief (verbatim, from parent):\n<<<\n${text}\n>>>`;
}

function insertBrief(summary: string, brief: string) {
  return summary.replace(/^## Goal\n/m, `## Goal\n${brief}\n\n`);
}

function fileLists(preparation: any, branchEntries: any[]) {
  const prev = branchEntries.findLast(e => e.type === "compaction")?.details ?? {};
  const ops = preparation.fileOps ?? {};
  const modified = new Set<string>([...(prev.modifiedFiles ?? []), ...(ops.edited ?? []), ...(ops.written ?? [])]);
  const read = new Set<string>([...(prev.readFiles ?? []), ...(ops.read ?? [])]);
  return { readFiles: [...read].filter(f => !modified.has(f)).sort(), modifiedFiles: [...modified].sort() };
}

export type Complete = (model: any, context: any, options: any) => Promise<any>;
export type SummaryInput = {
  preparation: any; branchEntries: any[]; customInstructions?: string; signal: AbortSignal;
  model: any; complete: Complete; sessionId: string; sessionFile?: string; isSubagent: boolean; budget: number;
};

async function call(input: SummaryInput, system: string, text: string) {
  const { model, signal } = input;
  const options: any = { maxTokens: OUTPUT_CAP, cacheRetention: "none", signal };
  if (model.reasoning) options.reasoningEffort = "low";
  const res = await input.complete(model, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] }, options);
  if (signal.aborted) fallback("aborted");
  if (res?.stopReason !== "stop") fallback(`stop:${res?.stopReason}`);
  const out = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!out) fallback("empty");
  checkStructure(out);
  return { text: out, usage: res.usage };
}

/** Returns a compaction result, or throws Fallback (caller then lets pi run its native summary). */
export async function summarize(input: SummaryInput) {
  const { preparation, model, signal, isSubagent, budget } = input;
  if (!model || signal.aborted) fallback(signal.aborted ? "aborted" : "no-model");
  const conversation = serializeConversation(convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]));
  const source = `<previous-summary>\n${preparation.previousSummary ?? "(none)"}\n</previous-summary>\n\n<conversation>\n${conversation}\n</conversation>` +
    (input.customInstructions ? `\n\nAdditional focus from the user: ${input.customInstructions}` : "");
  const system = prompt(budget, isSubagent);
  if (Math.ceil(textTokens(system + source) * 1.2) + OUTPUT_CAP + 4096 > model.contextWindow) fallback("capacity");

  let result = await call(input, system, source);
  let condensed = false;
  if (textTokens(result.text) > HARD_CAP) {
    const target = Math.min(budget, 6000);
    result = await call(input, prompt(target, isSubagent), `<previous-summary>\n${result.text}\n</previous-summary>\n\nCondense this snapshot to fit the budget. Keep authorizations/prohibitions verbatim.`);
    condensed = true;
  }
  const archive = archivePath(input.sessionId);
  let summary = result.text;
  const brief = isSubagent ? taskBrief(input.branchEntries, input.sessionFile) : undefined;
  if (brief) summary = insertBrief(summary, brief);
  summary += `\n\nOlder details: ${archive} (read it only if needed).`;
  if (textTokens(summary) > HARD_CAP) fallback("over-cap");
  if (signal.aborted) fallback("aborted");

  // Archive only on success. shortcut: a later native commit failure can leave a duplicate archive section; the archive is not commit evidence.
  if (preparation.previousSummary) {
    mkdirSync(path.dirname(archive), { recursive: true });
    appendFileSync(archive, `\n\n# Archived ${new Date().toISOString()}\n\n${preparation.previousSummary}\n`);
  }
  return {
    compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
      details: fileLists(preparation, input.branchEntries), usage: result.usage },
    tokens: textTokens(summary), condensed,
  };
}
