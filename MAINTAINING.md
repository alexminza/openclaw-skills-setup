# Maintaining

This file is for repository maintainers. It is not included in the published
ClawHub package.

## Upstream SDK Gap

This plugin currently carries small local implementations for installed-skill
resolution, SKILL.md setup metadata parsing, setup script path validation, skill
env config reading, and setup env sanitization.

Those helpers duplicate OpenClaw internals because `openclaw@2026.5.5` does not
expose the needed installed-skill workflow helpers through public
`openclaw/plugin-sdk/*` entrypoints. The upstream request for skill discovery,
structured metadata, skill config, path containment, and env sanitization SDK
APIs is tracked in
[openclaw/openclaw#81913](https://github.com/openclaw/openclaw/issues/81913).

After that SDK surface is merged and released, update the pinned OpenClaw
development dependency and replace the local parser/resolver/sanitizer code
with public SDK imports where the exported contracts fit this plugin's setup
workflow.

## Runtime packaging

ClawHub/OpenClaw extracts plugin packages into a plugin directory; it does not
run `npm install` inside that extracted directory. Runtime dependencies such as
`json5` and `yaml` therefore must be bundled into the published runtime files.

At OpenClaw 2026.5.5, extracted third-party plugins also cannot resolve the
global `openclaw` package by bare specifier from their plugin directory. Keep the
startup entrypoint (`dist/index.js`) small and lazy, and bundle the lazy
implementation (`dist/skills-setup.impl.js`) so invocation-time dependencies are
self-contained.

`npm run build` owns this shape:

- `tsc` emits declarations and JavaScript into `dist/`
- `scripts/bundle-runtime.mjs` replaces `dist/skills-setup.impl.js` with a
  bundled ESM artifact
- `scripts/check-runtime-imports.mjs` prevents bare runtime imports that would
  fail after extraction

Do not remove the bundling step unless OpenClaw documents and verifies that
extracted third-party plugins can resolve both package dependencies and
`openclaw/plugin-sdk/*` at runtime.

## Release

Publish ClawHub releases from immutable version tags. The package version in
`package.json` must match the Git tag without the `v` prefix.

Use the VS Code tasks as the standard release workflow. They keep the checks and
publish commands consistent across releases.

Run `Release: Prepare` first. It performs the local release validation without
any Git operations or ClawHub publishing. The task runs:

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

The individual subtasks are also available when only one step is needed:
`NPM: Check`, `NPM: Test`, `NPM: Build`, and `NPM: Pack Dry Run`.

After `Release: Prepare` passes, commit the changes, then create and push the
version tag manually:

```bash
VERSION=$(node -p "require('./package.json').version")
git status --short
git tag "v$VERSION"
git push origin main "v$VERSION"
```

After the tag has been pushed, create the GitHub Release manually in GitHub from
the `v<version>` tag.

There is no VS Code task for these steps. Git status, commits, tag creation,
pushes, and releases are intentionally manual.

After the tag exists locally, run `ClawHub: Publish Dry Run`. If it passes, run
`ClawHub: Publish`.

Those tasks run the equivalent of:

```bash
VERSION=$(node -p "require('./package.json').version")
clawhub package publish . --family code-plugin --version "$VERSION" --source-ref "v$VERSION" --dry-run
clawhub package publish . --family code-plugin --version "$VERSION" --source-ref "v$VERSION"
```

Both tasks read the version from `package.json` and publish with
`--source-ref v<version>`. They depend on `Release: Verify Version Tag`, which
fails if the matching version tag does not exist locally and on `origin`.
