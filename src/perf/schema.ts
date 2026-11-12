import { z } from "zod";
import { conditionSchema, inputSchema, launchSchema, regionSchema } from "../core/protocol.js";
import { pick } from "../core/i18n.js";

const name = z.string().min(1).max(120);
const profiles = z.array(z.string().min(1).max(8192)).min(1).max(32)
  .refine((values) => new Set(values).size === values.length,
    pick("profiles must be unique", "profiles 不能重复"));

/**
 * 一次「输入 → 可见结果」的测量单元。
 *
 * 这是 TUI 应用最贴近用户感受的指标：发出输入到目标内容真正出现。
 * `observe` 与 `input` 一起构成一次采样；`timeoutMs` 只限制单次采样，
 * 超时会使整个性能运行失败，而不是把一个慢样本悄悄算成通过。
 */
export const sampleSchema = z.object({
  name: name.optional(),
  /** 发送的输入。 */
  input: inputSchema,
  /** 等待的可见证据；为空时只等待出现新帧。 */
  observe: z.array(conditionSchema).max(8).optional(),
  region: regionSchema.optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
}).strict();

/** 阶段内的准备动作；不计入采样，用于构造对话历史等前置状态。 */
export const setupStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), action: inputSchema }).strict(),
  z.object({ type: z.literal("wait"), conditions: z.array(conditionSchema).min(1).max(8),
    timeoutMs: z.number().int().min(1).max(300000).optional() }).strict(),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(250) }).strict(),
  // 历史增长的主要手段：重复发送输入并等待固定证据。
  z.object({ type: z.literal("repeat"), times: z.number().int().min(1).max(10000),
    input: inputSchema, observe: z.array(conditionSchema).max(8).optional(),
    timeoutMs: z.number().int().min(1).max(300000).optional() }).strict(),
]);

export const phaseSchema = z.object({
  name,
  /** 阶段开始前的准备动作；每个采样轮次都会重新执行一次。 */
  setup: z.array(setupStepSchema).max(64).optional(),
  /** 本阶段的测量单元。 */
  samples: z.array(sampleSchema).min(1).max(32),
}).strict();

export const perfSpecSchema = z.object({
  version: z.literal(1),
  launch: launchSchema,
  /** 同一工作负载依次在各 terminal profile 下运行并汇总为矩阵。 */
  profiles: profiles.optional(),
  /**
   * 启动后、开始准备前必须成立的条件。
   * 被测程序在进入 raw mode 前的输入会被吞掉，缺少就绪条件会让首轮采样假超时。
   */
  ready: z.array(conditionSchema).min(1).max(8).optional(),
  readyTimeoutMs: z.number().int().min(1).max(300000).optional(),
  /** 正式测量前额外执行的轮次，用于预热 JIT 与浏览器渲染。 */
  warmupRounds: z.number().int().min(0).max(20).optional(),
  /** 正式测量轮次；每个轮次都会重新启动被测程序。 */
  rounds: z.number().int().min(1).max(50).optional(),
  /** 每个采样在同一轮内重复几次；取中位数前全部保留。 */
  repeats: z.number().int().min(1).max(50).optional(),
  phases: z.array(phaseSchema).min(1).max(24),
  /** 缺省包含启动耗时与所有采样；关闭可减少噪声来源。 */
  measure: z.object({
    startup: z.boolean().optional(),
    processTree: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type PerfSpec = z.infer<typeof perfSpecSchema>;
export type PerfSample = z.infer<typeof sampleSchema>;
export type PerfPhase = z.infer<typeof phaseSchema>;
