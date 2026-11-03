// Test-only: point host-package imports at the pi install (pi maps them itself at runtime).
// Writes tsconfig.json (gitignored). Override the module root with PI_GLOBAL_NODE_MODULES.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { hostModules } from "./host-modules.mjs";
const root = hostModules();
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
