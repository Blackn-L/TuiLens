import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const versionPath = resolve(root, "src/version.ts");
const manifest = JSON.parse(await readFile(packagePath, "utf8"));

if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  throw new Error(`package.json has an invalid version: ${String(manifest.version)}`);
}

const expected = [
  "// Generated from package.json by scripts/sync-version.mjs.",
  `export const VERSION = ${JSON.stringify(manifest.version)};`,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = await readFile(versionPath, "utf8");
  if (current !== expected) {
    console.error(`src/version.ts is stale; expected ${manifest.version}. Run npm run version:sync.`);
    process.exitCode = 1;
  } else {
    console.log(`src/version.ts matches package.json (${manifest.version}).`);
  }
} else {
  await writeFile(versionPath, expected, "utf8");
  console.log(`Synced src/version.ts to ${manifest.version}.`);
}
