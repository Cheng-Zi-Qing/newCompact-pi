#!/usr/bin/env bun
// Retention probe: after a real compaction, how many facts discarded from the model context can still be answered,
// and how much do the current artifacts (snapshot + pointers + pruned tool results) help?
// Read-only: reads session files and model metadata; never writes into ~/.pi except the cache file under --out.
// usage: bun scripts/eval-retention.ts [session.jsonl ...] [--questions N] [--sessions N] [--out path]
//        [--model provider/model[:thinking]] [--concurrency N] [--plan] [--selftest] [--resnapshot]
//        [--baseline-code <git-ref>] [--snapshot-code <git-ref>]
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime, SessionManager, buildSessionProjection, convertToLlm, prepareBranchEntries } from "@earendil-works/pi-coding-agent";
import { LIST_MAX, archivePath, restoreBlock, restoreListText, summarize } from "../src/summary.ts";
// The restore-list header src/summary.ts writes before each entry; duplicated here so product code stays untouched.
const LIST_HEADER = "Pruned tool results (entryId toolName originalChars: key slice):";
import { textTokens } from "../src/estimate.ts";
import { BUDGET } from "../src/guard.ts";

const CONDS = ["raw", "snap", "snap+restore"] as const;
// Round 2 only: the same snapshot regenerated with the current summarize(), plus its own restore list recovered.
const NEW_CONDS = ["snap:new", "snap:new+restore"] as const;
// Code A/B: the snapshot written by another tree's src/summary.ts (baseline ref vs snapshot ref).
const CODE_CONDS = ["snap:base", "snap:head"] as const;
export type CodeCond = typeof CODE_CONDS[number];
export type Cond = typeof CONDS[number] | typeof NEW_CONDS[number];
const PRUNED_MARK = "[tool_result pruned; raw entry ";
const RESTORE_HEAD_LIMIT = 8192; // one read_tool_result call returns at most this many codepoints
const RAW_TOKEN_CAP = 200_000;

// ---------- args ----------
type Args = { files: string[]; questions: number; sessions: number; out: string; model?: string; concurrency: number; plan: boolean;
  selftest: boolean; resnapshot: boolean; baselineCode?: string; snapshotCode?: string };
export function parseArgs(argv: string[]): Args {
  const args: Args = { files: [], questions: 6, sessions: 5, concurrency: 2, plan: false, selftest: false, resnapshot: false,
    out: path.join(homedir(), ".pi/agent/.eval-retention/cache.json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`Missing value for ${a}`); return v; };
    const int = (raw: string, min: number) => { const n = Number(raw); if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${a}: ${raw}`); return n; };
    if (a === "--questions") args.questions = int(value(), 1);
    else if (a === "--sessions") args.sessions = int(value(), 1);
    else if (a === "--concurrency") args.concurrency = int(value(), 1);
    else if (a === "--out") args.out = value();
    else if (a === "--model") args.model = value();
    else if (a === "--plan") args.plan = true;
    else if (a === "--selftest") args.selftest = true;
    else if (a === "--resnapshot") args.resnapshot = true;
    else if (a === "--baseline-code") args.baselineCode = value();
    else if (a === "--snapshot-code") args.snapshotCode = value();
    else if (a.startsWith("--")) throw new Error(`Unknown flag ${a}`);
    else args.files.push(a);
  }
  return args;
}

// ---------- code A/B: temp git worktrees ----------
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Which snapshot side a run has: baseline code ref, and the snapshot ref (absent = the working tree). */
export function codeSides(args: { baselineCode?: string; snapshotCode?: string }): Array<{ cond: CodeCond; ref?: string }> {
  const sides: Array<{ cond: CodeCond; ref?: string }> = [];
  if (args.baselineCode) sides.push({ cond: "snap:base", ref: args.baselineCode });
  if (args.snapshotCode || args.baselineCode) sides.push({ cond: "snap:head", ref: args.snapshotCode });
  return sides;
}

/** Both refs go into the cache key: snapshots and answers from different code never mix. */
export function abKey(sessionKey: string, baseRef?: string, headRef?: string): string {
  return `${sessionKey}@base:${baseRef ?? "-"}@head:${headRef ?? "worktree"}`;
}

/** Temp git worktree at ref; the caller removes it (in a finally block). */
export function addWorktree(ref: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-eval-code-"));
  try { execFileSync("git", ["worktree", "add", "--detach", dir, ref], { cwd: repoRoot, stdio: "pipe" });
  } catch (error: any) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git worktree add ${ref} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`);
  }
  return dir;
}

export function removeWorktree(dir: string) {
  try { execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "pipe" }); }
  catch { rmSync(dir, { recursive: true, force: true }); try { execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" }); } catch { /* best effort */ } }
}

// ---------- reading sessions (read-only) ----------
const textOf = (message: any): string => {
  const c = message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
};

export function renderMessages(messages: any[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || m.role === "system") continue;
    if (m.role === "user") { const t = textOf(m); if (t) parts.push(`[User]: ${t}`); }
    else if (m.role === "assistant") {
      const t = textOf(m); if (t) parts.push(`[Assistant]: ${t}`);
      const calls = Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "toolCall") : [];
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.map((b: any) => `${b.name}(${Object.entries(b.arguments ?? {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")})`).join("; ")}`);
    } else if (m.role === "toolResult") { const t = textOf(m); if (t) parts.push(`[Tool result]: ${t}`); }
  }
  return parts.join("\n\n");
}

const truncateTokens = (text: string, cap: number) => textTokens(text) <= cap ? { text, truncated: false }
  : { text: `${text.slice(0, Math.floor(text.length * cap / Math.max(1, textTokens(text))))}\n[truncated for the probe]`, truncated: true };

export type Candidate = {
  file: string; sessionId: string; cwd: string; compactionId: string; compactions: number;
  summary: string; discardedText: string; discardedTokens: number; snapshotTokens: number;
  pruned: Array<{ id: string; toolName: string; chars: number; raw: string }>;
  archived: boolean; archive: string; model?: string; truncated: boolean;
};

/** Mirrors prunedRestoreList in src/summary.ts (not exported): newest <=20 addressable pruned results in the range. */
export function prunedInRange(branch: any[], start: number, end: number) {
  const edits = new Map<string, string>();
  for (const entry of branch) if (entry.type === "context_edit") edits.set(entry.targetId, textOf(entry.replacement));
  return branch.slice(Math.max(0, start), end).filter((entry: any) => {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") return false;
    const replacement = edits.get(entry.id);
    return !!replacement && replacement.includes(`${PRUNED_MARK}${entry.id};`);
  }).reverse();
}

export function restoreList(pruned: Candidate["pruned"]): string {
  return restoreListText(pruned.map(p => ({ id: p.id, toolName: p.toolName, chars: p.chars, text: p.raw })));
}

export function readSession(file: string): { cwd: string; sessionId: string; branch: any[] } | undefined {
  let entries: any[];
  try { entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return undefined; }
  if (entries[0]?.type !== "session") return undefined;
  const manager = SessionManager.inMemory(entries[0].cwd ?? "/tmp", undefined, entries);
  const header: any = manager.getHeader();
  return { cwd: entries[0].cwd ?? "", sessionId: header?.id ?? path.basename(file, ".jsonl"), branch: manager.getBranch() };
}

/** One candidate per session: the compaction with the largest discarded range (ties: the later one). */
export function candidateOf(file: string): Candidate | undefined {
  const session = readSession(file);
  if (!session) return undefined;
  const { branch } = session;
  const idx = new Map<string, number>(branch.map((e: any, i: number) => [e.id, i]));
  const compactions = branch.map((e: any, i: number) => ({ e, i })).filter(({ e }: any) => e.type === "compaction");
  let best: Candidate | undefined;
  for (const { e: compaction, i } of compactions as any[]) {
    const keep = idx.get(compaction.firstKeptEntryId);
    if (keep === undefined) continue;
    const previous = (compactions as any[]).filter(c => c.i < i).at(-1);
    const start = previous ? idx.get(previous.e.firstKeptEntryId) ?? 0 : 0;
    const slice = branch.slice(start, i);
    // Older-than-kept range projected with its own context edits applied: what the model had in context.
    const messages = buildSessionProjection(slice).messages.filter((m: any) => m.role !== "system");
    const rendered = renderMessages(convertToLlm(messages));
    const capped = truncateTokens(rendered, RAW_TOKEN_CAP);
    const pruned = prunedInRange(branch, start, i);
    const summary = String(compaction.summary ?? "");
    const archive = archivePath(session.sessionId);
    // Same state as summarize(): an older snapshot is addressable when this is not the first compaction.
    const archived = previous !== undefined || existsSync(archive);
    const candidate: Candidate = {
      file, sessionId: session.sessionId, cwd: session.cwd, compactionId: compaction.id, compactions: compactions.length,
      summary, discardedText: capped.text, discardedTokens: textTokens(capped.text), snapshotTokens: textTokens(summary),
      pruned: pruned.map((entry: any) => ({ id: entry.id, toolName: entry.message.toolName ?? "?",
        chars: Array.from(textOf(entry.message)).length, raw: textOf(entry.message) })),
      archived, archive, model: sessionModel(branch, i), truncated: capped.truncated,
    };
    if (!best || candidate.discardedTokens > best.discardedTokens) best = candidate;
  }
  return best;
}

function sessionModel(branch: any[], before: number): string | undefined {
  for (let i = before; i >= 0; i--) {
    const m = branch[i]?.message;
    if (m?.role === "assistant" && m.provider && m.model) return `${m.provider}/${m.model}`;
  }
}

/** Exactly what our compaction commits: snapshot summary + `Older details:` pointer + restoreBlock + pruned list. */
export function buildSnap(c: Candidate): string {
  const older = c.archived ? `\n\nOlder details: ${c.archive} (read it only if needed).` : "";
  return `${c.summary}${older}\n\n${restoreBlock(c.archive, c.archived ? "archived" : "none", c.pruned.length > 0)}${restoreList(c.pruned)}`;
}

export function buildSnapRestoreFrom(snap: string, refs: Candidate["pruned"]): string {
  if (!refs.length) return snap;
  // A model following the pointers one read_tool_result call per listed result recovers at most 8192 codepoints each.
  const recovered = refs.slice(0, LIST_MAX).map(p => `# ${p.id} ${p.toolName} (${p.chars} chars)\n${Array.from(p.raw).slice(0, RESTORE_HEAD_LIMIT).join("")}`);
  return `${snap}\n\nRecovered pruned tool results:\n<<<\n${recovered.join("\n\n")}\n>>>`;
}

