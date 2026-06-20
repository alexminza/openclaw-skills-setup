import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const owner = inferPackageOwner(packageJson.name);
const sourceRepo = normalizeGitHubRepo(packageJson.repository);
const sourceCommit = execFileSync("git", ["rev-list", "-n", "1", tag], {
  encoding: "utf8",
}).trim();

function inferPackageOwner(packageName) {
  const match = /^@([^/]+)\//.exec(String(packageName ?? ""));
  if (!match) {
    throw new Error(`Expected a scoped package name, got ${JSON.stringify(packageName)}.`);
  }
  return match[1];
}

function normalizeGitHubRepo(repository) {
  const value =
    typeof repository === "string"
      ? repository
      : typeof repository?.url === "string"
        ? repository.url
        : "";
  const normalized = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      throw new Error(`Expected a GitHub repository URL, got ${value}.`);
    }
    const [repoOwner, repoName] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!repoOwner || !repoName) {
      throw new Error(`Expected a GitHub repository URL, got ${value}.`);
    }
    return `${repoOwner}/${repoName}`;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Expected ")) {
      throw error;
    }
    throw new Error(`Expected package.json repository to be a GitHub URL, got ${JSON.stringify(value)}.`);
  }
}

const args = [
  "package",
  "publish",
  ".",
  "--family",
  "code-plugin",
  "--owner",
  owner,
  "--version",
  version,
  "--source-repo",
  sourceRepo,
  "--source-commit",
  sourceCommit,
  "--source-ref",
  tag,
];

if (dryRun) {
  args.push("--dry-run");
}

const result = spawnSync("clawhub", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
