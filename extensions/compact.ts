import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { busy, committed, decide, dropState, failed, stateOf } from "../src/guard.ts";
import { dataDir, Fallback, summarize } from "../src/summary.ts";
import { compactionLine, contextDiagnostics, effectiveContextTokens, getSummaryModel, usageDecision, usageInputs } from "../src/usage.ts";
import { prepareBoundaryCompaction } from "../src/boundary.ts";
import { replay } from "./tool-result-pruner.ts";
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
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  } catch { /* diagnostics only */ }
}

const WHY_TEXT = {
  "rapid-loop": "it re-triggered within 60s twice",
  "commit-failures": "compaction failed to commit twice in a row",
} as const;

export default function piCompact(pi: ExtensionAPI) {
  // piCompact.summaryModel: a cheap main model must not write cheap snapshots (see docs/retention-eval.md §八).
  function summaryTarget(ctx: any) {
    const sessionId = ctx.sessionManager.getSessionId();
    const s = stateOf(sessionId);
    const registry = ctx.modelRegistry;
    const target = getSummaryModel(pi.getSettings(), typeof registry?.find === "function" ? (p: string, id: string) => registry.find(p, id) : undefined, ctx.model);
    if (target.reason && !s.summaryNoted) {
      s.summaryNoted = true;
      log({ session: sessionId, "summary-model": `fallback:${target.reason}` });
      // An unset key is the documented default, so only a key we cannot use is worth a warning.
      if (target.reason !== "unset") try {
        ctx.ui.notify(target.reason === "malformed"
          ? "Invalid piCompact.summaryModel: expected \"provider/model\" or \"provider/model:thinking\"; using the session model for snapshots."
          : `piCompact.summaryModel \"${JSON.stringify(pi.getSettings()?.piCompact?.summaryModel)}\" is not resolvable in this session; using the session model for snapshots.`, "warning");
      } catch { /* optional UI */ }
    }
    return target;
  }
  function inputs(ctx: any, manager = ctx.sessionManager) {
    return usageInputs(pi, ctx, manager, () => {
      const s = stateOf(ctx.sessionManager.getSessionId());
      if (s.ratioWarned) return;
      s.ratioWarned = true;
      try { ctx.ui.notify("Invalid piCompact.triggerRatio: expected a number from 0.5 to 0.95; using 0.8.", "warning"); } catch { /* optional UI */ }
    });
  }
  function guard(ctx: any, reason: any, tokensBefore: number) {
    const sessionId = ctx.sessionManager.getSessionId();
    const s = stateOf(sessionId);
    const sub = isSubagent(ctx);
    const d = decide(s, reason, sub, Date.now());
    const base = { session: sessionId, sub, reason: d.reason, tokensBefore, failStreak: s.failStreak };
    if (d.action === "cancel") {
      log({ ...base, result: `cancel:${d.why ?? "paused"}` });
      // Status stays visible; the warning is shown once per pause, not on every turn.
      try {
        ctx.ui.setStatus(STATUS, "Auto-compaction paused; run /compact or start a new session");
        if (d.justPaused && d.why) ctx.ui.notify(`Auto-compaction paused: ${WHY_TEXT[d.why]}. Run /compact or start a new session; context will keep growing until then.`, "warning");
      } catch { /* UI is optional */ }
      return { s, d, base, sub, sessionId };
    }
    if (d.action === "abort") {
      s.paused = true; // blocks the usage fallback from re-compacting the stopped run; the next successful compaction clears it
      const reason = d.why === "rapid-loop" ? "compression-loop" : "commit-failures";
      log({ ...base, streak: d.streak, result: `abort:${reason}` });
      // Written immediately and never sent to the model (sendMessage would be queued until the turn ends).
      try { pi.appendEntry(ABORT_ENTRY, { reason, sessionId, streak: d.streak, failStreak: s.failStreak }); } catch { /* abort still stops it */ }
      try { ctx.ui.notify(`pi-compact: ${WHY_TEXT[d.why]} in subagent; stopping this run so the parent can decide.`, "error"); } catch { /* optional */ }
      ctx.abort();
    }
    return { s, d, base, sub, sessionId };
  }

  pi.registerCommand("context", {
    description: "Inspect provider-aware context size and calibration",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const details = contextDiagnostics(branch);
      const { total, window, reserve, ratio } = inputs(ctx);
      const target = summaryTarget(ctx);
      const number = (n: number) => Math.round(n).toLocaleString("en-US");
      const line = window ? compactionLine(window, reserve, ratio) : undefined;
      const fit = details.calibration;
      ctx.ui.notify([
        `anchor=${details.anchor ? number(details.anchor.tokens) : "none"} age=${details.age} turns | delta=${number(details.delta)} savings=${number(details.savings)}`,
        `cal cjk=${fit.cjk.toFixed(3)}${fit.cjkLearned ? "" : "(prior)"} other=${fit.other.toFixed(3)}${fit.otherLearned ? "" : "(prior)"} n=${fit.observations} (${details.applied ? "calibrated" : "fallback"})`,
        `effective(A+B)=${number(total)} / ${window ? number(window) : "unknown"} (${window ? (total / window * 100).toFixed(1) + "%" : "unknown"}) line=${line === undefined ? "unknown" : number(line)} distance=${line === undefined ? "unknown" : number(line - total)}`,
        `snapshot model=${target.model?.provider ?? "unknown"}/${target.model?.id ?? "unknown"}${target.thinking ? `:${target.thinking}` : ""} (${target.explicit ? "explicit" : "session"}) window=${target.model?.contextWindow ? number(target.model.contextWindow) : "unknown"}`,
      ].join("\n"), "info");
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { s, d, base, sub, sessionId } = guard(ctx, event.reason, event.preparation.tokensBefore);
    if (d.action !== "run") return { cancel: true };
    s.compacting = true;
    try {
      const target = summaryTarget(ctx);
      const out = await summarize({
        preparation: event.preparation, branchEntries: event.branchEntries, customInstructions: event.customInstructions,
        signal: event.signal, model: target.model, thinking: target.thinking, complete: (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o).result(),
        contextWindow: ctx.getContextUsage()?.contextWindow,
        sessionId, sessionFile: ctx.sessionManager.getSessionFile(), isSubagent: sub, budget: d.budget,
      });
      log({ ...base, streak: d.streak, budget: d.budget, summaryTokens: out.tokens, result: out.condensed ? "condensed" : out.compressed ? "compressed" : "ok" });
      return { compaction: out.compaction };
    } catch (error) {
      s.compacting = false; // attempt still blocks usage/boundary via busy() until pi emits session_compact(_failed) for the native summary
      log({ ...base, streak: d.streak, result: `fallback:${error instanceof Fallback ? error.message : "error"}` });
      return; // pi runs its native summary; never cancel here
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const s = stateOf(ctx.sessionManager.getSessionId());
    const reason = committed(s, Date.now());
    s.compacting = false;
    if (reason && reason !== "manual" && isSubagent(ctx)) s.paused = false; // a successful compaction ends a subagent's post-abort block
    log({ session: ctx.sessionManager.getSessionId(), reason: reason ?? `untracked:${event.reason}`, result: "committed",
      fromExtension: event.fromExtension, summaryTokens: textTokens(event.compactionEntry.summary ?? "") });
    if (!s.paused) try { ctx.ui.setStatus(STATUS, undefined); } catch { /* optional */ }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const s = stateOf(ctx.sessionManager.getSessionId());
    const reason = failed(s, event.aborted);
    s.compacting = false;
    log({ session: ctx.sessionManager.getSessionId(), reason: reason ?? `untracked:${event.reason}`, result: "commit-failed",
      aborted: event.aborted, fromExtension: event.fromExtension, failStreak: s.failStreak,
      error: JSON.stringify((event.errorMessage ?? "").slice(0, 120)) });
  });
  pi.on("session_shutdown", (_event, ctx) => { try { dropState(ctx.sessionManager.getSessionId()); } catch { /* stale ctx */ } });

  // Manifest order is pruner first: event.entries already includes its proposed edits.
  pi.on("turn_end", async (event, ctx) => {
    if (event.outcome !== "completed") return;
    const s = stateOf(ctx.sessionManager.getSessionId());
    const base = { session: ctx.sessionManager.getSessionId(), sub: isSubagent(ctx) };
    const skip = (why: string) => { log({ ...base, result: `boundary-skip:${why}` }); };
    let attempted = false;
    const signal = ctx.signal ?? new AbortController().signal;
    try {
      if (s.compacting || busy(s, Date.now()) || s.usagePending) return skip("busy");
      if (event.entries.some(e => e.type === "compaction")) return skip("compacted");
      const preview = replay(ctx, event.entries);
      const { total, window, reserve, keepRecent, enabled, ratio } = inputs(ctx, preview);
      if (!enabled) return skip("disabled");
      if (!Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(reserve) || reserve < 0 ||
        !Number.isSafeInteger(keepRecent) || keepRecent < 0 || !Number.isFinite(total)) return skip("no-data");
      const line = compactionLine(window, reserve, ratio);
      if (line <= 0 || total <= line) return skip("small");
      if (s.paused) return skip("paused");
      const preparation = prepareBoundaryCompaction(preview, keepRecent, total);
      if (!preparation) return skip("nothing-to-compact");
      const { d } = guard(ctx, "threshold", total);
      if (d.action !== "run") return skip(d.action === "abort" ? "abort" : "paused");
      attempted = true;
      s.compacting = true;
      let after = 0;
      const target = summaryTarget(ctx);
      const out = await summarize({ preparation, branchEntries: preview.getBranch(), signal, model: target.model, thinking: target.thinking,
        complete: (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o).result(), contextWindow: window,
        sessionId: base.session, sessionFile: ctx.sessionManager.getSessionFile(), isSubagent: base.sub, budget: d.budget,
        validate: compaction => {
          const compacted = replay(ctx, [...event.entries, { type: "compaction", ...compaction }]);
          after = effectiveContextTokens(compacted.getBranch(), compacted.buildSessionProjection());
          // Preempt native mid-run compaction only when the refreshed projection is below both lines.
          if (after >= line) throw new Fallback("no-reduction");
        } });
      const entries = [...event.entries, { type: "compaction" as const, ...out.compaction }];
      // shortcut: boundary drafts have no commit callback; counters assume later handlers accept this validated draft.
      committed(s, Date.now());
      log({ ...base, tokensBefore: total, tokensAfter: after, limit: line, summaryTokens: out.tokens, result: "boundary-compact" });
      return { entries };
    } catch (error) {
      if (attempted) failed(s, signal.aborted);
      log({ ...base, result: `boundary-fallback:${error instanceof Fallback ? error.message : "error"}` });
    } finally {
      if (attempted) s.compacting = false;
    }
  });

  // Fallback at agent_end: keep idle/throttle rules; boundary compaction is the mid-run path.
  pi.on("agent_end", (_event, ctx) => {
    try {
      const s = stateOf(ctx.sessionManager.getSessionId());
      const { total, window, reserve, enabled, ratio } = inputs(ctx);
      const now = Date.now();
      if (usageDecision(s, total, window, reserve, enabled, now, ratio) !== "trigger") return;
      s.usageLastAttempt = now; // throttle from the first sighting, even if we end up skipping
      // ctx.compact() aborts whatever is running (including an in-flight compaction), so only act once idle.
      setTimeout(() => {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const again = inputs(ctx);
          // Re-check everything: the guard may have paused/aborted this session after the timer was queued.
          const d = usageDecision(s, again.total, again.window, again.reserve, again.enabled, Date.now(), again.ratio);
          // Ignore "throttled": this timer's first check just set usageLastAttempt.
          const skip = d === "disabled" || d === "paused" ? d : d === "busy" || !ctx.isIdle() ? "busy"
            : d === "no-data" || d === "small" ? "resolved" : undefined;
          if (skip) { log({ session: sessionId, usageTotal: again.total, result: `usage-skip:${skip}` }); return; }
          s.usagePending = true;
          log({ session: sessionId, usageTotal: again.total, limit: compactionLine(again.window, again.reserve, again.ratio), result: "usage-trigger" });
          ctx.compact({ onError: () => { s.usagePending = false; } }); // e.g. "nothing to compact" before our hook runs
        } catch { /* stale ctx after reload/session switch */ }
      }, usageDelay.ms);
    } catch { /* never break the turn */ }
  });
}
