#!/usr/bin/env bun
// Retention probe: after a real compaction, how many facts discarded from the model context can still be answered,
// and how much do the current artifacts (snapshot + pointers + pruned tool results) help?
// Read-only: reads session files and model metadata; never writes into ~/.pi except the cache file under --out.
// usage: bun scripts/eval-retention.ts [session.jsonl ...] [--questions N] [--sessions N] [--out path]
//        [--model provider/model[:thinking]] [--concurrency N] [--plan] [--selftest]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime, SessionManager, buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import { archivePath, restoreBlock } from "../src/summary.ts";
import { textTokens } from "../src/estimate.ts";

const CONDS = ["raw", "snap", "snap+restore"] as const;
export type Cond = typeof CONDS[number];
const PRUNED_MARK = "[tool_result pruned; raw entry ";
const RESTORE_HEAD_LIMIT = 8192; // one read_tool_result call returns at most this many codepoints
const RAW_TOKEN_CAP = 200_000;

// ---------- args ----------
type Args = { files: string[]; questions: number; sessions: number; out: string; model?: string; concurrency: number; plan: boolean; selftest: boolean };
export function parseArgs(argv: string[]): Args {
  const args: Args = { files: [], questions: 6, sessions: 5, concurrency: 2, plan: false, selftest: false,
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
    else if (a.startsWith("--")) throw new Error(`Unknown flag ${a}`);
    else args.files.push(a);
  }
  return args;
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
  if (!pruned.length) return "";
  return `\n\nPruned tool results (entryId toolName originalChars):\n${pruned.slice(0, 20).map(p => `${p.id} ${p.toolName} ${p.chars}`).join("\n")}` +
    (pruned.length > 20 ? `\n+${pruned.length - 20} more` : "");
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

export function buildSnapRestore(c: Candidate): string {
  const snap = buildSnap(c);
  if (!c.pruned.length) return snap;
  // A model following the pointers one read_tool_result call per result recovers at most 8192 codepoints each.
  const recovered = c.pruned.slice(0, 20).map(p => `# ${p.id} ${p.toolName} (${p.chars} chars)\n${Array.from(p.raw).slice(0, RESTORE_HEAD_LIMIT).join("")}`);
  return `${snap}\n\nRecovered pruned tool results:\n<<<\n${recovered.join("\n\n")}\n>>>`;
}

export function contexts(c: Candidate): Record<Cond, string> {
  return { raw: c.discardedText, snap: buildSnap(c), "snap+restore": buildSnapRestore(c) };
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
  model: string; truncated: boolean; probeUsage?: Usage; pairs?: PairRecord[] };
type Cache = { version: 1; model: string; sessions: Record<string, SessionRecord>; lastRun?: any };

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
        discardedTokens: c.discardedTokens, snapshotTokens: c.snapshotTokens, recoverable: c.pruned.slice(0, 20).reduce((n, p) => n + Math.min(p.chars, RESTORE_HEAD_LIMIT), 0),
        prunedListed: Math.min(20, c.pruned.length), archived: c.archived, model: spec, truncated: c.truncated };
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

  // Answer + judge: one independent call per (pair, condition); the condition is never named to the judge.
  const jobs: Array<() => Promise<void>> = [];
  for (const session of sessions) {
    const ctx = contexts(session.c);
    for (const pair of session.pairs) {
      pair.conditions ??= {};
      const order = [...CONDS].sort((a, b) => hash(`${pair.question}${a}`) - hash(`${pair.question}${b}`));
      for (const cond of order) {
        if (pair.conditions[cond]?.verdict) continue;
        jobs.push(async () => {
          const spec = session.spec, call = caller(spec);
          const answered = await call(ANSWER_SYSTEM, `Context:\n<<<\n${ctx[cond]}\n>>>\n\nQuestion: ${pair.question}`, 1500);
          const judged = await call(JUDGE_SYSTEM, `Question: ${pair.question}\nReference answer: ${pair.answer}\nCandidate answer: ${answered.text}`, 800);
          let verdict = "incorrect", reason = "";
          try {
            const parsed = parseJsonObject(judged.text);
            verdict = ["correct", "partial", "incorrect"].includes(parsed?.verdict) ? parsed.verdict : "incorrect";
            reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 200) : "";
          } catch { reason = "unparseable judge output"; }
          pair.conditions![cond] = { answer: answered.text, verdict, reason, exact: exactHit(pair.answer, answered.text),
            usage: { ...answered.usage, ms: answered.usage.ms + judged.usage.ms, cost: answered.usage.cost + judged.usage.cost,
              input: answered.usage.input + judged.usage.input, output: answered.usage.output + judged.usage.output,
              cached: answered.usage.cached + judged.usage.cached }, at: new Date().toISOString() };
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
  const cond = Object.fromEntries(CONDS.map(c => [c, { n: 0, correct: 0, partial: 0, exact: 0, incorrectBy: {} as Record<string, number>, part: {} as Record<string, number> }])) as any;
  const rows: string[][] = [["session", "cwd", "comp", "n", "RAW", "SNAP", "SNAP+RESTORE", "ratio", "recoverable"]];
  for (const session of sessions) {
    const per = Object.fromEntries(CONDS.map(c => [c, { n: 0, correct: 0, partial: 0, exact: 0 }])) as any;
    for (const pair of session.pairs) {
      for (const c of CONDS) {
        const rec = pair.conditions?.[c];
        if (!rec?.verdict) continue;
        per[c].n++;
        if (rec.verdict === "correct") per[c].correct++;
        if (rec.verdict !== "incorrect") per[c].partial++;
        if (rec.exact) per[c].exact++;
        usage.cost += rec.usage.cost; usage.input += rec.usage.input; usage.output += rec.usage.output; usage.ms += rec.usage.ms;
        if (rec.verdict !== "correct") {
          cond[c].incorrectBy[pair.category] = (cond[c].incorrectBy[pair.category] ?? 0) + 1;
          if (rec.verdict === "partial") cond[c].part[pair.category] = (cond[c].part[pair.category] ?? 0) + 1;
        }
      }
    }
    for (const c of CONDS) { const p = per[c]; cond[c].n += p.n; cond[c].correct += p.correct; cond[c].partial += p.partial; cond[c].exact += p.exact; }
    const n = per.raw.n;
    rows.push([session.c.sessionId.slice(0, 8), session.c.cwd, String(session.c.compactions), String(n),
      `${pct(per.raw.correct, n)} (${pct(per.raw.partial, n)})`, `${pct(per.snap.correct, n)} (${pct(per.snap.partial, n)})`,
      `${pct(per["snap+restore"].correct, n)} (${pct(per["snap+restore"].partial, n)})`,
      `${(session.c.discardedTokens / Math.max(1, session.c.snapshotTokens)).toFixed(1)}x`,
      String(session.c.pruned.length)]);
  }
  const nOverall = cond.raw.n;
  rows.push(["overall", "", "", String(nOverall),
    `${pct(cond.raw.correct, nOverall)} (${pct(cond.raw.partial, nOverall)})`,
    `${pct(cond.snap.correct, nOverall)} (${pct(cond.snap.partial, nOverall)})`,
    `${pct(cond["snap+restore"].correct, nOverall)} (${pct(cond["snap+restore"].partial, nOverall)})`, "", ""]);

  console.log(table(rows));
  console.log("\nexact-substring cross-check (correct, no judge):");
  console.log(table([["condition", "exact hit", "judged correct", "n"], ...CONDS.map(c =>
    [c, pct(cond[c].exact, cond[c].n), pct(cond[c].correct, cond[c].n), String(cond[c].n)])]));
  console.log("\nfailed pairs by keyword category (incorrect, partial in parentheses):");
  console.log(table([["condition", ...CATEGORIES.map(c => c)], ...CONDS.map(c =>
    [c, ...CATEGORIES.map(k => `${String(cond[c].incorrectBy[k] ?? 0)} (${String(cond[c].part[k] ?? 0)})`)])]));
  console.log(`\ncalls: ${usage.input + usage.output} tokens in/out (${usage.input} in, ${usage.output} out), cost $${usage.cost.toFixed(4)}, ` +
    `summed call time ${(usage.ms / 1000).toFixed(0)}s, wall ${((performance.now() - started) / 1000).toFixed(0)}s`);
  console.log(`compression: discarded ${sessions.reduce((n, s) => n + s.c.discardedTokens, 0)} tokens -> snapshot ` +
    `${sessions.reduce((n, s) => n + s.c.snapshotTokens, 0)} tokens; recoverable pruned results ` +
    `${sessions.reduce((n, s) => n + Math.min(20, s.c.pruned.length), 0)} (of ${sessions.reduce((n, s) => n + s.c.pruned.length, 0)} in range, head ${RESTORE_HEAD_LIMIT} codepoints each)`);
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
  assert(snap.includes("Restorable:") && snap.includes("Pruned tool results (entryId toolName originalChars):\ne2 bash 20000"), "snapshot tail lists the addressable result");
  assert(!snap.includes("Older details:"), "no archive pointer when nothing is archived");
  assert(buildSnapRestore(candidate).length > snap.length, "restore adds recovered text");
  assert(buildSnapRestore(candidate).includes("x".repeat(100)), "recovered text present");
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
  assert(/\/\.eval-retention\/cache\.json$/.test(parseArgs([]).out), "default cache lives outside the repo");
  console.log("selftest ok");
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();

function resolvePath(p: string) { try { return path.resolve(p); } catch { return p; } }
