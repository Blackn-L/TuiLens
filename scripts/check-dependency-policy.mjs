import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];

function check(group) {
  for (const [name, version] of Object.entries(manifest[group] ?? {})) {
    if (typeof version !== "string") {
      failures.push(`${group}.${name} must be a string`);
      continue;
    }
    if (name === "node-pty" && version === "1.2.0-beta.18") continue;
    if (!/^[\^~]|^\d+\.x$/u.test(version)) {
      failures.push(`${group}.${name}=${version} must use a caret/tilde range (node-pty beta is the only exact pin)`);
    }
  }
}

check("dependencies");
check("devDependencies");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Dependency ranges follow the library policy.");
}
