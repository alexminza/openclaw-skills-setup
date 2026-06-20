import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { extractErrorCode, isPathInside } from "openclaw/plugin-sdk/security-runtime";
import YAML from "yaml";

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
// Until upstream ships public SDK contracts for them, this plugin keeps a small
// local facade shaped like the expected SDK surface and keeps only the setup
// lifecycle proposal behavior as plugin-specific code.
// That makes the future migration mechanical: replace the copied helpers with
// plugin-sdk imports once upstream exports them.
// Upstream internals copied, adapted, or locally mirrored below:
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/workspace.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/config.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/env-overrides.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/sandbox/sanitize-env-vars.ts
// - https://github.com/openclaw/openclaw/blob/v2026.5.5/src/shared/frontmatter.ts

const PLUGIN_ID = "skills-setup";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-specific selector policy for this temporary RPC.
// OpenClaw v2026.5.5 does not export an installed-skill resolver that accepts a
// caller selector and returns one installed skill directory.
const VALID_SKILL_KEY_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Plugin-specific setup-env filtering policy.
// OpenClaw does not currently export a setup-env sanitizer, and the generic
// sandbox sanitizer intentionally blocks credential keys that setup scripts need.
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
// Plugin-specific inherited-env filtering policy.
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

// Plugin-specific proposal type:
// https://github.com/openclaw/openclaw/issues/80213
// OpenClaw does not currently export plugin-facing skill setup metadata types.
type SetupMetadata = {
  script?: string;
  skillKey?: string;
};

// Plugin-specific proposal type:
// https://github.com/openclaw/openclaw/issues/80213
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
// Plugin-specific selector normalization for this temporary RPC.
// Replace it with the upstream installed-skill resolver once OpenClaw exports
// one for plugins.
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

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Adapted from OpenClaw v2026.5.5 local skill loading because the loader is not
// exported through `openclaw/plugin-sdk/*`.
// Upstream source:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/workspace.ts
// This is not copied verbatim: OpenClaw's loader builds a skill catalog, while
// this RPC needs to resolve one caller-supplied selector to one installed skill
// directory and support group-qualified selectors.
// The path containment primitive itself is imported from the exported SDK.
// Migration action when https://github.com/openclaw/openclaw/issues/81913 lands:
// replace this region with the exported installed-skill directory resolver and
// keep only the RPC-specific error mapping if the SDK does not provide one.

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

// Plugin-specific adaptation of OpenClaw's realpath-safe local skill loading.
// Keep the same safety invariant: SKILL.md must resolve inside the resolved
// skill directory, and the skill directory must resolve inside the skills root.
// Migration action: delete this helper when the plugin SDK exposes the
// installed-skill directory resolver requested in
// https://github.com/openclaw/openclaw/issues/81913.
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

// Plugin-specific installed-skill lookup for this temporary RPC.
// OpenClaw does not currently export a resolver that maps direct and grouped
// skill selectors to a single installed skill directory.
// Migration action: replace this helper with the exported resolver requested in
// https://github.com/openclaw/openclaw/issues/81913.
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

// #region Local installed-skill SDK facade

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Local facade for the installed-skill SDK surface requested upstream.
// OpenClaw v2026.5.5 does not expose SKILL.md/frontmatter parsing or structured
// `metadata.openclaw` access to plugins.
// This local facade uses the same parser classes OpenClaw core uses for
// frontmatter and JSON-shaped manifest blocks, but keeps them as direct plugin
// dependencies until OpenClaw exports this capability through plugin-sdk.
// Migration action: replace this region with OpenClaw's exported installed-skill
// SDK helpers once they are available.
// Related upstream sources:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/shared/frontmatter.ts

const MANIFEST_KEY = "openclaw";
const LEGACY_MANIFEST_KEYS = ["clawdbot"] as const;

type ParsedSkillFrontmatter = Record<string, unknown>;

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractFrontmatterBlock(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return undefined;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return undefined;
  }
  return normalized.slice(4, endIndex);
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const block = extractFrontmatterBlock(content);
  if (!block) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(block, { schema: "core" }) as unknown;
  } catch {
    return {};
  }
  return isRecord(parsed) ? parsed : {};
}

