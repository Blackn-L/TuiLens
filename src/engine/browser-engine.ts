import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { TuiLensError } from "../core/errors.js";
import type { BrowserEngineOptions, Region, TerminalEngine, TerminalSnapshot, TerminalState } from "../core/types.js";
import { initializeBrowserRuntime } from "./browser-runtime.js";
import { installKittyRuntime } from "./kitty-runtime.js";
import { KITTY_DIACRITICS } from "./kitty-diacritics.js";

const require = createRequire(import.meta.url);
const DEFAULT_FONT = "'Cascadia Mono','DejaVu Sans Mono','Noto Sans Mono CJK SC','Noto Sans CJK SC','Microsoft YaHei','Segoe UI Emoji','Noto Color Emoji',monospace";

/** 优先显式配置，其次复用系统 Chrome；均不可用时使用 Playwright 已安装的 Chromium。 */
export function resolveBrowserExecutable(explicit?: string): string | undefined {
  const configured = explicit ?? process.env.TUILENS_BROWSER_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new TuiLensError("BROWSER_NOT_FOUND", "指定的浏览器文件不存在", { path: configured });
    }
    return configured;
  }
  const windowsRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const candidates = process.platform === "win32"
    ? windowsRoots.filter((path): path is string => Boolean(path)).flatMap((path) => [
      join(path, "Google/Chrome/Application/chrome.exe"),
      join(path, "Microsoft/Edge/Application/msedge.exe"),
    ])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((path) => existsSync(path));
}

function assertDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) {
    throw new TuiLensError("INVALID_SIZE", "终端尺寸必须为 2–500 列、2–250 行的整数");
  }
}

