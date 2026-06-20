import { rename } from "node:fs/promises";

import { build } from "esbuild";

const runtimeEntry = "dist/skills-setup.impl.js";
const bundledEntry = "dist/skills-setup.impl.bundle.js";

// OpenClaw/ClawHub extracts plugin tarballs without running npm install in the
// extracted plugin directory. Bundle the lazy implementation so invocation-time
// imports are self-contained while dist/index.js stays small for startup.
await build({
  entryPoints: [runtimeEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2023",
  outfile: bundledEntry,
  // Some bundled dependencies still use CommonJS for Node builtins. In an ESM
  // bundle, esbuild's dynamic require shim needs an explicit require function.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: "silent",
});

await rename(bundledEntry, runtimeEntry);
