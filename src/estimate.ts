import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

// Public-API copy of pi's internal estimateProjectedContextTokens (not exported).
// tests/estimate.consistency.test.ts compares it with the installed internal one; rerun after every pi upgrade.
export function estimateProjectedTokens(projection: any, branchEntries: any[]): number {
  const messages = projection.messages as any[];
  let usageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage && m.stopReason !== "aborted" && m.stopReason !== "error" && calculateContextTokens(m.usage) > 0) { usageIndex = i; break; }
  }
  if (usageIndex >= 0) {
    let seen = 0, usageEntryId: string | undefined;
    for (const entry of projection.entries) {
      seen += entry.messages.length;
      if (usageIndex < seen) { usageEntryId = entry.sourceEntry.id; break; }
    }
    const usageEntryIndex = usageEntryId ? branchEntries.findIndex(e => e.id === usageEntryId) : -1;
    const invalidating = branchEntries.findLastIndex(e => e.type === "context_edit" || e.type === "compaction");
    if (usageEntryIndex > invalidating) {
      let tokens = calculateContextTokens(messages[usageIndex].usage);
      for (let i = usageIndex + 1; i < messages.length; i++) tokens += estimateTokens(messages[i]);
      return tokens;
    }
  }
  const system = getCurrentSystemMessage(messages);
  let tokens = system ? estimateTokens(system as any) : 0;
  for (const m of messages) if (m.role !== "system") tokens += estimateTokens(m);
  return tokens;
}

// Conservative text size: CJK ~1 token/char, everything else ~4 chars/token.
export function textTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