export async function createBrowserEngine(options: BrowserEngineOptions): Promise<TerminalEngine> {
  assertDimensions(options.cols, options.rows);
  const fontSize = options.fontSize ?? 16;
  const images = options.images ?? "off";
  if (!["off", "sixel", "all"].includes(images)) throw new TuiLensError("INVALID_IMAGE_PROFILE", "不支持的图片配置");
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) {
    throw new TuiLensError("INVALID_FONT_SIZE", "字体大小必须在 8–48 像素范围内");
  }
  let browser: Browser | undefined;
  let page: Page;
  let closed = false;
  let crashed = false;
  const executablePath = resolveBrowserExecutable(options.executablePath);
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
    });
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: 1600, height: 1200 },
      colorScheme: "dark",
    });
    // 会话只渲染本地终端字节，拒绝页面产生外部网络请求。
    await context.route("**/*", (route) => route.abort());
    page = await context.newPage();
    page.on("crash", () => { crashed = true; });
    page.setDefaultTimeout(10_000);
    await page.exposeFunction("__tuilensData", (data: unknown) => {
      if (!closed && typeof data === "string") options.onData(data);
    });
    await page.setContent("<!doctype html><html><head><meta charset='utf-8'></head><body><div id='terminal'></div></body></html>");
    const terminalModule = require.resolve("@xterm/xterm");
    const addonModule = require.resolve("@xterm/addon-unicode-graphemes");
    await page.addStyleTag({ path: join(dirname(terminalModule), "../css/xterm.css") });
    await page.addStyleTag({
      content: "html,body{margin:0;padding:0;overflow:hidden;background:#101114}#terminal{display:inline-block}.xterm{padding:0}.xterm-viewport{scrollbar-width:none!important}.xterm-viewport::-webkit-scrollbar{display:none}.xterm-scrollable-element>.scrollbar{display:none!important}",
    });
    await page.addScriptTag({ path: terminalModule });
    await page.addScriptTag({ path: addonModule });
    if (images !== "off") await page.addScriptTag({ path: require.resolve("@xterm/addon-image") });
    if (images === "all") await page.evaluate(installKittyRuntime, KITTY_DIACRITICS);
    await page.evaluate(initializeBrowserRuntime, {
      cols: options.cols,
      rows: options.rows,
      fontFamily: options.fontFamily ?? DEFAULT_FONT,
      fontSize,
      images,
    });
    await resizeViewport();
  } catch (error) {
    await browser?.close().catch(() => undefined);
    if (error instanceof TuiLensError) throw error;
    throw new TuiLensError("BROWSER_START_FAILED", "无法启动终端浏览器。可设置 TUILENS_BROWSER_PATH 或执行 npx playwright install chromium。", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  function assertOpen(): void {
    if (closed) throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
    if (crashed || page.isClosed() || !browser?.isConnected()) {
      throw new TuiLensError("ENGINE_FAILED", "终端浏览器已退出或崩溃");
    }
  }

  async function state(): Promise<TerminalState> {
    assertOpen();
    return page.evaluate(() => window.__tuilens.state());
  }

  async function assertFrameReady(): Promise<void> {
    if ((await state()).modes.synchronizedOutput) {
      // 不在队列屏障内等待结束序列，否则会阻塞后续 PTY 数据造成死锁。
      throw new TuiLensError("FRAME_PENDING", "应用的同步输出帧尚未结束");
    }
  }

  async function settle(): Promise<void> {
    await page.evaluate(() => window.__tuilens.settle());
  }

  async function resizeViewport(): Promise<void> {
    await settle();
    const size = await page.evaluate(() => window.__tuilens.size());
    await page.setViewportSize(size);
    await settle();
  }

  return {
    async write(data): Promise<void> {
      assertOpen();
      await page.evaluate((chunk) => window.__tuilens.write(chunk), data);
    },
    async resize(cols, rows): Promise<void> {
      assertOpen();
      assertDimensions(cols, rows);
      await page.evaluate(({ cols: width, rows: height }) => window.__tuilens.resize(width, height), { cols, rows });
      await resizeViewport();
    },
    state,
    async hasText(text): Promise<boolean> {
      assertOpen();
      await assertFrameReady();
      return page.evaluate((value) => window.__tuilens.hasText(value), text);
    },
    async snapshot(frameId): Promise<TerminalSnapshot> {
      assertOpen();
      await assertFrameReady();
      // write 已保证解析完成。纯状态读取不等待绘制，避免轮询挡住后续协议查询；
      // PNG 仍在同一会话屏障内等待绘制，保持状态与图像对应。
      return page.evaluate((id) => window.__tuilens.snapshot(id), frameId);
    },
    async screenshot(region?: Region): Promise<{ png: Buffer; width: number; height: number }> {
      assertOpen();
      await assertFrameReady();
      await settle();
      const size = await page.evaluate(() => window.__tuilens.size());
      if (region) {
        const { cols, rows } = await state();
        if (!Object.values(region).every(Number.isInteger) || region.x < 0 || region.y < 0
          || region.width < 1 || region.height < 1 || region.x + region.width > cols || region.y + region.height > rows) {
          throw new TuiLensError("INVALID_REGION", "截图区域必须位于终端字符网格内");
        }
        const rectangle = await page.locator(".xterm-screen").boundingBox();
        if (!rectangle) throw new TuiLensError("ENGINE_FAILED", "终端画布不可见");
        const x = Math.floor(rectangle.x + rectangle.width * region.x / cols);
        const y = Math.floor(rectangle.y + rectangle.height * region.y / rows);
        const right = Math.ceil(rectangle.x + rectangle.width * (region.x + region.width) / cols);
        const bottom = Math.ceil(rectangle.y + rectangle.height * (region.y + region.height) / rows);
        const png = await page.screenshot({
          type: "png", animations: "disabled", caret: "initial",
          clip: { x, y, width: right - x, height: bottom - y },
        });
        return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      }
      const png = await page.locator(".xterm-screen").screenshot({
        type: "png",
        animations: "disabled",
        caret: "initial",
      });
      return { png, ...size };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await page.evaluate(() => window.__tuilens.dispose());
      } finally {
        await browser?.close();
      }
    },
  };
}
