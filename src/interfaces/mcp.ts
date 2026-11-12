import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Observation, SessionInfo } from "../core/types.js";
import { errorRecord } from "../core/errors.js";
import { request } from "../transport/client.js";
import { methodSchemas } from "./schemas.js";
import { mcpTools, type McpMethod } from "./mcp-tools.js";
import { VERSION } from "../version.js";
import { pick } from "../core/i18n.js";

/** MCP 与 CLI 共用同一应用协议；断开时只释放此连接创建的会话。 */
export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: "tuilens", version: VERSION });
  const tools = mcpTools();
  const owned = new Set<string>();
  const disconnect = new AbortController();
  const pending = new Set<Promise<unknown>>();
  for (const method of Object.keys(tools) as McpMethod[]) {
    const description = tools[method];
    server.registerTool(`terminal_${method}`, {
      description,
      inputSchema: methodSchemas[method].shape,
    }, async (args: Record<string, unknown>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<CallToolResult> => {
      try {
        const operation = request(method, args, { signal: AbortSignal.any([extra.signal, disconnect.signal]) });
        pending.add(operation);
        let data: unknown;
        try { data = await operation; } finally { pending.delete(operation); }
        // 连接断开与启动返回竞争时，不能把迟到会话加到已经清空的 owned 中。
        if (method === "launch" && disconnect.signal.aborted) {
          await request("close", { id: (data as SessionInfo).id }, { autoStart: false });
          return { isError: true, content: [{ type: "text", text: pick(
            "MCP connection closed; the late session was released.",
            "MCP 连接已关闭，迟到会话已释放",
          ) }] };
        }
        if (method === "launch") owned.add((data as SessionInfo).id);
        if (method === "close") owned.delete((args as { id: string }).id);
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(data) }];
        const observation = imageObservation(method, data);
        if (observation?.screenshot) {
          content.push({
            type: "image", mimeType: "image/png",
            data: (await readFile(observation.screenshot.path)).toString("base64"),
          });
        }
        const failed = data !== null && typeof data === "object" && "pass" in data && data.pass === false;
        return { content, ...(failed ? { isError: true } : {}) };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(errorRecord(error)) }] };
      }
    });
  }
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    disconnect.abort();
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled([...owned].map((id) => request("close", { id }, { autoStart: false, timeoutMs: 20000 })));
    for (const result of results) {
      if (result.status === "rejected") {
        process.stderr.write(`${pick("Session cleanup failed: ", "会话清理失败：")}${errorRecord(result.reason).message}\n`);
      }
    }
    owned.clear();
  })();
  server.server.onclose = () => { void cleanup(); };
  process.stdin.once("end", () => { void cleanup().then(() => server.close()); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void cleanup().then(() => server.close()); });
  }
  await server.connect(new StdioServerTransport());
}

function imageObservation(method: McpMethod, data: unknown): Observation | undefined {
  if (method === "observe" || method === "replay") return data as Observation;
  if (method !== "inputAndWait" || data === null || typeof data !== "object") return undefined;
  const observation = (data as { observation?: unknown }).observation;
  return observation !== null && typeof observation === "object" ? observation as Observation : undefined;
}
