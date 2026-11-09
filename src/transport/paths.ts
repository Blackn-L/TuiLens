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
    artifactDir: join(home, "artifacts"),
    log: join(home, "daemon.log"),
  };
}