export function buildSnapRestore(c: Candidate): string {
  return buildSnapRestoreFrom(buildSnap(c), c.pruned);
}

/** The results a generated snapshot's own restore list points at: `<entryId> <toolName> <chars>: <slice>`. */
export function restoreRefsOf(summary: string, branch: any[]): Candidate["pruned"] {
  const at = summary.indexOf(LIST_HEADER);
  if (at < 0) return [];
  const byId = new Map<string, any>(branch.map((e: any) => [e.id, e]));
  const refs: Candidate["pruned"] = [];
  for (const line of summary.slice(at + LIST_HEADER.length).split("\n").slice(1)) {
    if (!line.trim() || line.startsWith("+")) break;
    const m = /^(\S+) (\S+) (\d+):/.exec(line);
    const entry = m && byId.get(m[1]);
    if (!entry) continue;
    refs.push({ id: m![1], toolName: m![2], chars: Number(m![3]), raw: textOf(entry.message) });
  }
  return refs;
}

/**
 * The preparation the plugin would hand to summarize() at this compaction point. Faithful choice: the cut is taken
 * from the committed firstKeptEntryId (so the discarded range, and therefore the cached questions, stay identical)
 * and the summarized messages come from the same projected entries prepareBoundaryCompaction flattens. A split turn's
 * turn prefix is folded into messagesToSummarize: the union and document order are the same, serializeForSummary
 * concatenates both anyway. fileOps comes from the same prepareBranchEntries call.
 */
export function preparationFor(c: Candidate) {
  const branch = readSession(c.file)!.branch;
  const end = branch.findIndex((e: any) => e.id === c.compactionId);
  const compaction: any = branch[end];
  const previous = branch.slice(0, end).findLast((e: any) => e.type === "compaction");
  const start = previous ? branch.findIndex((e: any) => e.id === previous.firstKeptEntryId) : 0;
  const kept = branch.findIndex((e: any) => e.id === compaction.firstKeptEntryId);
  const messages = buildSessionProjection(branch.slice(start, kept)).messages.filter((m: any) => m.role !== "system");
  const nested = messages.filter((m: any) => m.role === "toolResult").flatMap((m: any) => m.nestedCalls?.calls ?? []);
  const fileOps = prepareBranchEntries([...messages.map((message: any) => ({ type: "message", message })),
    { type: "message", message: { role: "assistant", content: nested.map((call: any) =>
      ({ type: "toolCall", name: call.name, arguments: call.arguments })) } }] as any).fileOps;
  return { branchEntries: branch.slice(0, end),
    preparation: { firstKeptEntryId: compaction.firstKeptEntryId, messagesToSummarize: messages, turnPrefixMessages: [],
      tokensBefore: compaction.tokensBefore, previousSummary: previous?.summary, fileOps } };
}

