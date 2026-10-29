// Test-only: point host-package imports at the global pi install (pi maps them itself at runtime).
// Writes tsconfig.json (gitignored). Override the install root with PI_GLOBAL_NODE_MODULES.
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const root = process.env.PI_GLOBAL_NODE_MODULES ?? path.join(os.homedir(), ".bun/install/global/node_modules");
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
