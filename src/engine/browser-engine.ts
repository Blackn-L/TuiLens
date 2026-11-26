import type {
  BrowserEngineOptions,
  EngineFactory,
  RendererKind,
  TerminalEngine,
  TerminalSnapshot,
} from "../core/types.js";
import { TuiLensError } from "../core/errors.js";
import { HeadlessTerminalCore } from "./headless-core.js";
import { createVisualEngineFactory, LazyVisualRenderer, resolveBrowserExecutable } from "./visual-renderer.js";
import { applyTerminalProfileOverrides, defaultTerminalProfile } from "../profiles/index.js";

export { resolveBrowserExecutable } from "./visual-renderer.js";

function assertDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) {
    throw new TuiLensError("INVALID_SIZE", "终端尺寸必须为 2–500 列、2–250 行的整数");
  }
}

function assertRenderer(renderer: unknown): asserts renderer is RendererKind | undefined {
  if (renderer !== undefined && renderer !== "headless" && renderer !== "dom" && renderer !== "webgl") {
    throw new TuiLensError("INVALID_ARGUMENT", "renderer 必须是 headless、dom 或 webgl");
  }
}

export interface VisualEngineFactory {
  (options: BrowserEngineOptions): Promise<TerminalEngine>;
  shutdown(): Promise<void>;
}

function graphicsEnabled(options: BrowserEngineOptions): boolean {
  const graphics = options.profile?.capabilities.graphics;
  return graphics?.sixel === true || graphics?.kitty === true || graphics?.iterm === true;
}

/** 标准终端应答由 TerminalCore 唯一负责；视觉层只回传它独有的 Kitty 图形应答。 */
function isVisualOnlyReply(data: string): boolean {
  // 像素/字符尺寸报告依赖实际字体测量，headless 核心无法生成；其余标准应答由核心负责。
  return data.startsWith("\x1b_G") || /^\x1b\[(?:4|6|8|9);[0-9]+;[0-9]+t$/u.test(data);
}

async function createEngine(
  options: BrowserEngineOptions,
  visualFactory: VisualEngineFactory,
  shutdownOnClose = false
): Promise<TerminalEngine> {
  assertDimensions(options.cols, options.rows);
  assertRenderer(options.renderer);
  const profile = applyTerminalProfileOverrides(options.profile ?? defaultTerminalProfile(), {
    ...(options.graphics === undefined ? {} : { graphics: options.graphics }),
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
  });
  const core = new HeadlessTerminalCore({
    cols: options.cols,
    rows: options.rows,
    onData: options.onData,
    profile,
    ...(options.maxVisualReplayBytes === undefined ? {} : { maxVisualReplayBytes: options.maxVisualReplayBytes }),
  });
  let currentCols = options.cols;
  let currentRows = options.rows;
  const visualOptions: BrowserEngineOptions = {
    ...options,
    cols: options.cols,
    rows: options.rows,
    profile,
    onData: (data) => {
      if (isVisualOnlyReply(data)) options.onData(data);
    },
  };
  const visual = new LazyVisualRenderer(
    visualOptions,
    (engine) => core.replayTo(engine, { cols: currentCols, rows: currentRows }),
    visualFactory
  );
  const activateVisual = async (): Promise<TerminalEngine> => {
    const active = await visual.activate(currentCols, currentRows);
    core.disableReplayBuffer();
    return active;
  };
  const eager = options.renderer === "dom" || options.renderer === "webgl" || graphicsEnabled({ ...options, profile });
  if (eager) await activateVisual();
  let closed = false;

  const currentRenderer = (): RendererKind => visual.renderer ?? "headless";

  const engine: TerminalEngine = {
    get renderer() {
      return currentRenderer();
    },
    get visualSyncDegraded() {
      return visual.visualSyncDegraded;
    },
    async write(data): Promise<void> {
      if (closed) throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
      await core.write(data);
      const active = visual.active;
      if (active) await active.write(data);
    },
    async resize(cols, rows): Promise<void> {
      if (closed) throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
      await core.resize(cols, rows);
      currentCols = cols;
      currentRows = rows;
      const active = visual.active;
      if (active) await active.resize(cols, rows);
    },
    state: async () => core.state(),
    hasText: async (text) => core.hasText(text),
    probeText: async (text, region, style) => core.probeText(text, region, style),
    async glyphMetrics(texts) {
      const active = await activateVisual();
      if (!active.glyphMetrics) return [];
      return active.glyphMetrics(texts);
    },
    async paint() {
      const active = await activateVisual();
      return active.paint ? active.paint() : { paintMs: 0 };
    },
    async snapshot(frameId, frame = {}): Promise<TerminalSnapshot> {
      if (frame.allowPendingFrame !== true && core.state().modes.synchronizedOutput) {
        throw new TuiLensError("FRAME_PENDING", "应用的同步输出帧尚未结束");
      }
      // TerminalCore 是唯一文本/字符格事实源。浏览器激活后只补充绘制元数据，
      // 不能切换快照实现，否则同一区域在懒加载前后会产生不同指纹。
      const snapshot = core.snapshot(frameId, frame);
      const active = visual.active;
      if (active) {
        const rendered = await active.snapshot(frameId, {
          cells: false,
          allowPendingFrame: true,
        });
        if (rendered.render) snapshot.render = rendered.render;
      }
      return snapshot;
    },
    async screenshot(region, screenshotOptions) {
      const active = await activateVisual();
      return active.screenshot(region, screenshotOptions);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([core.close(), visual.close()]);
      if (shutdownOnClose) await visualFactory.shutdown();
    },
  };
  return engine;
}

export async function createBrowserEngine(
  options: BrowserEngineOptions,
  injectedVisualFactory?: VisualEngineFactory
): Promise<TerminalEngine> {
  assertDimensions(options.cols, options.rows);
  assertRenderer(options.renderer);
  const visualFactory =
    injectedVisualFactory ?? (createVisualEngineFactory(options.executablePath) as VisualEngineFactory);
  try {
    return await createEngine(options, visualFactory, injectedVisualFactory === undefined);
  } catch (error) {
    if (!injectedVisualFactory) await visualFactory.shutdown().catch(() => undefined);
    throw error;
  }
}

/**
 * 会话工厂共享一个按需启动的浏览器宿主。纯文本会话只创建 TerminalCore；
 * 任意会话首次截图/视觉比较时才会真正启动 Chromium。
 */
export function createBrowserEngineFactory(executablePath?: string) {
  const visualFactory = createVisualEngineFactory(executablePath) as VisualEngineFactory;
  let stopped = false;
  const factory = ((options: BrowserEngineOptions) => {
    if (stopped) return Promise.reject(new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭"));
    return createEngine(options, visualFactory);
  }) as EngineFactory & {
    shutdown(): Promise<void>;
  };
  factory.shutdown = async () => {
    stopped = true;
    await visualFactory.shutdown();
  };
  return factory;
}