export function contexts(c: Candidate, newSummary?: string): Partial<Record<Cond, string>> {
  const out: Partial<Record<Cond, string>> = { raw: c.discardedText, snap: buildSnap(c), "snap+restore": buildSnapRestore(c) };
  if (newSummary === undefined) return out;
  out["snap:new"] = newSummary;
  out["snap:new+restore"] = buildSnapRestoreFrom(newSummary, restoreRefsOf(newSummary, readSession(c.file)?.branch ?? []));
  return out;
}

// ---------- model calls ----------
type Usage = { input: number; output: number; cached: number; cost: number; ms: number };
const usageOf = (res: any, ms: number): Usage => ({ input: res?.usage?.input ?? 0, output: res?.usage?.output ?? 0,
  cached: res?.usage?.cacheRead ?? 0, cost: res?.usage?.cost?.total ?? 0, ms });

const RECORD_JSON = "Output ONLY one JSON object, no prose and no code fences.";

export function parseJsonObject(text: string): any {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export type Pair = { question: string; answer: string; sourceQuote: string };

/** Validate strictly; a pair whose sourceQuote is not a literal substring of the discarded text is dropped. */
export function validPairs(raw: any, discarded: string, limit: number): Pair[] {
  const seen = new Set<string>(), out: Pair[] = [];
  for (const p of Array.isArray(raw?.pairs) ? raw.pairs : []) {
    const question = typeof p?.question === "string" ? p.question.trim() : "";
    const answer = typeof p?.answer === "string" ? p.answer.trim() : "";
    const sourceQuote = typeof p?.sourceQuote === "string" ? p.sourceQuote.trim() : "";
    if (!question || !answer || !sourceQuote) continue;
    if (question.length > 400 || answer.length > 300 || sourceQuote.length > 2000) continue;
    if (!discarded.includes(sourceQuote)) continue; // must come from the discarded text only
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, answer, sourceQuote });
    if (out.length >= limit) break;
  }
  return out;
}

const CATEGORIES = ["path", "command", "decision", "number", "other"] as const;
export function classifyCategory(text: string): typeof CATEGORIES[number] {
  const t = text.toLowerCase();
  if (/[/\\]|\.(ts|js|json|md|py|go|rs|sh|yaml|yml|toml)\b|文件|目录|path/.test(t)) return "path";
  if (/\b(bun|npm|npx|git|curl|node|bash|sh|rg|grep|test|build|lint)\b|命令|运行|执行/.test(t)) return "command";
  if (/决定|决策|decid|choose|chose|decision|instead|prefer|not allowed|forbid|禁止|must not|should not/.test(t)) return "decision";
  if (/\d/.test(t)) return "number";
  return "other";
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export function exactHit(reference: string, candidate: string): boolean {
  const r = normalize(reference), c = normalize(candidate);
  return !!r && !!c && (c.includes(r) || r.includes(c));
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// Provider capacity is shared: a long RAW prompt hits the per-minute token limit and must back off, not fail.
async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (error: any) {
      last = error;
      const message = String(error?.message ?? "");
      const retryAfter = Number(/retry after (\d+) seconds/.exec(message)?.[1] ?? 0);
      const wait = retryAfter ? (retryAfter + 5) * 1000 : /rate_limit|429|capacity/.test(message) ? 20_000 * (i + 1) : 2_000 * (i + 1);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

type Caller = (system: string, user: string, maxTokens: number) => Promise<{ text: string; usage: Usage }>;

// One shared per-minute token budget (providers cap it; long RAW prompts are the whole cost).
const RATE_WINDOW_MS = 60_000, RATE_TOKENS = 300_000;
const sent: Array<{ at: number; tokens: number }> = [];
async function pace(tokens: number) {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0].at > RATE_WINDOW_MS) sent.shift();
    const used = sent.reduce((n, s) => n + s.tokens, 0);
    if (used + tokens <= RATE_TOKENS || !sent.length) { sent.push({ at: now, tokens }); return; }
    await new Promise(r => setTimeout(r, Math.min(RATE_WINDOW_MS, sent[0].at + RATE_WINDOW_MS - now + 1000)));
  }
}

function makeCaller(registry: ModelRegistry, model: any, thinking?: string): Caller {
  return async (system, user, maxTokens) => {
    await pace(Math.min(RATE_TOKENS, textTokens(system) + textTokens(user) + maxTokens));
    // Same provider-neutral options as summarize(): reasoning models need an explicit effort level.
    const options: any = { maxTokens, cacheRetention: "none" };
    const effort = thinking ?? (model.reasoning || model.api === "pi-virtual" ? "low" : undefined);
    if (effort) options.reasoning = effort;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600_000);
    try {
      const res: any = await withRetry(() => registry.streamSimple(model, {
        systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
      } as any, { ...options, signal: controller.signal }).result());
      const ms = Math.round(performance.now() - started);
      if (res?.stopReason === "error" || res?.stopReason === "aborted") throw new Error(`stop:${res.stopReason}: ${res?.errorMessage ?? ""}`);
      const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      // A reasoning model can spend the whole budget on thinking; retry rather than grade an empty answer.
      if (!text) throw new Error(`empty:${res?.stopReason}`);
      return { text, usage: usageOf(res, ms) };
    } finally { clearTimeout(timer); }
  };
}

const PROBE_SYSTEM = `You write fact-check probes for an information-retention test.
From the conversation excerpt the user gives you, produce $N Q/A pairs about facts that exist ONLY there: file paths, commands, numbers, error strings, ids, decisions.
Rules:
- The question must be answerable from that excerpt alone, short, and unambiguous.
- The answer must be short and checkable: a path, a command, a number, an id, or one short clause. No reasoning, no "because".
- "sourceQuote" must be copied character for character from the excerpt (a literal substring, 10-200 chars) and must contain the answer.
- Prefer facts a continuation of the work would actually need. No yes/no questions.
${RECORD_JSON} Shape: {"pairs":[{"question":"...","answer":"...","sourceQuote":"..."}]}`;

