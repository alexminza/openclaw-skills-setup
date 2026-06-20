# Skills Setup

Runs trusted setup scripts declared by installed OpenClaw skills through an
admin-only Gateway RPC.

This plugin registers the admin-only `skills.setup` Gateway RPC. Callers can use
it to run an idempotent setup script from an installed skill directory, for
example to install local dependencies or prepare tool-specific configuration.
Setup scripts run with `bash` and the agent process user's local privileges, so
invoke this RPC only for skills you trust and after reviewing the declared setup
script.

## Background

This plugin is a plugin-based implementation path for
[openclaw/openclaw#80213](https://github.com/openclaw/openclaw/issues/80213),
which tracks skill author-defined setup hooks for running skill-supplied scripts
after install/update.

Unlike a future core install/update hook, this plugin does not run setup scripts
automatically. A caller with `operator.admin` scope must invoke `skills.setup`
for a specific installed skill.

## Project Decisions

This plugin exists because the setup lifecycle in
[openclaw/openclaw#80213](https://github.com/openclaw/openclaw/issues/80213) is
not yet available in OpenClaw core. It provides an immediate, explicit
`operator.admin` RPC and a working reference implementation for the proposed
core mechanism.

The implementation also documents a plugin SDK gap tracked in
[openclaw/openclaw#81913](https://github.com/openclaw/openclaw/issues/81913).
At OpenClaw 2026.5.5, third-party plugins do not have a stable public SDK
surface for installed-skill discovery, SKILL.md/frontmatter parsing, structured
`metadata.openclaw` access, skill env config lookup, skill-local path
validation, or setup-mode env sanitization. Where possible, this plugin copies
the pinned OpenClaw behavior locally instead of inventing unrelated semantics,
so migration to future public SDK exports is mechanical.

The published runtime is also bundled intentionally. ClawHub/OpenClaw extracts
plugin packages into a plugin directory and does not run `npm install` there, so
runtime dependencies such as `json5` and `yaml` must be included in the
published artifact. OpenClaw 2026.5.5 also does not make
`openclaw/plugin-sdk/*` reliably resolvable from an extracted plugin directory.
The startup entrypoint remains small and lazy; the larger implementation is
loaded only when `skills.setup` is invoked.

## Skill Metadata

Add setup metadata to the skill's `SKILL.md` frontmatter:

```yaml
---
name: example-skill
description: Example skill with a setup script
metadata:
  openclaw:
    skillKey: example-skill
    setup:
      script: scripts/setup.sh
---
```

The `setup.script` value must be a relative path inside the skill directory.

## Runtime Behavior

- Looks for skills under the active agent workspace `skills/` directory.
- Supports grouped skills such as `skills/team/example-skill`.
- Accepts group-qualified selectors such as `team/example-skill`. Basename
  selectors are rejected when multiple grouped skills share the same basename.
- Runs the declared setup script with `bash`; this is intentional local code
  execution and is restricted to callers with `operator.admin`.
- Sets `SKILL_DIR` to the resolved skill directory.
- Merges configured skill env with request env, while blocking caller-supplied
  reserved execution-context keys such as `HOME`, `PATH`, and `SKILL_DIR`, bash
  startup/control keys such as `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`,
  `PS4`, and `IFS`, and injected function/loader prefixes such as
  `BASH_FUNC_`, `LD_`, and `DYLD_`.
- Clears inherited bash startup/control variables, exported bash functions, and
  loader-injection variables from the setup process environment.
- Enforces bounded setup timeouts.
- Does not record completion state. Each `skills.setup` invocation reruns the
  target setup script.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "skills-setup": {
        "config": {
          "timeoutMs": 120000
        }
      }
    }
  }
}
```

`timeoutMs` defaults to 120 seconds and is capped at 600 seconds.

## Security and idempotency

This plugin intentionally runs local setup scripts, so the Gateway method is
restricted to `operator.admin`. Scripts must resolve inside the skill directory,
and path escapes are rejected before execution. Review the setup script and the
env values you pass before invoking setup, especially when providing secrets.

Local code execution is expected for this plugin. Installed skills may already
ship executable setup assets; this plugin provides an explicit admin-only RPC to
run the reviewed, skill-local setup script declared by the skill.

Treat every setup script as a local shell script from the target skill. It can
install packages, write files, call network services, or make other local
changes allowed by the agent process user's permissions. Run setup only for
trusted skills.

The plugin's path and env checks ensure the selected script is skill-local and
block common execution-context overrides before running it. The setup script
itself still runs as trusted local code.

Environment variables can include credentials needed by a setup workflow. The
plugin blocks execution-context overrides and bash startup/function injection
variables, but any allowed secret passed through skill config or request env is
available to the setup script. Prefer narrowly scoped credentials and avoid
passing secrets to skills from untrusted sources.

Credential handling follows the installed skill trust boundary. The plugin does
not discover or grant new credentials on its own; it passes only explicit skill
config or request env values to the reviewed setup script for the trusted
installed skill.

Setup scripts must be idempotent. The plugin does not track whether setup has
already run for a skill, so repeated calls can repeat side effects such as
dependency installation, config writes, or external API calls.
Those repeated effects come only from deliberate `skills.setup` invocations; the
plugin does not schedule setup, retry setup, or run setup automatically after
installation.
