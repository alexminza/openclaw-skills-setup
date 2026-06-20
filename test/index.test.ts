import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

const ErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

type GatewayRequestHandlerOptions = {
  params?: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
  context: {
    getRuntimeConfig: () => Record<string, unknown>;
  };
};
type GatewayHandler = (options: GatewayRequestHandlerOptions) => Promise<void> | void;
type GatewayMethodOptions = { scope: string };

const commandMocks = vi.hoisted(() => ({
  runPluginCommandWithTimeout: vi.fn(async () => ({
    code: 0,
    stdout: "setup ok",
    stderr: "",
  })),
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: commandMocks.runPluginCommandWithTimeout,
}));

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill({
  workspaceDir,
  relativeDir,
  frontmatter,
  scriptPath = "scripts/setup.sh",
}: {
  workspaceDir: string;
  relativeDir: string;
  frontmatter: string;
  scriptPath?: string;
}): Promise<{ skillDir: string; skillDirReal: string; scriptPathReal: string }> {
  const skillDir = path.join(workspaceDir, "skills", relativeDir);
  await fs.mkdir(path.dirname(path.join(skillDir, scriptPath)), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\n${frontmatter.trim()}\n---\n# ${path.basename(relativeDir)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, scriptPath), "#!/usr/bin/env bash\n", "utf8");
  return {
    skillDir,
    skillDirReal: await fs.realpath(skillDir),
    scriptPathReal: await fs.realpath(path.join(skillDir, scriptPath)),
  };
}

function registerSkillsSetupPlugin({
  config,
  workspaceDir,
}: {
  config: Record<string, unknown>;
  workspaceDir: string;
}): {
  handler: GatewayHandler;
  options: GatewayMethodOptions;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
} {
  void config;
  let handler: GatewayHandler | undefined;
  let options: GatewayMethodOptions;
  const registerGatewayMethod = vi.fn(
    (method: string, nextHandler: GatewayHandler, nextOptions: GatewayMethodOptions) => {
      expect(method).toBe("skills.setup");
      handler = nextHandler;
      options = nextOptions;
    },
  );
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn(() => workspaceDir),
      },
    },
    registerGatewayMethod,
  };

  plugin.register(api);
  if (!handler) {
    throw new Error("skills-setup did not register skills.setup");
  }
  return { handler, options, registerGatewayMethod };
}

async function callGatewayMethod({
  handler,
  config,
  requestParams,
}: {
  handler: GatewayHandler;
  config: Record<string, unknown>;
  requestParams: Record<string, unknown>;
}) {
  const respond = vi.fn();
  await handler({
    params: requestParams,
    respond,
    context: {
      getRuntimeConfig: () => config,
    },
  });
  return respond;
}

