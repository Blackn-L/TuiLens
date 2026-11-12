import { chromium, type Browser } from "playwright";
import { TuiLensError } from "../core/errors.js";

/**
 * 跨会话共享的 Chromium 宿主。
 *
 * 每个会话只应拥有自己的浏览器上下文和页面；为每个会话启动独立浏览器进程
 * 会让启动耗时和内存成倍增长，并污染性能测量。这里按引用计数复用同一个
 * 浏览器进程，最后一个使用者释放时才真正关闭。
 */
export class BrowserHost {
  private browser: Browser | undefined;
  private pending: Promise<Browser> | undefined;
  private references = 0;
  private stopped = false;

  /**
   * @param executablePath 显式浏览器路径
   * @param keepAlive 为 true 时最后一个引用释放后仍保留浏览器，
   *   让后续会话复用已启动的进程；只有 shutdown 才真正关闭。
   */
  constructor(
    private readonly executablePath?: string,
    private readonly keepAlive = false,
  ) {}

  /** 取得共享浏览器并占用一个引用；调用方必须在引擎关闭时调用 release。 */
  async acquire(): Promise<Browser> {
    if (this.stopped) throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
    this.references += 1;
    try {
      return await this.handle();
    } catch (error) {
      this.references -= 1;
      this.dropIdle();
      throw error;
    }
  }

  /** 释放一个引用；归零时关闭浏览器，但允许之后再次 acquire。 */
  release(): void {
    this.references = Math.max(0, this.references - 1);
    this.dropIdle();
  }

  /** 永久停止：拒绝后续 acquire，并释放当前浏览器。 */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.references = 0;
    await this.dispose();
  }

  private dropIdle(): void {
    if (this.references === 0 && !this.keepAlive) void this.dispose();
  }

  private handle(): Promise<Browser> {
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);
    this.pending ??= this.launch().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async launch(): Promise<Browser> {
    const browser = await chromium.launch({
      headless: true,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
    });
    if (this.stopped) {
      await browser.close().catch(() => undefined);
      throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
    }
    this.browser = browser;
    // 崩溃后不保留失效句柄，下一次 acquire 会重新启动。
    browser.on("disconnected", () => {
      if (this.browser === browser) this.browser = undefined;
    });
    return browser;
  }

  private async dispose(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    // 等待正在进行的启动，避免关闭与新实例竞争。
    await this.pending?.catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
