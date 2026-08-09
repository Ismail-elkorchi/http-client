import { readFile } from "node:fs/promises";

const tagName = normalizeTag(process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "");
if (!tagName.startsWith("v")) {
  throw new Error(`release-gate: expected a v-prefixed tag, received "${tagName}"`);
}

const version = tagName.slice(1);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const jsrJson = JSON.parse(await readFile("jsr.json", "utf8"));
if (packageJson.version !== version) {
  throw new Error(
    `release-gate: package.json is ${packageJson.version}, expected ${version}`,
  );
}
if (jsrJson.version !== version) {
  throw new Error(
    `release-gate: jsr.json is ${jsrJson.version}, expected ${version}`,
  );
}

const changelog = await readFile("CHANGELOG.md", "utf8");
const heading = new RegExp(
  `^##\\s+${escapeRegExp(version)}(?:\\s|$)`,
  "m",
);
if (!heading.test(changelog)) {
  throw new Error(`release-gate: CHANGELOG.md has no ${version} section`);
}

process.stdout.write(
  `release-gate: ok tag=${tagName} package=${packageJson.version} jsr=${jsrJson.version}\n`,
);

function normalizeTag(value) {
  return value.startsWith("refs/tags/")
    ? value.slice("refs/tags/".length)
    : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
