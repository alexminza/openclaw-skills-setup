# Maintaining

This file is for repository maintainers. It is not included in the published
ClawHub package.

## Upstream SDK Gap

This plugin currently carries small local implementations for installed-skill
resolution, SKILL.md setup metadata projection, setup script path validation,
skill env config reading, and setup env sanitization.

Those helpers duplicate OpenClaw internals because `openclaw@2026.5.5` does not
expose the needed installed-skill workflow helpers through public
`openclaw/plugin-sdk/*` entrypoints. The upstream request for skill discovery,
structured metadata, skill config, path containment, and env sanitization SDK
APIs is tracked in
[openclaw/openclaw#81913](https://github.com/openclaw/openclaw/issues/81913).

After that SDK surface is merged and released, update the pinned OpenClaw
development dependency and replace the local resolver/sanitizer code and
frontmatter/metadata projection with public SDK imports where the exported
contracts fit this plugin's setup workflow.

## Runtime packaging

Normal OpenClaw-managed plugin installs provision package dependencies for the
installed plugin. Keep runtime dependencies explicit in `package.json` rather
than importing OpenClaw's transitive dependencies or deep paths.

OpenClaw SDK imports stay external. Installed plugin packages declare
`openclaw` as a peer dependency, and OpenClaw's plugin installer links the host
package into the plugin so `openclaw/plugin-sdk/*` imports resolve at runtime.
Keep the startup entrypoint (`dist/index.js`) small and lazy; the larger
implementation (`dist/skills-setup.impl.js`) and parser dependencies are loaded
only when `skills.setup` is invoked.

`npm run build` owns this shape:

- `tsc` emits declarations and JavaScript into `dist/`
- `scripts/check-runtime-imports.mjs` keeps the startup entrypoint free of
  eager OpenClaw SDK imports and blocks unsupported OpenClaw deep imports in
  the implementation

Do not import from `openclaw/dist/*` or `openclaw/node_modules/*`. If a library
is needed at runtime and is not part of the public OpenClaw plugin SDK, declare
it as a direct plugin dependency.

## Release

Publish ClawHub releases from immutable version tags. The package version in
`package.json` must match the Git tag without the `v` prefix.

This package is published as `@alexminza/skills-setup`, so the ClawHub package
owner must match the package scope. The publish script derives the owner from
`package.json#name`, derives the source repository from
`package.json#repository`, and passes the exact tag commit and source ref
explicitly to match ClawHub's current package provenance checks.

Use the VS Code tasks as the standard release workflow. They keep the checks and
publish commands consistent across releases.

Git status checks, commits, tag creation, pushes, and GitHub releases are
intentionally manual. There are no VS Code tasks for those state-changing steps.

### 1. Prepare the release

Run `Release: Prepare`. This performs local release validation without any Git
operations or ClawHub publishing. The task runs:

```bash
npm run check
npm test
npm run build
clawhub package validate . --out .clawhub/package-validate
npm pack --dry-run
```

The individual subtasks are also available when only one step is needed:
`NPM: Check`, `NPM: Test`, `NPM: Build`, `ClawHub: Validate`, and
`NPM: Pack Dry Run`.

### 2. Optionally run deeper local validation

Run `ClawHub: Validate Runtime With OpenClaw`. This runs
`npm run clawhub:validate:runtime:openclaw`, uses a sibling OpenClaw source
checkout, and executes plugin code in the inspector workspace. It is
intentionally not part of `Release: Prepare`.

### 3. Merge the release changes

Commit and merge the release changes to `main`.

### 4. Tag the merged release commit

Create and push the version tag from the merged `main` commit.

```bash
VERSION=$(node -p "require('./package.json').version")
git switch main
git pull --ff-only origin main
git status --short
git tag "v$VERSION"
git push origin main "v$VERSION"
```

### 5. Create the GitHub Release

Create the GitHub Release manually in GitHub from the `v<version>` tag.

### 6. Publish to ClawHub

Check out the tagged commit, then run `ClawHub: Publish Dry Run`. If the dry run
passes, run `ClawHub: Publish`.

The publish tasks call `scripts/clawhub-publish.mjs`. That script reads the
package version, owner, and source repository from `package.json`, resolves the
matching release tag commit, and passes explicit ClawHub provenance metadata.
The tasks depend on `Release: Verify Version Tag`, which fails if the matching
version tag does not exist locally and on `origin`, if `HEAD` does not match
that tag, or if the working tree is dirty.
