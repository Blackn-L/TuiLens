import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const tag = process.env.GITHUB_REF_NAME;

if (!tag) throw new Error("GITHUB_REF_NAME is required for release checks");
if (tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version ${manifest.version}`);
}
console.log(`Release tag ${tag} matches package version ${manifest.version}.`);
