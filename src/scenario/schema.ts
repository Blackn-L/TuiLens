import { z } from "zod";
import {
  clickTextOptionsSchema, conditionSchema, inputSchema, launchSchema, regionSchema, visualOptionsSchema,
} from "../core/protocol.js";

const name = z.string().min(1).max(120);
export const scenarioSchema = z.object({
  version: z.literal(1),
  launch: launchSchema,
  steps: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("input"), name: name.optional(), action: inputSchema }).strict(),
    z.object({ type: z.literal("resize"), name: name.optional(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(250) }).strict(),
    z.object({ type: z.literal("wait"), name: name.optional(), conditions: z.array(conditionSchema).min(1).max(16),
      timeoutMs: z.number().int().min(1).max(300000).optional() }).strict(),
    z.object({ type: z.literal("observe"), name: name.optional(), region: regionSchema.optional(),
      cursor: z.enum(["hide", "show"]).optional() }).strict(),
    z.object({ type: z.literal("clickText"), name: name.optional(), text: z.string().min(1).max(4096),
      region: regionSchema.optional(), options: clickTextOptionsSchema.optional() }).strict(),
    z.object({ type: z.literal("compare"), name: name.optional(), options: visualOptionsSchema }).strict(),
  ])).min(1).max(500),
}).strict();
export type ScenarioSpec = z.infer<typeof scenarioSchema>;
