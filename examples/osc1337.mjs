import { PNG } from "pngjs";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this sample inside a terminal.");
const png = new PNG({ width: 192, height: 64 });
for (let y = 0; y < png.height; y += 1) {
  for (let x = 0; x < png.width; x += 1) {
    const color = x < 64 ? [35, 145, 255] : x < 128 ? [40, 205, 160] : [255, 180, 55];
    png.data.set([...color, 255], (y * png.width + x) * 4);
  }
}
const data = PNG.sync.write(png);
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?25l\x1b[2J\x1b[3;1H");
process.stdout.write(`\x1b]1337;File=inline=1;width=192px;height=64px:${data.toString("base64")}\x07`);
process.stdout.write("\x1b[1;1HTuiLens - OSC 1337 inline image\x1b[9;1HIIP_IMAGE_READY   |   Ctrl+Q to exit");
process.stdin.on("data", (chunk) => {
  if (chunk.includes(0x11)) {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  }
});
process.stdin.resume();
