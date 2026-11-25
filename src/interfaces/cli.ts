#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { errorRecord, TuiLensError } from "../core/errors.js";
import { isDaemonUnavailable, request } from "../transport/client.js";
import { methodSchemas, type Method } from "./schemas.js";
import { readBoundedFile } from "../core/bounded-file.js";
import { VERSION } from "../version.js";
import { pick, resolveLocale } from "../core/i18n.js";
import { buildMcpConfig } from "./mcp-config.js";
import type { PerfRunResult } from "../perf/runner.js";
import type { ScenarioRunResult } from "../scenario/runner.js";

const HELP_EN = `TuiLens ${VERSION} - terminal observation and control for agents

Usage: tuilens <command> [session-id] [options]
All results are JSON; coordinates are zero-based character cells.

launch --cwd <path> [--terminal-profile kitty|wezterm|...|<JSON>]
       [--renderer headless|dom|webgl] [--record]
       [--protocol-replies auto|forward|suppress] [--protocol-reply-latency 250] -- <program> [args...]
                                     headless is the default; dom/webgl activate Chromium on demand
launch --json <JSON>                 also accepts --file <path> or --stdin
list                                 list sessions
observe <id> [--view compact|diff|full|cells] [--from-frame <id>] [--screenshot] [--show-cursor] [--region x,y,w,h]
type <id> <text>                     send text without submitting
paste <id> <text>                    use negotiated bracketed paste
key <id> Enter                       send a key or chord such as Ctrl+a
click <id> <x> <y>                   click a character cell
click-text <id> <text> [--nth 0]     require a unique match by default; JSON supports hitbox/point/offset
drag <id> <x1> <y1> <x2> <y2>        drag between cells; supports --shift/--ctrl/--alt
mouse-down / mouse-up <id> <x> <y>   press or release a mouse button
scroll <id> <x> <y> <up|down> [count] [--page]  scroll by line or page at a cell
scroll <id> <x> <y> --top / --bottom            jump to the start/end of scrollback
resize <id> <cols> <rows>            resize; wait separately for application layout
find <id> <text> [--region x,y,w,h]  locate wide-character text
wait <id> --text <text> [--region x,y,w,h] [--timeout 10000]
wait <id> --stable 250               wait for text and style stability
wait --json '{"id":"…","conditions":[…]}'  combine conditions with AND
input --json '{"id":"…","action":{…}}'    full low-level input interface
input-wait <id> <text> [--text expected] [--timeout 10000] [--screenshot]
                                        send one input and wait for a visible result; no automatic retry
metrics <id>                         counters without screenshots or full-screen reads
compare <id> --baseline <PNG> [--region x,y,w,h] [--show-cursor]  generate a visual diff and report
replay <recording> [--speed 0]       replay output offline; does not execute input or programs
doctor                               diagnose runtime, browser, PTY, storage and daemon state
probe [--font-file <path>] [--font-family <css>] [--strict-font]
                                     render fixed glyph samples and report font/grid fingerprints
watch <id> [--interval 250] [--timeout 0] [--control]  daemon-pushed JSONL screen stream; --control forwards terminal input
scenario --file <JSON> [--html <path>] [--junit <path>]
                                     run a declarative scenario, retain failure evidence and release the session
                                     the spec may include profiles:[...] to run a terminal matrix
perf --file <JSON> [--baseline <JSON>] [--write-baseline <JSON>] [--html <path>]
       [--max-regression 0.15] [--allow-env-mismatch]
                                     performance scenario: multi-round sampling, process-tree memory,
                                     baseline comparison and regression gating
                                     the spec may include profiles:[...] for a comparison table
close <id>                           release one session
shutdown                             release all sessions and stop the local service
mcp                                  start the MCP stdio interface
mcp-config [--client json|codex|claude-code|cursor|gemini] [--mode global|npx|absolute]
                                     print copy-paste MCP client configuration
report <result.json|recording.jsonl> --out <report.html>
                                     render a zero-dependency offline evidence report

Environment: TUILENS_HOME sets runtime data; TUILENS_BROWSER_PATH selects Chrome/Chromium;
TUILENS_FONT_FILE pins a screenshot font file; TUILENS_FONT_FAMILY overrides the fallback stack;
TUILENS_LANG selects en or zh-CN (default: en); TUILENS_PTY_WORKER=1 isolates node-pty;
TUILENS_IPC_TIMEOUT_MS optionally bounds IPC waits (default: no fixed cap).
The local IPC service starts automatically on first use. Observation has overhead and is not a zero-cost performance probe.
`;

