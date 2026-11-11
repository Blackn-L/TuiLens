import { TuiLensError } from "../core/errors.js";
import type {
  CursorState, InputAction, MatchStyle, Observation, Region, SessionInfo, WaitCondition,
} from "../core/types.js";
import type { SessionManager } from "../session/manager.js";

/** 断言失败携带期望、实际与证据路径，便于在测试框架里直接展示。 */
export class TuiLensAssertionError extends TuiLensError {
  constructor(
    code: string,
    message: string,
    public readonly assertion: {
      expected: string;
      actual: string;
      /** 失败时刻的截图路径；拿不到时为 undefined。 */
      artifact?: string;
      /** 失败时刻的画面文本，截断到便于阅读的长度。 */
      screen?: string;
    },
  ) {
    super(code, message, assertion);
    this.name = "TuiLensAssertionError";
  }
}

export interface ExpectOptions {
  /** 等待上限，默认 5000 ms。 */
  timeoutMs?: number;
  region?: Region;
  style?: MatchStyle;
}

export interface ScreenSnapshot {
  text: string;
  lines: string[];
  cols: number;
  rows: number;
  cursor: CursorState;
  frameId: number;
}

const SCREEN_EXCERPT_LINES = 24;
const SCREEN_EXCERPT_CHARS = 4000;

function excerpt(observation: Observation): string {
  const lines = observation.snapshot.lines.slice(0, SCREEN_EXCERPT_LINES);
  const text = lines.join("\n");
  return text.length > SCREEN_EXCERPT_CHARS ? `${text.slice(0, SCREEN_EXCERPT_CHARS)}…` : text;
}

/** 把毫秒渲染成人类可读的等待说明。 */
function waitedText(timeoutMs: number): string {
  return `${timeoutMs} ms 内未满足`;
}

/**
 * 面向测试代码的会话句柄。
 *
 * 与 `SessionManager` 的低层接口相比，这里只暴露「断言 → 失败即抛出」的写法，
 * 让 TUI 测试读起来接近 playwright：
 *
 * ```ts
 * const tui = await terminal(manager, { command: "my-tui" });
 * await tui.expectText("Ready");
 * await tui.type("hello");
 * await tui.expectNoText("Error", { timeoutMs: 500 });
 * ```
 */
export class Terminal {
  constructor(
    private readonly manager: SessionManager,
    readonly session: SessionInfo,
  ) {}

  get id(): string { return this.session.id; }

  /** 断言画面包含文本；支持区域与样式限定。 */
  async expectText(text: string, options: ExpectOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    try {
      await this.manager.wait(this.id, {
        conditions: [{
          kind: "text", text,
          ...(options.region ? { region: options.region } : {}),
          ...(options.style ? { style: options.style } : {}),
        }],
        timeoutMs,
      });
    } catch (error) {
      throw await this.fail("EXPECT_TEXT_FAILED",
        `期望画面包含 ${JSON.stringify(text)}，${waitedText(timeoutMs)}`,
        `包含 ${JSON.stringify(text)}`, "未找到", error);
    }
  }

