import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startupEntryPath = path.join(rootDir, "dist", "index.js");
const source = readFileSync(startupEntryPath, "utf8");
const sdkRuntimeImportPattern =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(?:openclaw|@openclaw)\/plugin-sdk(?:\/[^"']*)?["']/u;

if (sdkRuntimeImportPattern.test(source)) {
  throw new Error(
    "dist/index.js must not import openclaw/plugin-sdk/* at runtime; keep SDK imports in the lazy implementation module.",
  );
}