const HELP_ZH = `TuiLens ${VERSION} — 面向 Agent 的终端观察与操作

用法：tuilens <命令> [会话 ID] [参数]
所有结果为 JSON；坐标从 0 起算、以字符格计量。

launch --cwd <路径> [--terminal-profile kitty|wezterm|...|<JSON>]
       [--renderer headless|dom|webgl] [--record]
       [--protocol-replies auto|forward|suppress] [--protocol-reply-latency 250] -- <程序> [参数...]
                                     默认 headless；dom/webgl 按需激活 Chromium
launch --json <JSON>                 也可使用 --file <文件> 或 --stdin
list                                列出会话
observe <id> [--view compact|diff|full|cells] [--from-frame <id>] [--screenshot] [--show-cursor] [--region x,y,w,h]
type <id> <文本>                     输入文本，不自动提交
paste <id> <文本>                    使用已协商的括号粘贴
key <id> Enter                      按键或 Ctrl+a 等组合键
click <id> <x> <y>                   点击字符格
click-text <id> <文本> [--nth 0]      默认要求唯一匹配，防止重名误点；JSON 支持 hitbox/point/offset
drag <id> <x1> <y1> <x2> <y2>        带坐标拖拽；支持 --shift/--ctrl/--alt
mouse-down / mouse-up <id> <x> <y>   独立按住/松开
scroll <id> <x> <y> <up|down> [数量] [--page]  在指定位置按行或按页滚动
scroll <id> <x> <y> --top / --bottom         一次定位到回滚区首/尾
resize <id> <列数> <行数>            变更尺寸，应用重排另行等待
find <id> <文本> [--region x,y,w,h]   定位宽字符文本
wait <id> --text <文本> [--region x,y,w,h] [--timeout 10000]
wait <id> --stable 250               等待区域文字与样式稳定
wait --json '{"id":"…","conditions":[…]}'  组合 AND 条件
input --json '{"id":"…","action":{…}}'    完整低层操作接口
input-wait <id> <文本> [--text 确认文本] [--timeout 10000] [--screenshot]
                                        发送一次输入并等待可见结果，不自动重发
metrics <id>                        无截图、无全屏读取的计数
compare <id> --baseline <PNG> [--region x,y,w,h] [--show-cursor]  生成视觉差异和报告
replay <录制文件> [--speed 0]        离线回放输出，不执行输入或程序
doctor                               诊断运行时、浏览器、PTY、存储和 daemon 状态
probe [--font-file <路径>] [--font-family <CSS>] [--strict-font]
                                     渲染固定字形样本并报告字体/网格指纹
watch <id> [--interval 250] [--timeout 0] [--control]  服务端推送的 JSONL 实时画面流；--control 转发终端输入
scenario --file <JSON> [--html <路径>] [--junit <路径>]
                                     执行声明式场景，失败留证并释放会话
                                    规格可含 profiles:[...]，按终端 profile 运行矩阵
perf --file <JSON> [--baseline <JSON>] [--write-baseline <JSON>] [--html <路径>]
       [--max-regression 0.15] [--allow-env-mismatch]
                                     性能场景：多轮采样、进程树内存、基线比较与劣化判定
                                    规格可含 profiles:[...]，输出按 profile 的对比表
close <id>                          释放一个会话
shutdown                            释放所有会话并关闭本机服务
mcp                                 启动 MCP stdio 接口
mcp-config [--client json|codex|claude-code|cursor|gemini] [--mode global|npx|absolute]
                                     输出可直接复制的 MCP 客户端配置
report <结果.json|录制.jsonl> --out <报告.html>
                                     离线生成零外部依赖的证据报告

环境：TUILENS_HOME 指定运行数据；TUILENS_BROWSER_PATH 指定 Chrome/Chromium；
TUILENS_FONT_FILE 固定截图字体文件；TUILENS_FONT_FAMILY 覆盖回退字体栈；
TUILENS_LANG 选择 en 或 zh-CN（默认 en）；TUILENS_PTY_WORKER=1 隔离 node-pty；
TUILENS_IPC_TIMEOUT_MS 可限制 IPC 等待（默认不设固定上限）。
首次使用自动启动本机 IPC 服务。功能观察有开销，不能当作零开销性能探针。
`;

