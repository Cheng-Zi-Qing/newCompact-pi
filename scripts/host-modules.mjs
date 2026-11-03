// Shared test/setup resolver; pi maps host packages itself at runtime.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function hostModules() {
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
  return root;
}
