// 性能场景示例：每次输入都会重绘整段对话历史。
// 用于演示「历史增长后响应是否劣化」的固定工作负载。
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this sample inside a terminal.");

process.stdin.setRawMode(true);
const write = (text) => process.stdout.write(text);
write("\x1b[?25l\x1b[?1049h\x1b[2J\x1b[H");

const messages = [];
const maxVisible = 18;

function render() {
  // 每次重绘都覆盖整个可视区，历史越长拼接成本越高。
  const lines = [];
  lines.push("\x1b[1;38;2;90;190;255mTuiLens perf fixture\x1b[0m");
  lines.push(`turns=${messages.length}  prompt=press x to add a turn`);
  lines.push("");
  const visible = messages.slice(-maxVisible);
  for (const message of visible) lines.push(message);
  while (lines.length < 22) lines.push("");
  const body = lines.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`).join("");
  write(`${body}\x1b[22;1HTURN_${messages.length}\x1b[K`);
}

render();
process.stdin.on("data", (chunk) => {
  const text = chunk.toString();
  if (text.includes("\x11")) {
    write("\x1b[?1049l\x1b[?25h");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (!text.includes("x")) return;
  messages.push(`message-${messages.length} 中文 payload 🚀 `.repeat(2));
  render();
});
process.stdin.resume();
