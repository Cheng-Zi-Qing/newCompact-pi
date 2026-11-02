import { buildSessionProjection, calculateContextTokens, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import { busy, type SessionState } from "./guard.ts";
import { estimateProjectedTokens } from "./estimate.ts";
import { calibratedTokens, fitCalibration, messageCharacters, RECENT_OBSERVATIONS, type Observation } from "./calibration.ts";

export const THROTTLE_MS = 120000;
export const DEFAULT_TRIGGER_RATIO = 0.8;

export function compactionLine(window: number, reserve: number, ratio = DEFAULT_TRIGGER_RATIO): number {
  return Math.min(window - reserve, Math.floor(window * ratio));
}
export function getTriggerRatio(settings: any, warn?: () => void): number {
  const config = settings?.piCompact;
  if (config === undefined || (config && typeof config === "object" && !Array.isArray(config) && config.triggerRatio === undefined)) return DEFAULT_TRIGGER_RATIO;
  const ratio = config?.triggerRatio;
  if (typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 0.95) return ratio;
  warn?.(); return DEFAULT_TRIGGER_RATIO;
}
export function usageDecision(s: SessionState, total: number | undefined, window: number | undefined, reserve: number, enabled: boolean, now: number, ratio = DEFAULT_TRIGGER_RATIO) {
  if (!enabled) return "disabled";
  if (!total || !window || compactionLine(window, reserve, ratio) <= 0) return "no-data";
  if (total <= compactionLine(window, reserve, ratio)) return "small";
  if (s.paused) return "paused";
  if (s.compacting || busy(s, now) || (s.usagePending && now - s.usageLastAttempt < THROTTLE_MS * 2)) return "busy";
  if (now - s.usageLastAttempt < THROTTLE_MS) return "throttled";
  return "trigger";
}

export function reportedInput(message: any): number | undefined {
  const u = message?.usage;
  if (message?.role !== "assistant" || !u || message.stopReason === "aborted" || message.stopReason === "error") return;
  const fields = [u.input, u.cacheRead ?? 0, u.cacheWrite ?? 0];
  if (!fields.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return;
  const total = fields.reduce((a, b) => a + b, 0);
  return total > 0 ? total : undefined;
}
const modelKey = (message: any) => `${message?.provider ?? "unknown"}/${message?.model ?? "unknown"}`;
function usageAnchor(branch: any[]) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const e = branch[index];
    if (e.type === "compaction") return;
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") continue;
    const tokens = calculateContextTokens(m.usage);
    if (Number.isFinite(tokens) && tokens > 0) return { index, tokens, message: m };
  }
}
function editPairs(branch: any[], index: number) {
  const pairs: Array<{ before: any; after: any }> = [];
  const seen = new Set<string>();
  for (let i = branch.length - 1; i > index; i--) {
    const edit = branch[i];
    if (edit.type !== "context_edit") continue;
    const ti = branch.findIndex(x => x.id === edit.targetId);
    if (ti > index) continue;
    const target = branch[ti];
    if (ti < 0 || target.type !== "message") return;
    if (seen.has(edit.targetId)) continue;
    seen.add(edit.targetId);
    const previous = branch.slice(ti + 1, index).findLast(x => x.type === "context_edit" && x.targetId === edit.targetId);
    const apply = (replacement: any) => {
      if (replacement === null) return;
      const message = { ...target.message, ...replacement };
      if ((message.role === "assistant" || message.role === "toolResult") && typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
      return message;
    };
    pairs.push({ before: apply(previous?.replacement), after: apply(edit.replacement) });
  }
  return pairs;
}
function freshUsage(branch: any[], estimate = estimateTokens) {
  const anchor = usageAnchor(branch);
  if (!anchor) return;
  const pairs = editPairs(branch, anchor.index);
  if (!pairs) return;
  const savings = pairs.reduce((sum, pair) => sum + Math.max(0, (pair.before ? estimate(pair.before) : 0) - (pair.after ? estimate(pair.after) : 0)), 0);
  return { ...anchor, savings, total: Math.max(0, anchor.tokens - savings), pairs };
}
export function freshUsageTotal(branch: any[]): number | undefined { return freshUsage(branch)?.total; }

function trailingMessages(branch: any[], projection: any, index: number): any[] {
  const indices = new Map(branch.map((entry, i) => [entry.id, i]));
  return projection.entries.filter((entry: any) => (indices.get(entry.sourceEntry.id) ?? -1) > index).flatMap((entry: any) => entry.messages);
}
function breakdown(branch: any[], projection: any, estimate = estimateTokens) {
  const usage = freshUsage(branch, estimate);
  if (usage) {
    const anchor = projection.entries.find((e: any) => e.sourceEntry.id === branch[usage.index].id);
    if (anchor?.messages.some((m: any) => m.role === "assistant" && m.usage && m.stopReason !== "error" && m.stopReason !== "aborted")) {
      const trailing = trailingMessages(branch, projection, usage.index);
      const delta = trailing.reduce((sum, message) => sum + estimate(message), 0);
      return { anchor: usage, trailing, delta, savings: usage.savings, total: usage.total + delta,
        age: branch.slice(usage.index + 1).filter(e => e.type === "message" && e.message.role === "assistant").length };
    }
  }
  return { anchor: undefined, trailing: [], delta: 0, savings: 0, total: estimateProjectedTokens(projection, branch), age: 0 };
}

// Immutable session entries identify a branch prefix. Weak keys release a finished session/file's cache.
const calibrationCache = new WeakMap<object, Map<string, Observation[]>>();
export function calibrationForBranch(branch: any[], model?: string) {
  let observations = new Map<string, Observation[]>();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    const cached = calibrationCache.get(entry);
    if (cached) { observations = cached; continue; }
    const current = entry.type === "message" ? entry.message : undefined;
    const actual = reportedInput(current);
    if (actual !== undefined) {
      const prefix = branch.slice(0, i);
      const details = breakdown(prefix, buildSessionProjection(prefix));
      const anchor = details.anchor;
      const changed = anchor && prefix.slice(anchor.index + 1).some(e => e.type === "model_change" ||
        (e.type === "message" && (e.message.role === "system" || e.message.role === "assistant")));
      if (anchor && !changed && modelKey(anchor.message) === modelKey(current)) {
        const delta = { cjk: 0, other: 0, images: 0 };
        for (const message of details.trailing) {
          const chars = messageCharacters(message);
          delta.cjk += chars.cjk; delta.other += chars.other; delta.images += chars.images;
        }
        for (const pair of anchor.pairs) {
          const before = pair.before ? messageCharacters(pair.before) : { cjk: 0, other: 0, images: 0 };
          const after = pair.after ? messageCharacters(pair.after) : { cjk: 0, other: 0, images: 0 };
          delta.cjk += after.cjk - before.cjk; delta.other += after.other - before.other; delta.images += after.images - before.images;
        }
        const tokens = actual - anchor.tokens; // Previous response output is already in the anchor, not a new input delta.
        const magnitude = Math.abs(delta.cjk) + Math.abs(delta.other);
        const sameSign = delta.cjk * delta.other < 0 || tokens * (delta.cjk + delta.other) > 0;
        // Tiny deltas, images and impossible token/char changes cannot calibrate a text tokenizer reliably.
        if (delta.images === 0 && magnitude >= 128 && sameSign && Math.abs(tokens) <= magnitude * 4) {
          const key = modelKey(current);
          observations = new Map(observations);
          observations.set(key, [...(observations.get(key) ?? []), { cjk: delta.cjk, other: delta.other, tokens }].slice(-RECENT_OBSERVATIONS));
        }
      }
    }
    calibrationCache.set(entry, observations);
  }
  return fitCalibration(observations.get(model ?? modelKey(usageAnchor(branch)?.message)) ?? []);
}

