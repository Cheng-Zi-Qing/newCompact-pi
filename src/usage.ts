import { buildSessionProjection, calculateContextTokens, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import { busy, type SessionState } from "./guard.ts";
import { estimateProjectedTokens } from "./estimate.ts";

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
  warn?.();
  return DEFAULT_TRIGGER_RATIO;
}

// Provider usage is authoritative: the estimate misses encrypted reasoning tokens.
export function usageDecision(s: SessionState, total: number | undefined, window: number | undefined, reserve: number, enabled: boolean, now: number, ratio = DEFAULT_TRIGGER_RATIO) {
  if (!enabled) return "disabled";
  if (!total || !window || compactionLine(window, reserve, ratio) <= 0) return "no-data";
  if (total <= compactionLine(window, reserve, ratio)) return "small";
  if (s.paused) return "paused";
  if (s.compacting || busy(s, now) || (s.usagePending && now - s.usageLastAttempt < THROTTLE_MS * 2)) return "busy";
  if (now - s.usageLastAttempt < THROTTLE_MS) return "throttled";
  return "trigger";
}

// A compaction makes older usage stale. Subtract accounted edit savings, not the whole provider baseline.
function freshUsage(branch: any[]): { total: number; index: number } | undefined {
  const edits: any[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "compaction") return;
    if (e.type === "context_edit") { edits.push(e); continue; }
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") continue;
    const total = calculateContextTokens(m.usage);
    if (!Number.isFinite(total) || total <= 0) continue;
    let removed = 0;
    const seen = new Set<string>();
    for (const edit of edits) {
      const ti = branch.findIndex(x => x.id === edit.targetId);
      if (ti > i) continue; // edited a trailing message: counted from the projection instead
      const target = branch[ti];
      if (ti < 0 || target.type !== "message") return;
      if (seen.has(edit.targetId)) continue;
      seen.add(edit.targetId);
      const beforeEdit = branch.slice(ti + 1, i).findLast(x => x.type === "context_edit" && x.targetId === edit.targetId);
      const size = (replacement: any) => {
        if (replacement === null) return 0;
        const message = { ...target.message, ...replacement };
        if ((message.role === "assistant" || message.role === "toolResult") && typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
        return estimateTokens(message);
      };
      removed += Math.max(0, size(beforeEdit?.replacement) - size(edit.replacement));
    }
    return { total: Math.max(0, total - removed), index: i };
  }
}

export function freshUsageTotal(branch: any[]): number | undefined {
  return freshUsage(branch)?.total;
}

/** Stable public helper: provider baseline minus edit savings, plus projected messages after that usage. */
export function effectiveContextTokens(branch: any[], projection: any = buildSessionProjection(branch)): number {
  const usage = freshUsage(branch);
  if (usage) {
    const anchor = projection.entries.find((e: any) => e.sourceEntry.id === branch[usage.index].id);
    if (anchor?.messages.some((m: any) => m.role === "assistant" && m.usage && m.stopReason !== "error" && m.stopReason !== "aborted")) {
      let trailing = 0;
      const indices = new Map(branch.map((entry, index) => [entry.id, index]));
      for (const entry of projection.entries) {
        const index = indices.get(entry.sourceEntry.id) ?? -1;
        if (index > usage.index) for (const message of entry.messages) trailing += estimateTokens(message);
      }
      return usage.total + trailing;
    }
  }
  return estimateProjectedTokens(projection, branch);
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
