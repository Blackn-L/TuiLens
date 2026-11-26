import { opendir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readBoundedFile } from "../core/bounded-file.js";
import { TuiLensError } from "../core/errors.js";
import { pick, resolveLocale } from "../core/i18n.js";
import type { Observation, SessionInfo } from "../core/types.js";
import { isDaemonUnavailable, type request as daemonRequest } from "../transport/client.js";
import { runtimePaths } from "../transport/paths.js";

export const MCP_SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_RESOURCES = 256;
const MAX_ARTIFACT_ENTRIES = 1024;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/x-ndjson",
  "application/x-yaml",
  "image/svg+xml",
]);

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".har": "application/json",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".log": "text/plain",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".ndjson": "application/x-ndjson",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
};

export interface McpResourceOptions {
  artifactDir?: string;
}

export function registerMcpResources(
  server: McpServer,
  request: typeof daemonRequest,
  options: McpResourceOptions = {}
): void {
  const artifactDir = options.artifactDir ?? runtimePaths().artifactDir;
  const description = (en: string, zh: string): string => pick(en, zh);

  server.registerResource(
    "sessions",
    "tuilens://sessions",
    {
      title: description("TuiLens sessions", "TuiLens 会话"),
      description: description(
        "Active sessions with safe metadata only (no environment or credentials).",
        "活动会话的安全元数据列表（不含环境变量或凭据）。"
      ),
      mimeType: "application/json",
    },
    async (uri, extra) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(await safeSessions(request, extra.signal), null, 2),
        },
      ],
    })
  );

  const sessionResource = (
    kind: "screen" | "screenshot" | "metrics",
    mimeType: string,
    en: string,
    zh: string
  ): ResourceTemplate =>
    new ResourceTemplate(`tuilens://sessions/{id}/${kind}`, {
      list: async (extra) => ({
        resources: (await safeSessions(request, extra.signal)).map((session) => ({
          uri: `tuilens://sessions/${session.id}/${kind}`,
          name: `${session.id}-${kind}`,
          description: `${description(en, zh)}: ${session.id}`,
          mimeType,
        })),
      }),
    });

  server.registerResource(
    "session-screen",
    sessionResource("screen", "text/plain", "Compact text screen", "紧凑文本画面"),
    {
      title: description("Session screen", "会话画面"),
      description: description(
        "Compact text screen read from the browser-free terminal core.",
        "从无浏览器终端内核读取的紧凑文本画面。"
      ),
      mimeType: "text/plain",
    },
    async (uri, variables, extra) => {
      const observation = await request(
        "observe",
        { id: sessionId(variables.id), view: "compact", screenshot: false },
        { autoStart: false, signal: extra.signal }
      );
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/plain",
            text: (observation as Observation).snapshot.text,
          },
        ],
      };
    }
  );

  server.registerResource(
    "session-screenshot",
    sessionResource("screenshot", "image/png", "Current PNG screenshot", "当前 PNG 截图"),
    {
      title: description("Session screenshot", "会话截图"),
      description: description(
        "Current PNG screenshot; activates the visual layer on demand and is bounded to 32 MiB.",
        "当前 PNG 截图；按需激活视觉层，读取上限 32 MiB。"
      ),
      mimeType: "image/png",
    },
    async (uri, variables, extra) => {
      const observation = (await request(
        "observe",
        { id: sessionId(variables.id), view: "compact", screenshot: true },
        { autoStart: false, signal: extra.signal }
      )) as Observation;
      if (!observation.screenshot) throw new TuiLensError("SCREENSHOT_FAILED", "截图资源未生成 PNG");
      const image = await readBoundedFile(observation.screenshot.path, MCP_SCREENSHOT_MAX_BYTES);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "image/png",
            blob: image.toString("base64"),
          },
        ],
      };
    }
  );

  server.registerResource(
    "session-metrics",
    sessionResource("metrics", "application/json", "Backpressure and protocol counters", "背压与协议计数"),
    {
      title: description("Session metrics", "会话指标"),
      description: description(
        "Backpressure, queue and protocol-reply counters without rendering.",
        "零渲染的背压、队列与协议应答计数。"
      ),
      mimeType: "application/json",
    },
    async (uri, variables, extra) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            await request("metrics", { id: sessionId(variables.id) }, { autoStart: false, signal: extra.signal }),
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerResource(
    "artifact",
    new ResourceTemplate("tuilens://artifacts/{name}", {
      list: async () => ({ resources: await listArtifacts(artifactDir) }),
    }),
    {
      title: description("TuiLens artifact", "TuiLens 产物"),
      description: description(
        "A report, diff image, screenshot or recording inside the artifact directory; reads are bounded to 16 MiB.",
        "读取 artifact 目录内的报告、差异图、截图或录制；读取上限 16 MiB。"
      ),
    },
    async (uri, variables, extra) => {
      if (typeof variables.name !== "string") throw new TuiLensError("INVALID_ARGUMENT", "artifact 名称不能为空");
      if (extra.signal.aborted) throw new TuiLensError("ABORTED", "资源读取已取消");
      const artifact = await readArtifactResource(variables.name, artifactDir);
      if (extra.signal.aborted) throw new TuiLensError("ABORTED", "资源读取已取消");
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: artifact.mimeType,
            ...(isTextMime(artifact.mimeType)
              ? { text: artifact.data.toString("utf8") }
              : { blob: artifact.data.toString("base64") }),
          },
        ],
      };
    }
  );
}

