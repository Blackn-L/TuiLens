import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";

export function runtimePaths() {
  const home = resolve(process.env.TUILENS_HOME ?? join(homedir(), ".tuilens"));
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 20);
  let socket = join(tmpdir(), `tuilens-${process.getuid?.() ?? "user"}-${hash}.sock`);
  if (process.platform === "win32") socket = `\\\\.\\pipe\\tuilens-${hash}`;
  // Linux abstract socket 由内核回收，避免多个启动者竞争 unlink 陈旧文件。
  if (process.platform === "linux") socket = `\0tuilens-${process.getuid?.() ?? "user"}-${hash}`;
  return {
    home,
    socket,
    state: join(home, "daemon.json"),
    startLock: join(home, "daemon-start.lock"),
    artifactDir: join(home, "artifacts"),
    log: join(home, "daemon.log"),
  };
}

export type RuntimePaths = ReturnType<typeof runtimePaths>;

/** Pin path-valued settings before the detached server switches to its runtime directory. */
export function daemonEnvironment(home: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, TUILENS_HOME: home };
  for (const key of ["TUILENS_BROWSER_PATH", "TUILENS_FONT_FILE"] as const) {
    const path = inherited[key];
    if (path) env[key] = resolve(path);
  }
  return env;
}
