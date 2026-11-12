import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { errorRecord, TuiLensError } from "../src/core/errors.js";
import { normalizeLocale, pick } from "../src/core/i18n.js";
import { mcpTools } from "../src/interfaces/mcp-tools.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));

function envWithoutLocale(overrides: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env, ...overrides };
  if (!("TUILENS_LANG" in overrides)) delete env.TUILENS_LANG;
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

test("locale normalization defaults to English and recognizes Chinese", () => {
  assert.equal(normalizeLocale(undefined), undefined);
  assert.equal(normalizeLocale("zh_CN"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-TW"), undefined);
  assert.equal(normalizeLocale("fr"), undefined);
  assert.equal(pick("English", "中文", "en"), "English");
  assert.equal(pick("English", "中文", "zh-CN"), "中文");
});

test("error records expose both languages and localize message by default", () => {
  const error = new TuiLensError("INVALID_ARGUMENT", "参数不合法");
  const english = errorRecord(error, "en");
  assert.equal(english.message, "The request arguments are invalid.");
  assert.equal(english.messageEn, "The request arguments are invalid.");
  assert.equal(english.messageZh, "参数不合法");

  const chinese = errorRecord(error, "zh-CN");
  assert.equal(chinese.message, "参数不合法");
  assert.equal(chinese.messageEn, "The request arguments are invalid.");
  assert.equal(chinese.messageZh, "参数不合法");
});

test("MCP descriptions have English and Chinese variants", () => {
  assert.match(mcpTools("en").launch, /Launch a program/u);
  assert.match(mcpTools("zh-CN").launch, /启动程序/u);
});

test("CLI help and errors honor TUILENS_LANG", async () => {
  const english = await run(process.execPath, [cli, "--help"], { env: envWithoutLocale() });
  assert.match(english.stdout, /terminal observation and control for agents/u);
  assert.match(english.stdout, /TUILENS_LANG selects en or zh-CN/u);

  const chinese = await run(process.execPath, [cli, "--help"], {
    env: envWithoutLocale({ TUILENS_LANG: "zh-CN" }),
  });
  assert.match(chinese.stdout, /面向 Agent/u);
  assert.match(chinese.stdout, /TUILENS_LANG 选择/u);

  const failedEnglish = await run(process.execPath, [cli, "definitely-unknown"], {
    env: envWithoutLocale(), maxBuffer: 1024 * 1024,
  }).catch((error: { stdout?: string }) => error);
  const payloadEnglish = JSON.parse(failedEnglish.stdout ?? "{}") as {
    error?: { code?: string; message?: string; messageEn?: string; messageZh?: string };
  };
  assert.equal(payloadEnglish.error?.code, "UNKNOWN_METHOD");
  assert.equal(payloadEnglish.error?.message, "Unknown command; use --help for usage.");
  assert.equal(payloadEnglish.error?.messageZh, "未知命令；使用 --help 查看帮助");

  const failedChinese = await run(process.execPath, [cli, "definitely-unknown"], {
    env: envWithoutLocale({ TUILENS_LANG: "zh-CN" }), maxBuffer: 1024 * 1024,
  }).catch((error: { stdout?: string }) => error);
  const payloadChinese = JSON.parse(failedChinese.stdout ?? "{}") as {
    error?: { message?: string; messageEn?: string; messageZh?: string };
  };
  assert.equal(payloadChinese.error?.message, "未知命令；使用 --help 查看帮助");
  assert.equal(payloadChinese.error?.messageEn, "Unknown command; use --help for usage.");
});
