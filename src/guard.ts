// In-memory, per-session state. shortcut: resets on restart/reload; persist it if cross-restart breaking is ever needed.
export const RAPID_MS = 60000;
export const BUDGET = 6000;
export const TIGHT_BUDGET = 3000;

export type Reason = "manual" | "threshold" | "overflow";
export type SessionState = {
  streak: number; lastAutoSuccess: number | null; paused: boolean;
  pendingStreak?: number; usagePending?: boolean; usageLastAttempt: number; compacting?: boolean;
};
export type Decision = { action: "run"; budget: number; streak: number } | { action: "cancel"; justPaused: boolean } | { action: "abort"; streak: number };

const states = new Map<string, SessionState>();
export function stateOf(sessionId: string): SessionState {
  let s = states.get(sessionId);
  if (!s) { s = { streak: 0, lastAutoSuccess: null, paused: false, usageLastAttempt: 0 }; states.set(sessionId, s); }
  return s;
}
export function resetStates() { states.clear(); }

// usage-triggered ctx.compact() arrives as "manual"; count it as automatic so it cannot bypass the guard.
export function effectiveReason(s: SessionState, reason: Reason): Reason {
  return reason === "manual" && s.usagePending ? "threshold" : reason;
}

export function decide(s: SessionState, reason: Reason, isSubagent: boolean, now: number): Decision {
  if (reason === "manual") { s.pendingStreak = 0; return { action: "run", budget: BUDGET, streak: 0 }; }
  const streak = s.lastAutoSuccess !== null && now - s.lastAutoSuccess < RAPID_MS ? s.streak + 1 : 0;
  if (isSubagent) {
    // Nobody sees a subagent's pause notice, so never pause; stop the run instead and let the parent decide.
    if (streak >= 3) return { action: "abort", streak };
  } else {
    if (s.paused) return { action: "cancel", justPaused: false };
    if (streak >= 2) { s.paused = true; return { action: "cancel", justPaused: true }; }
  }
  s.pendingStreak = streak;
  return { action: "run", budget: streak >= 1 ? TIGHT_BUDGET : BUDGET, streak };
}

export function committed(s: SessionState, reason: Reason, now: number) {
  if (reason === "manual") { s.streak = 0; s.lastAutoSuccess = null; s.paused = false; }
  else { s.streak = s.pendingStreak ?? 0; s.lastAutoSuccess = now; }
  s.pendingStreak = undefined;
  s.usagePending = false;
  s.compacting = false;
}

export function failed(s: SessionState) { s.pendingStreak = undefined; s.usagePending = false; s.compacting = false; }