function helpText(): string {
  return resolveLocale() === "zh-CN" ? HELP_ZH : HELP_EN;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "_serve") {
    await (await import("../transport/server.js")).serve();
    return;
  }
  if (command === "mcp") {
    await (await import("./mcp.js")).startMcp();
    return;
  }
  if (command === "mcp-config") {
    const { values } = parseArgs({
      args: rest,
      options: {
        client: { type: "string", default: "json" },
        mode: { type: "string", default: "global" },
      },
    });
    const config = buildMcpConfig({ client: values.client, mode: values.mode });
    process.stdout.write(`${config.content}\n`);
    return;
  }
  if (command === "report") {
    await runReport(rest);
    return;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("../doctor.js");
    const data = await runDoctor();
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
    if (!data.ok) process.exitCode = 1;
    return;
  }
  if (command === "probe") {
    const { runProbe } = await import("../probe.js");
    const { values } = parseArgs({
      args: rest,
      options: {
        "font-file": { type: "string" },
        "font-family": { type: "string" },
        "font-size": { type: "string" },
        renderer: { type: "string" },
        "strict-font": { type: "boolean" },
      },
    });
    if (values.renderer !== undefined && values.renderer !== "dom" && values.renderer !== "webgl") {
      throw new TuiLensError("INVALID_ARGUMENT", "renderer 必须是 dom 或 webgl");
    }
    const fontFile = values["font-file"] ?? (process.env.TUILENS_FONT_FILE?.trim() || undefined);
    const fontFamily = values["font-family"] ?? (process.env.TUILENS_FONT_FAMILY?.trim() || undefined);
    const data = await runProbe({
      ...(fontFile ? { fontFile } : {}),
      ...(fontFamily ? { fontFamily } : {}),
      ...(values["font-size"] === undefined ? {} : { fontSize: Number(values["font-size"]) }),
      ...(values.renderer === undefined ? {} : { renderer: values.renderer }),
      ...(values["strict-font"] ? { strictFont: true } : {}),
    });
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
    if (!data.ok) process.exitCode = 1;
    return;
  }
  const separator = rest.indexOf("--");
  const program = separator >= 0 ? rest.slice(separator + 1) : [];
  const { values, positionals } = parseArgs({
    args: separator >= 0 ? rest.slice(0, separator) : rest,
    allowPositionals: true,
    options: {
      json: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      cwd: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      env: { type: "string", multiple: true },
      "color-mode": { type: "string" },
      "terminal-profile": { type: "string" },
      view: { type: "string" },
      "from-frame": { type: "string" },
      text: { type: "string" },
      region: { type: "string" },
      stable: { type: "string" },
      timeout: { type: "string" },
      interval: { type: "string" },
      control: { type: "boolean" },
      absent: { type: "boolean" },
      exited: { type: "boolean" },
      renderer: { type: "string" },
      record: { type: "boolean" },
      baseline: { type: "string" },
      threshold: { type: "string" },
      "max-diff": { type: "string" },
      speed: { type: "string" },
      "allow-truncated": { type: "boolean" },
      nth: { type: "string" },
      unique: { type: "boolean" },
      shift: { type: "boolean" },
      ctrl: { type: "boolean" },
      alt: { type: "boolean" },
      page: { type: "boolean" },
      top: { type: "boolean" },
      bottom: { type: "boolean" },
      frame: { type: "string" },
      "after-frame": { type: "string" },
      "protocol-replies": { type: "string" },
      "protocol-reply-latency": { type: "string" },
      "show-cursor": { type: "boolean" },
      screenshot: { type: "boolean" },
      "write-baseline": { type: "string" },
      "max-regression": { type: "string" },
      junit: { type: "string" },
      "allow-env-mismatch": { type: "boolean" },
      html: { type: "string" },
    },
  });
  if (command === "watch") {
    await runWatch(positionals[0], values.interval, values.timeout, values.control ?? false);
    return;
  }
  let method = command;
  let params: unknown;
  const payloadSources = [values.json !== undefined, values.file !== undefined, values.stdin === true].filter(
    Boolean
  ).length;
  if (payloadSources > 1) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "--json、--file 和 --stdin 只能选择一个",
      undefined,
      "Use only one of --json, --file, or --stdin."
    );
  }
  if (payloadSources) {
    method = normalizeMethod(command);
    let content = values.json;
    if (values.file) content = (await readBoundedFile(values.file, 1024 * 1024)).toString("utf8");
    if (values.stdin) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 1024 * 1024) {
          throw new TuiLensError("REQUEST_LIMIT", "输入超过 1 MiB", undefined, "Input exceeds 1 MiB.");
        }
        chunks.push(data);
      }
      content = Buffer.concat(chunks).toString("utf8");
    }
    params = JSON.parse(content ?? "{}");
    if (method === "scenario") params = { specification: params };
    if (method === "perf") {
      params = {
        specification: params,
        ...(values.baseline ? { baseline: values.baseline } : {}),
        ...(values["write-baseline"] ? { writeBaseline: values["write-baseline"] } : {}),
        ...(values["max-regression"] === undefined ? {} : { maxRegression: Number(values["max-regression"]) }),
        ...(values["allow-env-mismatch"] ? { allowEnvironmentMismatch: true } : {}),
      };
    }
  } else {
    const [id, first, second, third, fourth] = positionals;
    const region = values.region ? parseRegion(values.region) : undefined;
    const modifiers = { shift: values.shift ?? false, ctrl: values.ctrl ?? false, alt: values.alt ?? false };
    const matchOptions = {
      ...(values.unique ? { selection: "unique" } : {}),
      ...(values.nth === undefined ? {} : { nth: Number(values.nth) }),
    };
    switch (command) {
      case "launch": {
        if (!program[0]) {
          throw new TuiLensError(
            "INVALID_ARGUMENT",
            "请在 -- 后指定程序，或使用 --json",
            undefined,
            "Specify a program after --, or use --json."
          );
        }
        const env: Record<string, string> = {};
        for (const pair of values.env ?? []) {
          const index = pair.indexOf("=");
          if (index <= 0) {
            throw new TuiLensError(
              "INVALID_ARGUMENT",
              "--env 格式为 NAME=VALUE",
              undefined,
              "--env values must use NAME=VALUE."
            );
          }
          env[pair.slice(0, index)] = pair.slice(index + 1);
        }
        const protocolReplies: { mode?: string; maxLatencyMs?: number } = {};
        if (values["protocol-replies"]) protocolReplies.mode = values["protocol-replies"];
        if (values["protocol-reply-latency"] !== undefined) {
          protocolReplies.maxLatencyMs = Number(values["protocol-reply-latency"]);
        }
        params = {
          command: program[0],
          args: program.slice(1),
          cwd: values.cwd ?? process.cwd(),
          env,
          cols: Number(values.cols ?? 160),
          rows: Number(values.rows ?? 50),
          ...(values["color-mode"] ? { colorMode: values["color-mode"] } : {}),
          ...(values.renderer ? { renderer: values.renderer } : {}),
          ...(values["terminal-profile"] ? { terminalProfile: values["terminal-profile"] } : {}),
          ...(values.record ? { recording: {} } : {}),
          ...(Object.keys(protocolReplies).length ? { protocolReplies } : {}),
        };
        break;
      }
      case "observe":
        params = {
          id,
          view: values.view ?? "compact",
          ...(values["from-frame"] === undefined ? {} : { fromFrameId: Number(values["from-frame"]) }),
          ...(values.screenshot ? { screenshot: true } : {}),
          ...(region ? { region } : {}),
          ...(values["show-cursor"] ? { cursor: "show" } : {}),
        };
        break;
      case "type":
        method = "input";
        params = { id, action: { type: "text", text: first } };
        break;
      case "paste":
        method = "input";
        params = { id, action: { type: "paste", text: first } };
        break;
      case "key":
        method = "input";
        params = { id, action: { type: "key", key: first } };
        break;
      case "click":
        method = "input";
        params = { id, action: { type: "click", x: Number(first), y: Number(second), modifiers } };
        break;
      case "mouse-down":
      case "mouse-up":
        method = "input";
        params = {
          id,
          action: {
            type: command === "mouse-down" ? "mouseDown" : "mouseUp",
            x: Number(first),
            y: Number(second),
            modifiers,
          },
        };
        break;
      case "drag":
        method = "input";
        params = {
          id,
          action: {
            type: "drag",
            from: { x: Number(first), y: Number(second) },
            to: { x: Number(third), y: Number(fourth) },
            modifiers,
          },
        };
        break;
      case "scroll": {
        if (values.top && values.bottom) {
          throw new TuiLensError(
            "INVALID_ARGUMENT",
            "--top 与 --bottom 不能同时使用",
            undefined,
            "--top and --bottom cannot be used together."
          );
        }
        if ((values.top || values.bottom) && values.page) {
          throw new TuiLensError(
            "INVALID_ARGUMENT",
            "--page 不能与滚动终点同时使用",
            undefined,
            "--page cannot be combined with a scroll endpoint."
          );
        }
        if ((values.top || values.bottom) && (third !== undefined || fourth !== undefined)) {
          throw new TuiLensError(
            "INVALID_ARGUMENT",
            "--top/--bottom 不能与方向或数量同时使用",
            undefined,
            "--top/--bottom cannot be combined with a direction or count."
          );
        }
        method = "input";
        params = {
          id,
          action:
            values.top || values.bottom
              ? { type: "scroll", x: Number(first), y: Number(second), to: values.top ? "top" : "bottom", modifiers }
              : {
                  type: "scroll",
                  x: Number(first),
                  y: Number(second),
                  direction: third,
                  amount: Number(fourth ?? 3),
                  ...(values.page ? { unit: "page" } : {}),
                  modifiers,
                },
        };
        break;
      }
      case "resize":
        params = { id, cols: Number(first), rows: Number(second) };
        break;
      case "find":
        params = { id, text: first, ...(region ? { region } : {}), options: matchOptions };
        break;
      case "click-text":
        method = "clickText";
        params = { id, text: first, ...(region ? { region } : {}), options: matchOptions };
        break;
      case "compare":
        params = {
          id,
          options: {
            baseline: values.baseline,
            ...(region ? { region } : {}),
            ...(values.threshold === undefined ? {} : { pixelThreshold: Number(values.threshold) }),
            ...(values["max-diff"] === undefined ? {} : { maxDiffRatio: Number(values["max-diff"]) }),
            ...(values["show-cursor"] ? { cursor: "show" } : {}),
          },
        };
        break;
      case "input-wait": {
        method = "inputAndWait";
        const conditions: unknown[] = [];
        if (values.text) conditions.push({ kind: "text", text: values.text, ...(region ? { region } : {}) });
        params = {
          id,
          action: { type: "text", text: first },
          wait: {
            ...(conditions.length ? { conditions } : {}),
            timeoutMs: Number(values.timeout ?? 10000),
          },
          ...(values.screenshot ? { screenshot: true } : {}),
        };
        break;
      }
      case "replay":
        params = { path: id, speed: Number(values.speed ?? 0), allowTruncated: values["allow-truncated"] ?? false };
        break;
      case "metrics":
      case "close":
        params = { id };
        break;
      case "wait": {
        const conditions: unknown[] = [];
        if (values.text)
          conditions.push({
            kind: "text",
            text: values.text,
            ...(region ? { region } : {}),
            ...(values.absent ? { absent: true } : {}),
          });
        if (values.stable)
          conditions.push({ kind: "stable", durationMs: Number(values.stable), ...(region ? { region } : {}) });
        if (values.exited) conditions.push({ kind: "exited" });
        params = {
          id,
          conditions,
          timeoutMs: Number(values.timeout ?? 10000),
          ...(values["after-frame"] === undefined ? {} : { afterFrameId: Number(values["after-frame"]) }),
        };
        break;
      }
      case "perf": {
        throw new TuiLensError(
          "INVALID_ARGUMENT",
          "perf 需要 --file 或 --json 提供性能场景",
          undefined,
          "perf requires a performance scenario via --file or --json."
        );
      }
      case "list":
      case "ping":
      case "shutdown":
        params = {};
        break;
      default:
        throw new TuiLensError(
          "UNKNOWN_METHOD",
          "未知命令；使用 --help 查看帮助",
          undefined,
          "Unknown command; use --help for usage."
        );
    }
  }
  if ((method === "input" || method === "inputAndWait") && values.frame !== undefined) {
    params = { ...(params as object), guard: { frameId: Number(values.frame) } };
  }
  if (!Object.hasOwn(methodSchemas, method)) {
    throw new TuiLensError("UNKNOWN_METHOD", "未知命令", undefined, "Unknown command.");
  }
  const validated = methodSchemas[method as Method].safeParse(params);
  if (!validated.success) {
    throw new TuiLensError("INVALID_ARGUMENT", "参数不合法", validated.error.issues, "Invalid arguments.");
  }
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  let data: unknown;
  try {
    data = await request(method as Method, validated.data, {
      signal: abort.signal,
      autoStart: method !== "shutdown",
    });
  } catch (error) {
    if (method !== "shutdown" || !isDaemonUnavailable(error)) throw error;
    data = { stopped: true, alreadyStopped: true };
  }
  process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
  if (values.html !== undefined) {
    if (method !== "scenario" && method !== "perf") {
      throw new TuiLensError(
        "INVALID_ARGUMENT",
        "--html 只适用于 scenario 或 perf",
        undefined,
        "--html is only valid for scenario or perf."
      );
    }
    await writeHtml(values.html, method, data);
  }
  if (values.junit) await writeJunit(values.junit, method, data);
  if (data && typeof data === "object" && "pass" in data && data.pass === false) process.exitCode = 1;
}