beforeEach(() => {
  commandMocks.runPluginCommandWithTimeout.mockClear();
  commandMocks.runPluginCommandWithTimeout.mockResolvedValue({
    code: 0,
    stdout: "setup ok",
    stderr: "",
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("skills-setup plugin", () => {
  it("registers the admin-only skills.setup gateway method", async () => {
    const workspaceDir = await makeTempDir();
    const { options, registerGatewayMethod } = registerSkillsSetupPlugin({
      workspaceDir,
      config: {},
    });

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ scope: "operator.admin" });
  });

  it("runs grouped skills and passes sanitized setup env", async () => {
    const workspaceDir = await makeTempDir();
    await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "skills", "demo", "README.md"), "not a skill\n");
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "team/demo",
      frontmatter: `
metadata:
  openclaw:
    skillKey: team/demo
    setup:
      script: scripts/setup.sh
`,
    });
    const config = {
      plugins: {
        entries: {
          "skills-setup": {
            config: { timeoutMs: 5_000 },
          },
        },
      },
      skills: {
        entries: {
          "team/demo": {
            env: {
              API_TOKEN: "from-config",
              BASH_ENV: "/tmp/from-config.sh",
              "BASH_FUNC_setup%%": "() { echo from-config; }",
              EXTRA: "from-config",
              HOME: "/should/not/pass",
              IFS: "/",
              LD_PRELOAD: "/tmp/from-config.so",
              PATH: "/should/not/pass",
              SHELLOPTS: "xtrace",
            },
          },
        },
      },
    };
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config });

    const respond = await callGatewayMethod({
      handler,
      config,
      requestParams: {
        slug: "Demo",
        env: {
          API_TOKEN: "from-request",
          BASHOPTS: "extglob",
          BASH_XTRACEFD: "2",
          CUSTOM: "from-request",
          DYLD_INSERT_LIBRARIES: "/tmp/from-request.dylib",
          ENV: "/tmp/from-request-env.sh",
          GLOBIGNORE: "*",
          LEGACY_FUNC: "() { echo legacy; }",
          PATH: "/request/path",
          PS4: "$(touch /tmp/pwned)",
          SHELL: "/tmp/shell",
          SKILL_DIR: "/request/skill",
        },
        timeoutMs: 999_999,
      },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        API_TOKEN: "from-request",
        EXTRA: "from-config",
        CUSTOM: "from-request",
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 600_000,
    });
  });

  it("removes inherited bash control env from the setup process", async () => {
    vi.stubEnv("BASH_ENV", "/tmp/from-parent.sh");
    vi.stubEnv("ENV", "/tmp/from-parent-env.sh");
    vi.stubEnv("LD_PRELOAD", "/tmp/from-parent.so");
    vi.stubEnv("BASH_FUNC_parent%%", "() { echo from-parent; }");
    vi.stubEnv("LEGACY_PARENT_FUNC", "() { echo legacy-parent; }");

    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "demo",
      frontmatter: `
metadata:
  openclaw:
    setup:
      script: scripts/setup.sh
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "demo" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        BASH_ENV: undefined,
        ENV: undefined,
        LD_PRELOAD: undefined,
        "BASH_FUNC_parent%%": undefined,
        LEGACY_PARENT_FUNC: undefined,
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("runs group-qualified skill selectors when grouped basenames collide", async () => {
    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "team/demo",
      frontmatter: `
metadata:
  openclaw:
    skillKey: team/demo
    setup:
      script: scripts/setup.sh
`,
    });
    await writeSkill({
      workspaceDir,
      relativeDir: "other/demo",
      frontmatter: `
metadata:
  openclaw:
    skillKey: other/demo
    setup:
      script: scripts/setup.sh
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "Team/Demo" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("reads nested setup metadata when parent keys have trailing comments", async () => {
    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "commented",
      frontmatter: `
metadata: # skill metadata
  openclaw: # OpenClaw-specific settings
    setup: # setup declaration
      script: scripts/setup.sh # relative setup script
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "commented" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("rejects ambiguous grouped basename selectors", async () => {
    const workspaceDir = await makeTempDir();
    await writeSkill({
      workspaceDir,
      relativeDir: "team/demo",
      frontmatter: `
metadata:
  openclaw:
    setup:
      script: scripts/setup.sh
`,
    });
    await writeSkill({
      workspaceDir,
      relativeDir: "other/demo",
      frontmatter: `
metadata:
  openclaw:
    setup:
      script: scripts/setup.sh
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "demo" },
    });

    expect(commandMocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      error: 'multiple installed skills match "demo"; use a group-qualified skill key',
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
    });
  });

  it("reads JSON-shaped skill metadata", async () => {
    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "json-skill",
      scriptPath: "setup.sh",
      frontmatter: `
metadata: '{"openclaw":{"skillKey":"json-skill-key","setup":{"script":"setup.sh"}}}'
`,
    });
    const config = {
      skills: {
        entries: {
          "json-skill-key": {
            env: {
              JSON_SKILL_ENV: "enabled",
            },
          },
        },
      },
    };
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config });

    const respond = await callGatewayMethod({
      handler,
      config,
      requestParams: { slug: "json-skill" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        JSON_SKILL_ENV: "enabled",
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("reads multi-line JSON metadata when metadata key has a trailing comment", async () => {
    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "json-commented",
      scriptPath: "setup.sh",
      frontmatter: `
metadata: # JSON-shaped OpenClaw metadata
  {"openclaw":{"skillKey":"json-commented-key","setup":{"script":"setup.sh"}}}
`,
    });
    const config = {
      skills: {
        entries: {
          "json-commented-key": {
            env: {
              JSON_COMMENTED_ENV: "enabled",
            },
          },
        },
      },
    };
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config });

    const respond = await callGatewayMethod({
      handler,
      config,
      requestParams: { slug: "json-commented" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        JSON_COMMENTED_ENV: "enabled",
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("rejects setup scripts outside the skill directory", async () => {
    const workspaceDir = await makeTempDir();
    await writeSkill({
      workspaceDir,
      relativeDir: "escape",
      frontmatter: `
metadata:
  openclaw:
    setup:
      script: ../outside.sh
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "escape" },
    });

    expect(commandMocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      error: "setup.script escapes the skill directory",
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
    });
  });

  it("reports invalid slugs as invalid requests", async () => {
    const workspaceDir = await makeTempDir();
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "../bad" },
    });

    expect(commandMocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      error: "invalid skill slug",
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
    });
  });
});
