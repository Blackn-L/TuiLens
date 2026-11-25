import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiLensError } from "../core/errors.js";

export const MCP_CONFIG_CLIENTS = ["json", "codex", "claude-code", "cursor", "gemini"] as const;
export const MCP_CONFIG_MODES = ["global", "npx", "absolute"] as const;

export type McpConfigClient = (typeof MCP_CONFIG_CLIENTS)[number];
export type McpConfigMode = (typeof MCP_CONFIG_MODES)[number];
export type McpConfigFormat = "json" | "toml" | "command";

export interface McpConfigOptions {
  client?: string;
  mode?: string;
  execPath?: string;
  cliPath?: string;
}

export interface McpConfigResult {
  client: McpConfigClient;
  mode: McpConfigMode;
  format: McpConfigFormat;
  content: string;
}

interface ServerCommand {
  command: string;
  args: string[];
}

export function buildMcpConfig(options: McpConfigOptions = {}): McpConfigResult {
  const client = options.client ?? "json";
  const mode = options.mode ?? "global";
  if (!MCP_CONFIG_CLIENTS.includes(client as McpConfigClient)) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      `--client 必须是 ${MCP_CONFIG_CLIENTS.join("、")}`,
      undefined,
      `--client must be one of ${MCP_CONFIG_CLIENTS.join(", ")}.`
    );
  }
  if (!MCP_CONFIG_MODES.includes(mode as McpConfigMode)) {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      `--mode 必须是 ${MCP_CONFIG_MODES.join("、")}`,
      undefined,
      `--mode must be one of ${MCP_CONFIG_MODES.join(", ")}.`
    );
  }
  const typedClient = client as McpConfigClient;
  const typedMode = mode as McpConfigMode;
  const command = serverCommand(typedMode, options);
  if (typedClient === "codex") {
    return {
      client: typedClient,
      mode: typedMode,
      format: "toml",
      content: codexToml(command),
    };
  }
  if (typedClient === "claude-code") {
    return {
      client: typedClient,
      mode: typedMode,
      format: "command",
      content: `claude mcp add --scope user tuilens -- ${[command.command, ...command.args].map(shellArg).join(" ")}`,
    };
  }
  return {
    client: typedClient,
    mode: typedMode,
    format: "json",
    content: JSON.stringify({ mcpServers: { tuilens: command } }, null, 2),
  };
}

function serverCommand(mode: McpConfigMode, options: McpConfigOptions): ServerCommand {
  if (mode === "global") return { command: "tuilens", args: ["mcp"] };
  if (mode === "npx") return { command: "npx", args: ["-y", "tuilens", "mcp"] };
  return {
    command: options.execPath ?? process.execPath,
    args: [resolve(options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url))), "mcp"],
  };
}

function codexToml(command: ServerCommand): string {
  return [
    "[mcp_servers.tuilens]",
    `command = ${JSON.stringify(command.command)}`,
    `args = [${command.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
  ].join("\n");
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  if (process.platform === "win32") return `"${value.replace(/"/gu, '\\"')}"`;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