/**
 * 把场景或性能结果写成 JUnit XML，方便 CI 直接展示每一步。
 * 报告写出失败不应改变命令本身的判定结果，但要报错退出。
 */
async function writeJunit(path: string, method: string, data: unknown): Promise<void> {
  const { renderJunit, failureOf } = await import("../testing/junit.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const suites: Parameters<typeof renderJunit>[0] = [];
  if (method === "scenario") {
    const result = data as {
      pass: boolean;
      matrix?: boolean;
      runs?: unknown[];
      terminalProfile?: string;
      steps: { index: number; type: string; name?: string; elapsedMs: number; error?: unknown }[];
    };
    const appendScenario = (run: typeof result, suffix = ""): void => {
      suites.push({
        name: `tuilens-scenario${suffix}`,
        cases: run.steps.map((step) => ({
          name: `${step.index + 1}. ${step.type}${step.name ? ` (${step.name})` : ""}`,
          className: "scenario",
          timeMs: step.elapsedMs,
          ...(step.error ? { failure: failureOf(step.error) } : {}),
        })),
      });
    };
    if (result.matrix === true && Array.isArray(result.runs)) {
      for (const [index, item] of result.runs.entries()) {
        const run = item as typeof result;
        appendScenario(run, `:${run.terminalProfile ?? index + 1}`);
      }
    } else appendScenario(result);
  } else if (method === "perf") {
    const result = data as {
      pass: boolean;
      matrix?: boolean;
      runs?: unknown[];
      profile?: string;
      error?: unknown;
      metrics: { phase: string; name: string; elapsedMs: { p50: number; p95: number; count: number } }[];
      regressions: string[];
      errors: { round: number; error: unknown }[];
    };
    const appendPerf = (run: typeof result, suffix = ""): void => {
      suites.push({
        name: `tuilens-perf${suffix}`,
        cases:
          run.error !== undefined
            ? [
                {
                  name: `profile ${run.profile ?? suffix}`,
                  className: "perf",
                  timeMs: 0,
                  failure: failureOf(run.error),
                },
              ]
            : [
                ...run.metrics.map((metric) => ({
                  name: `${metric.phase}/${metric.name} p50=${metric.elapsedMs.p50}ms`,
                  className: "perf",
                  timeMs: metric.elapsedMs.p50,
                  output: `samples=${metric.elapsedMs.count} p50=${metric.elapsedMs.p50}ms p95=${metric.elapsedMs.p95}ms`,
                })),
                ...run.errors.map((item) => ({
                  name: `round ${item.round}`,
                  className: "perf",
                  timeMs: 0,
                  failure: failureOf(item.error),
                })),
                ...run.regressions.map((text) => ({
                  name: `regression: ${text}`,
                  className: "perf",
                  timeMs: 0,
                  failure: { message: text, type: "PerfRegression" },
                })),
              ],
      });
    };
    if (result.matrix === true && Array.isArray(result.runs)) {
      for (const [index, item] of result.runs.entries()) {
        const run = item as typeof result & { environment?: { terminalProfile?: string } };
        appendPerf(run, `:${run.profile ?? run.environment?.terminalProfile ?? index + 1}`);
      }
    } else appendPerf(result);
  } else {
    return;
  }
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, renderJunit(suites), { mode: 0o644 });
  process.stderr.write(`${pick("JUnit report written to", "JUnit 报告已写入")} ${target}\n`);
}

