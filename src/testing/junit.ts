/**
 * JUnit XML 输出，供 CI（GitHub Actions、Jenkins、GitLab 等）直接解析。
 *
 * 只实现测试报告实际需要的子集：testsuite / testcase / failure / skipped / system-out。
 * 数值与文本都做 XML 转义；控制字符会被移除，否则 XML 解析器会拒绝整份报告
 * （终端输出里经常包含 ESC 之外的非法控制码）。
 */

export interface JunitCase {
  name: string;
  /** 毫秒。 */
  timeMs: number;
  className?: string;
  failure?: { message: string; type?: string; details?: string };
  skipped?: { message?: string };
  /** 附加输出，例如截图路径与错误码。 */
  output?: string;
}

export interface JunitSuite {
  name: string;
  cases: JunitCase[];
  /** 套件级失败（例如启动失败），不计入 case 数但必须可见。 */
  error?: { message: string; type?: string };
}

const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu;

export function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

export function renderJunit(suites: JunitSuite[]): string {
  const lines: string[] = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>"];
  const totalTests = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
  const totalFailures = suites.reduce(
    (sum, suite) => sum + suite.cases.filter((item) => item.failure).length, 0);
  const totalSkipped = suites.reduce(
    (sum, suite) => sum + suite.cases.filter((item) => item.skipped).length, 0);
  const totalTime = suites.reduce(
    (sum, suite) => sum + suite.cases.reduce((inner, item) => inner + item.timeMs, 0), 0);
  lines.push(`<testsuites name="tuilens" tests="${totalTests}" failures="${totalFailures}"`
    + ` skipped="${totalSkipped}" time="${seconds(totalTime)}">`);
  for (const suite of suites) {
    const failures = suite.cases.filter((item) => item.failure).length;
    const skipped = suite.cases.filter((item) => item.skipped).length;
    const time = suite.cases.reduce((sum, item) => sum + item.timeMs, 0);
    lines.push(`  <testsuite name="${escapeXml(suite.name)}" tests="${suite.cases.length}"`
      + ` failures="${failures}" skipped="${skipped}" time="${seconds(time)}"`
      + `${suite.error ? ` errors="1"` : ""}>`);
    if (suite.error) {
      lines.push(`    <error message="${escapeXml(suite.error.message)}"`
        + `${suite.error.type ? ` type="${escapeXml(suite.error.type)}"` : ""}/>`);
    }
    for (const item of suite.cases) {
      const className = item.className ? ` classname="${escapeXml(item.className)}"` : "";
      lines.push(`    <testcase name="${escapeXml(item.name)}"${className} time="${seconds(item.timeMs)}">`);
      if (item.failure) {
        lines.push(`      <failure message="${escapeXml(item.failure.message)}"`
          + `${item.failure.type ? ` type="${escapeXml(item.failure.type)}"` : ""}>`
          + `${escapeXml(item.failure.details ?? "")}</failure>`);
      }
      if (item.skipped) {
        lines.push(`      <skipped${item.skipped.message ? ` message="${escapeXml(item.skipped.message)}"` : ""}/>`);
      }
      if (item.output) lines.push(`      <system-out>${escapeXml(item.output)}</system-out>`);
      lines.push("    </testcase>");
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return `${lines.join("\n")}\n`;
}

/**
 * 把一个失败对象转成 JUnit 可读的三元组。
 *
 * TuiLens 的断言错误带有期望/实际/截图；这些信息进入 `<failure>` 正文，
 * 在 CI 页面上比只看到 message 有用得多。
 */
export function failureOf(error: unknown): { message: string; type?: string; details?: string } {
  if (error && typeof error === "object") {
    const value = error as {
      name?: unknown; code?: unknown; message?: unknown; stack?: unknown;
      assertion?: { expected?: unknown; actual?: unknown; artifact?: unknown; screen?: unknown };
    };
    const message = typeof value.message === "string" ? value.message : String(error);
    const parts: string[] = [];
    if (value.assertion) {
      if (value.assertion.expected !== undefined) parts.push(`expected: ${String(value.assertion.expected)}`);
      if (value.assertion.actual !== undefined) parts.push(`actual:   ${String(value.assertion.actual)}`);
      if (value.assertion.artifact !== undefined) parts.push(`screenshot: ${String(value.assertion.artifact)}`);
      if (value.assertion.screen !== undefined) parts.push(`screen:\n${String(value.assertion.screen)}`);
    }
    if (typeof value.stack === "string") parts.push(value.stack);
    return {
      message,
      ...(typeof value.name === "string" ? { type: value.name } : {}),
      ...(parts.length ? { details: parts.join("\n") } : {}),
    };
  }
  return { message: String(error) };
}
