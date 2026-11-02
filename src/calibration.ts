export type Characters = { cjk: number; other: number; images: number };
export type Observation = { cjk: number; other: number; tokens: number };
export type Calibration = { cjk: number; other: number; observations: number; ready: boolean; cjkLearned: boolean; otherLearned: boolean };
export const MIN_OBSERVATIONS = 4;
export const RECENT_OBSERVATIONS = 32;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const contentCache = new WeakMap<object, Map<string, Characters>>();

export function messageCharacters(message: any): Characters {
  const content = message.content;
  const cache = Array.isArray(content) ? contentCache.get(content)?.get(message.role) : undefined;
  if (cache && message.role !== "system") return cache;
  const result = { cjk: 0, other: 0, images: 0 };
  const text = (value: any) => {
    if (typeof value !== "string") return;
    const cjk = value.match(CJK)?.length ?? 0;
    result.cjk += cjk; result.other += value.length - cjk;
  };
  const blocks = () => {
    if (typeof content === "string") { text(content); return; }
    for (const block of content ?? []) {
      if (block.type === "text") text(block.text);
      else if (block.type === "image") result.images++;
    }
  };
  switch (message.role) {
    case "system":
      blocks();
      for (const section of Object.values(message.sections ?? {})) text(section);
      if (message.toolsAdded) text(JSON.stringify(message.toolsAdded));
      break;
    case "user": case "toolResult": case "custom": blocks(); break;
    case "assistant":
      for (const block of content ?? []) {
        if (block.type === "text") text(block.text);
        else if (block.type === "thinking") text(block.thinking);
        else if (block.type === "toolCall") { text(block.name); text(JSON.stringify(block.arguments)); }
      }
      break;
    case "bashExecution": text(message.command); text(message.output); break;
    case "branchSummary": case "compactionSummary": text(message.summary); break;
  }
  if (Array.isArray(content) && message.role !== "system") {
    let roles = contentCache.get(content);
    if (!roles) { roles = new Map(); contentCache.set(content, roles); }
    roles.set(message.role, result);
  }
  return result;
}

/** Two-column least squares over recent signed request deltas; unidentifiable columns retain Pi's 1/4 prior. */
export function fitCalibration(observations: Observation[]): Calibration {
  const recent = observations.slice(-RECENT_OBSERVATIONS);
  const fallback = { cjk: 0.25, other: 0.25, observations: recent.length, ready: false, cjkLearned: false, otherLearned: false };
  if (recent.length < MIN_OBSERVATIONS) return fallback;
  let cc = 0, oo = 0, co = 0, cy = 0, oy = 0;
  for (const row of recent) {
    cc += row.cjk ** 2; oo += row.other ** 2; co += row.cjk * row.other;
    cy += row.cjk * row.tokens; oy += row.other * row.tokens;
  }
  let cjk = 0.25, other = 0.25, cjkLearned = false, otherLearned = false;
  const determinant = cc * oo - co ** 2;
  if (determinant > cc * oo * 1e-6) {
    cjk = (cy * oo - oy * co) / determinant;
    other = (oy * cc - cy * co) / determinant;
    cjkLearned = otherLearned = true;
  } else if (cc === 0 && oo > 0) { other = oy / oo; otherLearned = true; }
  else if (oo === 0 && cc > 0) { cjk = cy / cc; cjkLearned = true; }
  else return fallback; // Mixed, collinear text cannot identify two separate ratios.
  // Reject negative/extreme fits: changing hidden context is not evidence for a text tokenizer ratio.
  if (![cjk, other].every(ratio => Number.isFinite(ratio) && ratio >= 0.05 && ratio <= 4)) return fallback;
  return { cjk, other, observations: recent.length, ready: true, cjkLearned, otherLearned };
}

export function calibratedTokens(message: any, fit: Pick<Calibration, "cjk" | "other">): number {
  const chars = messageCharacters(message);
  return Math.ceil(chars.cjk * fit.cjk + chars.other * fit.other + chars.images * 1200);
}
