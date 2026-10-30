import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { busy, committed, decide, dropState, failed, stateOf } from "../src/guard.ts";
import { dataDir, Fallback, summarize } from "../src/summary.ts";
import { usageDecision, usageInputs } from "../src/usage.ts";
import { textTokens } from "../src/estimate.ts";

const STATUS = "pi-compact";
export const ABORT_ENTRY = "pi-compact-abort";
// Delay before the usage fallback acts, so pi's own end-of-run compaction (or a queued run) goes first.
export const usageDelay = { ms: 2000 };

export function isSubagent(ctx: ExtensionContext): boolean {
  // The router's role tag is authoritative when present: /fork and branched sessions also carry parentSession
  // but are main sessions (their copied route entry says "main").
  const route: any = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "model-route-state");
  if (typeof route?.data?.contextRole === "string") return route.data.contextRole !== "main";
  return !!(ctx.sessionManager.getHeader() as any)?.parentSession;
}

export function log(fields: Record<string, unknown>) {
  try {
    const file = path.join(dataDir(), "pi-compact.log");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  } catch { /* diagnostics only */ }
}

const WHY_TEXT = {
  "rapid-loop": "it re-triggered within 60s twice",
  "commit-failures": "compaction failed to commit twice in a row",
} as const;

export default function piCompact(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const s = stateOf(sessionId);
    const sub = isSubagent(ctx);
    const d = decide(s, event.reason, sub, Date.now());
    const base = { session: sessionId, sub, reason: d.reason, tokensBefore: event.preparation.tokensBefore, failStreak: s.failStreak };
    if (d.action === "cancel") {
      log({ ...base, result: `cancel:${d.why ?? "paused"}` });
      // Status stays visible; the warning is shown once per pause, not on every turn.
      try {
        ctx.ui.setStatus(STATUS, "Auto-compaction paused; run /compact or start a new session");
        if (d.justPaused && d.why) ctx.ui.notify(`Auto-compaction paused: ${WHY_TEXT[d.why]}. Run /compact or start a new session; context will keep growing until then.`, "warning");
      } catch { /* UI is optional */ }
      return { cancel: true };
    }
    if (d.action === "abort") {
      s.paused = true; // blocks the usage fallback from re-compacting the stopped run; the next successful compaction clears it
      const reason = d.why === "rapid-loop" ? "compression-loop" : "commit-failures";
      log({ ...base, streak: d.streak, result: `abort:${reason}` });
      // Written immediately and never sent to the model (sendMessage would be queued until the turn ends).
      try { pi.appendEntry(ABORT_ENTRY, { reason, sessionId, streak: d.streak, failStreak: s.failStreak }); } catch { /* abort still stops it */ }
      try { ctx.ui.notify(`pi-compact: ${WHY_TEXT[d.why]} in subagent; stopping this run so the parent can decide.`, "error"); } catch { /* optional */ }
      ctx.abort();
      return { cancel: true };
    }
    try {
      const out = await summarize({
        preparation: event.preparation, branchEntries: event.branchEntries, customInstructions: event.customInstructions,
        signal: event.signal, model: ctx.model, complete: (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o).result(),
        contextWindow: ctx.getContextUsage()?.contextWindow,
        sessionId, sessionFile: ctx.sessionManager.getSessionFile(), isSubagent: sub, budget: d.budget,
      });
      log({ ...base, streak: d.streak, budget: d.budget, summaryTokens: out.tokens, result: out.condensed ? "condensed" : "ok" });
      return { compaction: out.compaction };
    } catch (error) {
      log({ ...base, streak: d.streak, result: `fallback:${error instanceof Fallback ? error.message : "error"}` });
      return; // pi runs its native summary; never cancel here
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const s = stateOf(ctx.sessionManager.getSessionId());
    const reason = committed(s, Date.now());
    if (reason && reason !== "manual" && isSubagent(ctx)) s.paused = false; // a successful compaction ends a subagent's post-abort block
    log({ session: ctx.sessionManager.getSessionId(), reason: reason ?? `untracked:${event.reason}`, result: "committed",
      fromExtension: event.fromExtension, summaryTokens: textTokens(event.compactionEntry.summary ?? "") });
    if (!s.paused) try { ctx.ui.setStatus(STATUS, undefined); } catch { /* optional */ }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const s = stateOf(ctx.sessionManager.getSessionId());
    const reason = failed(s, event.aborted);
    log({ session: ctx.sessionManager.getSessionId(), reason: reason ?? `untracked:${event.reason}`, result: "commit-failed",
      aborted: event.aborted, fromExtension: event.fromExtension, failStreak: s.failStreak,
      error: JSON.stringify((event.errorMessage ?? "").slice(0, 120)) });
  });
  pi.on("session_shutdown", (_event, ctx) => { try { dropState(ctx.sessionManager.getSessionId()); } catch { /* stale ctx */ } });

  // Fallback when provider-reported usage crosses the threshold. Only at agent_end: mid tool-loop compaction discards needed work.
  pi.on("agent_end", (_event, ctx) => {
    try {
      const s = stateOf(ctx.sessionManager.getSessionId());
      const { total, window, reserve, enabled } = usageInputs(pi, ctx);
      const now = Date.now();
      if (usageDecision(s, total, window, reserve, enabled, now) !== "trigger") return;
      s.usageLastAttempt = now; // throttle from the first sighting, even if we end up skipping
      // ctx.compact() aborts whatever is running (including an in-flight compaction), so only act once idle.
      setTimeout(() => {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const again = usageInputs(pi, ctx);
          // Re-check everything: the guard may have paused/aborted this session after the timer was queued.
          const skip = !again.enabled ? "disabled" : s.paused ? "paused" : busy(s, Date.now()) || !ctx.isIdle() ? "busy"
            : again.total === undefined || again.total <= again.window - again.reserve ? "resolved" : undefined;
          if (skip) { log({ session: sessionId, usageTotal: again.total, result: `usage-skip:${skip}` }); return; }
          s.usagePending = true;
          log({ session: sessionId, usageTotal: again.total, limit: again.window - again.reserve, result: "usage-trigger" });
          ctx.compact({ onError: () => { s.usagePending = false; } }); // e.g. "nothing to compact" before our hook runs
        } catch { /* stale ctx after reload/session switch */ }
      }, usageDelay.ms);
    } catch { /* never break the turn */ }
  });
}
