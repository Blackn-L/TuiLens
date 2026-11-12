export { SessionManager } from "./session/manager.js";
export { createBrowserEngine } from "./engine/browser-engine.js";
export { findText, regionFingerprint } from "./core/locator.js";
export { TuiLensError, errorRecord } from "./core/errors.js";
export { VERSION } from "./version.js";
export type * from "./core/types.js";
export type { SessionMetrics, OperationControl } from "./session/session.js";
export { compareImages } from "./visual/compare.js";
export { replayRecording } from "./recording/replay.js";
export { scenarioSchema } from "./scenario/schema.js";
export type { ReplayOptions, ReplayResult } from "./recording/replay.js";
export type { VisualOptions } from "./visual/artifacts.js";
// 面向测试代码的断言层：读取接近 playwright，失败携带期望/实际/截图。
export { Terminal, terminal, attach, TuiLensAssertionError } from "./testing/assertions.js";
export type { ExpectOptions, ScreenSnapshot } from "./testing/assertions.js";
export { renderJunit, escapeXml, failureOf } from "./testing/junit.js";
export type { JunitCase, JunitSuite } from "./testing/junit.js";
// 性能测试：场景、基线比较与进程树采样。
export { runPerf } from "./perf/runner.js";
export { summarize, percentile } from "./perf/stats.js";
export { perfSpecSchema } from "./perf/schema.js";
export type { BaselineFile, MetricComparison, PerfResult, PerfRunOptions } from "./perf/runner.js";
export type { PerfSpec } from "./perf/schema.js";
export { createBrowserEngineFactory } from "./engine/browser-engine.js";