const ANSWER_SYSTEM = `You answer questions from a provided context only.
Use only the context. Be terse: the exact path, command, number, id, or one short clause.
If the context does not contain the answer, reply exactly: UNKNOWN
Do not explain, do not add caveats, do not mention the context.`;

const JUDGE_SYSTEM = `You grade one answer against a reference fact.
correct = the reference fact is present and nothing contradicts it.
partial = some of it is right but a key element is missing or vague.
incorrect = wrong, absent, UNKNOWN, or contradicts the reference.
Ignore wording, formatting and extra detail.
${RECORD_JSON} Shape: {"verdict":"correct|partial|incorrect","reason":"one short line"}`;

// ---------- cache ----------
type AnswerRecord = { answer: string; verdict?: string; reason?: string; exact?: boolean; usage: Usage; at: string };
type PairRecord = Pair & { category: string; conditions?: Partial<Record<Cond, AnswerRecord>> };
type SessionRecord = { file: string; sessionId: string; cwd: string; compactionId: string; compactions: number;
  discardedTokens: number; snapshotTokens: number; recoverable: number; prunedListed: number; archived: boolean;
  model: string /* probe+judge spec, not the snapshot author */; snapshotModel?: string; truncated: boolean; probeUsage?: Usage; pairs?: PairRecord[];
  newSummary?: string; newSnapshotTokens?: number; newListed?: number; newUsage?: Usage }; // --resnapshot only
type AbSnapshot = { ref: string; model: string; summary: string; tokens: number; listed: number; usage: Usage };
// One entry per (session, code refs): snapshots and answers belong to one pair of trees.
type AbEntry = { snapshots: Partial<Record<CodeCond, AbSnapshot>>; answers: Record<string, AnswerRecord> };
type Cache = { version: 1; model: string; sessions: Record<string, SessionRecord>; ab?: Record<string, AbEntry>; lastRun?: any };

function loadCache(file: string): Cache {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.sessions) return parsed;
  } catch { /* new cache */ }
  return { version: 1, model: "", sessions: {} };
}

function saveCache(file: string, cache: Cache) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(tmp, file);
}

// ---------- run ----------
async function defaultSessionFiles(): Promise<string[]> {
  const root = path.join(homedir(), ".pi/agent/sessions");
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root);
  return files.sort();
}

function selectSessions(candidates: Candidate[], limit: number): Candidate[] {
  // Preference: the committed summary carries the addressable restore list, then the largest discarded range,
  // then how many pruned results that range actually holds.
  const score = (c: Candidate) => [c.summary.includes(PRUNED_MARK) ? 1 : 0, c.discardedTokens, c.pruned.length];
  return candidates.sort((a, b) => {
    const sa = score(a), sb = score(b);
    return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2];
  }).slice(0, limit);
}

