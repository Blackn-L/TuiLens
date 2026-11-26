import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Observation, OperationProgress, SessionInfo } from "../core/types.js";
import { readBoundedFile } from "../core/bounded-file.js";
import { errorRecord, TuiLensError } from "../core/errors.js";
import { createOwnedRequest, isDaemonUnavailable, type request as daemonRequest } from "../transport/client.js";
import { methodSchemas } from "./schemas.js";
import { mcpInstructions, mcpTools, type McpMethod } from "./mcp-tools.js";
import { MCP_SCREENSHOT_MAX_BYTES, registerMcpPrompts, registerMcpResources } from "./mcp-resources.js";
import { McpProgressForwarder } from "./mcp-progress.js";
import { anchorRequestPaths } from "./request-paths.js";
import { VERSION } from "../version.js";
import { pick } from "../core/i18n.js";

const PROGRESS_METHODS = new Set<McpMethod>(["wait", "inputAndWait", "scenario", "perf", "replay"]);

/** A stdio adapter owns its sessions across idle daemon socket reconnects. */
export async function startMcp(): Promise<void> {
  const server = new McpServer(
    { name: "tuilens", version: VERSION },
    {
      instructions: mcpInstructions(),
    }
  );
  const request = createOwnedRequest(randomUUID());
  registerMcpResources(server, request);
  registerMcpPrompts(server);
  const tools = mcpTools();
  let mayOwnSessions = false;
  const disconnect = new AbortController();
  const pending = new Set<Promise<CallToolResult>>();
  for (const method of Object.keys(tools) as McpMethod[]) {
    const description = tools[method];
    server.registerTool(
      `terminal_${method}`,
      {
        description,
        inputSchema: methodSchemas[method].shape,
      },
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
      ): Promise<CallToolResult> => {
        const acquisitionId = method === "launch" || method === "adopt" ? randomUUID() : undefined;
        // Even the first acquisition can commit before an IPC error reaches this adapter.
        if (acquisitionId) mayOwnSessions = true;
        const task = (async (): Promise<CallToolResult> => {
          try {
            const signal = AbortSignal.any([extra.signal, disconnect.signal]);
            const params = anchorRequestPaths(method, args);
            const data = acquisitionId
              ? await request(method, params, { signal, acquisitionId })
              : await requestWithProgress(request, method, params, extra, signal);
            if (acquisitionId && signal.aborted) {
              await request(
                "releaseAcquisition",
                { id: (data as SessionInfo).id, acquisitionId },
                { autoStart: false, timeoutMs: 20000 }
              );
              throw new TuiLensError("ABORTED", "操作已取消");
            }
            const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(data) }];
            const observation = imageObservation(method, data);
            if (observation?.screenshot) {
              content.push(await mcpImageContent(observation.screenshot.path));
            }
            const failed = data !== null && typeof data === "object" && "pass" in data && data.pass === false;
            return { content, ...(failed ? { isError: true } : {}) };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify(errorRecord(error)) }] };
          }
        })();
        pending.add(task);
        try {
          return await task;
        } finally {
          pending.delete(task);
        }
      }
    );
  }
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      disconnect.abort();
      await Promise.allSettled([...pending]);
      if (!mayOwnSessions) return;
      try {
        await request("releaseOwned", {}, { autoStart: false, timeoutMs: 20000 });
      } catch (error) {
        if (!isDaemonUnavailable(error)) {
          process.stderr.write(`${pick("Session cleanup failed: ", "会话清理失败：")}${errorRecord(error).message}\n`);
        }
      }
    })());
  server.server.onclose = () => {
    void cleanup();
  };
  process.stdin.once("end", () => {
    void cleanup().then(() => server.close());
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanup().then(() => server.close());
    });
  }
  await server.connect(new StdioServerTransport());
}

/**
 * 客户端通过 `_meta.progressToken` 请求时，把 daemon 的真实 progress 事件
 * 转成 MCP notifications/progress。没有服务端进度就不发心跳。
 */
async function requestWithProgress(
  request: typeof daemonRequest,
  method: McpMethod,
  args: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  signal: AbortSignal
): Promise<unknown> {
  const token = extra._meta?.progressToken;
  if (token === undefined || !PROGRESS_METHODS.has(method)) return request(method, args, { signal });
  let stopped = false;
  let sending = Promise.resolve();
  const forwarder = new McpProgressForwarder((progress) => {
    sending = sending
      .then(() =>
        extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: progress.current,
            total: progress.total,
            message: progressMessage(progress),
          },
        })
      )
      .catch(() => undefined);
  });
  const onEvent = (event: string, data: unknown): void => {
    if (stopped || event !== "progress" || !isOperationProgress(data)) return;
    forwarder.offer(data);
  };
  try {
    return await request(method, args, { signal, onEvent });
  } finally {
    stopped = true;
    forwarder.finish();
    await sending;
  }
}

/** Keep tool image content on the same bounded path as screenshot resources. */
export async function mcpImageContent(path: string): Promise<{ type: "image"; mimeType: "image/png"; data: string }> {
  const png = await readBoundedFile(path, MCP_SCREENSHOT_MAX_BYTES);
  return {
    type: "image",
    mimeType: "image/png",
    data: png.toString("base64"),
  };
}

function isOperationProgress(value: unknown): value is OperationProgress {
  if (value === null || typeof value !== "object") return false;
  const progress = value as Partial<OperationProgress>;
  return (
    ["scenario", "perf", "wait", "inputAndWait", "replay"].includes(progress.kind ?? "") &&
    typeof progress.current === "number" &&
    Number.isFinite(progress.current) &&
    progress.current >= 0 &&
    typeof progress.total === "number" &&
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    typeof progress.elapsedMs === "number" &&
    Number.isFinite(progress.elapsedMs) &&
    progress.elapsedMs >= 0
  );
}

function progressMessage(progress: OperationProgress): string {
  const profile = progress.profile ? ` (${progress.profile})` : "";
  const suffix = progress.kind === "wait" || progress.kind === "inputAndWait" ? " ms" : "";
  return pick(
    `${progress.kind}${profile}: ${progress.current}/${progress.total}${suffix}`,
    `${progress.kind}${profile}：${progress.current}/${progress.total}${suffix}`
  );
}

function imageObservation(method: McpMethod, data: unknown): Observation | undefined {
  if (method === "observe" || method === "replay") return data as Observation;
  if (method !== "inputAndWait" || data === null || typeof data !== "object") return undefined;
  const observation = (data as { observation?: unknown }).observation;
  return observation !== null && typeof observation === "object" ? (observation as Observation) : undefined;
}
