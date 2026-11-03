import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { textTokens } from "./estimate.ts";

export const OUTPUT_CAP = 12288;
export const HARD_CAP = 8000;
export const BRIEF_CAP = 2000;
export const MAIN_BRIEF_CAP = 600;
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
- Goal must state the CURRENT goal. The session's first user message is context only and may be superseded by later requests; do not copy it into the current Goal.
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
function headTail(text: string, head: number, tail: number, omitted = "chars") {
  if (text.length <= head + tail) return text;
  const end = safeIndex(text, head), start = safeIndex(text, text.length - tail);
  return `${text.slice(0, end)}\n[+${start - end} ${omitted}]\n${text.slice(start)}`;
}

const argValue = (v: any) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));

export function serializeForSummary(messages: any[], profile: SummaryProfile = "full"): string {
  const p = SUMMARY_PROFILE[profile];
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg?.role === "user") {
      const text = textOf(msg);
      if (text) parts.push(`[User]: ${profile === "tight" ? headTail(text, 3000, 1000, "chars of user text omitted") : text}`);
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

// Main sessions keep a small context-only first message; subagents retain the parent's task brief.
export function taskBrief(branchEntries: any[], sessionFile: string | undefined, kind: "subagent" | "main" = "subagent"): string | undefined {
  const first = branchEntries.find(e => e.type === "message" && e.message.role === "user");
  if (!first) return;
  let text = textOf(first.message);
  if (!text.trim()) return;
  const title = kind === "main" ? "Session's first user message (verbatim; may be superseded by later requests):" : "Task brief (verbatim, from parent):";
  const wrap = (body: string) => `${title}\n<<<\n${body}\n>>>`;
  const cap = kind === "main" ? MAIN_BRIEF_CAP : BRIEF_CAP;
  const charge = (body: string) => textTokens(kind === "main" ? wrap(body) : body);
  if (charge(text) > cap) {
    const where = sessionFile ? `full brief: ${sessionFile} entry ${first.id}` : "in-memory session, full text is not addressable";
    const marker = `\n[truncated; ${where}]`;
    let end = text.length;
    while (end > 0 && charge(text.slice(0, safeIndex(text, end)) + (kind === "main" ? marker : "")) > cap) end = Math.floor(end * 0.9);
    text = `${text.slice(0, safeIndex(text, end))}${marker}`;
  }
  return wrap(text);
}

export type ArchiveState = "archived" | "none" | "append-failed" | "failed";
// No heading: these pointers belong after the eight snapshot sections.
export function restoreBlock(archive: string, state: ArchiveState, hasPruned = false) {
  const where = state === "archived" ? `older snapshots in ${archive}; ` : state === "append-failed"
    ? `the latest previous snapshot could not be appended (write failed); older snapshots in ${archive}; ` : state === "failed"
    ? "earlier snapshots were not archived (write failed), so this snapshot is the only record; " : "";
  const results = hasPruned ? "pruned tool results listed below, and markers still visible in kept messages," : "pruned tool-result markers still visible in kept messages";
  return `Restorable: ${where}${results} reopen via read_tool_result(entryId, offset, limit) when that tool is enabled. Newer messages verbatim.`;
}

function prunedRestoreList(preparation: any, branch: any[]) {
  const end = branch.findIndex(e => e.id === preparation.firstKeptEntryId);
  if (end < 0) return "";
  const previous = branch.findLast(e => e.type === "compaction");
  const start = previous ? branch.findIndex(e => e.id === previous.firstKeptEntryId) : 0;
  const summarized = new Set([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
    .filter(m => m.role === "toolResult").map(m => `${m.toolCallId}\u0000${m.toolName}`));
  const edits = new Map<string, any>();
  for (const entry of branch) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  const results = branch.slice(Math.max(0, start), end).filter(entry => {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult") return false;
    if (!summarized.has(`${message.toolCallId}\u0000${message.toolName}`)) return false;
    const replacement = edits.get(entry.id);
    return replacement && textOf(replacement).includes(`[tool_result pruned; raw entry ${entry.id}; use read_tool_result]`);
  }).reverse();
  if (!results.length) return "";
  return `\n\nPruned tool results (entryId toolName originalChars):\n${results.slice(0, 20).map(e =>
    `${e.id} ${e.message.toolName} ${Array.from(textOf(e.message)).length}`).join("\n")}` +
    (results.length > 20 ? `\n+${results.length - 20} more` : "");
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
  validate?: (compaction: any) => void; // boundary projection check, before any archive write
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
  const archive = archivePath(input.sessionId);
  // Reserve the successful archive pointer before validation; do not write until the whole attempt passes.
  let archived: ArchiveState = preparation.previousSummary || existsSync(archive) ? "archived" : "none";
  let restoreList = prunedRestoreList(preparation, input.branchEntries);
  let olderDetails = true;
  const tail = () => (olderDetails && archived === "archived" ? `\n\nOlder details: ${archive} (read it only if needed).` : "") +
    `\n\n${restoreBlock(archive, archived, !!restoreList)}${restoreList}`;
  const assemble = (text: string) => (brief ? insertBrief(text, brief) : text) + tail();
  // Main briefs and the current tail come out of the budget; subagent briefs use SUB_SHARE instead.
  const modelBudget = (target: number) => Math.max(3000, target - (!isSubagent && brief ? textTokens(brief) : 0) - textTokens(tail()));
  const system = prompt(modelBudget(budget), isSubagent);
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

  let result = await call(input, system, sourceText);
  let summary = assemble(result.text);
  let condensed = false;
  if (textTokens(summary) > HARD_CAP) {
    restoreList = "";
    summary = assemble(result.text);
  }
  if (textTokens(summary) > HARD_CAP) {
    olderDetails = false;
    summary = assemble(result.text);
  }
  if (textTokens(summary) > HARD_CAP) {
    const target = modelBudget(Math.min(budget, 6000));
    result = await call(input, prompt(target, isSubagent), `<previous-summary>\n${result.text}\n</previous-summary>\n\nCondense this snapshot to fit the budget. Keep authorizations/prohibitions verbatim.`);
    summary = assemble(result.text);
    condensed = true;
  }
  if (textTokens(summary) > HARD_CAP) fallback("over-cap");
  if (signal.aborted) fallback("aborted");

  const compaction = { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
    details: fileLists(preparation, input.branchEntries), usage: result.usage };
  input.validate?.(compaction);
  if (signal.aborted) fallback("aborted");
  if (preparation.previousSummary) {
    try {
      mkdirSync(path.dirname(archive), { recursive: true });
      appendFileSync(archive, `\n\n# Archived ${new Date().toISOString()}\n\n${preparation.previousSummary}\n`);
    } catch {
      archived = existsSync(archive) ? "append-failed" : "failed";
      summary = assemble(result.text);
      if (textTokens(summary) > HARD_CAP) fallback("over-cap");
      compaction.summary = summary;
      input.validate?.(compaction);
    }
  }
  return { compaction, tokens: textTokens(summary), condensed, compressed };
}
