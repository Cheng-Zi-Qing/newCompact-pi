// In-memory, per-session state. shortcut: resets on restart/reload; persist it if cross-restart breaking is ever needed.
export const RAPID_MS = 60000;
export const BUDGET = 6000;
export const TIGHT_BUDGET = 3000;
export const FAIL_LIMIT = 2;           // consecutive failed commits of our own attempts
export const ATTEMPT_STALE_MS = 600000; // an attempt with no commit/fail event after this is ignored

export type Reason = "manual" | "threshold" | "overflow";
export type Why = "rapid-loop" | "commit-failures";
export type Attempt = { reason: Reason; streak: number; at: number };
export type SessionState = {
  streak: number; lastAutoSuccess: number | null; paused: boolean; failStreak: number;
  attempt?: Attempt; usagePending?: boolean; usageLastAttempt: number;
};
export type Decision =
  | { action: "run"; reason: Reason; budget: number; streak: number }
  | { action: "cancel"; reason: Reason; justPaused: boolean; why?: Why }
  | { action: "abort"; reason: Reason; streak: number; why: Why };

const states = new Map<string, SessionState>();
export function stateOf(sessionId: string): SessionState {
  let s = states.get(sessionId);
  if (!s) { s = { streak: 0, lastAutoSuccess: null, paused: false, failStreak: 0, usageLastAttempt: 0 }; states.set(sessionId, s); }
  return s;
}
export function resetStates() { states.clear(); }
export function dropState(sessionId: string) { states.delete(sessionId); }

export function busy(s: SessionState, now: number) { return !!s.attempt && now - s.attempt.at < ATTEMPT_STALE_MS; }

export function decide(s: SessionState, raw: Reason, isSubagent: boolean, now: number): Decision {
  // usage-triggered ctx.compact() arrives as "manual"; count it as automatic so it cannot bypass the guard.
  const reason: Reason = raw === "manual" && s.usagePending ? "threshold" : raw;
  s.usagePending = false;
  if (reason === "manual") { s.attempt = { reason, streak: 0, at: now }; return { action: "run", reason, budget: BUDGET, streak: 0 }; }
  const streak = s.lastAutoSuccess !== null && now - s.lastAutoSuccess < RAPID_MS ? s.streak + 1 : 0;
  // Overflow is never blocked: pi has already dropped the failed reply and retries once after compacting,
  // so cancelling would silently lose the turn. It still counts toward the streak.
  if (reason !== "overflow") {
    const why: Why | undefined = streak >= 2 ? "rapid-loop" : s.failStreak >= FAIL_LIMIT ? "commit-failures" : undefined;
    if (isSubagent) {
      // Nobody sees a subagent's pause notice, so never pause; stop the run (3rd attempt) and let the parent decide.
      if (why) return { action: "abort", reason, streak, why };
    } else {
      if (s.paused) return { action: "cancel", reason, justPaused: false };
      if (why) { s.paused = true; return { action: "cancel", reason, justPaused: true, why }; }
    }
  }
  s.attempt = { reason, streak, at: now };
  return { action: "run", reason, budget: streak >= 1 ? TIGHT_BUDGET : BUDGET, streak };
}

/** Our attempt was committed. Returns the attempt's reason, or undefined if the commit was not ours. */
export function committed(s: SessionState, now: number): Reason | undefined {
  const a = s.attempt;
  if (!a) return;
  if (a.reason === "manual") { s.streak = 0; s.lastAutoSuccess = null; s.paused = false; }
  else { s.streak = a.streak; s.lastAutoSuccess = now; }
  s.failStreak = 0;
  s.attempt = undefined;
  return a.reason;
}

/** Our attempt failed to commit. Failures pi emits without running our hook (no attempt) are ignored. */
export function failed(s: SessionState, aborted: boolean): Reason | undefined {
  const a = s.attempt;
  if (!a) return;
  if (!aborted) s.failStreak++;
  s.attempt = undefined;
  return a.reason;
}
