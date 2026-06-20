import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startupEntryPath = path.join(rootDir, "dist", "index.js");
const startupSource = readFileSync(startupEntryPath, "utf8");
const sdkRuntimeImportPattern =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(?:openclaw|@openclaw)\/plugin-sdk(?:\/[^"']*)?["']/u;

if (sdkRuntimeImportPattern.test(startupSource)) {
  throw new Error(
    "dist/index.js must not import openclaw/plugin-sdk/* at runtime; keep SDK imports in the lazy implementation module.",
  );
}

const implementationEntryPath = path.join(rootDir, "dist", "skills-setup.impl.js");
const implementationSource = readFileSync(implementationEntryPath, "utf8");
// Extracted plugins do not get a local node_modules install, and OpenClaw
// 2026.5.5 does not make the global openclaw package resolvable from the
// extracted plugin directory. The lazy implementation must therefore be
// self-contained for these runtime imports.
const externalRuntimeImportPattern =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(?:json5|yaml|openclaw(?:\/[^"']*)?)["']/u;

if (externalRuntimeImportPattern.test(implementationSource)) {
  throw new Error(
    "dist/skills-setup.impl.js must bundle json5/yaml/openclaw SDK helpers; extracted OpenClaw plugins are not installed with node_modules.",
  );
}
