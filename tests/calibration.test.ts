import { expect, test } from "bun:test";
import { fitCalibration, messageCharacters, calibratedTokens } from "../src/calibration.ts";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

test("calibration falls back with too few observations and separates identifiable CJK/other ratios", () => {
  const observations = [
    { cjk: 1000, other: 0, tokens: 1500 }, { cjk: 0, other: 1000, tokens: 500 },
    { cjk: 1000, other: 1000, tokens: 2000 }, { cjk: -1000, other: -1000, tokens: -2000 },
  ];
  expect(fitCalibration(observations.slice(0, 3)).ready).toBe(false);
  const fit = fitCalibration(observations);
  expect(fit.ready).toBe(true);
  expect(fit.cjk).toBeCloseTo(1.5);
  expect(fit.other).toBeCloseTo(0.5);
  expect(fit.observations).toBe(4);
  expect(calibratedTokens({ role: "user", content: "中文abcd" }, fit)).toBe(5);
});
test("rank-deficient observations retain the unidentifiable coefficient; bad fits fall back", () => {
  const fit = fitCalibration(Array.from({ length: 4 }, () => ({ cjk: 0, other: 1000, tokens: 500 })));
  expect(fit.ready).toBe(true); expect(fit.cjk).toBe(0.25); expect(fit.other).toBeCloseTo(0.5);
  const bad = fitCalibration(Array.from({ length: 4 }, () => ({ cjk: 0, other: 1000, tokens: -500 })));
  expect(bad.ready).toBe(false);
});
test("message character counts match Pi's heuristic, excluding images from learned text ratios", () => {
  const messages: any[] = [
    { role: "user", content: "中文abcd" },
    { role: "user", content: [{ type: "image", data: "unused", mimeType: "image/png" }, { type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", name: "bash", arguments: { command: "hello" } }] },
    { role: "system", content: "prompt", sections: { tools: "tools" }, toolsAdded: [{ name: "read" }] },
    { role: "bashExecution", command: "pwd", output: "work" }, { role: "compactionSummary", summary: "中文abcd" },
  ];
  for (const message of messages) {
    const chars = messageCharacters(message);
    expect(Math.ceil((chars.cjk + chars.other + chars.images * 4800) / 4)).toBe(estimateTokens(message));
  }
  const fit = fitCalibration(Array.from({ length: 4 }, () => ({ cjk: 0, other: 1000, tokens: 500 })));
  expect(calibratedTokens(messages[1], fit)).toBe(1203);
});
