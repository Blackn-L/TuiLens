import { createRequire } from "node:module";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const entry = process.argv[2];
if (!entry) throw new Error("module-load-probe requires an entry module");

await import(pathToFileURL(entry).href);
const playwrightLoaded = Object.keys(require.cache).some((path) => path.includes(`${sep}playwright-core${sep}`));
process.stdout.write(JSON.stringify({ playwrightLoaded }));
