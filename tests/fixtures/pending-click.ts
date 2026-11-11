if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("需要真实 PTY");
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H\x1b[?2026hRun\x1b[2;1H");
process.stdin.on("data", (data: Buffer) => {
  if (data.includes("\x1b[<0;2;1M")) {
    process.stdout.write("\x1b[?2026l\x1b[3;1HCLICKED");
    return;
  }
  if (data.includes(0x11)) process.exit(0);
});
process.stdin.resume();
