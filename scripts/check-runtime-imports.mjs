import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importSpecifierStartPattern = String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)`;
const optionalModuleSubpathPattern = "(?:\\/[^\"'`]*)?";

function quotedImportSpecifierPattern(modulePattern) {
  return new RegExp(`${importSpecifierStartPattern}(["'\`])${modulePattern}\\1`, "u");
}

const startupEntryPath = path.join(rootDir, "dist", "index.js");
const startupSource = readFileSync(startupEntryPath, "utf8");
const sdkRuntimeImportPattern = quotedImportSpecifierPattern(
  `(?:openclaw|@openclaw)\\/plugin-sdk${optionalModuleSubpathPattern}`,
);

if (sdkRuntimeImportPattern.test(startupSource)) {
  throw new Error(
    "dist/index.js must not import openclaw/plugin-sdk/* at runtime; keep SDK imports in the lazy implementation module.",
  );
}

const implementationEntryPath = path.join(rootDir, "dist", "skills-setup.impl.js");
const implementationSource = readFileSync(implementationEntryPath, "utf8");
// OpenClaw SDK imports are intentionally host-provided peer imports.
// Parser libraries are direct plugin dependencies and must stay external so the
// plugin package manager can provision them normally.
const forbiddenRuntimeImportPattern = quotedImportSpecifierPattern(
  `(?:(?:node:)?child_process|openclaw\\/(?:dist|node_modules)${optionalModuleSubpathPattern})`,
);

if (forbiddenRuntimeImportPattern.test(implementationSource)) {
  throw new Error(
    "dist/skills-setup.impl.js must not import child_process or unsupported OpenClaw deep paths.",
  );
}