async function writeHtml(path: string, method: "scenario" | "perf", data: unknown): Promise<void> {
  const { renderPerfHtmlReport, renderScenarioHtmlReport, writeHtmlReport } = await import(
    "../reporting/html-report.js"
  );
  const report =
    method === "scenario"
      ? await renderScenarioHtmlReport(data as ScenarioRunResult)
      : await renderPerfHtmlReport(data as PerfRunResult);
  await writeHtmlReport(path, report);
  process.stderr.write(`${pick("HTML report written to", "HTML 报告已写入")} ${resolve(path)}\n`);
}

async function runReport(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
    },
  });
  const input = positionals[0];
  const output = values.out;
  if (!input) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "report 需要输入 JSON 或录制 JSONL",
      undefined,
      "report requires a JSON result or JSONL recording."
    );
  }
  if (!output) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "report 需要 --out <report.html>",
      undefined,
      "report requires --out <report.html>."
    );
  }
  const { renderEvidenceFileHtmlReport, writeHtmlReport } = await import("../reporting/html-report.js");
  const report = await renderEvidenceFileHtmlReport(input);
  await writeHtmlReport(output, report);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      data: {
        path: resolve(output),
        kind: report.manifest.kind,
        inlineImages: report.inlineImages,
        inlineImageBytes: report.inlineImageBytes,
      },
    }) + "\n"
  );
}

