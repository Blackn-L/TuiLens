import { resolveLocale, type Locale } from "./i18n.js";
import { englishMessage } from "./error-catalog.js";

/** 协议层保留稳定错误码，诊断文字不拼接启动环境或凭据。 */
export class TuiLensError extends Error {
  readonly messageZh: string;
  readonly messageEn: string;

  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    messageEn = englishMessage(code),
  ) {
    super(message);
    this.name = "TuiLensError";
    this.messageZh = message;
    this.messageEn = messageEn;
  }
}

export interface ErrorRecord {
  code: string;
  message: string;
  messageEn: string;
  messageZh: string;
  details?: unknown;
}

/**
 * 对外错误结构。
 *
 * `message` follows the active locale, while `messageEn` and `messageZh` are
 * always present so callers can display either language without parsing codes.
 */
export function errorRecord(error: unknown, locale: Locale = resolveLocale()): ErrorRecord {
  if (error instanceof TuiLensError) {
    return {
      code: error.code,
      message: locale === "zh-CN" ? error.messageZh : error.messageEn,
      messageEn: error.messageEn,
      messageZh: error.messageZh,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL",
    message: locale === "zh-CN" ? reason : "An unexpected internal error occurred.",
    messageEn: "An unexpected internal error occurred.",
    messageZh: reason,
    details: { reason },
  };
}
