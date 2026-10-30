import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { committed, decide, effectiveReason, failed, stateOf } from "../src/guard.ts";
import { dataDir, Fallback, summarize } from "../src/summary.ts";
import { usageDecision, usageInputs } from "../src/usage.ts";
import { textTokens } from "../src/estimate.ts";

const STATUS = "pi-compact";
// Delay before the usage fallback acts, so pi's own end-of-run compaction (or a queued run) goes first.
export const usageDelay = { ms: 2000 };

export function isSubagent(ctx: ExtensionContext): boolean {
  const header: any = ctx.sessionManager.getHeader();
  if (header?.parentSession) return true;
  // In-memory children have no parentSession; pi-subagents-route tags them with a non-main contextRole.
  const route: any = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "model-route-state");
  return typeof route?.data?.contextRole === "string" && route.data.contextRole !== "main";
}

export function log(fields: Record<string, unknown>) {
  try {
    const file = path.join(dataDir(), "pi-compact.log");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  } catch { /* diagnostics only */ }
}

export default function piCompact(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const s = stateOf(sessionId);
    const sub = isSubagent(ctx);
    const reason = effectiveReason(s, event.reason);
    const d = decide(s, reason, sub, Date.now());
    const base = { session: sessionId, sub, reason, tokensBefore: event.preparation.tokensBefore };
    if (d.action === "cancel") {
      failed(s);
      log({ ...base, result: "cancel:paused" });
      // Status stays visible; the warning is shown once per pause, not on every turn.
      try {
        ctx.ui.setStatus(STATUS, "Auto-compaction paused (rapid loop); run /compact or start a new session");
        if (d.justPaused) ctx.ui.notify("Auto-compaction paused: it re-triggered within 60s twice. Run /compact or start a new session; context will keep growing until then.", "warning");
      } catch { /* UI is optional */ }
      return { cancel: true };
    }
    if (d.action === "abort") {
      failed(s);
      s.paused = true; // blocks the usage fallback from re-compacting the stopped run; a later manual /compact clears it
      log({ ...base, streak: d.streak, result: "abort:compaction-loop" });
      try { ctx.ui.notify("pi-compact: compaction loop in subagent; stopping this run so the parent can decide.", "error"); } catch { /* optional */ }
      // Marker first, so the reason is in the child transcript before the run stops.
      try {
        pi.sendMessage({ customType: "pi-compact-abort", content: "压缩循环", details: { reason: "compression-loop", sessionId } }, { triggerTurn: false });
      } catch { /* the abort below still stops the loop */ }
      ctx.abort();
      return { cancel: true };
    }
    s.compacting = true;
    try {
      const out = await summarize({
        preparation: event.preparation, branchEntries: event.branchEntries, customInstructions: event.customInstructions,
        signal: event.signal, model: ctx.model, complete: (m, c, o) => ctx.modelRegistry.complete(m, c, o),
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
    const reason = effectiveReason(s, (event as any).reason ?? "threshold");
    committed(s, reason, Date.now());
    if (isSubagent(ctx)) s.paused = false; // a successful compaction ends a subagent's post-abort usage block
    log({ session: ctx.sessionManager.getSessionId(), reason, result: "committed", fromExtension: event.fromExtension,
      summaryTokens: textTokens(event.compactionEntry.summary ?? "") });
    if (!s.paused) try { ctx.ui.setStatus(STATUS, undefined); } catch { /* optional */ }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    failed(stateOf(ctx.sessionManager.getSessionId()));
    log({ session: ctx.sessionManager.getSessionId(), reason: event.reason, result: "commit-failed", aborted: event.aborted,
      fromExtension: event.fromExtension, error: JSON.stringify((event.errorMessage ?? "").slice(0, 120)) });
  });

  // Fallback when provider-reported usage crosses the threshold. Only at agent_end: mid tool-loop compaction discards needed work.
  pi.on("agent_end", (_event, ctx) => {
    try {
      const s = stateOf(ctx.sessionManager.getSessionId());
      const { total, window, reserve } = usageInputs(pi, ctx);
      const now = Date.now();
      const decision = usageDecision(s, total, window, reserve, now);
      if (decision !== "trigger") return;
      s.usageLastAttempt = now; // throttle from the first sighting, even if we end up skipping
      // ctx.compact() aborts whatever is running (including an in-flight compaction), so only act once idle.
      setTimeout(() => {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const again = usageInputs(pi, ctx);
          // Re-check pause: the guard may have paused/aborted this session after the timer was queued.
          if (s.paused || s.compacting || !ctx.isIdle() || again.total === undefined || again.total <= again.window - again.reserve) {
            log({ session: sessionId, usageTotal: again.total, result: s.paused ? "usage-skip:paused" : s.compacting || !ctx.isIdle() ? "usage-skip:busy" : "usage-skip:resolved" });
            return;
          }
          s.usagePending = true;
          log({ session: sessionId, usageTotal: again.total, limit: again.window - again.reserve, result: "usage-trigger" });
          ctx.compact({ onError: () => failed(s) });
        } catch { /* stale ctx after reload/session switch */ }
      }, usageDelay.ms);
    } catch { /* never break the turn */ }
  });
}