/** 只读实时观察：每个变化帧输出一行 JSONL，不发送输入，也不会自动关闭会话。 */
async function runWatch(
  id: string | undefined,
  intervalValue: string | undefined,
  timeoutValue: string | undefined,
  control: boolean
): Promise<void> {
  if (!id) {
    throw new TuiLensError("INVALID_ARGUMENT", "watch 需要会话 ID", undefined, "watch requires a session ID.");
  }
  const interval = Number(intervalValue ?? 250);
  const timeout = Number(timeoutValue ?? 0);
  if (!Number.isFinite(interval) || interval < 50 || interval > 60_000) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "watch interval 必须在 50～60000 ms 之间",
      undefined,
      "watch interval must be between 50 and 60000 ms."
    );
  }
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 86_400_000) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "watch timeout 必须在 0～86400000 ms 之间",
      undefined,
      "watch timeout must be between 0 and 86400000 ms."
    );
  }
  if (control && !process.stdin.isTTY) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "watch --control 需要交互式 TTY",
      undefined,
      "watch --control requires an interactive TTY."
    );
  }
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  let detachInput: (() => void) | undefined;
  let forwarding: Promise<void> = Promise.resolve();
  if (control) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const forward = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const controlAt = data.indexOf("\u0003");
      const payload = controlAt < 0 ? data : data.slice(0, controlAt);
      if (payload) {
        forwarding = forwarding
          .then(() => request("input", { id, action: { type: "raw", data: payload } }, { signal: abort.signal }))
          .then(
            () => {},
            () => undefined
          );
      }
      // Ctrl+C 在这个模式里用于脱离，而不是送给被测程序。
      if (controlAt >= 0) abort.abort();
    };
    process.stdin.on("data", forward);
    detachInput = () => {
      process.stdin.off("data", forward);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  }
  let lastFrame = -1;
  let frames = 0;
  let stoppedPrinted = false;
  const stopped = (): void => {
    if (stoppedPrinted) return;
    stoppedPrinted = true;
    process.stdout.write(JSON.stringify({ ok: true, data: { stopped: true, frames } }) + "\n");
  };
  try {
    await request(
      "watch",
      {
        id,
        intervalMs: interval,
        ...(timeout > 0 ? { timeoutMs: timeout } : {}),
      },
      {
        signal: abort.signal,
        onEvent: (event, data) => {
          if (event !== "frame") return;
          const observation = data as {
            snapshot: { frameId: number };
            session: { status?: "running" | "exited" | "closed" };
          };
          if (observation.snapshot.frameId === lastFrame) return;
          lastFrame = observation.snapshot.frameId;
          frames += 1;
          process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
        },
      }
    );
    stopped();
  } catch (error) {
    if (abort.signal.aborted) {
      stopped();
      return;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    detachInput?.();
    await forwarding;
  }
}

function parseRegion(value: string) {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "区域格式为 x,y,width,height",
      undefined,
      "Region format is x,y,width,height."
    );
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function normalizeMethod(command: string): string {
  if (Object.hasOwn(methodSchemas, command)) return command;
  if (command === "input-wait") return "inputAndWait";
  const camel = command.replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase());
  return Object.hasOwn(methodSchemas, camel) ? camel : command;
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: errorRecord(error) }) + "\n");
  process.exitCode = 1;
});
