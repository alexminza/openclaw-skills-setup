import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitOk(args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitMaybe(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

if (!gitOk(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
  console.error(`Missing local release tag ${tag}. Create it before publishing.`);
  process.exit(1);
}

const tagCommit = git(["rev-list", "-n", "1", tag]);
const remoteTagOutput = gitMaybe([
  "ls-remote",
  "--exit-code",
  "--tags",
  "origin",
  `refs/tags/${tag}`,
  `refs/tags/${tag}^{}`,
]);
if (!remoteTagOutput) {
  console.error(`Missing remote release tag ${tag} on origin. Push it before publishing.`);
  process.exit(1);
}
const remoteTagCommit = remoteTagOutput
  .split("\n")
  .map((line) => line.split(/\s+/))
  .find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ??
  remoteTagOutput
    .split("\n")
    .map((line) => line.split(/\s+/))
    .find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
if (remoteTagCommit !== tagCommit) {
  console.error(
    `Local ${tag} points to ${tagCommit}, but origin/${tag} points to ${remoteTagCommit}. Sync tags before publishing.`,
  );
  process.exit(1);
}

const headCommit = git(["rev-parse", "HEAD"]);
if (headCommit !== tagCommit) {
  console.error(
    `HEAD is ${headCommit}, but ${tag} points to ${tagCommit}. Check out the release tag before publishing.`,
  );
  process.exit(1);
}

const status = git(["status", "--porcelain"]);
if (status) {
  console.error("Working tree is not clean. Commit, stash, or remove local changes before publishing.");
  console.error(status);
  process.exit(1);
}

console.log(
  `Release tag ${tag} is present locally and on origin, HEAD matches it, and the working tree is clean.`,
);
