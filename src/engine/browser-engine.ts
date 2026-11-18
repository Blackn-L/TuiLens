import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { TuiLensError } from "../core/errors.js";
import { readBoundedFile } from "../core/bounded-file.js";
import type {
  BrowserEngineOptions, EngineFactory, Region, RenderMetadata, RendererKind, TerminalEngine, TerminalSnapshot,
  TerminalState,
} from "../core/types.js";
import { BrowserHost } from "./browser-host.js";
import { initializeBrowserRuntime } from "./browser-runtime.js";
import { unpackGrid } from "./snapshot-codec.js";
import { Osc1337Normalizer } from "./osc1337.js";
import { installKittyRuntime } from "./kitty-runtime.js";
import { KITTY_DIACRITICS } from "./kitty-diacritics.js";
import { applyTerminalProfileOverrides, defaultTerminalProfile } from "../profiles/index.js";

const require = createRequire(import.meta.url);
// Windows Terminal 的 Cascadia Mono 来自私有字体集合，且不能假定它覆盖全部圈码；
// 先在 CJK 字体中寻找 16px 圈码，再用 MS PGothic/符号字体兜底，最后才允许 generic monospace。
const DEFAULT_FONT = "'Cascadia Mono','DejaVu Sans Mono','Noto Sans Mono CJK SC','Noto Sans CJK SC','Microsoft YaHei','Noto Sans SC','MS PGothic','Segoe UI Symbol','Apple Symbols','Segoe UI Emoji','Noto Color Emoji',monospace";
const EMBEDDED_FONT_FAMILY = "TuiLensEmbeddedFont";
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const FONT_FORMATS: Record<string, { mime: string; format: string }> = {
  ".ttf": { mime: "font/ttf", format: "truetype" },
  ".otf": { mime: "font/otf", format: "opentype" },
  ".woff": { mime: "font/woff", format: "woff" },
  ".woff2": { mime: "font/woff2", format: "woff2" },
};

interface EmbeddedFont {
  family: string;
  css: string;
  hash: string;
}

/**
 * 读取本地字体并编码为内联 FontFace。Chromium 看不到终端私有的字体集合，
 * 例如 Windows Terminal AppX 包内的 Cascadia Mono；显式字体文件是唯一可靠的固定方式。
 */
async function loadEmbeddedFont(fontFile: string): Promise<EmbeddedFont> {
  const extension = extname(fontFile).toLowerCase();
  const format = FONT_FORMATS[extension];
  if (!format) {
    throw new TuiLensError("INVALID_FONT_FILE", "字体文件格式必须是 .ttf、.otf、.woff 或 .woff2", {
      path: fontFile,
      extension,
    }, "The font file must use .ttf, .otf, .woff or .woff2.");
  }
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(fontFile, MAX_FONT_BYTES);
  } catch (error) {
    throw new TuiLensError("INVALID_FONT_FILE", "无法读取字体文件", {
      path: fontFile,
      reason: error instanceof Error ? error.message : String(error),
    }, "The font file could not be read.");
  }
  if (bytes.length === 0) {
    throw new TuiLensError("INVALID_FONT_FILE", "字体文件为空", { path: fontFile },
      "The font file is empty.");
  }
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const css = `@font-face{font-family:'${EMBEDDED_FONT_FAMILY}';`
    + `src:url("data:${format.mime};base64,${bytes.toString("base64")}") format('${format.format}');`
    + "font-display:block}";
  return { family: EMBEDDED_FONT_FAMILY, css, hash };
}

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

