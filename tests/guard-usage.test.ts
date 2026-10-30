import { beforeEach, describe, expect, test } from "bun:test";
import { BUDGET, busy, committed, decide, failed, FAIL_LIMIT, resetStates, stateOf, TIGHT_BUDGET } from "../src/guard.ts";
import { freshUsageTotal, THROTTLE_MS, usageDecision } from "../src/usage.ts";

beforeEach(resetStates);
const T = 1_000_000;

function autoRun(id: string, sub: boolean, at: number, reason: any = "threshold") {
  const s = stateOf(id);
  const d = decide(s, reason, sub, at);
  if (d.action === "run") committed(s, at);
  return d;
}

describe("guard: main session", () => {
  test("rapid repeats: 2nd tightens to 3k, 3rd pauses and cancels", () => {
    expect(autoRun("m", false, T)).toMatchObject({ action: "run", budget: BUDGET });
    expect(autoRun("m", false, T + 10_000)).toMatchObject({ action: "run", budget: TIGHT_BUDGET });
    expect(autoRun("m", false, T + 20_000)).toEqual({ action: "cancel", reason: "threshold", justPaused: true, why: "rapid-loop" });
    expect(stateOf("m").paused).toBe(true);
  });
  test("paused: auto cancelled, manual allowed and clears pause", () => {
    autoRun("m", false, T); autoRun("m", false, T + 1); autoRun("m", false, T + 2);
    expect(decide(stateOf("m"), "threshold", false, T + 999_999)).toEqual({ action: "cancel", reason: "threshold", justPaused: false });
    expect(decide(stateOf("m"), "manual", false, T + 3).action).toBe("run");
    committed(stateOf("m"), T + 3);
    expect(stateOf("m").paused).toBe(false);
    expect(autoRun("m", false, T + 4)).toMatchObject({ action: "run", budget: BUDGET });
  });
  test(">= 60s gap resets the streak", () => {
    autoRun("m", false, T);
    expect(autoRun("m", false, T + 59_999)).toMatchObject({ budget: TIGHT_BUDGET });
    expect(autoRun("m", false, T + 59_999 + 60_000)).toMatchObject({ budget: BUDGET, streak: 0 });
  });
  test("manual never counts", () => {
    autoRun("m", false, T);
    expect(decide(stateOf("m"), "manual", false, T + 1)).toMatchObject({ action: "run", budget: BUDGET, streak: 0 });
  });
  test("overflow is never cancelled, even when paused or looping; it still counts", () => {
    autoRun("m", false, T); autoRun("m", false, T + 1); autoRun("m", false, T + 2); // paused
    expect(decide(stateOf("m"), "overflow", false, T + 3)).toMatchObject({ action: "run", reason: "overflow" });
    resetStates();
    autoRun("c", true, T); autoRun("c", true, T + 1);
    expect(autoRun("c", true, T + 2, "overflow")).toMatchObject({ action: "run", streak: 2 });
  });
});

describe("guard: subagent", () => {
  test("never pauses; aborts on the 3rd rapid compaction", () => {
    expect(autoRun("c", true, T).action).toBe("run");
    expect(autoRun("c", true, T + 1)).toMatchObject({ action: "run", budget: TIGHT_BUDGET });
    expect(autoRun("c", true, T + 2)).toEqual({ action: "abort", reason: "threshold", streak: 2, why: "rapid-loop" });
    expect(stateOf("c").paused).toBe(false);
  });
});

describe("guard: commit failures", () => {
  const failOnce = (id: string, sub: boolean, at: number) => {
    const s = stateOf(id); const d = decide(s, "threshold", sub, at);
    if (d.action === "run") failed(s, false);
    return d;
  };
  test(`main: ${FAIL_LIMIT} consecutive failed commits pause auto-compaction`, () => {
    expect(failOnce("m", false, T).action).toBe("run");
    expect(failOnce("m", false, T + 1).action).toBe("run");
    expect(decide(stateOf("m"), "threshold", false, T + 2)).toEqual({ action: "cancel", reason: "threshold", justPaused: true, why: "commit-failures" });
  });
  test("subagent: consecutive failed commits abort", () => {
    failOnce("c", true, T); failOnce("c", true, T + 1);
    expect(decide(stateOf("c"), "threshold", true, T + 2)).toMatchObject({ action: "abort", why: "commit-failures" });
  });
  test("a success resets the failure count; aborted failures do not count", () => {
    failOnce("m", false, T);
    autoRun("m", false, T + 100_000);
    expect(stateOf("m").failStreak).toBe(0);
    const s = stateOf("m"); decide(s, "threshold", false, T + 300_000); failed(s, true);
    expect(s.failStreak).toBe(0);
  });
  test("failures pi emits without our attempt are ignored (no stray resets)", () => {
    const s = stateOf("m");
    s.usagePending = true;
    expect(failed(s, false)).toBeUndefined();
    expect(s.failStreak).toBe(0);
    expect(s.usagePending).toBe(true);
  });
  test("failed attempt does not advance the rapid streak", () => {
    autoRun("m", false, T);
    failOnce("m", false, T + 1);
    expect(stateOf("m").streak).toBe(0);
  });
});

