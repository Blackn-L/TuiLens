import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { terminal, TuiLensAssertionError } from "../src/testing/assertions.js";
import { escapeXml, failureOf, renderJunit } from "../src/testing/junit.js";

const fixture = ["-e", String.raw`
process.stdin.setRawMode(true);
process.stdout.write("\x1b[2J\x1b[HREADY\r\n");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString();
  if (text.includes("E")) process.stdout.write("\x1b[3;1HERROR_STATE");
  if (text.includes("Q")) process.exit(0);
});
process.stdin.resume();
`];

test("断言句柄提供可读期望与实际，并附失败截图", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-assert-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const tui = await terminal(manager, { command: process.execPath, args: fixture, cols: 40, rows: 8 });
    await tui.expectText("READY");
    await tui.expectSize(40, 8);
    await tui.expectNoText("ERROR_STATE");
    const screen = await tui.screen();
    assert.equal(screen.rows, 8);
    assert.match(screen.text, /READY/u);
    assert.ok(await tui.screenshot());

    await assert.rejects(tui.expectText("NEVER_THERE", { timeoutMs: 300 }), (error: unknown) => {
      assert.ok(error instanceof TuiLensAssertionError);
      assert.equal(error.code, "EXPECT_TEXT_FAILED");
      assert.match(error.assertion.expected, /NEVER_THERE/u);
      assert.match(error.assertion.actual, /not found/u);
      // 失败证据必须真实存在，而不是只写一个路径。
      assert.ok(error.assertion.artifact);
      assert.match(error.assertion.screen ?? "", /READY/u);
      return true;
    });

    // 否定断言必须等满窗口：刚发出输入时 ERROR 还没渲染，不能立刻判定通过。
    await tui.type("E");
    await assert.rejects(tui.expectNoText("ERROR_STATE", { timeoutMs: 2000 }),
      (error: unknown) => error instanceof TuiLensAssertionError && error.code === "EXPECT_NO_TEXT_FAILED");
    await tui.key("Q");
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test("JUnit 输出转义 XML 并去掉非法控制字符", () => {
  assert.equal(escapeXml("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
  // ESC 等控制字符会让解析器拒绝整份报告。
  assert.equal(escapeXml("a\u001b[31mb\u0001"), "a[31mb");
  const xml = renderJunit([{
    name: "suite&1",
    cases: [
      { name: "passes", timeMs: 12, output: "screenshot: <path>" },
      { name: "fails", timeMs: 34, failure: { message: "期望 <READY>", type: "TuiLensAssertionError",
        details: "expected: A\nactual:   B" } },
      { name: "skips", timeMs: 0, skipped: { message: "not on this platform" } },
    ],
  }]);
  assert.match(xml, /<testsuites name="tuilens" tests="3" failures="1" skipped="1"/u);
  assert.match(xml, /<testsuite name="suite&amp;1"/u);
  assert.match(xml, /<failure message="期望 &lt;READY&gt;"/u);
  assert.match(xml, /<skipped message="not on this platform"\/>/u);
  assert.match(xml, /<system-out>screenshot: &lt;path&gt;<\/system-out>/u);
  assert.ok(xml.endsWith("</testsuites>\n"));
});

test("失败信息包含期望、实际与截图路径", () => {
  const error = new TuiLensAssertionError("EXPECT_TEXT_FAILED", "未找到", {
    expected: "READY", actual: "未找到", artifact: "/tmp/a.png", screen: "line1\nline2",
  });
  const failure = failureOf(error);
  assert.equal(failure.type, "TuiLensAssertionError");
  assert.match(failure.details ?? "", /expected: READY/u);
  assert.match(failure.details ?? "", /screenshot: \/tmp\/a\.png/u);
  assert.match(failure.details ?? "", /screen:\nline1/u);
  assert.equal(failureOf("plain").message, "plain");
});
