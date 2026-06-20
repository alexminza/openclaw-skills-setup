import { rename } from "node:fs/promises";

import { build } from "esbuild";

const runtimeEntry = "dist/skills-setup.impl.js";
const bundledEntry = "dist/skills-setup.impl.bundle.js";

// Keep the runtime as a single local artifact while preserving OpenClaw SDK
// imports as host-provided peer imports. OpenClaw's plugin installer links the
// host package into installed plugins that declare `openclaw` as a peer
// dependency.
await build({
  entryPoints: [runtimeEntry],
  bundle: true,
  external: ["openclaw/*"],
  platform: "node",
  format: "esm",
  target: "es2023",
  outfile: bundledEntry,
  logLevel: "silent",
});

await rename(bundledEntry, runtimeEntry);