const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : "n/a";
const table = (rows: string[][]) => {
  const head = rows[0];
  const widths = head.map((_, i) => Math.max(...rows.map(r => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => (c ?? "").padEnd(widths[i])).join(" | ")} |`;
  return [line(head), `|${widths.map(w => "-".repeat(w + 2)).join("|")}|`, ...rows.slice(1).map(line)].join("\n");
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  const files = args.files.length ? args.files : await defaultSessionFiles();
  const candidates: Candidate[] = [];
  let parsed = 0, noCompaction = 0;
  for (const file of files) {
    const c = candidateOf(file);
    if (!c) { noCompaction++; continue; }
    parsed++;
    candidates.push(c);
  }
  const chosen = selectSessions(candidates, args.sessions);
  if (!chosen.length) throw new Error("No session with a compaction entry found.");

  if (args.plan) {
    console.log(`sessions scanned: ${files.length}, parsed with a compaction: ${candidates.length}, without: ${noCompaction}`);
    console.log(table([["session", "cwd", "compactions", "discarded tok", "snapshot tok", "ratio", "pruned", "ours*"],
      ...chosen.map(c => [c.sessionId.slice(0, 8), c.cwd, String(c.compactions), String(c.discardedTokens), String(c.snapshotTokens),
        `${(c.discardedTokens / Math.max(1, c.snapshotTokens)).toFixed(1)}x`, String(c.pruned.length),
        c.summary.includes(PRUNED_MARK) ? "yes" : "no"])]));
    return;
  }

  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const resolve = (spec: string) => {
    const [name, thinking] = spec.split(":");
    const slash = name.indexOf("/");
    if (slash < 0) throw new Error(`--model must be provider/model[:thinking], got ${spec}`);
    const model = registry.find(name.slice(0, slash), name.slice(slash + 1));
    if (!model) throw new Error(`Unknown model ${name}; available: ${registry.getAll().map((m: any) => `${m.provider}/${m.id}`).join(", ")}`);
    return { model, thinking };
  };

  const cache = loadCache(args.out);
  const started = performance.now();
  const callerFor = new Map<string, Caller>();
  const caller = (spec: string) => {
    if (!callerFor.has(spec)) { const { model, thinking } = resolve(spec); callerFor.set(spec, makeCaller(registry, model, thinking)); }
    return callerFor.get(spec)!;
  };

  const sessions: Array<{ c: Candidate; key: string; spec: string; pairs: PairRecord[] }> = [];
  const skipped: string[] = [];
  for (const c of chosen) {
    const spec = args.model ?? c.model;
    if (!spec) { skipped.push(`${c.sessionId.slice(0, 8)}: no session model and no --model`); continue; }
    try { resolve(spec.replace(/:\w+$/, "")); } catch { skipped.push(`${c.sessionId.slice(0, 8)}: model ${spec} not available`); continue; }
    // Cache key keeps the model: answers graded by different models must never be mixed in one report.
    const key = `${c.sessionId}@${c.compactionId}@${spec}`;
    let record = cache.sessions[key];
    if (!record) {
      record = { file: c.file, sessionId: c.sessionId, cwd: c.cwd, compactionId: c.compactionId, compactions: c.compactions,
        discardedTokens: c.discardedTokens, snapshotTokens: c.snapshotTokens, recoverable: c.pruned.slice(0, LIST_MAX).reduce((n, p) => n + Math.min(p.chars, RESTORE_HEAD_LIMIT), 0),
        prunedListed: Math.min(LIST_MAX, c.pruned.length), archived: c.archived, model: spec, snapshotModel: c.model,
        truncated: c.truncated };
      cache.sessions[key] = record;
    }
    if (!record.pairs) {
      process.stderr.write(`probes: ${c.sessionId.slice(0, 8)} (${c.discardedTokens} discarded tokens)... `);
      const generated = await caller(spec)(PROBE_SYSTEM.replace("$N", String(args.questions)),
        `<conversation>\n${c.discardedText}\n</conversation>\n\nProduce ${args.questions} pairs.`, 4000);
      let raw: any;
      try { raw = parseJsonObject(generated.text); } catch { process.stderr.write("unparseable JSON, skipped\n"); skipped.push(`${c.sessionId.slice(0, 8)}: probe JSON unparseable`); continue; }
      const pairs = validPairs(raw, c.discardedText, args.questions);
      if (!pairs.length) { process.stderr.write("no verifiable pair, skipped\n"); skipped.push(`${c.sessionId.slice(0, 8)}: no pair passed sourceQuote validation`); continue; }
      record.pairs = pairs.map(p => ({ ...p, category: classifyCategory(`${p.question} ${p.answer}`) }));
      record.probeUsage = generated.usage as any;
      saveCache(args.out, cache);
      process.stderr.write(`${record.pairs.length} pairs\n`);
    }
    sessions.push({ c, key, spec, pairs: record.pairs });
  }

  if (!sessions.length) throw new Error(`No session could be probed. ${skipped.join("; ")}`);

  const conds: Cond[] = args.resnapshot ? [...CONDS, ...NEW_CONDS] : [...CONDS];
  const label: Record<Cond, string> = { raw: "RAW", snap: args.resnapshot ? "SNAP_OLD" : "SNAP",
    "snap+restore": args.resnapshot ? "SNAP_OLD+RESTORE" : "SNAP+RESTORE", "snap:new": "SNAP_NEW", "snap:new+restore": "SNAP_NEW+RESTORE" };
  // Regeneration writes an archive when there is a previous summary: keep it out of ~/.pi/agent.
  if (args.resnapshot) process.env.PI_COMPACT_DIR = mkdtempSync(path.join(tmpdir(), "pi-compact-eval-"));
  const snapUsage = { cost: 0, input: 0, output: 0, ms: 0 };
  /** One summarize() call from `mod` (a tree's src/summary.ts), driven through the probe's shared pacing/retry. */
  const runSummarize = async (mod: any, c: Candidate, spec: string) => {
    const { model } = resolve(spec);
    const complete = async (m: any, ctx: any, options: any) => {
      const body = (ctx?.messages ?? []).map((x: any) => Array.isArray(x.content)
        ? x.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : String(x.content ?? "")).join("\n");
      await pace(Math.min(RATE_TOKENS, textTokens(String(ctx?.systemPrompt ?? "")) + textTokens(body) + (options?.maxTokens ?? 0)));
      return withRetry(() => registry.streamSimple(m, ctx, options).result());
    };
    const { branchEntries, preparation } = preparationFor(c);
    const out = await mod.summarize({ preparation, branchEntries, signal: new AbortController().signal, model, complete,
      sessionId: c.sessionId, sessionFile: c.file, isSubagent: false, budget: BUDGET, contextWindow: model.contextWindow });
    const spent = out.compaction.usage ?? {};
    return { messages: preparation.messagesToSummarize.length, summary: out.compaction.summary as string,
      tokens: out.tokens as number, listed: restoreRefsOf(out.compaction.summary, branchEntries).length,
      usage: { input: spent.input ?? 0, output: spent.output ?? 0, cached: spent.cacheRead ?? 0,
        cost: spent.cost?.total ?? 0, ms: 0 } };
  };
  for (const session of sessions) {
    if (!args.resnapshot) break;
    const record = cache.sessions[session.key];
    // Regenerate when missing or when the authoring model changed: cached SNAP_NEW answers belong to one snapshot text.
    if (record.newSummary && record.snapshotModel === session.c.model) continue;
    // The regenerated snapshot must be written by the session's own model, never by the probe/judge spec.
    const spec = session.c.model;
    if (!spec) { skipped.push(`${session.c.sessionId.slice(0, 8)}: no session model for the regenerated snapshot`); continue; }
    process.stderr.write(`resnapshot: ${session.c.sessionId.slice(0, 8)} with ${spec}... `);
    try {
      const out = await runSummarize({ summarize }, session.c, spec);
      process.stderr.write(`ok (${out.messages} messages, ${record.snapshotTokens} -> ${out.tokens} tokens, ${out.listed} restorable)\n`);
      if (record.newSummary) for (const pair of record.pairs ?? [])
        for (const cond of NEW_CONDS) delete pair.conditions?.[cond]; // stale answers for the replaced snapshot
      record.snapshotModel = spec;
      record.newSummary = out.summary;
      record.newSnapshotTokens = out.tokens;
      record.newListed = out.listed;
      record.newUsage = out.usage;
      snapUsage.input += out.usage.input; snapUsage.output += out.usage.output; snapUsage.cost += out.usage.cost;
      saveCache(args.out, cache);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      process.stderr.write(`failed: ${why}\n`);
      skipped.push(`${session.c.sessionId.slice(0, 8)}: resnapshot failed (${why.slice(0, 80)})`);
    }
  }

  // ---------- code A/B: the same questions answered from snapshots written by two different trees ----------
  const sides = codeSides(args);
  const abAnswers = { cost: 0, n: 0 };
  if (sides.length) {
    // summarize() can write an archive: keep that, and every worktree's build output, out of ~/.pi/agent.
    process.env.PI_COMPACT_DIR ??= mkdtempSync(path.join(tmpdir(), "pi-compact-eval-"));
    cache.ab ??= {};
    const trees: string[] = [];
    try {
      // Load one module per ref: the working tree (no ref) or a detached worktree of that ref.
      const modules = new Map<string, any>();
      for (const side of sides) {
        const id = side.ref ?? "worktree";
        if (modules.has(id)) continue;
        const dir = side.ref ? addWorktree(side.ref) : undefined;
        if (dir) trees.push(dir);
        process.stderr.write(`code ${side.cond}: ${side.ref ?? "working tree"}${dir ? ` (worktree ${dir})` : ""}... `);
        try {
          modules.set(id, dir ? await import(`${dir}/src/summary.ts`) : { summarize });
          process.stderr.write("loaded\n");
        } catch (error) {
          if (dir) { removeWorktree(dir); trees.splice(trees.indexOf(dir), 1); }
          throw error;
        }
      }
      for (const session of sessions) {
        const entry = (cache.ab[abKey(session.key, args.baselineCode, args.snapshotCode)] ??= { snapshots: {}, answers: {} });
        // One model for both sides, as in the reference A/B: --model when given, else the session's own author.
        const spec = args.model ?? session.c.model ?? session.spec;
        for (const side of sides) {
          const cached = entry.snapshots[side.cond];
          if (cached && cached.model === spec) continue; // one snapshot text per side and model
          process.stderr.write(`code snapshot ${session.c.sessionId.slice(0, 8)} ${side.cond} with ${spec}... `);
          try {
            const out = await runSummarize(modules.get(side.ref ?? "worktree"), session.c, spec);
            // Answers belong to one snapshot text: drop them when the snapshot is replaced.
            if (cached) for (const index of session.pairs.keys()) delete entry.answers[`${index}|${side.cond}`];
            entry.snapshots[side.cond] = { ref: side.ref ?? "worktree", model: spec, summary: out.summary,
              tokens: out.tokens, listed: out.listed, usage: out.usage };
            saveCache(args.out, cache);
            process.stderr.write(`ok (${out.tokens} tokens, ${out.listed} restorable)\n`);
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            process.stderr.write(`failed: ${why}\n`);
            skipped.push(`${session.c.sessionId.slice(0, 8)}: ${side.cond} snapshot failed (${why.slice(0, 80)})`);
          }
        }
      }
    } finally {
      // The imported modules keep their worktree paths in memory only; nothing is imported after this point.
      for (const dir of trees) removeWorktree(dir);
    }
  }

  // Answer + judge: one independent call per (pair, condition); the condition is never named to the judge.
  const grade = async (call: Caller, pair: PairRecord, context: string): Promise<AnswerRecord> => {
    const answered = await call(ANSWER_SYSTEM, `Context:\n<<<\n${context}\n>>>\n\nQuestion: ${pair.question}`, 1500);
    const judged = await call(JUDGE_SYSTEM, `Question: ${pair.question}\nReference answer: ${pair.answer}\nCandidate answer: ${answered.text}`, 800);
    let verdict = "incorrect", reason = "";
    try {
      const parsed = parseJsonObject(judged.text);
      verdict = ["correct", "partial", "incorrect"].includes(parsed?.verdict) ? parsed.verdict : "incorrect";
      reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 200) : "";
    } catch { reason = "unparseable judge output"; }
    return { answer: answered.text, verdict, reason, exact: exactHit(pair.answer, answered.text),
      usage: { ...answered.usage, ms: answered.usage.ms + judged.usage.ms, cost: answered.usage.cost + judged.usage.cost,
        input: answered.usage.input + judged.usage.input, output: answered.usage.output + judged.usage.output,
        cached: answered.usage.cached + judged.usage.cached }, at: new Date().toISOString() };
  };
  const jobs: Array<() => Promise<void>> = [];
  for (const session of sessions) {
    const ctx = contexts(session.c, cache.sessions[session.key].newSummary);
    for (const pair of session.pairs) {
      pair.conditions ??= {};
      const order = conds.filter(c => ctx[c] !== undefined)
        .sort((a, b) => hash(`${pair.question}${a}`) - hash(`${pair.question}${b}`));
      for (const cond of order) {
        if (pair.conditions[cond]?.verdict) continue;
        jobs.push(async () => {
          pair.conditions![cond] = await grade(caller(session.spec), pair, ctx[cond]!);
          saveCache(args.out, cache);
        });
      }
    }
  }
  // Code A/B answers: the same cached questions against one snapshot per side.
  if (sides.length) for (const session of sessions) {
    const entry = cache.ab?.[abKey(session.key, args.baselineCode, args.snapshotCode)];
    if (!entry) continue;
    for (const [index, pair] of session.pairs.entries()) {
      const order = sides.filter(s => entry.snapshots[s.cond])
        .sort((a, b) => hash(`${pair.question}${a.cond}`) - hash(`${pair.question}${b.cond}`));
      for (const side of order) {
        const key = `${index}|${side.cond}`;
        if (entry.answers[key]?.verdict) continue;
        jobs.push(async () => {
          entry.answers[key] = await grade(caller(session.spec), pair, entry.snapshots[side.cond]!.summary);
          abAnswers.n++;
          saveCache(args.out, cache);
        });
      }
    }
  }
  let done = 0;
  const workers = Array.from({ length: Math.min(args.concurrency, jobs.length) }, async () => {
    while (jobs.length) {
      const job = jobs.shift()!;
      await job();
      if (++done % 10 === 0) process.stderr.write(`progress: ${done}/${done + jobs.length}\n`);
    }
  });
  await Promise.all(workers);
  saveCache(args.out, cache);

  // ---------- report ----------
  const usage = { cost: 0, input: 0, output: 0, ms: 0 };
  const cond = Object.fromEntries(conds.map(c => [c, { n: 0, correct: 0, partial: 0, exact: 0, incorrectBy: {} as Record<string, number>,
    part: {} as Record<string, number>, usage: { cost: 0, input: 0, output: 0, ms: 0 } }])) as any;
  const rows: string[][] = [["session", "cwd", "comp", "n", ...conds.map(c => label[c]), "ratio(old)", "ratio(new)", "restorable", "snapshot by"]];
  for (const session of sessions) {
    const record = cache.sessions[session.key];
    const per = Object.fromEntries(conds.map(c => [c, { n: 0, correct: 0, partial: 0, exact: 0 }])) as any;
    for (const pair of session.pairs) {
      for (const c of conds) {
        const rec = pair.conditions?.[c];
        if (!rec?.verdict) continue;
        per[c].n++;
        if (rec.verdict === "correct") per[c].correct++;
        if (rec.verdict !== "incorrect") per[c].partial++;
        if (rec.exact) per[c].exact++;
        usage.cost += rec.usage.cost; usage.input += rec.usage.input; usage.output += rec.usage.output; usage.ms += rec.usage.ms;
        cond[c].usage.cost += rec.usage.cost; cond[c].usage.input += rec.usage.input;
        cond[c].usage.output += rec.usage.output; cond[c].usage.ms += rec.usage.ms;
        if (rec.verdict !== "correct") {
          cond[c].incorrectBy[pair.category] = (cond[c].incorrectBy[pair.category] ?? 0) + 1;
          if (rec.verdict === "partial") cond[c].part[pair.category] = (cond[c].part[pair.category] ?? 0) + 1;
        }
      }
    }
    for (const c of conds) { const p = per[c]; cond[c].n += p.n; cond[c].correct += p.correct; cond[c].partial += p.partial; cond[c].exact += p.exact; }
    const n = per.raw.n;
    rows.push([session.c.sessionId.slice(0, 8), session.c.cwd, String(session.c.compactions), String(n),
      ...conds.map(c => `${pct(per[c].correct, n)} (${pct(per[c].partial, n)})`),
      `${(session.c.discardedTokens / Math.max(1, session.c.snapshotTokens)).toFixed(1)}x`,
      record.newSnapshotTokens ? `${(session.c.discardedTokens / Math.max(1, record.newSnapshotTokens)).toFixed(1)}x` : "-",
      record.newListed !== undefined ? `${record.newListed} / ${session.c.pruned.length}` : String(session.c.pruned.length),
      record.snapshotModel ?? session.c.model ?? "?"]);
  }
  const nOverall = cond.raw.n;
  rows.push(["overall", "", "", String(nOverall), ...conds.map(c => `${pct(cond[c].correct, nOverall)} (${pct(cond[c].partial, nOverall)})`), "", "", "", ""]);

  console.log(table(rows));
  console.log("\nexact-substring cross-check (correct, no judge):");
  console.log(table([["condition", "exact hit", "judged correct", "n"], ...conds.map(c =>
    [label[c], pct(cond[c].exact, cond[c].n), pct(cond[c].correct, cond[c].n), String(cond[c].n)])]));
  console.log("\nfailed pairs by keyword category (incorrect, partial in parentheses):");
  console.log(table([["condition", ...CATEGORIES.map(c => c)], ...conds.map(c =>
    [label[c], ...CATEGORIES.map(k => `${String(cond[c].incorrectBy[k] ?? 0)} (${String(cond[c].part[k] ?? 0)})`)])]));
  console.log(`\ncalls: ${usage.input + usage.output} tokens in/out (${usage.input} in, ${usage.output} out), cost $${usage.cost.toFixed(4)}, ` +
    `summed call time ${(usage.ms / 1000).toFixed(0)}s, wall ${((performance.now() - started) / 1000).toFixed(0)}s`);
  console.log(`compression: discarded ${sessions.reduce((n, s) => n + s.c.discardedTokens, 0)} tokens -> snapshot ` +
    `${sessions.reduce((n, s) => n + s.c.snapshotTokens, 0)} tokens; recoverable pruned results ` +
    `${sessions.reduce((n, s) => n + Math.min(LIST_MAX, s.c.pruned.length), 0)} (of ${sessions.reduce((n, s) => n + s.c.pruned.length, 0)} in range, head ${RESTORE_HEAD_LIMIT} codepoints each)`);
  console.log("\nspend by condition (cached answers are re-reported, not re-billed):");
  console.log(table([["condition", "answers", "in tok", "out tok", "cost", "call time"], ...conds.map(c =>
    [label[c], String(cond[c].n), String(cond[c].usage.input), String(cond[c].usage.output),
      `$${cond[c].usage.cost.toFixed(4)}`, `${(cond[c].usage.ms / 1000).toFixed(0)}s`])]));
  if (args.resnapshot) console.log(`regenerated snapshots (session's own model, one summarize() call each): ` +
    `${snapUsage.input} in / ${snapUsage.output} out tokens, cost $${snapUsage.cost.toFixed(4)}; ` +
    `${sessions.filter(s => cache.sessions[s.key].newSnapshotTokens).length}/${sessions.length} regenerated, ` +
    `new snapshots total ${sessions.reduce((n, s) => n + (cache.sessions[s.key].newSnapshotTokens ?? 0), 0)} tokens, ` +
    `restorable now ${sessions.reduce((n, s) => n + (cache.sessions[s.key].newListed ?? 0), 0)} (of ${sessions.reduce((n, s) => n + s.c.pruned.length, 0)} in range)`);
  if (sides.length) {
    // One shared model per side pair, so a difference is the tree's, not the author's.
    const abLabel = (side: { cond: CodeCond; ref?: string }) => `${side.cond} (${side.ref ?? "worktree"})`;
    const acc = Object.fromEntries(sides.map(s => [s.cond, { n: 0, correct: 0, partial: 0, cost: 0 }])) as any;
    const cats: Record<string, any> = {};
    const abRows: string[][] = [["session", "n", ...sides.map(abLabel), "restorable base -> head", "snapshot tok base -> head"]];
    for (const session of sessions) {
      const entry = cache.ab?.[abKey(session.key, args.baselineCode, args.snapshotCode)];
      const per = Object.fromEntries(sides.map(s => [s.cond, { n: 0, correct: 0, partial: 0 }])) as any;
      for (const [index, pair] of session.pairs.entries()) for (const side of sides) {
        const rec = entry?.answers[`${index}|${side.cond}`];
        if (!rec?.verdict) continue;
        abAnswers.cost += rec.usage.cost;
        for (const b of [per[side.cond], acc[side.cond]]) { b.n++; if (rec.verdict === "correct") b.correct++; if (rec.verdict !== "incorrect") b.partial++; }
        acc[side.cond].cost += rec.usage.cost;
        const cat = ((cats[pair.category] ??= Object.fromEntries(sides.map(s => [s.cond, { n: 0, correct: 0 }]))));
        cat[side.cond].n++; if (rec.verdict === "correct") cat[side.cond].correct++;
      }
      const tokens = (c: CodeCond) => entry?.snapshots[c]?.tokens;
      const base = entry?.snapshots["snap:base"];
      abRows.push([session.c.sessionId.slice(0, 8), String(per[sides[0].cond].n),
        ...sides.map(s => `${pct(per[s.cond].correct, per[s.cond].n)} (${pct(per[s.cond].partial, per[s.cond].n)})`),
        `${base?.listed ?? "-"} -> ${entry?.snapshots["snap:head"]?.listed ?? "-"}`,
        `${tokens("snap:base") ?? "-"} -> ${tokens("snap:head") ?? "-"}`]);
    }
    const n = acc[sides[0].cond].n;
    abRows.push(["overall", String(n), ...sides.map(s => `${pct(acc[s.cond].correct, acc[s.cond].n)} (${pct(acc[s.cond].partial, acc[s.cond].n)})`), "", ""]);
    console.log("\ncode A/B (same cached questions, one snapshot per side, one model per session):");
    console.log(table(abRows));
    console.log("\ncode A/B by keyword category (correct / n):");
    console.log(table([["category", ...sides.map(abLabel)], ...CATEGORIES.filter(c => cats[c]).map(c =>
      [c, ...sides.map(s => `${cats[c][s.cond].correct}/${cats[c][s.cond].n}`)])]));
    const snapCost = sides.reduce((sum, s) => sum + sessions.reduce((n2, x) =>
      n2 + (cache.ab?.[abKey(x.key, args.baselineCode, args.snapshotCode)]?.snapshots[s.cond]?.usage.cost ?? 0), 0), 0);
    console.log(`code A/B spend: snapshots $${snapCost.toFixed(4)}, answers+judges $${abAnswers.cost.toFixed(4)} (${abAnswers.n} pairs)`);
  }
  if (skipped.length) console.log(`skipped: ${skipped.join("; ")}`);
  console.log(`cache: ${args.out}`);

  cache.lastRun = { at: new Date().toISOString(), model: args.model ?? sessions[0].spec, questions: args.questions,
    sessions: rows, usage, skipped };
  saveCache(args.out, cache);
}

// ---------- selftest (no network) ----------
function selftest() {
  const assert = (ok: any, what: string) => { if (!ok) { console.error(`selftest FAILED: ${what}`); process.exit(1); } };
  const message = (id: string, role: string, content: any) => ({ type: "message", id, parentId: null, timestamp: "",
    message: { role, content, provider: "p", model: "m", ...(role === "toolResult" ? { toolName: "bash", toolCallId: `c${id}` } : {}) } });
  const raw = "x".repeat(20000);
  const pruned = `${Array.from(raw).slice(0, 4096).join("")}\n${PRUNED_MARK}e2; use read_tool_result]\n${Array.from(raw).slice(-1024).join("")}`;
  const branch = [
    message("e1", "user", [{ type: "text", text: "build the thing /tmp/a.ts" }]),
    message("e2", "toolResult", [{ type: "text", text: raw }]),
    { type: "context_edit", id: "e2e", parentId: null, timestamp: "", targetId: "e2", replacement: { content: [{ type: "text", text: pruned }] } },
    message("e3", "toolResult", [{ type: "text", text: "kept 42" }]),
    { type: "compaction", id: "c1", parentId: null, timestamp: "", summary: "## Goal\nkeep going", firstKeptEntryId: "e3", tokensBefore: 1 },
  ];
  assert(prunedInRange(branch, 0, 4).length === 1, "one pruned result in range");
  assert(prunedInRange(branch, 0, 4)[0].id === "e2", "pruned id");
  const candidate: Candidate = { file: "f", sessionId: "s", cwd: "/tmp", compactionId: "c1", compactions: 1, summary: "## Goal\nsnap",
    discardedText: "d", discardedTokens: 1, snapshotTokens: 1, pruned: [{ id: "e2", toolName: "bash", chars: 20000, raw }],
    archived: false, archive: "/tmp/archive.md", model: "p/m", truncated: false };
  const snap = buildSnap(candidate);
  assert(snap.includes("Restorable:") && snap.includes("Pruned tool results (entryId toolName originalChars: key slice") &&
    /\ne2 bash 20000: .*xxx/.test(snap), "snapshot tail lists the addressable result with a key slice");
  assert(!snap.includes("Older details:"), "no archive pointer when nothing is archived");
  assert(buildSnapRestore(candidate).length > snap.length, "restore adds recovered text");
  assert(buildSnapRestore(candidate).includes("x".repeat(100)), "recovered text present");
  const refs = restoreRefsOf(snap, branch);
  assert(refs.length === 1 && refs[0].id === "e2" && refs[0].raw.length === 20000, `restore list parsed back to the raw entry (${refs.length})`);
  assert(buildSnapRestoreFrom(snap, refs) === buildSnapRestore(candidate), "restored context is the same whichever list it came from");
  const pairs = validPairs({ pairs: [
    { question: "q1", answer: "a1", sourceQuote: "not in text" },
    { question: "q2", answer: "42", sourceQuote: "kept 42" },
    { question: "", answer: "a", sourceQuote: "kept 42" },
    { question: "q2", answer: "42", sourceQuote: "kept 42" },
  ] }, "context with kept 42 inside", 10);
  assert(pairs.length === 1 && pairs[0].question === "q2", `only verifiable, deduplicated pairs survive (${pairs.length})`);
  assert(classifyCategory("/tmp/a.ts") === "path" && classifyCategory("bun test failed") === "command" &&
    classifyCategory("42 retries") === "number" && classifyCategory("we decided to skip it") === "decision" &&
    classifyCategory("nothing here") === "other", "keyword categories");
  assert(exactHit("e178a65", "commit e178a65 pushed") && !exactHit("e178a65", "e178a66"), "exact-substring score");
  assert(parseJsonObject("```json\n{\"verdict\":\"correct\"}\n```").verdict === "correct", "JSON extraction");
  const parsedArgs = parseArgs(["--questions", "3", "a.jsonl", "--sessions", "2"]);
  assert(parsedArgs.questions === 3 && parsedArgs.sessions === 2 && parsedArgs.files[0] === "a.jsonl", "arg parsing");
  assert(!parsedArgs.resnapshot && parseArgs(["--resnapshot"]).resnapshot === true, "resnapshot is opt-in");
  const abArgs = parseArgs(["--baseline-code", "e178a65", "--snapshot-code", "HEAD"]);
  assert(abArgs.baselineCode === "e178a65" && abArgs.snapshotCode === "HEAD", "code A/B flags parse");
  assert(codeSides({}).length === 0, "no code A/B without a ref");
  const headOnly = codeSides({ baselineCode: "e178a65" });
  assert(headOnly.length === 2 && headOnly[1].cond === "snap:head" && headOnly[1].ref === undefined,
    "head defaults to the working tree when only the baseline ref is given");
  assert(codeSides({ snapshotCode: "12a74da" }).length === 1, "a snapshot ref alone gives one side");
  assert(abKey("s@c@m", "e178a65", "12a74da") !== abKey("s@c@m", "e178a65", undefined) &&
    abKey("s@c@m", "a", "b").includes("base:a") && abKey("s@c@m", "a", "b").includes("head:b"),
    "cache keys carry both code refs");
  assert(/\/\.eval-retention\/cache\.json$/.test(parseArgs([]).out), "default cache lives outside the repo");
  console.log("selftest ok");
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();

function resolvePath(p: string) { try { return path.resolve(p); } catch { return p; } }