  /**
   * 断言画面**不**包含文本。
   *
   * 这是否定断言：文本不存在随时成立，因此必须等待满整个窗口而不是立刻返回，
   * 否则「还没渲染出来」会被误判为通过。默认窗口为 1000 ms。
   */
  async expectNoText(text: string, options: ExpectOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 1000;
    const deadline = performance.now() + timeoutMs;
    let observed = "";
    while (performance.now() < deadline) {
      const observation = await this.manager.observe(this.id, { screenshot: false, cells: false });
      observed = observation.snapshot.text;
      const present = options.region
        ? observation.snapshot.lines
          .slice(options.region.y, options.region.y + options.region.height)
          .some((line) => line.includes(text))
        : observed.includes(text);
      if (present) {
        throw await this.fail("EXPECT_NO_TEXT_FAILED",
          `期望画面不包含 ${JSON.stringify(text)}，但已出现`,
          `不包含 ${JSON.stringify(text)}`, `包含 ${JSON.stringify(text)}`);
      }
      // 仅在剩余时间内继续观察；不为了凑满窗口而空转。
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
      }
    }
  }

  /** 断言光标位置或可见性。 */
  async expectCursor(
    expected: { x?: number; y?: number; visible?: boolean },
    options: ExpectOptions = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    try {
      await this.manager.wait(this.id, {
        conditions: [{
          kind: "cursor",
          ...(expected.x === undefined ? {} : { x: expected.x }),
          ...(expected.y === undefined ? {} : { y: expected.y }),
          ...(expected.visible === undefined ? {} : { visible: expected.visible }),
        }],
        timeoutMs,
      });
    } catch (error) {
      const observation = await this.manager.observe(this.id, { screenshot: false, cells: false })
        .catch(() => undefined);
      throw await this.fail("EXPECT_CURSOR_FAILED",
        `期望光标满足 ${JSON.stringify(expected)}，${waitedText(timeoutMs)}`,
        JSON.stringify(expected),
        observation ? JSON.stringify(observation.snapshot.cursor) : "不可用", error);
    }
  }

  /** 断言终端网格尺寸。resize 之后应用重排仍需单独等待可见条件。 */
  async expectSize(cols: number, rows: number, options: ExpectOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    try {
      await this.manager.wait(this.id, {
        conditions: [{ kind: "size", cols, rows }],
        timeoutMs,
      });
    } catch (error) {
      const observation = await this.manager.observe(this.id, { screenshot: false, cells: false })
        .catch(() => undefined);
      throw await this.fail("EXPECT_SIZE_FAILED",
        `期望终端尺寸为 ${cols}×${rows}，${waitedText(timeoutMs)}`,
        `${cols}×${rows}`,
        observation ? `${observation.snapshot.cols}×${observation.snapshot.rows}` : "不可用", error);
    }
  }

  /** 截图并返回路径，供测试框架归档。 */
  async screenshot(options: { region?: Region } = {}): Promise<string | undefined> {
    const observation = await this.manager.observe(this.id, {
      cells: false,
      ...(options.region ? { region: options.region } : {}),
    });
    return observation.screenshot?.path;
  }

  /** 当前画面（文本、行、光标），不截图也不返回字符网格。 */
  async screen(): Promise<ScreenSnapshot> {
    const observation = await this.manager.observe(this.id, { screenshot: false, cells: false });
    return {
      text: observation.snapshot.text,
      lines: observation.snapshot.lines,
      cols: observation.snapshot.cols,
      rows: observation.snapshot.rows,
      cursor: observation.snapshot.cursor,
      frameId: observation.snapshot.frameId,
    };
  }

  input(action: InputAction, guard?: Parameters<SessionManager["input"]>[2]) {
    return this.manager.input(this.id, action, guard);
  }

  type(text: string) { return this.input({ type: "text", text }); }

  typeAndWait(text: string, conditions: WaitCondition[], timeoutMs = 10_000) {
    return this.manager.inputAndWait(this.id, { type: "text", text }, undefined, { conditions, timeoutMs });
  }

  key(key: string) { return this.input({ type: "key", key }); }

  click(x: number, y: number) { return this.input({ type: "click", x, y }); }

  clickText(text: string, options?: Parameters<SessionManager["clickText"]>[3]) {
    return this.manager.clickText(this.id, text, undefined, options);
  }

  resize(cols: number, rows: number) { return this.manager.resize(this.id, cols, rows); }

  close() { return this.manager.close(this.id); }

  /**
   * 组装断言失败。尽量附带失败时刻的截图，
   * 但证据采集本身失败时不能掩盖原始断言结果。
   */
  private async fail(code: string, message: string, expected: string, actual: string,
    cause?: unknown): Promise<TuiLensAssertionError> {
    let artifact: string | undefined;
    let screen: string | undefined;
    try {
      const observation = await this.manager.observe(this.id, { cells: false }, { timeoutMs: 2000 });
      artifact = observation.screenshot?.path;
      screen = excerpt(observation);
    } catch {
      if (cause instanceof TuiLensError && cause.code === "SESSION_NOT_FOUND") {
        return new TuiLensAssertionError(code, message, { expected, actual });
      }
    }
    return new TuiLensAssertionError(code, message, {
      expected, actual,
      ...(artifact ? { artifact } : {}),
      ...(screen === undefined ? {} : { screen }),
    });
  }
}

/** 启动被测程序并返回断言句柄；调用方负责 close 或 closeAll。 */
export async function terminal(manager: SessionManager, options: Parameters<SessionManager["launch"]>[0]): Promise<Terminal> {
  return new Terminal(manager, await manager.launch(options));
}

/** 用已有会话包装成断言句柄，便于与既有 ID 流程混用。 */
export function attach(manager: SessionManager, session: SessionInfo): Terminal {
  return new Terminal(manager, session);
}
