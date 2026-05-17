import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";

// Plugin-shaped implementation path for openclaw/openclaw#80213:
// https://github.com/openclaw/openclaw/issues/80213
// This intentionally exposes manual admin-triggered setup execution instead of
// automatic post-install/post-update execution in core. Local code execution is
// the point of this plugin, so the Gateway method is admin-only and path/env
// boundaries are enforced before invoking a skill-supplied setup script.

// SDK gap tracked upstream by openclaw/openclaw#81913:
// https://github.com/openclaw/openclaw/issues/81913
// At openclaw@2026.5.5 the plugin SDK does not expose a stable installed-skill
// workflow surface for skill discovery, structured metadata, skill config,
// skill-local path resolution, or setup-mode env sanitization. The underlying
// helpers live under src/agents/skills/* and src/infra/*, but the published
// package's `exports` map limits plugin imports to ./plugin-sdk/*. Until
// upstream ships public SDK contracts for them, this plugin resolves skill
// directories, parses frontmatter, validates setup paths, reads skill env
// config, and sanitizes setup env overlays directly.

const METHOD_NAME = "skills.setup";
const PLUGIN_ID = "skills-setup";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const VALID_SKILL_KEY_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
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

type SetupMetadata = {
  script?: string;
  skillKey?: string;
};

type SetupScriptResolution = {
  scriptPath: string;
  skillKey?: string;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

// #region Basic request/config normalization

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
  return hasErrorCode(error, ERR_SKILL_NOT_FOUND) || hasErrorCode(error, ERR_INVALID_REQUEST);
}

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
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
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
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
  if (!isPathInside(candidateDirReal, skillMarkdownReal)) {
    throw invalidRequest("skill manifest escapes skill directory");
  }

  return candidateDirReal;
}

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
    if (hasErrorCode(error, "ENOENT")) {
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

// SDK gap tracked by openclaw/openclaw#81913: OpenClaw has internal SKILL.md
// frontmatter helpers, but they are not exported through
// `openclaw/plugin-sdk/*` in openclaw@2026.5.5.
// Needed public surface: `parseFrontmatter()` + `resolveOpenClawMetadata()` or
// a narrower `resolveSkillSetupScript()` helper. That would replace
// normalizeScalar(), extractFrontmatterBlock(), parseIndentedSetupMetadata(),
// parseMetadataValueSetupMetadata(), and parseSetupMetadataFromSkillMarkdown().
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

function extractFrontmatterBlock(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(1, endIndex).join("\n") : undefined;
}

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

function isYamlBlockScalarIndicator(value: string): boolean {
  return /^[|>][+-]?(\d+)?[+-]?$/u.test(value.trim());
}

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

// SDK gap tracked by openclaw/openclaw#81913: OpenClaw does not expose a public
// resolver for an installed skill's setup script. Needed public surface:
// `resolveSkillSetupScriptPath(skillDir)` or composition from public
// frontmatter helpers that reads the supported metadata shape and enforces the
// same path boundary.
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

// SDK gap tracked by openclaw/openclaw#81913: OpenClaw does not expose a setup-
// env sanitizer that allows operator-provided credential vars while blocking
// only execution-context overrides. The generic sandbox sanitizer blocks token-
// like keys, which is wrong for this setup hook. Needed public surface:
// `sanitizeSetupEnvOverlay()` or a documented setup-mode option for the host env
// sanitizer. Allowed credential variables remain visible to the setup script;
// callers must pass them only to trusted skills and prefer narrowly scoped
// secrets.
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
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = config.plugins;
  if (!isRecord(plugins) || !isRecord(plugins.entries)) {
    return undefined;
  }
  const entry = plugins.entries[PLUGIN_ID];
  // OpenClaw plugin config schema lives at plugins.entries.<id>.config.* — see
  // openclaw/src/plugin-sdk/plugin-config-runtime.ts resolvePluginConfigObject.
  // Reading entry.timeoutMs directly would silently ignore the operator setting.
  if (!isRecord(entry) || !isRecord(entry.config)) {
    return undefined;
  }
  return entry.config.timeoutMs;
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

// #region Gateway RPC registration

function respondError(
  respond: GatewayRequestHandlerOptions["respond"],
  code: Parameters<typeof errorShape>[0],
  message: string,
): void {
  respond(false, { error: message }, errorShape(code, message));
}

export default definePluginEntry({
  id: "skills-setup",
  name: "Skills Setup",
  description: "Runs installed skill setup scripts through the admin-only skills.setup gateway RPC.",
  register(api) {
    api.registerGatewayMethod(
      METHOD_NAME,
      async ({ params, respond, context }) => {
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

          // Intentionally runs a skill-declared local setup script. The method
          // is registered with operator.admin scope, setup.script is constrained
          // to the resolved skill directory, and no completion state is stored,
          // so setup scripts must be safe to rerun.
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
          // (see openclaw src/gateway/protocol/schema/error-codes.ts). Reserve
          // UNAVAILABLE for transient / server-side execution failures.
          const code = isInvalidRequestError(error)
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
          api.logger.warn(
            `skills.setup ${selectorForLog} (agent=${agentIdForLog}) failed: ${message} durationMs=${Date.now() - startedAt}`,
          );
          respondError(respond, code, message);
        }
      },
      { scope: "operator.admin" },
    );
  },
});

// #endregion