function resolveOpenClawManifestBlock(
  frontmatter: ParsedSkillFrontmatter,
): Record<string, unknown> | undefined {
  let metadata = frontmatter.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON5.parse(metadata) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(metadata)) {
    return undefined;
  }
  for (const manifestKey of [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS]) {
    const manifestBlock = metadata[manifestKey];
    if (isRecord(manifestBlock)) {
      return manifestBlock;
    }
  }
  return undefined;
}

// #endregion

// #region Setup metadata proposal

// Plugin-specific proposal surface:
// https://github.com/openclaw/openclaw/issues/80213
// OpenClaw v2026.5.5 has no setup lifecycle metadata contract.
// This resolver uses the local installed-skill SDK facade above, but the
// `setup.script` projection remains local until upstream exposes an official
// setup metadata contract.
// Migration action when https://github.com/openclaw/openclaw/issues/80213 lands:
// replace this region with the official setup metadata contract/resolver.

function resolveSetupMetadataFromOpenClawManifest(
  metadataObj: Record<string, unknown>,
): SetupMetadata | undefined {
  const setup = isRecord(metadataObj.setup) ? metadataObj.setup : undefined;
  const script = readStringValue(setup?.script)?.trim();
  const skillKey = readStringValue(metadataObj.skillKey)?.trim();
  if (!script && !skillKey) {
    return undefined;
  }
  return {
    ...(script ? { script } : {}),
    ...(skillKey ? { skillKey } : {}),
  };
}

function parseSetupMetadataFromSkillMarkdown(markdown: string): SetupMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock(parseSkillFrontmatter(markdown));
  if (!metadataObj) {
    return undefined;
  }
  return resolveSetupMetadataFromOpenClawManifest(metadataObj);
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
// Upstream source used for the compatible pieces:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/local-loader.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/frontmatter.ts

// Plugin-specific reimplementation:
// https://github.com/openclaw/openclaw/issues/80213
// OpenClaw v2026.5.5 has no setup script resolver because setup scripts are not
// yet an upstream lifecycle feature.
// This combines the copied frontmatter helpers above with the exported
// `isPathInside()` SDK primitive.
// Migration action when https://github.com/openclaw/openclaw/issues/80213 lands:
// replace this helper with the official setup script resolver or remove the
// explicit RPC if setup execution moves fully into OpenClaw install/update.
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
// OpenClaw does not expose a setup-env sanitizer that allows explicit
// setup-script credential vars while blocking only execution-context overrides.
// The generic sandbox sanitizer intentionally blocks token-like keys, which is
// wrong for this trusted setup hook.
// Candidate upstream surface:
// `sanitizeSetupEnvOverlay()` or a documented setup-mode option for the host env
// sanitizer.
// Allowed credential variables remain visible to the setup script.
// Callers must pass them only to trusted skills and prefer narrowly scoped
// secrets.
// Upstream source used for the compatible copied/adapted pieces:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/env-overrides.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/sandbox/sanitize-env-vars.ts
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/config.ts
// Migration action when https://github.com/openclaw/openclaw/issues/81913 lands:
// replace this region with the exported setup-env sanitizer/builder if it
// preserves the setup-hook requirement to allow explicit credential vars.
// If upstream instead owns setup execution through
// https://github.com/openclaw/openclaw/issues/80213, delete this region with the
// explicit RPC implementation.

const BLOCKED_ENV_VALUE_WARNING = "Contains null bytes";

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Copied from OpenClaw v2026.5.5 because `validateEnvVarValue()` is not
// exported through `openclaw/plugin-sdk/*`.
// Upstream source:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/sandbox/sanitize-env-vars.ts
function validateEnvVarValue(value: string): string | undefined {
  if (value.includes("\0")) {
    return "Contains null bytes";
  }
  if (value.length > 32768) {
    return "Value exceeds maximum length";
  }
  if (/^[A-Za-z0-9+/=]{80,}$/.test(value)) {
    return "Value looks like base64-encoded credential data";
  }
  return undefined;
}

