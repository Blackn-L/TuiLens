/** 协议层保留稳定错误码，诊断文字不拼接启动环境或凭据。 */
export class TuiLensError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TuiLensError";
  }
}

import { englishMessage } from "./error-catalog.js";

/**
 * 对外错误结构。
 *
 * `message` 保留原始诊断文本，`messageEn` 是按错误码查表的英文说明，
 * 让非中文调用方至少能得到一句可读解释而不必解析错误码。
 */
export function errorRecord(error: unknown): {
  code: string; message: string; messageEn: string; details?: unknown;
} {
  if (error instanceof TuiLensError) {
    return {
      code: error.code,
      message: error.message,
      messageEn: englishMessage(error.code),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    messageEn: "An unexpected internal error occurred.",
  };
}
