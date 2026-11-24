import { z } from "zod";

export const IPC_VERSION = 2;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_INFLIGHT_PER_CONNECTION = 64;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_SERVER_FRAME_BYTES = 64 * 1024 * 1024;

const tokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9a-f]+$/iu);
const requestIdSchema = z.string().uuid();

export const authFrameSchema = z
  .object({
    type: z.literal("auth"),
    version: z.literal(IPC_VERSION),
    token: tokenSchema,
  })
  .strict();

export const requestFrameSchema = z
  .object({
    type: z.literal("req"),
    id: requestIdSchema,
    method: z.string().min(1).max(128),
    params: z.unknown(),
    stream: z.boolean().optional(),
  })
  .strict();

export const cancelFrameSchema = z
  .object({
    type: z.literal("cancel"),
    id: requestIdSchema,
  })
  .strict();

export const clientFrameSchema = z.discriminatedUnion("type", [authFrameSchema, requestFrameSchema, cancelFrameSchema]);

export type AuthFrame = z.infer<typeof authFrameSchema>;
export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type CancelFrame = z.infer<typeof cancelFrameSchema>;
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export type IpcEventName = "progress" | "frame" | "exit";

export interface AuthOkFrame {
  type: "auth_ok";
  version: typeof IPC_VERSION;
  daemonPid: number;
  daemonVersion: string;
}

export interface AuthErrorFrame {
  type: "auth_error";
  error: {
    code: string;
    message: string;
    messageEn: string;
    messageZh: string;
    details?: unknown;
  };
}

export interface IpcEventFrame {
  type: "event";
  id: string;
  event: IpcEventName;
  data: unknown;
}

export interface IpcResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: AuthErrorFrame["error"] | undefined;
}

export type ServerFrame = AuthOkFrame | AuthErrorFrame | IpcEventFrame | IpcResponseFrame;

const errorFrameSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    messageEn: z.string(),
    messageZh: z.string(),
    details: z.unknown().optional(),
  })
  .strict();

export const serverFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("auth_ok"),
      version: z.literal(IPC_VERSION),
      daemonPid: z.number().int().positive(),
      daemonVersion: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("auth_error"), error: errorFrameSchema }).strict(),
  z
    .object({
      type: z.literal("event"),
      id: requestIdSchema,
      event: z.enum(["progress", "frame", "exit"]),
      data: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("res"),
      id: requestIdSchema,
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: errorFrameSchema.optional(),
    })
    .strict(),
]);

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
