/** 通用协议夹具：重复标签、样式、鼠标、粘贴和 resize，不依赖外部服务。 */
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("PTY required");
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[HREADY\r\n");
process.stdout.write("\x1b[31mRun\x1b[0m   \x1b[1;32mRun\x1b[0m\r\n中文 🚀 A⠀B");
let drag = false;
process.stdin.on("data", (data: Buffer) => {
  const value = data.toString();
  if (value.includes("\x11")) {
    process.stdout.write("\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[8;1HRECORD_FINAL");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (value === "g") process.stdout.write("\x1b[1;1HUPDATED");
  if (value.includes("\x1b[200~")) process.stdout.write("\x1b[5;1HPASTE_RECEIVED");
  if (/\x1b\[<3[26];/.test(value)) drag = true;
  if (drag && /\x1b\[<\d+;\d+;\d+m/.test(value)) process.stdout.write("\x1b[6;1HDRAG_RECEIVED");
});
process.stdout.on("resize", () => process.stdout.write(`\x1b[7;1HSIZE_${process.stdout.columns}_${process.stdout.rows}`));
process.stdin.resume();
