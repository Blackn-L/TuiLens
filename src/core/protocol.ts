import { z } from "zod";
import { pick } from "./i18n.js";

const dimension = z.number().int().min(2).max(500);
const coordinate = z.number().int().min(0).max(499);
const modifiers = z.object({ shift: z.boolean().optional(), alt: z.boolean().optional(), ctrl: z.boolean().optional() }).strict();
const button = z.enum(["left", "middle", "right"]);
const scrollSchema = z.object({
  type: z.literal("scroll"), x: coordinate, y: coordinate,
  direction: z.enum(["up", "down"]).optional(), unit: z.enum(["line", "page"]).optional(),
  amount: z.number().int().min(1).max(100).optional(), to: z.enum(["top", "bottom"]).optional(),
  modifiers: modifiers.optional(),
}).strict().superRefine((action, context) => {
  const conflicts = action.to !== undefined
    && (action.direction !== undefined || action.unit !== undefined || action.amount !== undefined);
  if (action.to === undefined && action.direction === undefined || conflicts) {
    context.addIssue({ code: "custom", message: pick(
      "Scroll requires direction, or only the to:top/bottom endpoint.",
      "滚动需要 direction，或仅使用 to:top/bottom",
    ) });
  }
});
const cursorCondition = z.object({
  x: coordinate.optional(),
  y: z.number().int().min(0).max(249).optional(),
  visible: z.boolean().optional(),
  style: z.enum(["block", "underline", "bar"]).optional(),
  blink: z.boolean().optional(),
}).strict();
export const regionSchema = z.object({
  x: coordinate, y: coordinate, width: z.number().int().min(1).max(500), height: z.number().int().min(1).max(250),
}).strict();
export const graphicsSchema = z.object({
  sixel: z.boolean().optional(),
  kitty: z.boolean().optional(),
  iterm: z.boolean().optional(),
}).strict();
export const launchSchema = z.object({
  command: z.string().min(1).max(8192),
  args: z.array(z.string().max(65536)).max(256).optional(),
  cwd: z.string().min(1).max(8192).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: dimension.optional(),
  rows: z.number().int().min(2).max(250).optional(),
  colorMode: z.enum(["truecolor", "ansi256", "none"]).optional(),
  images: z.enum(["off", "sixel", "iterm", "all"]).optional(),
  graphics: graphicsSchema.optional(),
  terminalProfile: z.string().min(1).max(8192).optional(),
  recording: z.object({ maxBytes: z.number().int().min(4096).max(64 * 1024 * 1024).optional() }).strict().optional(),
  protocolReplies: z.object({
    mode: z.enum(["auto", "forward", "suppress"]).optional(),
    maxLatencyMs: z.number().int().min(0).max(5000).optional(),
  }).strict().optional(),
}).strict();
const text = z.string().max(256 * 1024);
export const styleSchema = z.object({
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
}).strict();
export const matchOptionsSchema = z.object({
  style: styleSchema.optional(), selection: z.enum(["all", "unique", "first", "last"]).optional(),
  nth: z.number().int().min(0).max(125000).optional(),
}).strict();
export const clickTextOptionsSchema = matchOptionsSchema.extend({
  allowPendingFrame: z.boolean().optional(),
  hitbox: z.object({
    left: z.number().int().min(0).max(500).optional(),
    right: z.number().int().min(0).max(500).optional(),
    top: z.number().int().min(0).max(250).optional(),
    bottom: z.number().int().min(0).max(250).optional(),
  }).strict().optional(),
  point: z.enum(["center", "left", "right", "top", "bottom"]).optional(),
  offset: z.object({
    x: z.number().int().min(-500).max(500).optional(),
    y: z.number().int().min(-250).max(250).optional(),
  }).strict().optional(),
  button: button.optional(),
  modifiers: modifiers.optional(),
}).strict();
export const visualOptionsSchema = z.object({
  baseline: z.string().min(1).max(8192), region: regionSchema.optional(),
  pixelThreshold: z.number().int().min(0).max(255).optional(), maxDiffRatio: z.number().min(0).max(1).optional(),
  cursor: z.enum(["hide", "show"]).optional(),
  masks: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0),
    width: z.number().int().min(1), height: z.number().int().min(1).max(250) }).strict()).max(256).optional(),
}).strict();
const guardSchema = z.object({
  frameId: z.number().int().min(0).optional(),
  region: z.object({ bounds: regionSchema, fingerprint: z.string().min(1).max(32 * 1024 * 1024) }).strict().optional(),
}).strict();
export const inputSchema = z.union([
  z.object({ type: z.literal("text"), text }).strict(),
  z.object({ type: z.literal("paste"), text }).strict(),
  z.object({ type: z.literal("raw"), data: text }).strict(),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal("click"), x: coordinate, y: coordinate,
    button: button.optional(), modifiers: modifiers.optional() }).strict(),
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate, modifiers: modifiers.optional() }).strict(),
  z.object({ type: z.literal("mouseDown"), x: coordinate, y: coordinate, button: button.optional(), modifiers: modifiers.optional() }).strict(),
  z.object({ type: z.literal("mouseUp"), x: coordinate, y: coordinate, button: button.optional(), modifiers: modifiers.optional() }).strict(),
  z.object({ type: z.literal("drag"), from: z.object({ x: coordinate, y: coordinate }).strict(),
    to: z.object({ x: coordinate, y: coordinate }).strict(), steps: z.number().int().min(1).max(100).optional(),
    button: button.optional(), modifiers: modifiers.optional() }).strict(),
  scrollSchema,
]);
export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: text.min(1), region: regionSchema.optional(), absent: z.boolean().optional(),
    style: styleSchema.optional(), count: z.number().int().min(0).max(125000).optional() }).strict(),
  z.object({ kind: z.literal("stable"), region: regionSchema.optional(), durationMs: z.number().int().min(50).max(10000).optional() }).strict(),
  z.object({ kind: z.literal("size"), cols: dimension, rows: z.number().int().min(2).max(250) }).strict(),
  z.object({ kind: z.literal("exited") }).strict(),
  cursorCondition.extend({ kind: z.literal("cursor") }).strict().refine(
    (value) => Object.entries(value).some(([key, field]) => key !== "kind" && field !== undefined),
    { message: pick("A cursor condition requires at least one field.", "cursor 条件至少需要一个字段") },
  ),
]);
const inputWaitSchema = z.object({
  conditions: z.array(conditionSchema).max(16).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
}).strict();
export const idSchema = z.string().uuid();
export const methodSchemas = {
  ping: z.object({}).strict(),
  launch: launchSchema,
  list: z.object({}).strict(),
  metrics: z.object({ id: idSchema }).strict(),
  find: z.object({ id: idSchema, text: text.min(1), region: regionSchema.optional(), options: matchOptionsSchema.optional() }).strict(),
  clickText: z.object({ id: idSchema, text: text.min(1), region: regionSchema.optional(), options: clickTextOptionsSchema.optional() }).strict(),
  observe: z.object({ id: idSchema, screenshot: z.boolean().optional(), includeCells: z.boolean().optional(),
    region: regionSchema.optional(), scrollback: z.number().int().min(1).max(5000).optional(),
    cursor: z.enum(["hide", "show"]).optional() }).strict(),
  compare: z.object({ id: idSchema, options: visualOptionsSchema }).strict(),
  input: z.object({ id: idSchema, action: inputSchema, guard: guardSchema.optional() }).strict(),
  inputAndWait: z.object({ id: idSchema, action: inputSchema, guard: guardSchema.optional(),
    wait: inputWaitSchema.optional(), screenshot: z.boolean().optional() }).strict(),
  resize: z.object({ id: idSchema, cols: dimension, rows: z.number().int().min(2).max(250) }).strict(),
  wait: z.object({ id: idSchema, conditions: z.array(conditionSchema).min(1).max(16),
    timeoutMs: z.number().int().min(1).max(300000).optional(), afterFrameId: z.number().int().min(0).optional() }).strict(),
  replay: z.object({ path: z.string().min(1).max(8192), speed: z.number().min(0).max(100).optional(), allowTruncated: z.boolean().optional() }).strict(),
  perf: z.object({
    specification: z.unknown(),
    baseline: z.string().min(1).max(8192).optional(),
    writeBaseline: z.string().min(1).max(8192).optional(),
    maxRegression: z.number().min(0).max(10).optional(),
    allowEnvironmentMismatch: z.boolean().optional(),
  }).strict(),
  scenario: z.object({ specification: z.unknown() }).strict(),
  close: z.object({ id: idSchema }).strict(),
  shutdown: z.object({}).strict(),
};
export type Method = keyof typeof methodSchemas;