export function registerMcpPrompts(server: McpServer): void {
  const locale = resolveLocale();
  const english = locale !== "zh-CN";

  server.registerPrompt(
    "tui_reproduce_bug",
    {
      title: english ? "Reproduce a TUI bug" : "复现 TUI 缺陷",
      description: english
        ? "Reproduce and diagnose an interactive terminal issue with a compact/diff observation loop."
        : "用 compact/diff 观察循环复现并诊断交互式终端问题。",
      argsSchema: {
        description: z.string().min(1).max(4000),
        command: z.string().max(8192).optional(),
        expected: z.string().max(4000).optional(),
      },
    },
    ({ description, command, expected }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: english
              ? [
                  "Reproduce and diagnose this TUI issue with TuiLens.",
                  `Issue: ${description}`,
                  command ? `Target command: ${command}` : "Launch the application in TuiLens.",
                  expected ? `Expected result: ${expected}` : "",
                  'Use terminal_launch, then terminal_observe with view:"compact" and keep snapshot.frameId.',
                  'Drive the minimum input with terminal_inputAndWait, then call terminal_observe with view:"diff" and that frameId.',
                  "Request screenshot:true only when visual evidence is needed. Finish with terminal_close.",
                  "Report reproducible steps, frame IDs, the observed diff, and the likely root cause.",
                ]
                  .filter(Boolean)
                  .join("\n")
              : [
                  "使用 TuiLens 复现并诊断这个 TUI 问题。",
                  `问题：${description}`,
                  command ? `目标命令：${command}` : "在 TuiLens 中启动该应用。",
                  expected ? `预期结果：${expected}` : "",
                  '先用 terminal_launch 启动，再用 terminal_observe(view:"compact") 观察并保存 snapshot.frameId。',
                  '用 terminal_inputAndWait 执行最小必要输入，然后带上面的 frameId 调用 terminal_observe(view:"diff")。',
                  "仅在需要视觉证据时传 screenshot:true，结束时调用 terminal_close。",
                  "报告可复现步骤、frameId、观察到的 diff，以及可能的根因。",
                ]
                  .filter(Boolean)
                  .join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "tui_visual_regression",
    {
      title: english ? "Check a TUI visual regression" : "检查 TUI 视觉回归",
      description: english
        ? "Capture a stable TUI state and compare it with a baseline image."
        : "截取稳定 TUI 状态并与基准图比较。",
      argsSchema: {
        scenario: z.string().min(1).max(4000),
        baseline: z.string().max(8192).optional(),
      },
    },
    ({ scenario, baseline }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: english
              ? [
                  "Run a TUI visual regression check with TuiLens.",
                  `Scenario: ${scenario}`,
                  baseline ? `Baseline image: ${baseline}` : "Record or locate the baseline image first.",
                  "Launch the application, wait for a stable visible condition, and capture only the region under test.",
                  "Use terminal_compare with the baseline; inspect the generated diff image and JSON evidence.",
                  "Report pass/fail, pixel counts, changed regions, and the screenshot/diff paths. Close the session.",
                ].join("\n")
              : [
                  "使用 TuiLens 运行 TUI 视觉回归检查。",
                  `场景：${scenario}`,
                  baseline ? `基准图：${baseline}` : "先录制或定位基准图。",
                  "启动应用，等待明确的可见稳定条件，只截取被测区域。",
                  "用 terminal_compare 与基准图比较，并检查差异图和 JSON 证据。",
                  "报告通过/失败、像素数量、变化区域以及截图/差异图路径，最后关闭会话。",
                ].join("\n"),
          },
        },
      ],
    })
  );
}

