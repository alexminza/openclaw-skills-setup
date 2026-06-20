import { rename } from "node:fs/promises";

import { build } from "esbuild";

const runtimeEntry = "dist/skills-setup.impl.js";
const bundledEntry = "dist/skills-setup.impl.bundle.js";

// Bundle third-party parser dependencies while keeping OpenClaw SDK imports as
// host-provided peer imports. OpenClaw's plugin installer links the host package
// into installed plugins that declare `openclaw` as a peer dependency.
await build({
  entryPoints: [runtimeEntry],
  bundle: true,
  external: ["openclaw/*"],
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
