import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { extractErrorCode, isPathInside } from "openclaw/plugin-sdk/security-runtime";

// Working plugin implementation for the proposed skill setup lifecycle:
// https://github.com/openclaw/openclaw/issues/80213
// The upstream issue proposes first-class setup execution when skills are
// installed or updated.
// This plugin provides the same mechanism as an immediate bridge while that core
// feature is still pending, and gives upstream a concrete reference
// implementation to evaluate.
// Because setup scripts execute local code, the temporary Gateway method is
// admin-only and enforces path/env boundaries before invoking a skill-supplied
// setup script.

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// At openclaw@2026.5.5 the plugin SDK does not expose a stable installed-skill
// workflow surface for skill discovery, structured metadata, skill config,
// skill-local path resolution, or setup-mode env sanitization.
// The underlying helpers live under src/agents/skills/* and src/infra/*, but the
// published package's `exports` map limits plugin imports to ./plugin-sdk/*.
// Until upstream ships public SDK contracts for them, this plugin resolves skill
// directories, parses frontmatter, validates setup paths, reads skill env config,
// and sanitizes setup env overlays directly.
// The helpers below are plugin-owned reimplementations of the subset this plugin
// needs; they are not verbatim copies of OpenClaw internals and do not assert
// byte-for-byte parity.
// Upstream internals modeled by these reimplementations:
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/workspace.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/config.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/env-overrides.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/sandbox/sanitize-env-vars.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/markdown/frontmatter.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/shared/frontmatter.ts

const PLUGIN_ID = "skills-setup";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for valid skill-key segments.
// OpenClaw does not currently export an installed-skill resolver that owns
// basename/group matching.
const VALID_SKILL_KEY_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-env filtering.
// OpenClaw does not currently export a setup-env sanitizer, and the generic
// sandbox sanitizer is too broad for trusted setup credentials.
const RESERVED_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "BASH_XTRACEFD",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "PATH",
  "PS4",
  "SHELL",
  "SHELLOPTS",
  "SKILL_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const RESERVED_ENV_PREFIXES = ["BASH_FUNC_", "DYLD_", "LD_"];
// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for inherited-env filtering.
// OpenClaw does not currently export setup-mode inherited-env policy.
const BLOCKED_INHERITED_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "BASH_XTRACEFD",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "IFS",
  "PS4",
  "SHELLOPTS",
]);

type EnvMap = Record<string, string>;

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned setup metadata shape.
// OpenClaw does not currently export plugin-facing skill setup metadata types.
type SetupMetadata = {
  script?: string;
  skillKey?: string;
};

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned setup-script resolution shape.
// OpenClaw does not currently export a plugin-facing setup-script resolution
// result type.
type SetupScriptResolution = {
  scriptPath: string;
  skillKey?: string;
};

export type SkillsSetupApi = {
  logger: {
    debug?: (message: string) => void;
    warn: (message: string) => void;
  };
  runtime: {
    agent: {
      resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string;
    };
  };
};

export type SkillsSetupHandlerOptions = {
  params?: Record<string, unknown>;
  respond: (ok: boolean, result: unknown, error?: unknown) => void;
  context: {
    getRuntimeConfig: () => unknown;
  };
};

// #region Basic request/config normalization

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for selector normalization.
// OpenClaw does not currently export an installed-skill resolver, so the plugin
// must normalize skill selectors before filesystem resolution.
function normalizeSkillSelector(value: unknown): string {
  const selector = normalizeString(value).toLowerCase();
  if (!selector || selector.includes("\\") || selector.includes("..")) {
    throw invalidRequest("invalid skill slug");
  }
  const segments = selector.split("/");
  if (
    segments.some((segment) => !VALID_SKILL_KEY_SEGMENT_PATTERN.test(segment)) ||
    segments.length > 2
  ) {
    throw invalidRequest("invalid skill slug");
  }
  return selector;
}

function normalizeAgentId(value: unknown): string {
  return normalizeString(value) || DEFAULT_AGENT_ID;
}

// #endregion

// #region Installed skill path resolution

// Upstream source modeled locally because it is not exported to plugins:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/workspace.ts

const ERR_SKILL_NOT_FOUND = "SKILL_NOT_FOUND";
const ERR_INVALID_REQUEST = "INVALID_REQUEST";

function invalidRequest(message: string): Error & { code: typeof ERR_INVALID_REQUEST } {
  const err = new Error(message) as Error & { code: typeof ERR_INVALID_REQUEST };
  err.code = ERR_INVALID_REQUEST;
  return err;
}