async function safeSessions(
  request: typeof daemonRequest,
  signal: AbortSignal
): Promise<ReturnType<typeof safeSession>[]> {
  try {
    const sessions = (await request("list", {}, { autoStart: false, signal })) as SessionInfo[];
    return sessions.map(safeSession);
  } catch (error) {
    if (isDaemonUnavailable(error)) return [];
    throw error;
  }
}

function safeSession(session: SessionInfo) {
  return {
    id: session.id,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    status: session.status,
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    ...(session.terminalProfile ? { terminalProfile: session.terminalProfile } : {}),
    ...(session.renderer ? { renderer: session.renderer } : {}),
    ...(session.visualSyncDegraded === undefined ? {} : { visualSyncDegraded: session.visualSyncDegraded }),
  };
}

function sessionId(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !z.string().uuid().safeParse(value).success) {
    throw new TuiLensError("INVALID_ARGUMENT", "会话资源 ID 必须是 UUID");
  }
  return value;
}

function artifactName(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !value) {
    throw new TuiLensError("INVALID_ARGUMENT", "artifact 名称不能为空");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TuiLensError("INVALID_ARGUMENT", "artifact 名称包含无效的百分号编码");
  }
  if (
    !decoded ||
    decoded.includes("\0") ||
    isAbsolute(decoded) ||
    /^[A-Za-z]:/u.test(decoded) ||
    decoded.startsWith("\\\\") ||
    decoded.startsWith("//") ||
    decoded.split(/[\\/]/u).some((part) => part === ".." || part === ".")
  ) {
    throw new TuiLensError("INVALID_ARGUMENT", "artifact 名称必须是 artifact 目录内的相对路径");
  }
  return decoded;
}

export async function readArtifactResource(
  name: string,
  artifactDir = runtimePaths().artifactDir
): Promise<{ data: Buffer; mimeType: string }> {
  const safeName = artifactName(name);
  let root: string;
  try {
    root = await realpath(artifactDir);
  } catch {
    throw new TuiLensError("INVALID_FILE", "artifact 目录不存在");
  }
  const candidate = resolve(root, safeName);
  if (!within(root, candidate)) {
    throw new TuiLensError("INVALID_ARGUMENT", "artifact 路径逃逸出 artifact 目录");
  }
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new TuiLensError("INVALID_FILE", "artifact 文件不存在");
  }
  if (!within(root, actual)) {
    throw new TuiLensError("INVALID_ARGUMENT", "artifact 符号链接逃逸出 artifact 目录");
  }
  return {
    data: await readBoundedFile(actual, ARTIFACT_MAX_BYTES),
    mimeType: mimeTypeFor(actual),
  };
}

async function listArtifacts(artifactDir: string): Promise<
  {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }[]
> {
  const resources: { uri: string; name: string; description: string; mimeType: string }[] = [];
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(artifactDir);
  } catch {
    return [];
  }
  try {
    let scanned = 0;
    for await (const entry of directory) {
      if (scanned >= MAX_ARTIFACT_ENTRIES) break;
      scanned += 1;
      if (!entry.isFile()) continue;
      resources.push({
        uri: `tuilens://artifacts/${encodeURIComponent(entry.name)}`,
        name: entry.name,
        description: `TuiLens artifact: ${entry.name}`,
        mimeType: mimeTypeFor(entry.name),
      });
      if (resources.length >= MAX_ARTIFACT_RESOURCES) break;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return resources.sort((left, right) => left.name.localeCompare(right.name));
}

function within(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function mimeTypeFor(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType);
}
