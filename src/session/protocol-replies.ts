import type {
  LaunchOptions, ResolvedTerminalProfile, TerminalKeyboardCapabilities, TerminalReplies,
} from "../core/types.js";

export type ProtocolRepliesOptions = NonNullable<LaunchOptions["protocolReplies"]>;

type ReplyKind = "primary" | "secondary" | "cursor" | "status" | "cellSize" | "windowSize"
  | "decrqm" | "xtversion" | "keyboard";

const QUERY_PATTERNS: readonly [ReplyKind, RegExp][] = [
  ["primary", /\x1b\[(?:0)?c/gu],
  ["secondary", /\x1b\[>(?:0)?c/gu],
  ["cursor", /\x1b\[(?:\?)?6n/gu],
  ["status", /\x1b\[5n/gu],
  ["cellSize", /\x1b\[16t/gu],
  ["windowSize", /\x1b\[(?:14|18|19)t/gu],
  ["decrqm", /\x1b\[\?\d+\$p/gu],
  ["xtversion", /\x1b\[>(?:0)?q/gu],
  ["keyboard", /\x1b\[\?u/gu],
];

const REPLY_PATTERNS: readonly [ReplyKind, RegExp][] = [
  ["primary", /^\x1b\[\?[0-9;]*c$/u],
  ["secondary", /^\x1b\[>[0-9;]*c$/u],
  ["cursor", /^\x1b\[\??[0-9]+;[0-9]+R$/u],
  ["status", /^\x1b\[0n$/u],
  ["cellSize", /^\x1b\[6;[0-9]+;[0-9]+t$/u],
  ["windowSize", /^\x1b\[[489];[0-9]+;[0-9]+t$/u],
  ["decrqm", /^\x1b\[\?[0-9]+;[0-9]+\$y$/u],
  ["xtversion", /^\x1bP>\|[^\x1b]*\x1b\\$/u],
  ["keyboard", /^\x1b\[\?[0-9;]*u$/u],
];

export interface ProtocolReplyMetrics {
  protocolQueries: number;
  protocolRepliesForwarded: number;
  protocolRepliesDropped: number;
  lastProtocolReplyLatencyMs: number;
}

const DA1_REPLY = /\x1b\[\?[0-9;]*c/gu;
const DA2_REPLY = /\x1b\[>[0-9;]*c/gu;
const XTVERSION_REPLY = /\x1bP>\|[^\x1b]*\x1b\\/gu;
const KEYBOARD_REPLY = /\x1b\[\?[0-9;]*u/gu;

/**
 * ConPTY 等 PTY 实现可能先于浏览器模拟器回答 DA1/DA2。
 * 进入 PTY 前的最后一层按 profile 改写，确保应用收到声明的终端身份。
 */
export function rewriteProfileReplies(
  data: string,
  replies: TerminalReplies,
  keyboard?: TerminalKeyboardCapabilities,
): string {
  return data
    .replace(DA1_REPLY, () => replies.da1 ?? "")
    .replace(DA2_REPLY, () => replies.da2 ?? "")
    .replace(XTVERSION_REPLY, () => replies.xtversion ?? "")
    .replace(KEYBOARD_REPLY, () => keyboard?.kitty === undefined ? "" : `\x1b[?${keyboard.kitty}u`);
}

export function rewriteTerminalProfileReplies(data: string, profile: ResolvedTerminalProfile): string {
  return rewriteProfileReplies(data, profile.replies, profile.capabilities.keyboard);
}

/**
 * 终端查询由 xterm 自动应答，但应答经过浏览器桥接后可能晚于应用恢复 cooked mode。
 * 这层只处理已知的自动应答；未知数据继续交给 PTY，避免误伤图片协议等扩展。
 */
export class ProtocolReplyGuard {
  private readonly mode: "auto" | "forward" | "suppress";
  private readonly maxLatencyMs: number;
  private readonly pending = new Map<ReplyKind, number[]>();
  private scanTail = "";
  private readonly state: ProtocolReplyMetrics = {
    protocolQueries: 0,
    protocolRepliesForwarded: 0,
    protocolRepliesDropped: 0,
    lastProtocolReplyLatencyMs: 0,
  };

  constructor(options: ProtocolRepliesOptions = {}) {
    this.mode = options.mode ?? "auto";
    this.maxLatencyMs = options.maxLatencyMs ?? 250;
  }

  observeOutput(data: string): void {
    const previousLength = this.scanTail.length;
    const value = this.scanTail + data;
    for (const [kind, pattern] of QUERY_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
        if (match.index + match[0].length <= previousLength) continue;
        this.record(kind);
      }
    }
    this.scanTail = value.slice(-64);
  }

  shouldForward(data: string): boolean {
    if (this.mode === "suppress") {
      const kind = REPLY_PATTERNS.find(([, pattern]) => pattern.test(data))?.[0];
      if (kind) {
        this.pending.get(kind)?.shift();
        this.state.protocolRepliesDropped += 1;
        return false;
      }
    }
    if (this.mode === "forward") {
      this.state.protocolRepliesForwarded += 1;
      return true;
    }
    const kind = REPLY_PATTERNS.find(([, pattern]) => pattern.test(data))?.[0];
    if (!kind) {
      this.state.protocolRepliesForwarded += 1;
      return true;
    }
    const times = this.pending.get(kind);
    const queryAt = times?.shift();
    if (queryAt === undefined) {
      this.state.protocolRepliesDropped += 1;
      return false;
    }
    const latency = performance.now() - queryAt;
    this.state.lastProtocolReplyLatencyMs = latency;
    if (latency <= this.maxLatencyMs) {
      this.state.protocolRepliesForwarded += 1;
      return true;
    }
    this.state.protocolRepliesDropped += 1;
    return false;
  }

  metrics(): ProtocolReplyMetrics {
    return { ...this.state };
  }

  private record(kind: ReplyKind): void {
    const times = this.pending.get(kind) ?? [];
    times.push(performance.now());
    if (times.length > 32) times.splice(0, times.length - 32);
    this.pending.set(kind, times);
    this.state.protocolQueries += 1;
  }
}
