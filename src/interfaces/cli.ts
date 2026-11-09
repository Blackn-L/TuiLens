#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorRecord, TuiLensError } from "../core/errors.js";
import { request } from "../transport/client.js";
import { methodSchemas, type Method } from "./schemas.js";

const HELP = `TuiLens 0.1.0 — 面向 Agent 的终端观察与操作

用法：tuilens <命令> [会话 ID] [参数]
所有结果为 JSON；坐标从 0 起算、以字符格计量。

launch --cwd <路径> --cols 160 --rows 50 -- <程序> [程序参数...]
launch --json <JSON>                 也可使用 --file <文件> 或 --stdin
list                                列出会话
observe <id> [--no-screenshot] [--cells]  同帧文字与 PNG；按需返回完整字符格
type <id> <文本>                     输入文本，不自动提交
paste <id> <文本>                    使用已协商的括号粘贴
key <id> Enter                      按键或 Ctrl+a 等组合键
click <id> <x> <y>                   点击字符格
scroll <id> <x> <y> <up|down> [数量]  在指定位置滚轮
resize <id> <列数> <行数>            变更尺寸，应用重排另行等待
find <id> <文本> [--region x,y,w,h]   定位宽字符文本
wait <id> --text <文本> [--region x,y,w,h] [--timeout 10000]
wait <id> --stable 250               等待区域文字与样式稳定
wait --json '{"id":"…","conditions":[…]}'  组合 AND 条件
input --json '{"id":"…","action":{…}}'    完整低层操作接口
metrics <id>                        无截图、无全屏读取的计数
close <id>                          释放一个会话
shutdown                            释放所有会话并关闭本机服务
mcp                                 启动 MCP stdio 接口

环境：TUILENS_HOME 指定运行数据；TUILENS_BROWSER_PATH 指定 Chrome/Chromium。
首次使用自动启动本机 IPC 服务。功能观察有开销，不能当作零开销性能探针。
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") { process.stdout.write(HELP); return; }
  if (command === "--version") { process.stdout.write("0.1.0\n"); return; }
  if (command === "_serve") { await (await import("../transport/server.js")).serve(); return; }
  if (command === "mcp") { await (await import("./mcp.js")).startMcp(); return; }
  const separator = rest.indexOf("--");
  const program = separator >= 0 ? rest.slice(separator + 1) : [];
  const { values, positionals } = parseArgs({
    args: separator >= 0 ? rest.slice(0, separator) : rest, allowPositionals: true,
    options: {
      json: { type: "string" }, file: { type: "string" }, stdin: { type: "boolean" },
      cwd: { type: "string" }, cols: { type: "string" }, rows: { type: "string" },
      env: { type: "string", multiple: true }, "color-mode": { type: "string" },
      "no-screenshot": { type: "boolean" }, cells: { type: "boolean" }, text: { type: "string" },
      region: { type: "string" }, stable: { type: "string" }, timeout: { type: "string" },
      absent: { type: "boolean" }, exited: { type: "boolean" },
    },
  });
  let method = command;
  let params: unknown;
  const payloadSources = [values.json !== undefined, values.file !== undefined, values.stdin === true].filter(Boolean).length;
  if (payloadSources > 1) throw new TuiLensError("INVALID_ARGUMENT", "--json、--file 和 --stdin 只能选择一个");
  if (payloadSources) {
    let content = values.json;
    if (values.file) content = await readFile(values.file, "utf8");
    if (values.stdin) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 1024 * 1024) throw new TuiLensError("REQUEST_LIMIT", "输入超过 1 MiB");
        chunks.push(data);
      }
      content = Buffer.concat(chunks).toString("utf8");
    }
    params = JSON.parse(content ?? "{}");
  } else {
    const [id, first, second, third, fourth] = positionals;
    const region = values.region ? parseRegion(values.region) : undefined;
    switch (command) {
      case "launch": {
        if (!program[0]) throw new TuiLensError("INVALID_ARGUMENT", "请在 -- 后指定程序，或使用 --json");
        const env: Record<string, string> = {};
        for (const pair of values.env ?? []) {
          const index = pair.indexOf("=");
          if (index <= 0) throw new TuiLensError("INVALID_ARGUMENT", "--env 格式为 NAME=VALUE");
          env[pair.slice(0, index)] = pair.slice(index + 1);
        }
        params = {
          command: program[0], args: program.slice(1), cwd: values.cwd ?? process.cwd(), env,
          cols: Number(values.cols ?? 160), rows: Number(values.rows ?? 50),
          ...(values["color-mode"] ? { colorMode: values["color-mode"] } : {}),
        };
        break;
      }
      case "observe": params = { id, screenshot: !values["no-screenshot"], includeCells: values.cells ?? false }; break;
      case "type": method = "input"; params = { id, action: { type: "text", text: first } }; break;
      case "paste": method = "input"; params = { id, action: { type: "paste", text: first } }; break;
      case "key": method = "input"; params = { id, action: { type: "key", key: first } }; break;
      case "click": method = "input"; params = { id, action: { type: "click", x: Number(first), y: Number(second) } }; break;
      case "scroll": method = "input"; params = { id, action: { type: "scroll", x: Number(first), y: Number(second), direction: third, amount: Number(fourth ?? 3) } }; break;
      case "resize": params = { id, cols: Number(first), rows: Number(second) }; break;
      case "find": params = { id, text: first, ...(region ? { region } : {}) }; break;
      case "metrics": case "close": params = { id }; break;
      case "wait": {
        const conditions: unknown[] = [];
        if (values.text) conditions.push({ kind: "text", text: values.text, ...(region ? { region } : {}), ...(values.absent ? { absent: true } : {}) });
        if (values.stable) conditions.push({ kind: "stable", durationMs: Number(values.stable), ...(region ? { region } : {}) });
        if (values.exited) conditions.push({ kind: "exited" });
        params = { id, conditions, timeoutMs: Number(values.timeout ?? 10000) };
        break;
      }
      case "list": case "ping": case "shutdown": params = {}; break;
      default: throw new TuiLensError("UNKNOWN_METHOD", "未知命令；使用 --help 查看帮助");
    }
  }
  if (!Object.hasOwn(methodSchemas, method)) throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  const validated = methodSchemas[method as Method].safeParse(params);
  if (!validated.success) throw new TuiLensError("INVALID_ARGUMENT", "参数不合法", validated.error.issues);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  const data = await request(method as Method, validated.data, { signal: abort.signal, autoStart: method !== "shutdown" });
  process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
}

function parseRegion(value: string) {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4) throw new TuiLensError("INVALID_ARGUMENT", "区域格式为 x,y,width,height");
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: errorRecord(error) }) + "\n");
  process.exitCode = 1;
});