describe("state isolation", () => {
  test("sessions do not share counters, pauses or throttles", () => {
    autoRun("a", false, T); autoRun("a", false, T + 1); autoRun("a", false, T + 2);
    expect(stateOf("a").paused).toBe(true);
    expect(autoRun("b", false, T + 3)).toMatchObject({ action: "run", budget: BUDGET });
    stateOf("a").usageLastAttempt = T;
    expect(usageDecision(stateOf("b"), 120_000, 128_000, 16384, true, T + 1)).toBe("trigger");
  });
});

describe("usage fallback", () => {
  const s = () => stateOf("u");
  test("threshold follows reserve", () => {
    expect(usageDecision(s(), 111_616, 128_000, 16384, true, T)).toBe("small");
    expect(usageDecision(s(), 111_617, 128_000, 16384, true, T)).toBe("trigger");
    expect(usageDecision(s(), 70_000, 128_000, 65536, true, T)).toBe("trigger");
  });
  test("auto-compaction disabled in settings -> never triggers", () => {
    expect(usageDecision(s(), 127_000, 128_000, 16384, false, T)).toBe("disabled");
  });
  test("paused guard or in-flight attempt blocks the trigger", () => {
    s().paused = true;
    expect(usageDecision(s(), 127_000, 128_000, 16384, true, T)).toBe("paused");
    s().paused = false;
    decide(s(), "threshold", false, T);
    expect(busy(s(), T + 1)).toBe(true);
    expect(usageDecision(s(), 127_000, 128_000, 16384, true, T + 1)).toBe("busy");
    expect(busy(s(), T + 600_001)).toBe(false); // stale attempt does not block forever
  });
  test("throttle", () => {
    s().usageLastAttempt = T;
    expect(usageDecision(s(), 127_000, 128_000, 16384, true, T + THROTTLE_MS - 1)).toBe("throttled");
    expect(usageDecision(s(), 127_000, 128_000, 16384, true, T + THROTTLE_MS)).toBe("trigger");
  });
  test("usage-triggered manual compaction counts as automatic", () => {
    s().usagePending = true;
    expect(decide(s(), "manual", false, T)).toMatchObject({ reason: "threshold" });
    expect(s().usagePending).toBe(false);
    expect(decide(s(), "manual", false, T + 1)).toMatchObject({ reason: "manual" });
  });
});

describe("fresh usage", () => {
  const u = (id: string, total: number, stopReason = "stop") => ({ id, type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text: "a" }], usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total } } });
  const tool = (id: string, n: number) => ({ id, type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(n) }] } });
  test("latest valid assistant usage", () => {
    expect(freshUsageTotal([u("a", 100_000), u("b", 5_000, "error")])).toBe(100_000);
  });
  test("compaction after the usage makes it stale (no double compaction)", () => {
    expect(freshUsageTotal([u("a", 120_000), { type: "compaction" }])).toBeUndefined();
    expect(freshUsageTotal([u("a", 120_000), { type: "compaction" }, u("b", 40_000)])).toBe(40_000);
  });
  test("pruning after the usage subtracts what it removed (pruner and usage fallback stay compatible)", () => {
    const branch = [tool("t1", 40_000), u("a", 120_000), { type: "context_edit", targetId: "t1", replacement: { content: [{ type: "text", text: "short" }] } }];
    const total = freshUsageTotal(branch)!;
    expect(total).toBeLessThan(120_000);
    expect(total).toBeGreaterThan(105_000); // ~10k tokens removed
  });
  test("deletion edit subtracts the whole message; unknown target makes the usage stale", () => {
    expect(freshUsageTotal([tool("t1", 40_000), u("a", 120_000), { type: "context_edit", targetId: "t1", replacement: null }])!).toBeLessThan(111_000);
    expect(freshUsageTotal([u("a", 120_000), { type: "context_edit", targetId: "missing", replacement: null }])).toBeUndefined();
  });
});
