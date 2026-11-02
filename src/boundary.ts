import { findCutPoint, prepareBranchEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Fallback } from "./summary.ts";

// Use public cut-point logic over canonical (already edited) messages, never raw tool text.
export function prepareBoundaryCompaction(manager: any, keepRecentTokens: number, tokensBefore: number) {
  const branch = manager.getBranch();
  if (branch.at(-1)?.type === "compaction") return;
  const entries = manager.buildSessionProjection().entries;
  const previous = entries.findIndex((e: any) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
  const start = previous < 0 ? 0 : previous + 1;
  const normalized = entries.map((entry: any) => {
    const messages = entry.messages;
    if (messages.length > 1 && entry.sourceEntry.type !== "compaction") throw new Fallback("projection");
    if (entry.sourceEntry.type === "compaction") {
      if (!messages.length) throw new Fallback("projection");
      return entry.sourceEntry;
    }
    return messages.length ? { ...entry.sourceEntry, type: "message", message: messages[0] }
      : { ...entry.sourceEntry, type: "custom" };
  });
  const cut = findCutPoint(normalized, start, normalized.length, keepRecentTokens);
  const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.sourceEntry.id;
  if (!firstKeptEntryId) return;
  // Native prepareCompaction has special recovery-omission suffix logic, not exposed publicly.
  // Decline that shape rather than risk moving its cut across unsent input.
  if (entries.slice(cut.firstKeptEntryIndex + 1).some((e: any) =>
    e.sourceEntry.type === "message" && sessionEntryToContextMessages(e.sourceEntry).length > 0 && e.messages.length === 0)) throw new Fallback("recovery-omission");
  const messages = (from: number, to: number) => entries.slice(from, to)
    .filter((e: any) => e.sourceEntry.type !== "compaction")
    .flatMap((e: any) => e.messages.filter((m: any) => m.role !== "system"));
  const messagesToSummarize = messages(start, cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex);
  const turnPrefixMessages = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
  const summarized = [...messagesToSummarize, ...turnPrefixMessages];
  if (!summarized.length) return;
  const nested = summarized.filter(m => m.role === "toolResult").flatMap(m => m.nestedCalls?.calls ?? []);
  const fileEntries = [...summarized, { role: "assistant", content: nested.map((call: any) =>
    ({ type: "toolCall", name: call.name, arguments: call.arguments })) }].map(message => ({ type: "message", message }));
  return { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, tokensBefore,
    previousSummary: previous < 0 ? undefined : entries[previous].sourceEntry.summary,
    fileOps: prepareBranchEntries(fileEntries as any).fileOps };
}
