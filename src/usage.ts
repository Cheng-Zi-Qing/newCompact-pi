import { calculateContextTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./guard.ts";

export const THROTTLE_MS = 120000;

// Provider usage is authoritative: the estimate misses encrypted reasoning tokens.
export function usageDecision(s: SessionState, total: number | undefined, window: number | undefined, reserve: number, now: number) {
  if (!total || !window || window <= reserve) return "no-data";
  if (total <= window - reserve) return "small";
  if (s.paused) return "paused";
  if (s.usagePending && now - s.usageLastAttempt < THROTTLE_MS * 2) return "busy";
  if (now - s.usageLastAttempt < THROTTLE_MS) return "throttled";
  return "trigger";
}

// Latest valid assistant usage, or undefined when a compaction/context_edit came after it (that usage is stale;
// pi's own _checkCompaction applies the same rule). Native compaction runs before agent_end, so without this the
// pre-compaction usage would immediately trigger a second compaction.
export function freshUsageTotal(branch: any[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "compaction" || e.type === "context_edit") return;
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role === "assistant" && m.usage && m.stopReason !== "aborted" && m.stopReason !== "error") {
      const total = calculateContextTokens(m.usage);
      if (total > 0) return total;
    }
  }
}

export function usageInputs(pi: any, ctx: any) {
  const total = freshUsageTotal(ctx.sessionManager.getBranch());
  const window = ctx.getContextUsage()?.contextWindow || ctx.model?.contextWindow;
  const reserve = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model).reserveTokens;
  return { total, window, reserve };
}