function isBlockedSetupEnvValue(value: string): boolean {
  return (
    validateEnvVarValue(value) === BLOCKED_ENV_VALUE_WARNING || /^\s*\(\)\s*\{/u.test(value)
  );
}

// Plugin-specific reimplementation:
// https://github.com/openclaw/openclaw/issues/80213
// This setup hook must allow explicitly supplied credential keys, unlike
// OpenClaw's generic sandbox env sanitizer.
// It blocks shell/loader execution controls and inherited shell functions while
// preserving setup credentials.
// Migration action: replace with the exported setup-env policy requested in
// https://github.com/openclaw/openclaw/issues/81913 once it supports setup
// credentials.
function isBlockedSetupEnvEntry(key: string, value: string): boolean {
  const upperKey = key.toUpperCase();
  if (RESERVED_ENV_KEYS.has(upperKey)) {
    return true;
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
    return true;
  }
  return isBlockedSetupEnvValue(value);
}

// Plugin-specific reimplementation:
// https://github.com/openclaw/openclaw/issues/80213
// Inherited env policy is narrower than caller-provided setup env policy so
// common process env remains available while shell execution controls are
// tombstoned before command invocation.
// Migration action: replace with the exported setup-env policy requested in
// https://github.com/openclaw/openclaw/issues/81913 once it defines inherited
// env handling for setup commands.
function isBlockedInheritedSetupEnvEntry(key: string, value: string): boolean {
  const upperKey = key.toUpperCase();
  if (BLOCKED_INHERITED_ENV_KEYS.has(upperKey)) {
    return true;
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
    return true;
  }
  return isBlockedSetupEnvValue(value);
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

// OpenClaw SDK gap: https://github.com/openclaw/openclaw/issues/81913
// Adapted from OpenClaw v2026.5.5 because `resolveSkillConfig()` is not
// exported through `openclaw/plugin-sdk/*`.
// Upstream source:
// https://github.com/openclaw/openclaw/blob/v2026.5.5/src/agents/skills/config.ts
// The plugin uses `unknown` at the SDK boundary and projects only the `env`
// field needed by setup scripts.
// Migration action when https://github.com/openclaw/openclaw/issues/81913 lands:
// import the exported `resolveSkillConfig()` and keep only the boundary
// normalization needed by this plugin, if any.
function resolveSkillConfig(config: unknown, skillKey: string): { env?: unknown } | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const skills = config.skills;
  if (!isRecord(skills) || !isRecord(skills.entries)) {
    return undefined;
  }
  const entry = skills.entries[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry as { env?: unknown };
}

function readSkillConfigEnv(config: unknown, skillKey: string): EnvMap {
  return normalizeEnvMap(resolveSkillConfig(config, skillKey)?.env);
}

// Plugin-specific reimplementation:
// https://github.com/openclaw/openclaw/issues/80213
// Upstream has no setup command env builder yet.
// Migration action: replace with the exported setup command env builder if
// https://github.com/openclaw/openclaw/issues/81913 adds one, or delete this
// helper if https://github.com/openclaw/openclaw/issues/80213 moves setup
// execution into OpenClaw.
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
  let selectorForLog = "?";
  let agentIdForLog = "?";
  try {
    const selector = normalizeSkillSelector(params?.slug);
    const agentId = normalizeAgentId(params?.agentId);
    selectorForLog = selector;
    agentIdForLog = agentId;
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}): reading runtime config`,
    );
    const config = context.getRuntimeConfig();
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}): locating agent workspace`,
    );
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}): resolving installed skill`,
    );
    const skillDir = await resolveInstalledSkillDir({ workspaceDir, selector });
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}): reading setup metadata`,
    );
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
      `skills.setup ${selector} (agent=${agentId}): preparing setup environment`,
    );
    const env = buildSetupEnv({
      configEnv: readSkillConfigEnv(config, skillKey),
      overlayEnv: normalizeEnvMap(params?.env),
      skillDir,
    });
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}): running setup script ${path.relative(skillDir, scriptPath)} with timeoutMs=${timeoutMs}`,
    );

    // Temporary plugin lifecycle hook:
    // https://github.com/openclaw/openclaw/issues/80213
    // This explicit admin RPC remains until OpenClaw owns skill setup on
    // install/update.
    const result = await runPluginCommandWithTimeout({
      argv: ["bash", scriptPath],
      cwd: skillDir,
      env,
      timeoutMs,
    });
    api.logger.debug?.(
      `skills.setup ${selector} (agent=${agentId}) completed: code=${result.code}`,
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
      `skills.setup ${selectorForLog} (agent=${agentIdForLog}) failed: ${message}`,
    );
    respondError(respond, code, message);
  }
}

// #endregion
