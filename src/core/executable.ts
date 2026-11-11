import { stat } from "node:fs/promises";
import path from "node:path";
import { TuiLensError } from "./errors.js";

export interface ResolveExecutableOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface ResolvedExecutable {
  file: string;
  resolved?: string;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_PATH_SEPARATOR = /[\\/]/u;

function environmentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  if (Object.hasOwn(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function extensionCandidates(pathext: string): string[] {
  const configured = pathext.split(";").map((value) => value.trim()).filter(Boolean)
    .map((value) => value.startsWith(".") ? value : `.${value}`)
    .map((value) => value.toUpperCase());
  const ordered = [".EXE", ".COM", ...configured.filter((value) => value !== ".EXE" && value !== ".COM")];
  return [...new Set(ordered)];
}

async function regularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function assertDirectExecutable(file: string, command: string): void {
  const extension = path.win32.extname(file).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    throw new TuiLensError("EXECUTABLE_REQUIRES_SHELL", "Windows 批处理脚本不能直接作为 PTY 可执行文件启动", {
      command,
      resolved: file,
      hint: "请改用原生 .exe/.com，或显式启动 shell",
    });
  }
}

/**
 * Windows CreateProcess 的裸命令查找不会补 PATHEXT；node-pty 也只接受可找到的文件。
 * 在进入 node-pty 前显式解析，让 `ssh` 与 `ssh.exe` 行为一致。
 */
export async function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions,
): Promise<ResolvedExecutable> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command };

  const win = path.win32;
  const pathext = environmentValue(options.env, "PATHEXT") ?? DEFAULT_PATHEXT;
  const extensions = extensionCandidates(pathext);
  const commandExtension = win.extname(command).toLowerCase();
  const hasExtension = commandExtension.length > 0
    && extensions.some((extension) => extension.toLowerCase() === commandExtension);
  const explicitPath = win.isAbsolute(command) || WINDOWS_PATH_SEPARATOR.test(command);
  const candidates: string[] = [];

  if (explicitPath) {
    const base = win.isAbsolute(command) ? win.normalize(command) : win.resolve(options.cwd, command);
    if (hasExtension) {
      candidates.push(base);
    } else {
      for (const extension of extensions) candidates.push(`${base}${extension.toLowerCase()}`);
      candidates.push(`${base}${extensions[0]}`, base);
    }
  } else {
    const searchDirectories = (environmentValue(options.env, "PATH") ?? "")
      .split(";")
      .map((directory) => directory.trim().replace(/^"(.*)"$/u, "$1"))
      .filter((directory) => directory.length > 0);
    for (const directory of searchDirectories) {
      const absoluteDirectory = win.isAbsolute(directory) ? win.normalize(directory) : win.resolve(options.cwd, directory);
      if (hasExtension) {
        candidates.push(win.join(absoluteDirectory, command));
      } else {
        for (const extension of extensions) candidates.push(win.join(absoluteDirectory, `${command}${extension.toLowerCase()}`));
        candidates.push(win.join(absoluteDirectory, command));
      }
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = win.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await regularFile(normalized))) continue;
    assertDirectExecutable(normalized, command);
    return { file: normalized, resolved: normalized };
  }

  const searchDirectories = (environmentValue(options.env, "PATH") ?? "")
    .split(";")
    .map((directory) => directory.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((directory) => directory.length > 0)
    .slice(0, 64);
  throw new TuiLensError("EXECUTABLE_NOT_FOUND", "Windows 上找不到可执行文件", {
    command,
    searchDirectories,
  });
}
