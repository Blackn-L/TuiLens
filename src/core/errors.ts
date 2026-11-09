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

export function errorRecord(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof TuiLensError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
