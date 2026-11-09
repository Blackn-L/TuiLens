import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Observation, SessionInfo } from "../core/types.js";
import { errorRecord } from "../core/errors.js";
import { request } from "../transport/client.js";
import { methodSchemas, type Method } from "./schemas.js";

/** MCP 与 CLI 共用同一应用协议；断开时只释放此连接创建的会话。 */
export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: "tuilens", version: "0.3.0" });
  const owned = new Set<string>();
  const disconnect = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const descriptions: Partial<Record<Method, string>> = {
    launch: "在真实 PTY 中启动程序。返回会话 ID。坐标以 0 起算的字符格计量。",
    list: "列出 TuiLens 会话。",
    observe: "冻结输出消费，获取同一 frameId 的字符格和实际终端 PNG；截图会产生采集开销。",
    input: "发送文字、括号粘贴、按键、点击、带位置滚轮或原始字节。先观察实际控件位置。",
    find: "从字符格定位文字，正确处理中文宽字符。找到文字不等于业务控件可点击。",
    clickText: "定位后按区域指纹保护点击。默认拒绝重名，可指定样式/区域/nth。",
    resize: "改变 PTY 和模拟器尺寸。之后需等待应用布局条件。",
    wait: "等待全部条件成立；可按区域检查文字、样式稳定、尺寸或退出。支持取消。",
    metrics: "读取字节、排队和背压计数；不截图或读取整个字符网格。",
    close: "关闭会话并释放进程和浏览器资源。",
    compare: "将实际 PNG 与只读基准图比较，输出差异图；遮罩坐标以截图像素计量。",
    replay: "离线重放显式录制的终端输出与 resize，不执行程序或输入，返回截图。",
    scenario: "运行声明式场景步骤，自动记录失败证据并回收本次会话。",
  };
  for (const [name, description] of Object.entries(descriptions)) {
    const method = name as Method;
    server.registerTool(`terminal_${name}`, {
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
          return { isError: true, content: [{ type: "text", text: "MCP 连接已关闭，迟到会话已释放" }] };
        }
        if (method === "launch") owned.add((data as SessionInfo).id);
        if (method === "close") owned.delete((args as { id: string }).id);
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(data) }];
        if (method === "observe" || method === "replay") {
          const observation = data as Observation;
          if (observation.screenshot) {
            content.push({
              type: "image", mimeType: "image/png",
              data: (await readFile(observation.screenshot.path)).toString("base64"),
            });
          }
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
      if (result.status === "rejected") process.stderr.write(`会话清理失败：${errorRecord(result.reason).message}\n`);
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
