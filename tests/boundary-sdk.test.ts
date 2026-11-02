import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import { effectiveContextTokens } from "../src/usage.ts";
import { OUTPUT_CAP, SECTIONS } from "../src/summary.ts";

const modules = join(homedir(), ".bun/install/global/node_modules");
const { loadExtensions } = await import(join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
const { createAssistantMessageEventStream } = await import(join(modules, "@earendil-works/pi-ai/dist/compat.js"));
const rootRepo = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(rootRepo, "package.json"), "utf8"));
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = (total: number) => ({ ...cost, input: total, totalTokens: total, cost: { ...cost, total: 0 } });

for (const sub of [false, true]) test(`Pi 1.4.0 real extension loader: prune drafts commit, one snapshot, next request refreshed (sub=${sub})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-sdk-"));
  const saved = process.env.PI_COMPACT_DIR;
  process.env.PI_COMPACT_DIR = root;
  let session: any;
  try {
    expect(manifest.pi.extensions).toEqual(["./extensions/tool-result-pruner.ts", "./extensions/compact.ts"]);
    const loaded = await loadExtensions(manifest.pi.extensions.map((p: string) => join(rootRepo, p)), root);
    expect(loaded.errors).toEqual([]);
    const manager = sdk.SessionManager.inMemory(root);
    if (sub) manager.appendCustomEntry("model-route-state", { contextRole: "worker" });
    manager.appendMessage({ role: "user", content: "Keep this original task brief", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old", name: "bash", arguments: { command: "example" } }], api: "openai-completions", provider: "test", model: "large", stopReason: "toolUse", timestamp: 1, usage: usage(100) } as any);
    const oldTool = manager.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "x".repeat(60_000) }], isError: false, timestamp: 1 });
    manager.appendMessage({ role: "user", content: "Recent history ".repeat(1000), timestamp: 1 });
    const requests: any[] = [];
    let summaries = 0;
    const runtime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("test", { api: "openai-completions", apiKey: "offline", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "large", name: "large", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 16384, cost }],
      streamSimple(model: any, context: any, options: any) {
        const summary = options.maxTokens === OUTPUT_CAP;
        if (summary) summaries++;
        else requests.push(structuredClone(context));
        const content = summary ? [{ type: "text", text: SECTIONS.map(s => `## ${s}\nok`).join("\n\n") }]
          : requests.length === 1 ? [{ type: "toolCall", id: "read", name: "read_tool_result", arguments: { entryId: oldTool, offset: 0, limit: 100 } }]
          : [{ type: "text", text: "Finished" }];
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
          usage: usage(summary ? 1000 : requests.length === 1 ? 965_689 : 4000), stopReason: summary || requests.length > 1 ? "stop" : "toolUse", timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message);
        return stream;
      },
    });
    const resourceLoader: any = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Offline compaction test", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {} };
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("test", "large"),
      sessionManager: manager, resourceLoader, noTools: true, settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1000 }, cacheWarming: "off", retry: { enabled: false },
      }) }));
    const errors: any[] = [];
    await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
    await session.prompt("Continue with the raw-history read and finish");
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(summaries).toBe(1);
    const branch = manager.getBranch();
    const edits = branch.filter(e => e.type === "context_edit");
    const compactions = branch.filter(e => e.type === "compaction");
    expect(edits.some((e: any) => e.targetId === oldTool)).toBe(true);
    expect(compactions).toHaveLength(1);
    expect(branch.indexOf(edits[0])).toBeLessThan(branch.indexOf(compactions[0]));
    expect(JSON.stringify(requests[0])).toContain("x".repeat(60_000));
    expect(JSON.stringify(requests[1])).toContain("## Goal");
    expect(JSON.stringify(requests[1])).not.toContain("x".repeat(60_000));
    if (sub) expect(compactions[0].summary).toContain("Task brief (verbatim, from parent):");
    expect(effectiveContextTokens(branch)).toBeLessThan(800_000);
    console.log(`Pi 1.4.0 boundary verified: sub=${sub}, requests=${requests.length}, summaries=${summaries}, drafts=${edits.length}+${compactions.length}; refreshed second request, no native double compaction`);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose(); }
    if (saved === undefined) delete process.env.PI_COMPACT_DIR; else process.env.PI_COMPACT_DIR = saved;
  }
});
