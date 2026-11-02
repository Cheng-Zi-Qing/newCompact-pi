import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
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

export const dataDir = () => process.env.PI_COMPACT_DIR ?? getAgentDir();
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
- If the previous snapshot's Goal already holds the user's verbatim request, do not copy it into the new Goal; write only the current goal.
- Paths, IDs, commands, numbers only; never paste file contents.
- Pointers (entry id / file path / command) beat pasted content: pruned tool results and archived snapshots stay retrievable, so a pointer loses nothing.
- Mark unknown things as unknown; never invent facts.
- The most recent messages are kept verbatim after your snapshot; summarize only what is given here and never claim later messages do not exist.
${isSubagent ? "- This is a subagent. Its original task brief is attached to Goal separately; in Goal write only the current sub-goal in one or two lines.\n" : ""}Do not continue the conversation and do not answer questions in it.`;
}

// Known names only, code fences ignored, duplicates count once: an extra "## Notes" must not cost the whole snapshot.
export function checkStructure(text: string) {
  const visible = text.replace(/```[\s\S]*?```/g, "");
  const seen = new Set<string>();
  const headings: string[] = [];
  for (const line of visible.split(/\r?\n/)) {
    if (!line.startsWith("## ")) continue;
    const name = line.slice(3).trim();
    if (!(SECTIONS as readonly string[]).includes(name) || seen.has(name)) continue;
    seen.add(name);
    headings.push(name);
  }
  if (JSON.stringify(headings) !== JSON.stringify(SECTIONS)) fallback("structure");
}

function textOf(message: any): string {
  const c = message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
}

// Same shape as pi's serializeConversation, but toolCall args and tool results are capped so file bodies and
// bash heredocs do not eat the summarizer's window. tight is the overflow fallback, never a second model call.
export const SUMMARY_PROFILE = {
  full: { args: 300, command: 500, resultHead: 300, resultTail: 100, text: 4000 },
  tight: { args: 120, command: 200, resultHead: 120, resultTail: 60, text: 1200 },
} as const;
export type SummaryProfile = keyof typeof SUMMARY_PROFILE;

// Slicing by UTF-16 units can land inside a surrogate pair; move the cut one unit left so the text stays valid.
const safeIndex = (text: string, i: number) => {
  const hi = text.charCodeAt(i - 1), lo = text.charCodeAt(i);
  return i > 0 && i < text.length && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? i - 1 : i;
};

const cut = (text: string, max: number) => {
  if (text.length <= max) return text;
  const end = safeIndex(text, max);
  return `${text.slice(0, end)}\n[+${text.length - end} chars]`;
};

// Bash errors land at the tail, so keep both ends instead of pi's head-only 2000 chars.
function headTail(text: string, head: number, tail: number) {
  if (text.length <= head + tail) return text;
  const end = safeIndex(text, head), start = safeIndex(text, text.length - tail);
  return `${text.slice(0, end)}\n[+${start - end} chars]\n${text.slice(start)}`;
}

const argValue = (v: any) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));

export function serializeForSummary(messages: any[], profile: SummaryProfile = "full"): string {
  const p = SUMMARY_PROFILE[profile];
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg?.role === "user") {
      const text = textOf(msg);
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg?.role === "assistant") {
      const text = textOf(msg); // text blocks only: thinking is dropped
      if (text) parts.push(`[Assistant]: ${cut(text, p.text)}`);
      const blocks = Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "toolCall") : [];
      const calls = blocks.map((b: any) => `${b.name}(${Object.entries(b.arguments ?? {})
        .map(([k, v]) => `${k}=${cut(argValue(v), k === "command" ? p.command : p.args)}`).join(", ")})`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (msg?.role === "toolResult") {
      const text = textOf(msg);
      if (text) parts.push(`[Tool result]: ${headTail(text, p.resultHead, p.resultTail)}`);
    }
  }
  return parts.join("\n\n");
}

// The subagent's first user message is the parent's task brief; a main session's is the user's original request.
// Both go in verbatim up to BRIEF_CAP.
export function taskBrief(branchEntries: any[], sessionFile: string | undefined, kind: "subagent" | "main" = "subagent"): string | undefined {
  const first = branchEntries.find(e => e.type === "message" && e.message.role === "user");
  if (!first) return;
  let text = textOf(first.message);
  if (!text.trim()) return;
  // Neither kind of session can carry the whole brief: it would push the snapshot over HARD_CAP and hand the
  // compaction back to pi. Only a persisted session has a readable pointer; an in-memory one has none, say so.
  if (textTokens(text) > BRIEF_CAP) {
    let end = text.length;
    while (end > 0 && textTokens(text.slice(0, end)) > BRIEF_CAP) end = Math.floor(end * 0.9);
    const where = sessionFile ? `full brief: ${sessionFile} entry ${first.id}` : "in-memory session, full text is not addressable";
    text = `${text.slice(0, safeIndex(text, end))}\n[truncated; ${where}]`;
  }
  const title = kind === "main" ? "Original request (verbatim, from user):" : "Task brief (verbatim, from parent):";
  return `${title}\n<<<\n${text}\n>>>`;
}

// No "## " heading: headings must stay at exactly the 8 SECTIONS. Tells the model that compaction is reversible.
// archived=false means the previous snapshot could not be written: say so instead of pointing at a missing file.
export function restoreBlock(archive: string, archived = true) {
  const where = archived ? `older snapshots in ${archive}` : "earlier snapshots were not archived (write failed), so this snapshot is the only record";
  return `Restorable: ${where}; pruned tool results marked "[tool_result pruned; raw entry <id>; use read_tool_result]" reopen via read_tool_result(entryId, offset, limit) when that tool is enabled. Newer messages verbatim.`;
}

export function insertBrief(summary: string, brief: string) {
  return summary.replace(/^## Goal[ \t]*(?=\r?\n|$)/m, `## Goal\n${brief}\n\n`);
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
  contextWindow?: number; // fallback when the model reports none (e.g. virtual models)
};

