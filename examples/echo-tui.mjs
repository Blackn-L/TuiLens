// Standalone terminal sample used by the quick start and declarative scenario.
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this sample inside a terminal.");
process.stdin.setRawMode(true);
const write = (text) => process.stdout.write(text);
write("\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H");
write("\x1b[1;38;2;90;190;255mTuiLens\x1b[0m   Terminal automation playground\r\n\r\n");
write("\x1b[42;30m Run \x1b[0m    \x1b[44;97m Capture \x1b[0m\r\n\r\n");
write("READY  |  Unicode: 中文  🚀  ✅  |  Blank cell: A⠀B\r\n\r\n");
write("Type g to update. Drag anywhere. Ctrl+Q to exit.\r\n");
let dragging = false;
process.stdin.on("data", (chunk) => {
  const text = chunk.toString();
  if (text.includes("\x11")) {
    write("\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[10;1HEXIT_OK\r\n\x1b[?25h");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (text === "g") write("\x1b[8;1H\x1b[32mUPDATED\x1b[0m");
  if (text.includes("\x1b[200~")) write("\x1b[9;1HPASTE_RECEIVED");
  if (/\x1b\[<3[26];/.test(text)) dragging = true;
  if (dragging && /\x1b\[<\d+;\d+;\d+m/.test(text)) {
    write("\x1b[10;1HDRAG_RECEIVED");
    dragging = false;
  }
});
process.stdout.on("resize", () => write(`\x1b[11;1HSIZE_${process.stdout.columns}_${process.stdout.rows}\x1b[K`));
process.stdin.resume();
