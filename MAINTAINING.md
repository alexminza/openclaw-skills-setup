# Maintaining

This file is for repository maintainers. It is not included in the published
ClawHub package.

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
