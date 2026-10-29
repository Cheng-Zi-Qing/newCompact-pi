import { Type } from "typebox";
import { convertToLlm, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateProjectedTokens } from "../src/estimate.ts";

// Migrated from ~/.pi/agent/experiments/tool-result-pruner.ts; behaviour unchanged except public imports
// and skipping sessions where read_tool_result is not an active tool (pruned text would be unrecoverable).
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const warning = "Tool-result pruning skipped: invalid context or compaction settings.";
export const KEEP_LIMIT = 8192, HEAD = 4096, TAIL = 1024;

export function replay(ctx: any, drafts: any[]) {
  const header = ctx.sessionManager.getHeader();
  if (!header) throw new Error("Invalid preview");
  const manager = SessionManager.inMemory(ctx.cwd, undefined, structuredClone([header, ...ctx.sessionManager.getBranch()]));
  for (const draft of structuredClone(drafts)) {
    switch (draft.type) {
      case "custom": manager.appendCustomEntry(draft.customType, draft.data); break;
      case "custom_message": manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details); break;
      case "context_edit": manager.appendContextEdit(draft.targetId, draft.replacement); break;
      case "compaction": manager.appendCompaction(draft.summary, draft.firstKeptEntryId,
        estimateProjectedTokens(manager.buildSessionProjection(), manager.getBranch()), draft.details, true, draft.usage); break;
      default: throw new Error("Invalid preview");
    }
  }
  return manager;
}

export function pruneText(text: string, entryId: string): string | undefined {
  const points = Array.from(text);
  if (points.length <= KEEP_LIMIT) return;
  const out = points.slice(0, HEAD).join("") + `\n[tool_result pruned; raw entry ${entryId}; use read_tool_result]\n` + points.slice(-TAIL).join("");
  const n = Array.from(out).length;
  return n >= KEEP_LIMIT || n >= points.length ? undefined : out;
}

export default function toolResultPruner(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_tool_result", label: "Read raw tool result",
    description: "Read raw text of an active-branch tool-result entry, including pruned text. Text blocks are joined with a newline. Offsets/limits are Unicode codepoints, not bytes. No filesystem access.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({ entryId: Type.String(), offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 8192 }) }),
    async execute(_callId: string, args: any, _signal: any, _update: any, ctx: any) {
      try {
        if (!ctx || typeof args.entryId !== "string" || !integer(args.offset) || !integer(args.limit) || args.limit === 0 || args.limit > 8192 ||
          !ctx.sessionManager.getBranch().some((entry: any) => entry.id === args.entryId)) throw new Error("Denied");
        const entry = ctx.sessionManager.getEntry(args.entryId);
        if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Denied");
        // Raw history intentionally differs from canonical context after a context_edit.
        const points = Array.from(entry.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n"));
        if (args.offset > points.length) throw new Error("Denied");
        const end = Math.min(points.length, args.offset + args.limit);
        return { content: [{ type: "text", text: points.slice(args.offset, end).join("") }],
          details: { entryId: args.entryId, offset: args.offset, nextOffset: end < points.length ? end : null, totalCodepoints: points.length, raw: true } };
      } catch { throw new Error("Tool-result retrieval denied."); }
    },
  } as any);

  pi.on("turn_end", (event: any, ctx: any) => {
    if (event.outcome !== "completed") return;
    try {
      if (!pi.getActiveTools().includes("read_tool_result")) return;
      const effective: any = pi.getSettings();
      if (!effective || typeof effective !== "object" ||
        (effective.compaction !== undefined && (!effective.compaction || typeof effective.compaction !== "object" || Array.isArray(effective.compaction)))) throw new Error("Invalid settings");
      const settings = SettingsManager.inMemory(effective).getCompactionSettings(ctx.model);
      const routed = ctx.getContextUsage()?.contextWindow;
      const window = integer(routed) && routed > 0 ? routed : ctx.model?.contextWindow;
      if (!integer(window) || window === 0 || typeof settings.enabled !== "boolean" || !integer(settings.reserveTokens) ||
        !integer(settings.keepRecentTokens) || settings.reserveTokens >= window) throw new Error("Invalid settings");
      if (!settings.enabled) return;
      const threshold = window - settings.reserveTokens;
      const entries = [...event.entries];
      let preview = replay(ctx, entries);
      const estimate = () => {
        const n = estimateProjectedTokens(preview.buildSessionProjection(), preview.getBranch());
        if (!integer(n)) throw new Error("Invalid estimate");
        return n;
      };
      if (estimate() <= threshold) return;
      const projected = event.context.contextEntries;
      const lastUser = projected.findLastIndex((entry: any) => convertToLlm(entry.messages).some((message: any) => message.role === "user"));
      // shortcut: turn_end only and the whole latest user span is excluded; startup/current-span pressure remains native compaction's job.
      if (lastUser < 0) return;
      for (const entry of projected.slice(0, lastUser)) {
        const message = entry.messages[0];
        if (entry.sourceEntry.type !== "message" || message?.role !== "toolResult" || message.isError !== false) continue;
        let changed = false;
        const content = message.content.map((block: any) => {
          if (block.type !== "text" || typeof block.text !== "string") return block;
          const text = pruneText(block.text, entry.sourceEntry.id);
          if (text === undefined) return block;
          changed = true;
          return { ...block, text };
        });
        if (!changed) continue;
        entries.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: { content } });
        preview = replay(ctx, entries);
        if (estimate() <= threshold) break;
      }
      if (entries.length > event.entries.length) return { entries };
    } catch { ctx.ui.notify(warning, "warning"); }
  });
}
