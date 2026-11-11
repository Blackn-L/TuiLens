import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright";
import { TuiLensError } from "../core/errors.js";
import type {
  BrowserEngineOptions, EngineFactory, Region, TerminalEngine, TerminalSnapshot, TerminalState,
} from "../core/types.js";
import { BrowserHost } from "./browser-host.js";
import { initializeBrowserRuntime } from "./browser-runtime.js";
import { unpackGrid } from "./snapshot-codec.js";
import { Osc1337Normalizer } from "./osc1337.js";
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
  return createEngine(options);
}

/**
 * 绑定一个共享浏览器的引擎工厂：多个会话复用同一 Chromium 进程，
 * 各自使用独立上下文与页面。返回的 `shutdown` 必须在管理器关闭时调用。
 */
export function createBrowserEngineFactory(executablePath?: string) {
  const resolved = resolveBrowserExecutable(executablePath);
  // 共享宿主保活：会话之间复用同一进程，只有管理器关闭时才真正释放。
  const host = new BrowserHost(resolved, true);
  const factory = ((options: BrowserEngineOptions) => createEngine(options, host)) as EngineFactory & {
    shutdown(): Promise<void>;
  };
  factory.shutdown = () => host.shutdown();
  return factory;
}

async function createEngine(options: BrowserEngineOptions, shared?: BrowserHost): Promise<TerminalEngine> {
  assertDimensions(options.cols, options.rows);
  const fontSize = options.fontSize ?? 16;
  const images = options.images ?? "off";
  const iip = images === "iterm" || images === "all" ? new Osc1337Normalizer() : undefined;
  if (!["off", "sixel", "iterm", "all"].includes(images)) throw new TuiLensError("INVALID_IMAGE_PROFILE", "不支持的图片配置");
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) {
    throw new TuiLensError("INVALID_FONT_SIZE", "字体大小必须在 8–48 像素范围内");
  }
  const host = shared ?? new BrowserHost(resolveBrowserExecutable(options.executablePath));
  const ownsHost = shared === undefined;
  let browser: Browser | undefined;
  let page: Page;
  let closed = false;
  let crashed = false;
  try {
    browser = await host.acquire();
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
      content: "html,body{margin:0;padding:0;overflow:hidden;background:#101114}#terminal{display:inline-block}.xterm{padding:0}.xterm-viewport{scrollbar-width:none!important}.xterm-viewport::-webkit-scrollbar{display:none}.xterm-scrollable-element>.scrollbar{display:none!important}.tuilens-cursor-hidden .xterm-cursor{visibility:hidden!important;animation:none!important}",
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
    // 启动失败只归还本次引用；共享浏览器可能仍有其他会话在用。
    if (ownsHost) await host.shutdown();
    else host.release();
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

  async function nextPaint(): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }

  async function screenRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    const rectangle = await page.locator(".xterm-screen").boundingBox();
    if (!rectangle) throw new TuiLensError("ENGINE_FAILED", "终端画布不可见");
    return {
      x: Math.floor(rectangle.x),
      y: Math.floor(rectangle.y),
      width: Math.max(1, Math.ceil(rectangle.width)),
      height: Math.max(1, Math.ceil(rectangle.height)),
    };
  }

  async function waitForGeometry(expected?: { cols: number; rows: number }) {
    await settle();
    let previous: { width: number; height: number } | undefined;
    const deadline = Date.now() + 5000;
    do {
      const current = await state();
      const rectangle = await screenRect();
      const stable = previous !== undefined
        && Math.abs(previous.width - rectangle.width) <= 1
        && Math.abs(previous.height - rectangle.height) <= 1;
      if (stable && (!expected || (current.cols === expected.cols && current.rows === expected.rows))) {
        return { rectangle, current };
      }
      previous = rectangle;
      await nextPaint();
    } while (Date.now() < deadline);
    throw new TuiLensError("ENGINE_FAILED", "终端画布尺寸未能稳定");
  }

  async function resizeViewport(expected?: { cols: number; rows: number }): Promise<void> {
    await settle();
    const size = await page.evaluate(() => window.__tuilens.size());
    await page.setViewportSize(size);
    const { rectangle, current } = await waitForGeometry(expected);
    iip?.setGeometry({ cols: current.cols, rows: current.rows, ...rectangle });
  }

  async function screenshot(region: Region | undefined, options: { cursor?: "hide" | "show" } = {}) {
    assertOpen();
    await assertFrameReady();
    const hideCursor = options.cursor !== "show";
    try {
      if (hideCursor) {
        await page.evaluate(() => document.documentElement.classList.add("tuilens-cursor-hidden"));
      } else {
        await page.evaluate(() => document.documentElement.classList.remove("tuilens-cursor-hidden"));
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await settle();
        const { rectangle, current } = await waitForGeometry();
        let clip = rectangle;
        if (region) {
          if (!Object.values(region).every(Number.isInteger) || region.x < 0 || region.y < 0
            || region.width < 1 || region.height < 1 || region.x + region.width > current.cols
            || region.y + region.height > current.rows) {
            throw new TuiLensError("INVALID_REGION", "截图区域必须位于终端字符网格内");
          }
          const x = Math.floor(rectangle.x + rectangle.width * region.x / current.cols);
          const y = Math.floor(rectangle.y + rectangle.height * region.y / current.rows);
          const right = Math.ceil(rectangle.x + rectangle.width * (region.x + region.width) / current.cols);
          const bottom = Math.ceil(rectangle.y + rectangle.height * (region.y + region.height) / current.rows);
          clip = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
        }
        const png = await page.screenshot({ type: "png", animations: "disabled", caret: "initial", clip });
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (width === clip.width && height === clip.height) return { png, width, height };
      }
      throw new TuiLensError("ENGINE_FAILED", "截图尺寸与终端画布不一致");
    } finally {
      if (hideCursor) {
        await page.evaluate(() => document.documentElement.classList.remove("tuilens-cursor-hidden")).catch(() => undefined);
      }
    }
  }

  return {
    async write(data): Promise<void> {
      assertOpen();
      const normalized = iip ? iip.write(data) : data;
      if (normalized) await page.evaluate((chunk) => window.__tuilens.write(chunk), normalized);
    },
    async resize(cols, rows): Promise<void> {
      assertOpen();
      assertDimensions(cols, rows);
      await page.evaluate(({ cols: width, rows: height }) => window.__tuilens.resize(width, height), { cols, rows });
      await resizeViewport({ cols, rows });
    },
    state,
    async hasText(text): Promise<boolean> {
      assertOpen();
      await assertFrameReady();
      return page.evaluate((value) => window.__tuilens.hasText(value), text);
    },
    async snapshot(frameId, options): Promise<TerminalSnapshot> {
      assertOpen();
      if (!options?.allowPendingFrame) await assertFrameReady();
      // write 已保证解析完成。纯状态读取不等待绘制，避免轮询挡住后续协议查询；
      // PNG 仍在同一会话屏障内等待绘制，保持状态与图像对应。
      const includeGrid = options?.cells !== false;
      const packed = await page.evaluate(
        ({ id, grid, scrollback }) => window.__tuilens.snapshot(id, grid, scrollback),
        { id: frameId, grid: includeGrid, scrollback: options?.scrollback ?? 0 });
      return {
        frameId: packed.frameId,
        capturedAt: packed.capturedAt,
        cols: packed.cols,
        rows: packed.rows,
        text: packed.text,
        lines: packed.lines,
        cells: packed.grid ? unpackGrid(packed.grid, packed.cols, packed.rows) : [],
        cursor: packed.cursor,
        modes: packed.modes,
        ...(packed.scrollback ? { scrollback: packed.scrollback } : {}),
        ...(packed.scrollbackTruncated ? { scrollbackTruncated: true } : {}),
      };
    },
    screenshot,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        // 只释放本会话的页面与上下文；共享浏览器由宿主按引用计数管理。
        await page.evaluate(() => window.__tuilens.dispose());
      } finally {
        try { await page.context().close(); } catch { /* 页面或浏览器可能已崩溃。 */ }
        if (ownsHost) await host.shutdown();
        else host.release();
      }
    },
  };
}
