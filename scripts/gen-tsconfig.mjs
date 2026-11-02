// Test-only: point host-package imports at the pi install (pi maps them itself at runtime).
// Writes tsconfig.json (gitignored). Override the module root with PI_GLOBAL_NODE_MODULES.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const defaultRoot = path.join(os.homedir(), ".pi/agent/install");
function releaseModules(root) {
  try {
    const version = readFileSync(path.join(root, "current-version"), "utf8").trim();
    return version ? path.join(root, "releases", version, "node_modules") : undefined;
  } catch { return undefined; }
}
const candidates = [...new Set([
  process.env.PI_GLOBAL_NODE_MODULES,
  releaseModules(process.env.PI_MANAGED_INSTALL_ROOT ?? defaultRoot),
  releaseModules(defaultRoot),
  path.join(os.homedir(), ".bun/install/global/node_modules"),
].filter(Boolean))];
const root = candidates.find(p => existsSync(path.join(p, "@earendil-works/pi-coding-agent/package.json")));
if (!root) throw new Error(`Cannot find Pi host node_modules containing @earendil-works/pi-coding-agent/package.json. Tried:\n${candidates.map(p => `  - ${p}`).join("\n")}\nSet PI_GLOBAL_NODE_MODULES to the host node_modules root.`);
const config = {
  compilerOptions: {
    module: "esnext", target: "esnext", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, baseUrl: ".",
    paths: {
      "@earendil-works/pi-coding-agent": [path.join(root, "@earendil-works/pi-coding-agent/dist/index.js")],
      "@earendil-works/pi-ai": [path.join(root, "@earendil-works/pi-ai/dist/index.js")],
      typebox: [path.join(root, "typebox")],
    },
  },
};
writeFileSync(new URL("../tsconfig.json", import.meta.url), JSON.stringify(config, null, 2) + "\n");