async function call(input: SummaryInput, system: string, text: string) {
  const { model, signal } = input;
  // Provider-neutral options for modelRegistry.streamSimple (handles every API and virtual models).
  const options: any = { maxTokens: OUTPUT_CAP, cacheRetention: "none", signal };
  if (model.reasoning || model.api === "pi-virtual") options.reasoning = "low";
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
  // Projected entries carry extra roles (bashExecution, custom, branchSummary, ...); convertToLlm maps them to
  // user/assistant/toolResult text, so nothing silently drops out of the summary input.
  const messages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
  const source = (profile: SummaryProfile) => `<previous-summary>\n${preparation.previousSummary ?? "(none)"}\n</previous-summary>\n\n<conversation>\n${serializeForSummary(messages, profile)}\n</conversation>` +
    (input.customInstructions ? `\n\nAdditional focus from the user: ${input.customInstructions}` : "");
  const brief = taskBrief(input.branchEntries, input.sessionFile, isSubagent ? "subagent" : "main");
  // A main session's request is kept verbatim in Goal, so it comes out of the snapshot budget; subagents use SUB_SHARE instead.
  const promptBudget = !isSubagent && brief ? Math.max(3000, budget - textTokens(brief)) : budget;
  const system = prompt(promptBudget, isSubagent);
  const window = model.contextWindow || input.contextWindow;
  const fits = (text: string) => !window || Math.ceil(textTokens(system + text) * 1.2) + OUTPUT_CAP + 4096 <= window;
  // Narrow the input before giving the whole compaction back to pi's native summary.
  let sourceText = source("full");
  let compressed = false;
  if (!fits(sourceText)) {
    sourceText = source("tight");
    compressed = true;
    if (!fits(sourceText)) fallback("capacity");
  }

  const archive = archivePath(input.sessionId);
  // A storage failure must never cost the snapshot: it only removes the pointer line. Archiving before the final
  // cap/abort checks means a later fallback can leave an orphan archive section; the archive is not commit evidence.
  let archived = !preparation.previousSummary;
  if (preparation.previousSummary) {
    try {
      mkdirSync(path.dirname(archive), { recursive: true });
      appendFileSync(archive, `\n\n# Archived ${new Date().toISOString()}\n\n${preparation.previousSummary}\n`);
      archived = true;
    } catch { archived = false; }
  }
  // The 8k cap applies to what is committed: snapshot + verbatim brief + archive and restore pointers.
  const assemble = (text: string) => (brief ? insertBrief(text, brief) : text) +
    (archived ? `\n\nOlder details: ${archive} (read it only if needed).` : "") + `\n\n${restoreBlock(archive, archived)}`;
  let result = await call(input, system, sourceText);
  let summary = assemble(result.text);
  let condensed = false;
  if (textTokens(summary) > HARD_CAP) {
    const target = Math.min(promptBudget, 6000);
    result = await call(input, prompt(target, isSubagent), `<previous-summary>\n${result.text}\n</previous-summary>\n\nCondense this snapshot to fit the budget. Keep authorizations/prohibitions verbatim.`);
    summary = assemble(result.text);
    condensed = true;
  }
  if (textTokens(summary) > HARD_CAP) fallback("over-cap");
  if (signal.aborted) fallback("aborted");

  return {
    compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
      details: fileLists(preparation, input.branchEntries), usage: result.usage },
    tokens: textTokens(summary), condensed, compressed,
  };
}