/** A: pre-calibration behavior, retained for paired evaluation. */
export function uncalibratedContextTokens(branch: any[], projection: any = buildSessionProjection(branch)): number {
  return breakdown(branch, projection).total;
}
export function contextDiagnostics(branch: any[], projection: any = buildSessionProjection(branch)) {
  const a = breakdown(branch, projection);
  const selection = branch.findLastIndex(e => e.type === "model_change");
  const selectedModel = selection >= 0 && (!a.anchor || selection > a.anchor.index) ? `${branch[selection].provider}/${branch[selection].modelId}` : modelKey(a.anchor?.message);
  const calibration = calibrationForBranch(branch, selectedModel);
  const applied = calibration.ready && selectedModel === modelKey(a.anchor?.message);
  const ab = applied ? breakdown(branch, projection, message => calibratedTokens(message, calibration)) : a;
  return { anchor: a.anchor ? { index: a.anchor.index, tokens: a.anchor.tokens } : undefined,
    age: a.age, delta: ab.delta, savings: ab.savings, total: ab.total, calibration, applied,
    uncalibrated: a.total, model: selectedModel, calibrated: ab.total,
    calibratedDelta: ab.delta, calibratedSavings: ab.savings };
}
export function calibratedContextTokens(branch: any[], projection: any = buildSessionProjection(branch)): number {
  return contextDiagnostics(branch, projection).calibrated;
}
/** Stable public signature: calibrate trailing text/edit savings when past observations identify safe model ratios. */
export function effectiveContextTokens(branch: any[], projection: any = buildSessionProjection(branch)): number {
  return calibratedContextTokens(branch, projection);
}
export function usageInputs(pi: any, ctx: any, manager = ctx.sessionManager, warn?: () => void) {
  const branch = manager.getBranch();
  const total = effectiveContextTokens(branch, manager.buildSessionProjection?.() ?? buildSessionProjection(branch));
  const window = ctx.getContextUsage()?.contextWindow || ctx.model?.contextWindow;
  const config = pi.getSettings();
  const settings = SettingsManager.inMemory(config).getCompactionSettings(ctx.model);
  return { total, window, reserve: settings.reserveTokens, keepRecent: settings.keepRecentTokens,
    enabled: settings.enabled !== false, ratio: getTriggerRatio(config, warn) };
}