function skillNotFound(message: string): Error & { code: typeof ERR_SKILL_NOT_FOUND } {
  const err = new Error(message) as Error & { code: typeof ERR_SKILL_NOT_FOUND };
  err.code = ERR_SKILL_NOT_FOUND;
  return err;
}

function isInvalidRequestError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code === ERR_SKILL_NOT_FOUND || code === ERR_INVALID_REQUEST;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for realpath-safe skill directory candidates.
// OpenClaw does not currently export this resolver to plugins.
async function resolveRealSkillDirCandidate({
  skillsDirReal,
  candidateDir,
}: {
  skillsDirReal: string;
  candidateDir: string;
}): Promise<string | undefined> {
  let candidateDirReal;
  try {
    candidateDirReal = await realpath(candidateDir);
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  if (!isPathInside(skillsDirReal, candidateDirReal)) {
    throw invalidRequest("skill directory escapes skills root");
  }

  let skillMarkdownReal;
  try {
    skillMarkdownReal = await realpath(path.join(candidateDirReal, "SKILL.md"));
    const skillMarkdownStat = await stat(skillMarkdownReal);
    if (!skillMarkdownStat.isFile()) {
      return undefined;
    }
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  if (!isPathInside(candidateDirReal, skillMarkdownReal)) {
    throw invalidRequest("skill manifest escapes skill directory");
  }

  return candidateDirReal;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for installed-skill lookup.
// OpenClaw does not currently export a resolver that handles direct and grouped
// skill directories.
async function resolveInstalledSkillDir({
  workspaceDir,
  selector,
}: {
  workspaceDir: string;
  selector: string;
}): Promise<string> {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const targetDir = path.resolve(skillsDir, selector);
  if (!isPathInside(skillsDir, targetDir)) {
    throw invalidRequest("invalid skill target path");
  }
  let skillsDirReal;
  try {
    skillsDirReal = await realpath(skillsDir);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      throw skillNotFound(`skill "${selector}" not installed`);
    }
    throw error;
  }

  const directDir = await resolveRealSkillDirCandidate({ skillsDirReal, candidateDir: targetDir });
  if (directDir) {
    return directDir;
  }

  if (selector.includes("/")) {
    throw skillNotFound(`skill "${selector}" not installed`);
  }

  const groupedMatches: string[] = [];
  const groupEntries = await readdir(skillsDirReal, { withFileTypes: true });
  for (const entry of groupEntries
    .filter((candidate) => !candidate.name.startsWith(".") && candidate.name !== "node_modules")
    .toSorted((left, right) => left.name.localeCompare(right.name, "en"))) {
    const groupedTargetDir = path.resolve(skillsDirReal, entry.name, selector);
    if (!isPathInside(skillsDirReal, groupedTargetDir)) {
      throw invalidRequest("invalid grouped skill target path");
    }
    const groupedDir = await resolveRealSkillDirCandidate({
      skillsDirReal,
      candidateDir: groupedTargetDir,
    });
    if (groupedDir) {
      groupedMatches.push(groupedDir);
    }
  }

  if (groupedMatches.length === 1) {
    return groupedMatches[0];
  }
  if (groupedMatches.length > 1) {
    throw invalidRequest(
      `multiple installed skills match "${selector}"; use a group-qualified skill key`,
    );
  }

  throw skillNotFound(`skill "${selector}" not installed`);
}

// #endregion

// #region SDK gap: setup script metadata parsing

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// OpenClaw has internal SKILL.md frontmatter helpers, but they are not exported
// through `openclaw/plugin-sdk/*` in openclaw@2026.5.5.
// Upstream source modeled locally because it is not exported to plugins:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/markdown/frontmatter.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/shared/frontmatter.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts
// Candidate upstream surface: `parseFrontmatter()` + `resolveOpenClawMetadata()`
// or a narrower `resolveSkillSetupScript()` helper.
// If OpenClaw exposes that through the plugin SDK, this plugin-owned parser
// group can be deleted.

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for scalar normalization.
// Skill metadata helpers are not exported to plugins.
function normalizeScalar(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("#")) {
    return "";
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  const commentIndex = value.indexOf(" #");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for quote handling.
// Frontmatter metadata parsing is not exported to plugins.
function stripWrappingQuotes(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup metadata precedence.
// OpenClaw skill metadata precedence is not exported to plugins.
function mergeSetupMetadata(...items: Array<Partial<SetupMetadata> | undefined>): SetupMetadata | undefined {
  const merged: SetupMetadata = {};
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.script === "string" && item.script) {
      merged.script = item.script;
    }
    if (typeof item.skillKey === "string" && item.skillKey) {
      merged.skillKey = item.skillKey;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for metadata projection.
// `resolveOpenClawMetadata()` is not exported to plugins.
function readSetupMetadataFromObject(value: unknown): SetupMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const openclaw = value.openclaw;
  if (!isRecord(openclaw)) {
    return undefined;
  }
  return mergeSetupMetadata({
    script:
      isRecord(openclaw.setup) && typeof openclaw.setup.script === "string"
        ? openclaw.setup.script.trim()
        : undefined,
    skillKey: typeof openclaw.skillKey === "string" ? openclaw.skillKey.trim() : undefined,
  });
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for JSON-shaped SKILL.md `metadata` values.
// No exported plugin SDK helper parses this shape.
function parseSetupMetadataFromManifestText(raw: string): SetupMetadata | undefined {
  const value = stripWrappingQuotes(raw);
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    const metadata = readSetupMetadataFromObject(parsed);
    if (metadata) {
      return metadata;
    }
  } catch {
    // Existing skill metadata is JSON-shaped but historically parsed as JSON5.
  }

  const openclawMatch = /(?:^|[,{]\s*)["']?openclaw["']?\s*:/u.exec(value);
  if (!openclawMatch) {
    return undefined;
  }
  const openclawText = value.slice(openclawMatch.index);
  const scriptMatch =
    /(?:^|[,{]\s*)["']?setup["']?\s*:\s*\{[\s\S]*?["']?script["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/u.exec(
      openclawText,
    );
  const skillKeyMatch =
    /(?:^|[,{]\s*)["']?skillKey["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/u.exec(
      openclawText,
    );
  return mergeSetupMetadata({
    script: scriptMatch
      ? normalizeScalar(scriptMatch[1] ?? scriptMatch[2] ?? scriptMatch[3] ?? "")
      : undefined,
    skillKey: skillKeyMatch
      ? normalizeScalar(skillKeyMatch[1] ?? skillKeyMatch[2] ?? skillKeyMatch[3] ?? "")
      : undefined,
  });
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for SKILL.md frontmatter extraction.
// No exported plugin SDK helper provides it.
function extractFrontmatterBlock(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(1, endIndex).join("\n") : undefined;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for YAML/frontmatter parsing.
// No exported plugin SDK helper provides it.
function parseIndentedSetupMetadata(frontmatter: string): SetupMetadata | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const stack: Array<{ indent: number; key: string }> = [];
  const metadata: SetupMetadata = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? "";
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const pathKeys = [...stack.map((entry) => entry.key), key];
    const pathKey = pathKeys.join(".");
    const normalizedValue = normalizeScalar(rawValue);
    if (pathKey === "metadata.openclaw.setup.script" && normalizedValue) {
      metadata.script = normalizedValue;
    }
    if (pathKey === "metadata.openclaw.skillKey" && normalizedValue) {
      metadata.skillKey = normalizedValue;
    }
    if (!normalizedValue) {
      stack.push({ indent, key });
    }
  }
  return mergeSetupMetadata(metadata);
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for frontmatter block-scalar detection.
// No exported plugin SDK helper provides it.
function isYamlBlockScalarIndicator(value: string): boolean {
  return /^[|>][+-]?(\d+)?[+-]?$/u.test(value.trim());
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for `metadata:` scalar and indented JSON-style
// values.
// No exported plugin SDK helper parses this shape.
function parseMetadataValueSetupMetadata(frontmatter: string): SetupMetadata | undefined {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^metadata:(?:\s*(.*))?$/.exec(line);
    if (!match) {
      continue;
    }
    const rawValue = match[1] ?? "";
    const normalizedValue = normalizeScalar(rawValue);
    if (normalizedValue && !isYamlBlockScalarIndicator(normalizedValue)) {
      return parseSetupMetadataFromManifestText(rawValue);
    }

    const valueLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextLine = lines[cursor] ?? "";
      if (nextLine.trim() && !nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
        break;
      }
      valueLines.push(nextLine.trim());
    }
    return parseSetupMetadataFromManifestText(valueLines.join("\n"));
  }
  return undefined;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for SKILL.md setup metadata resolution.
// No exported plugin SDK helper provides it.
function parseSetupMetadataFromSkillMarkdown(markdown: string): SetupMetadata | undefined {
  const frontmatter = extractFrontmatterBlock(markdown);
  if (!frontmatter) {
    return undefined;
  }
  return mergeSetupMetadata(
    parseMetadataValueSetupMetadata(frontmatter),
    parseIndentedSetupMetadata(frontmatter),
  );
}

// #endregion

// #region SDK gap: setup script path resolution

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// OpenClaw does not expose a public resolver for an installed skill's setup
// script.
// Candidate upstream surface:
// `resolveSkillSetupScriptPath(skillDir)` or composition from public
// frontmatter helpers that reads the supported metadata shape and enforces the
// same path boundary.
// Upstream source modeled locally because it is not exported to plugins:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup script path resolution.
// `resolveSkillSetupScriptPath()` is not exported to plugins.
async function resolveSetupScriptPath(skillDir: string): Promise<SetupScriptResolution | undefined> {
  const skillMarkdown = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const metadata = parseSetupMetadataFromSkillMarkdown(skillMarkdown);
  const script = metadata?.script;
  if (!script) {
    return undefined;
  }
  if (path.isAbsolute(script) || script.includes("\0")) {
    throw invalidRequest("setup.script must be a relative path inside the skill directory");
  }
  const scriptPath = path.resolve(skillDir, script);
  if (!isPathInside(skillDir, scriptPath)) {
    throw invalidRequest("setup.script escapes the skill directory");
  }
  const scriptPathReal = await realpath(scriptPath);
  if (!isPathInside(skillDir, scriptPathReal)) {
    throw invalidRequest("setup.script resolves outside the skill directory");
  }
  await access(scriptPathReal);
  return { scriptPath: scriptPathReal, skillKey: metadata.skillKey };
}

// #endregion

// #region SDK gap: setup env overlay

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// OpenClaw does not expose a setup-env sanitizer that allows operator-provided
// credential vars while blocking only execution-context overrides.
// The generic sandbox sanitizer blocks token-like keys, which is wrong for this
// setup hook.
// Candidate upstream surface:
// `sanitizeSetupEnvOverlay()` or a documented setup-mode option for the host env
// sanitizer.
// Allowed credential variables remain visible to the setup script.
// Callers must pass them only to trusted skills and prefer narrowly scoped
// secrets.
// Upstream source modeled locally because it is not exported to plugins:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/env-overrides.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/sandbox/sanitize-env-vars.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/config.ts

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-mode env-entry policy.
// No exported plugin SDK helper provides it.
function isBlockedSetupEnvEntry(key: string, value: string): boolean {
  const upperKey = key.toUpperCase();
  if (RESERVED_ENV_KEYS.has(upperKey)) {
    return true;
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
    return true;
  }
  return /^\s*\(\)\s*\{/u.test(value);
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-mode inherited-env policy.
// No exported plugin SDK helper provides it.
function isBlockedInheritedSetupEnvEntry(key: string, value: string): boolean {
  const upperKey = key.toUpperCase();
  if (BLOCKED_INHERITED_ENV_KEYS.has(upperKey)) {
    return true;
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
    return true;
  }
  return /^\s*\(\)\s*\{/u.test(value);
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-mode inherited-env sanitization.
// No exported plugin SDK helper provides it.
function tombstoneBlockedInheritedSetupEnv(env: NodeJS.ProcessEnv): void {
  // runPluginCommandWithTimeout merges this object over process.env; undefined
  // tombstones are required to suppress unsafe inherited bash/loader controls.
  for (const [rawKey, rawValue] of Object.entries(process.env)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = rawKey.trim();
    if (key && isBlockedInheritedSetupEnvEntry(key, rawValue)) {
      env[rawKey] = undefined;
    }
  }
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-env overlay normalization.
// No exported plugin SDK helper provides it.
function normalizeEnvMap(value: unknown): EnvMap {
  const env: EnvMap = {};
  if (!isRecord(value)) {
    return env;
  }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = rawKey.trim();
    if (!key || isBlockedSetupEnvEntry(key, rawValue)) {
      continue;
    }
    env[key] = rawValue;
  }
  return env;
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup env lookup.
// No exported skill config resolver returns setup env for a skill key.
function readSkillConfigEnv(config: unknown, skillKey: string): EnvMap {
  if (!isRecord(config)) {
    return {};
  }
  const skills = config.skills;
  if (!isRecord(skills) || !isRecord(skills.entries)) {
    return {};
  }
  const entry = skills.entries[skillKey];
  return isRecord(entry) ? normalizeEnvMap(entry.env) : {};
}

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-owned reimplementation for setup-env assembly.
// No exported plugin SDK helper provides this builder/sanitizer behavior.
function buildSetupEnv({
  configEnv,
  overlayEnv,
  skillDir,
}: {
  configEnv: EnvMap;
  overlayEnv: EnvMap;
  skillDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  Object.assign(env, configEnv, overlayEnv);
  tombstoneBlockedInheritedSetupEnv(env);
  // SKILL_DIR is supplied by the plugin after caller overrides are filtered.
  env.SKILL_DIR = skillDir;
  return env;
}

// #endregion

// #region Timeout resolution

function clampTimeoutMs(candidate: unknown, fallback: number): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return fallback;
  }
  const rounded = Math.floor(candidate);
  if (rounded < MIN_TIMEOUT_MS) {
    return MIN_TIMEOUT_MS;
  }
  if (rounded > MAX_TIMEOUT_MS) {
    return MAX_TIMEOUT_MS;
  }
  return rounded;
}

function readPluginConfigTimeoutMs(config: unknown): unknown {
  return resolvePluginConfigObject(
    config as Parameters<typeof resolvePluginConfigObject>[0],
    PLUGIN_ID,
  )?.timeoutMs;
}

function resolveTimeoutMs({
  config,
  params,
}: {
  config: unknown;
  params?: Record<string, unknown>;
}): number {
  const configured = clampTimeoutMs(readPluginConfigTimeoutMs(config), DEFAULT_TIMEOUT_MS);
  return clampTimeoutMs(params?.timeoutMs, configured);
}

// #endregion

// #region Gateway RPC handling

function respondError(
  respond: SkillsSetupHandlerOptions["respond"],
  code: Parameters<typeof errorShape>[0],
  message: string,
): void {
  respond(false, { error: message }, errorShape(code, message));
}

export async function handleSkillsSetup({
  api,
  options,
}: {
  api: SkillsSetupApi;
  options: SkillsSetupHandlerOptions;
}): Promise<void> {
  const { params, respond, context } = options;
  const startedAt = Date.now();
  let selectorForLog = "?";
  let agentIdForLog = "?";
  try {
    const selector = normalizeSkillSelector(params?.slug);
    const agentId = normalizeAgentId(params?.agentId);
    selectorForLog = selector;
    agentIdForLog = agentId;
    const config = context.getRuntimeConfig();
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
    const skillDir = await resolveInstalledSkillDir({ workspaceDir, selector });
    const setupScript = await resolveSetupScriptPath(skillDir);
    if (!setupScript) {
      api.logger.debug?.(
        `skills.setup ${selector} (agent=${agentId}) skipped: no setup script declared`,
      );
      respond(true, { code: 0, stdout: "", stderr: "" });
      return;
    }

    const { scriptPath, skillKey = selector } = setupScript;
    const timeoutMs = resolveTimeoutMs({ config, params });
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}) started: script=${path.relative(skillDir, scriptPath)} timeoutMs=${timeoutMs}`,
    );

    // Temporary plugin lifecycle hook:
    // https://github.com/openclaw/openclaw/issues/80213
    // This explicit admin RPC remains until OpenClaw owns skill setup on
    // install/update.
    const result = await runPluginCommandWithTimeout({
      argv: ["bash", scriptPath],
      cwd: skillDir,
      env: buildSetupEnv({
        configEnv: readSkillConfigEnv(config, skillKey),
        overlayEnv: normalizeEnvMap(params?.env),
        skillDir,
      }),
      timeoutMs,
    });
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}) completed: code=${result.code} durationMs=${Date.now() - startedAt}`,
    );
    respond(true, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill setup failed";
    // INVALID_REQUEST when the caller-supplied slug doesn't resolve to an
    // installed skill on this agent — no generic NOT_FOUND code at v2026.5.5
    // (see openclaw src/gateway/protocol/schema/error-codes.ts).
    // Reserve UNAVAILABLE for transient / server-side execution failures.
    const code = isInvalidRequestError(error)
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE;
    api.logger.warn(
      `skills.setup ${selectorForLog} (agent=${agentIdForLog}) failed: ${message} durationMs=${Date.now() - startedAt}`,
    );
    respondError(respond, code, message);
  }
}

// #endregion