function renderMetadata(render: Omit<RenderMetadata, "fingerprint">): RenderMetadata {
  const { paintMs, ...stable } = render;
  const fingerprint = createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
  return { ...render, fingerprint };
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
  const renderer = options.renderer ?? "dom";
  if (renderer !== "dom" && renderer !== "webgl") {
    throw new TuiLensError("INVALID_ARGUMENT", "renderer 必须是 dom 或 webgl");
  }
  const profile = applyTerminalProfileOverrides(options.profile ?? defaultTerminalProfile(), {
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.graphics === undefined ? {} : { graphics: options.graphics }),
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
  });
  const graphics = {
    sixel: profile.capabilities.graphics?.sixel === true,
    kitty: profile.capabilities.graphics?.kitty === true,
    iterm: profile.capabilities.graphics?.iterm === true,
  };
  const scrollback = profile.capabilities.scrollback ?? 2000;
  if (!Number.isInteger(scrollback) || scrollback < 0 || scrollback > 5000) {
    throw new TuiLensError("INVALID_PROFILE", "profile scrollback 必须是 0～5000 的整数");
  }
  const iip = graphics.iterm ? new Osc1337Normalizer() : undefined;
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) {
    throw new TuiLensError("INVALID_FONT_SIZE", "字体大小必须在 8–48 像素范围内");
  }
  const embeddedFont = options.fontFile === undefined ? undefined : await loadEmbeddedFont(options.fontFile);
  const requestedFontFamily = options.fontFamily ?? DEFAULT_FONT;
  const fontFamily = embeddedFont ? `'${embeddedFont.family}',${requestedFontFamily}` : requestedFontFamily;
  const host = shared ?? new BrowserHost(resolveBrowserExecutable(options.executablePath));
  const ownsHost = shared === undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let closed = false;
  let crashed = false;
  let actualRenderer: RendererKind = "dom";
  try {
    browser = await host.acquire();
    context = await browser.newContext({
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
    if (embeddedFont) {
      await page.addStyleTag({ content: embeddedFont.css });
      try {
        const loaded = await page.evaluate(async ({ family, size }) => {
          const faces = await document.fonts.load(`${size}px "${family}"`);
          await document.fonts.ready;
          return faces.length > 0 && faces.every((face) => face.status === "loaded");
        }, { family: embeddedFont.family, size: fontSize });
        if (!loaded) throw new Error("FontFace was not loaded");
      } catch (error) {
        throw new TuiLensError("INVALID_FONT_FILE", "字体文件无法在浏览器中加载", {
          path: options.fontFile,
          reason: error instanceof Error ? error.message : String(error),
        }, "The font file could not be loaded in the browser.");
      }
    }
    await page.addScriptTag({ path: terminalModule });
    await page.addScriptTag({ path: addonModule });
    if (graphics.sixel || graphics.iterm) {
      await page.addScriptTag({ path: require.resolve("@xterm/addon-image") });
    }
    if (renderer === "webgl") {
      try {
        await page.addScriptTag({ path: require.resolve("@xterm/addon-webgl") });
      } catch {
        // 依赖缺失或脚本加载失败时由页面运行时回退 DOM，并回传实际 renderer。
      }
    }
    if (graphics.kitty) await page.evaluate(installKittyRuntime, KITTY_DIACRITICS);
    actualRenderer = await page.evaluate(initializeBrowserRuntime, {
      cols: options.cols,
      rows: options.rows,
      fontFamily,
      fontSize,
      ...(embeddedFont ? { fontHash: embeddedFont.hash } : {}),
      renderer,
      scrollback,
      graphics,
      ...(options.profile ? { replies: profile.replies } : {}),
      ...(options.profile && profile.capabilities.keyboard?.kitty !== undefined
        ? { keyboard: profile.capabilities.keyboard } : {}),
    });
    await resizeViewport();
  } catch (error) {
    // 字体解码等启动中途失败时，不能把已创建的页面留在共享浏览器里。
    try { await context?.close(); } catch { /* 浏览器或页面可能已崩溃。 */ }
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
        // 放在 settle 之后，避免重绘重新生成带光标类的节点。
        await setScreenshotCursorHidden(hideCursor);
        const png = await page.screenshot({ type: "png", animations: "disabled", caret: "initial", clip });
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (width === clip.width && height === clip.height) return { png, width, height };
      }
      throw new TuiLensError("ENGINE_FAILED", "截图尺寸与终端画布不一致");
    } finally {
      await setScreenshotCursorHidden(false).catch(() => undefined);
    }
  }

  /** xterm 把光标格字符画在 `.xterm-cursor` span 上；只隐藏该元素会连字符一起
   *  隐藏，露出终端底色。截图时摘掉光标类、保留 span 自身的字符与配色，截完恢复。 */
  async function setScreenshotCursorHidden(hidden: boolean): Promise<void> {
    await page.evaluate((hide) => {
      if (hide) {
        for (const element of document.querySelectorAll<HTMLElement>(".xterm-cursor")) {
          if (element.dataset.tuilensCursorClass === undefined) {
            element.dataset.tuilensCursorClass = element.className;
          }
          element.classList.remove("xterm-cursor");
        }
        return;
      }
      for (const element of document.querySelectorAll<HTMLElement>("[data-tuilens-cursor-class]")) {
        element.className = element.dataset.tuilensCursorClass ?? "";
        delete element.dataset.tuilensCursorClass;
      }
    }, hidden);
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
    async probeText(text, region, style) {
      assertOpen();
      await assertFrameReady();
      return page.evaluate((args) => window.__tuilens.probeText(args.text, args.region, args.style), {
        text, region, style,
      });
    },
    async glyphMetrics(texts) {
      assertOpen();
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > 64
        || texts.some((text) => typeof text !== "string" || text.length === 0 || text.length > 16)) {
        throw new TuiLensError("INVALID_ARGUMENT", "glyphMetrics 需要 1～64 个非空短字符串");
      }
      await settle();
      return page.evaluate((samples) => window.__tuilens.glyphMetrics(samples), texts);
    },
    async paint() {
      assertOpen();
      return page.evaluate(() => window.__tuilens.paint());
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
        ...(packed.render ? { render: renderMetadata(packed.render) } : {}),
        ...(packed.scrollback ? { scrollback: packed.scrollback } : {}),
        ...(packed.scrollbackTruncated ? { scrollbackTruncated: true } : {}),
      };
    },
    screenshot,
    renderer: actualRenderer,
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
