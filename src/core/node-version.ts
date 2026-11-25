import { pick, type Locale } from "./i18n.js";

export const MIN_NODE_MAJOR = 22;

export function nodeMajor(version: string = process.versions.node): number {
  const major = Number.parseInt(version.replace(/^v/u, ""), 10);
  return Number.isFinite(major) ? major : 0;
}

export function isSupportedNode(version: string = process.versions.node): boolean {
  return nodeMajor(version) >= MIN_NODE_MAJOR;
}

export function unsupportedNodeMessage(version: string = process.versions.node, locale?: Locale): string {
  return pick(
    `TuiLens requires Node.js ${MIN_NODE_MAJOR} or newer (current: ${version}). Upgrade Node.js, then rerun this command.`,
    `TuiLens 需要 Node.js ${MIN_NODE_MAJOR} 或更高版本（当前：${version}）。请升级 Node.js 后重试。`,
    locale
  );
}
