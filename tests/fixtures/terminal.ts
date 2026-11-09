/** 原生 PTY 测试夹具：公开协商模式并原样证明输入到达，避免只测模拟接口。 */
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("需要真实 PTY");
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H");
process.stdout.write("TUILENS_READY 中文 🚀 A⠀B\r\n\x1b[38;2;12;34;56mCOLOR\x1b[0m\r\n");
process.stdin.on("data", (data: Buffer) => {
  if (data.includes(0x11)) {
    process.stdout.write("\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[?1049l");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (data.toString().includes("PING")) process.stdout.write("\x1b[5;1HINPUT_RECEIVED");
});
process.stdout.on("resize", () => {
  process.stdout.write(`\x1b[7;1HSIZE_${process.stdout.columns}_${process.stdout.rows}     `);
});
process.stdin.resume();
