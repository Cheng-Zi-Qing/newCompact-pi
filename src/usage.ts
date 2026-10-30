import { calculateContextTokens, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import { busy, type SessionState } from "./guard.ts";

export const THROTTLE_MS = 120000;

// Provider usage is authoritative: the estimate misses encrypted reasoning tokens.
export function usageDecision(s: SessionState, total: number | undefined, window: number | undefined, reserve: number, enabled: boolean, now: number) {
  if (!enabled) return "disabled";
  if (!total || !window || window <= reserve) return "no-data";
  if (total <= window - reserve) return "small";
  if (s.paused) return "paused";
  if (busy(s, now) || (s.usagePending && now - s.usageLastAttempt < THROTTLE_MS * 2)) return "busy";
  if (now - s.usageLastAttempt < THROTTLE_MS) return "throttled";
  return "trigger";
}

// Latest valid assistant usage, adjusted for context_edits made after it (tool-result pruning): the estimated
// size each edit removed is subtracted. A compaction after the usage makes it stale (pi's own rule), as does an
// edit we cannot account for. Native compaction runs before agent_end, so without this the pre-compaction
// usage would immediately trigger a second compaction.
export function freshUsageTotal(branch: any[]): number | undefined {
  const edits: any[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "compaction") return;
    if (e.type === "context_edit") { edits.push(e); continue; }
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") continue;
    const total = calculateContextTokens(m.usage);
    if (total <= 0) continue;
    let removed = 0;
    const seen = new Set<string>();
    for (const edit of edits) {
      const ti = branch.findIndex(x => x.id === edit.targetId);
      if (ti > i) continue; // edited something that came after the usage: not part of this total
      const target = branch[ti];
      if (ti < 0 || target.type !== "message" || seen.has(edit.targetId)) return;
      seen.add(edit.targetId);
      const after = edit.replacement === null ? 0 : estimateTokens({ ...target.message, ...edit.replacement });
      removed += Math.max(0, estimateTokens(target.message) - after);
    }
    return Math.max(0, total - removed);
  }
}

export function usageInputs(pi: any, ctx: any) {
  const total = freshUsageTotal(ctx.sessionManager.getBranch());
  const window = ctx.getContextUsage()?.contextWindow || ctx.model?.contextWindow;
  const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
  return { total, window, reserve: settings.reserveTokens, enabled: settings.enabled !== false };
}
