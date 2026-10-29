import { beforeEach, describe, expect, test } from "bun:test";
import { committed, decide, effectiveReason, failed, resetStates, stateOf, TIGHT_BUDGET, BUDGET } from "../src/guard.ts";
import { freshUsageTotal, THROTTLE_MS, usageDecision } from "../src/usage.ts";

beforeEach(resetStates);
const T = 1_000_000;

function autoRun(id: string, sub: boolean, at: number) {
  const s = stateOf(id);
  const d = decide(s, "threshold", sub, at);
  if (d.action === "run") committed(s, "threshold", at);
  return d;
}

describe("guard: main session", () => {
  test("rapid repeats: 2nd tightens to 3k, 3rd pauses and cancels", () => {
    expect(autoRun("m", false, T)).toMatchObject({ action: "run", budget: BUDGET });
    expect(autoRun("m", false, T + 10_000)).toMatchObject({ action: "run", budget: TIGHT_BUDGET });
    expect(autoRun("m", false, T + 20_000)).toEqual({ action: "cancel", justPaused: true });
    expect(stateOf("m").paused).toBe(true);
  });
  test("paused: auto cancelled, manual allowed and clears pause", () => {
    autoRun("m", false, T); autoRun("m", false, T + 1); autoRun("m", false, T + 2);
    expect(decide(stateOf("m"), "threshold", false, T + 999_999)).toEqual({ action: "cancel", justPaused: false });
    expect(decide(stateOf("m"), "manual", false, T + 3).action).toBe("run");
    committed(stateOf("m"), "manual", T + 3);
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
  test("failed compaction does not advance the streak", () => {
    autoRun("m", false, T);
    decide(stateOf("m"), "threshold", false, T + 1); failed(stateOf("m"));
    expect(stateOf("m").streak).toBe(0);
  });
});

describe("guard: subagent", () => {
  test("never pauses; aborts at streak 3", () => {
    expect(autoRun("c", true, T).action).toBe("run");
    expect(autoRun("c", true, T + 1)).toMatchObject({ action: "run", budget: TIGHT_BUDGET });
    expect(autoRun("c", true, T + 2)).toMatchObject({ action: "run", budget: TIGHT_BUDGET });
    expect(stateOf("c").paused).toBe(false);
    expect(autoRun("c", true, T + 3)).toEqual({ action: "abort", streak: 3 });
  });
});

describe("state isolation", () => {
  test("sessions do not share counters, pauses or throttles", () => {
    autoRun("a", false, T); autoRun("a", false, T + 1); autoRun("a", false, T + 2);
    expect(stateOf("a").paused).toBe(true);
    expect(autoRun("b", false, T + 3)).toMatchObject({ action: "run", budget: BUDGET });
    stateOf("a").usageLastAttempt = T;
    expect(usageDecision(stateOf("b"), 120_000, 128_000, 16384, T + 1)).toBe("trigger");
  });
});

describe("usage fallback", () => {
  const s = () => stateOf("u");
  test("threshold follows reserve", () => {
    expect(usageDecision(s(), 111_616, 128_000, 16384, T)).toBe("small");
    expect(usageDecision(s(), 111_617, 128_000, 16384, T)).toBe("trigger");
    expect(usageDecision(s(), 70_000, 128_000, 65536, T)).toBe("trigger");
  });
  test("paused guard blocks usage trigger", () => {
    s().paused = true;
    expect(usageDecision(s(), 127_000, 128_000, 16384, T)).toBe("paused");
  });
  test("throttle", () => {
    s().usageLastAttempt = T;
    expect(usageDecision(s(), 127_000, 128_000, 16384, T + THROTTLE_MS - 1)).toBe("throttled");
    expect(usageDecision(s(), 127_000, 128_000, 16384, T + THROTTLE_MS)).toBe("trigger");
  });
  test("usage-triggered manual compaction counts as automatic", () => {
    s().usagePending = true;
    expect(effectiveReason(s(), "manual")).toBe("threshold");
    committed(s(), "threshold", T);
    expect(effectiveReason(s(), "manual")).toBe("manual");
  });
});

describe("fresh usage only", () => {
  const u = (total: number, stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason, usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total } } });
  test("latest valid assistant usage", () => {
    expect(freshUsageTotal([u(100_000), u(5_000, "error")])).toBe(100_000);
  });
  test("compaction or context_edit after the usage makes it stale (no double compaction)", () => {
    expect(freshUsageTotal([u(120_000), { type: "compaction" }])).toBeUndefined();
    expect(freshUsageTotal([u(120_000), { type: "context_edit" }])).toBeUndefined();
    expect(freshUsageTotal([u(120_000), { type: "compaction" }, u(40_000)])).toBe(40_000);
  });
});
