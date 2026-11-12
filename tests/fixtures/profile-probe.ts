/** 通过真实 PTY 查询 profile 应答，并回显可断言的字节序列。 */
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("需要真实 PTY");
process.stdin.setRawMode(true);
process.stdin.resume();

const encode = (value: string): string => Buffer.from(value).toString("base64");
process.stdout.write(`PROFILE_ENV ${encode(process.env.TERM ?? "")}`
  + ` ${encode(process.env.TERM_PROGRAM ?? "")}`
  + ` ${encode(process.env.TERM_PROGRAM_VERSION ?? "")}`
  + ` ${encode(process.env.COLORTERM ?? "")}\r\nPROFILE_READY\r\n`);

let received = "";
process.stdin.on("data", (data: Buffer) => {
  received += data.toString("latin1");
});

setTimeout(() => {
  process.stdout.write("\x1b[c\x1b[>c\x1b[>q\x1b[?u");
  setTimeout(() => {
    process.stdout.write(`\r\nPROFILE_REPLY ${Buffer.from(received, "latin1").toString("hex")}`
      + "\r\nPROFILE_DONE\r\n");
  }, 350);
}, 50);
