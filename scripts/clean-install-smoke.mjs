import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "tuilens-clean-install-"));
const consumer = join(temporary, "consumer");
const npmCli = process.env.npm_execpath;
const npmEnvironment = { ...process.env };
delete npmEnvironment.npm_config_allow_scripts;
delete npmEnvironment.NPM_CONFIG_ALLOW_SCRIPTS;
const runNpm = (args, options) =>
  npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { ...options, env: npmEnvironment })
    : execFileSync("npm", args, {
        ...options,
        env: npmEnvironment,
        shell: process.platform === "win32",
      });

try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  runNpm(["run", "build"], { cwd: root, stdio: "inherit" });
  const packed = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    })
  );
  const entry = Object.values(packed)[0];
  const filename = entry?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");
  const tarball = join(temporary, filename);

  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "tuilens-clean-install",
      private: true,
      allowScripts: { [`node-pty@${manifest.dependencies["node-pty"]}`]: true },
    })
  );
  runNpm(["install", tarball, "--no-audit", "--no-fund"], {
    cwd: consumer,
    stdio: "inherit",
  });

  const installedVersion = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", "import('tuilens').then((module) => process.stdout.write(module.VERSION))"],
    { cwd: consumer, encoding: "utf8" }
  );
  const packageJson = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import('node:fs/promises').then(async ({ readFile }) => process.stdout.write(await readFile('node_modules/tuilens/package.json', 'utf8')))",
      ],
      { cwd: consumer, encoding: "utf8" }
    )
  );
  if (installedVersion !== packageJson.version) {
    throw new Error(`Installed VERSION ${installedVersion} does not match package.json ${packageJson.version}`);
  }

  const cli = join(consumer, "node_modules", "tuilens", "dist", "src", "interfaces", "cli.js");
  const printed = execFileSync(process.execPath, [cli, "--version"], { cwd: consumer, encoding: "utf8" }).trim();
  if (printed !== packageJson.version) throw new Error(`CLI --version returned ${printed}`);

  const home = join(temporary, "home");
  await mkdir(home, { recursive: true });
  const doctorOutput = execFileSync(process.execPath, [cli, "doctor"], {
    cwd: consumer,
    encoding: "utf8",
    env: {
      ...process.env,
      TUILENS_HOME: home,
      TUILENS_LANG: "en",
    },
  });
  const doctor = JSON.parse(doctorOutput);
  if (!doctor.ok || !doctor.data?.ok) {
    throw new Error("Clean install doctor reported an error");
  }
  for (const code of ["browser", "pty", "storage"]) {
    const check = doctor.data.checks?.find((item) => item.code === code);
    if (check?.status !== "ok") throw new Error(`Doctor check ${code} did not pass: ${check?.status ?? "missing"}`);
  }
  console.log(`Clean install smoke passed for tuilens ${packageJson.version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
