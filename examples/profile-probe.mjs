/** Minimal profile probe used by examples/profile-matrix.json. */
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("PTY required");
process.stdin.setRawMode(true);
process.stdin.resume();

const encode = (value) => Buffer.from(value).toString("base64");
process.stdout.write(`TERM=${encode(process.env.TERM ?? "")}`
  + ` PROGRAM=${encode(process.env.TERM_PROGRAM ?? "")}\r\nPROFILE_READY\r\n`);

let received = "";
process.stdin.on("data", (data) => {
  received += data.toString("latin1");
});

setTimeout(() => {
  process.stdout.write("\x1b[c\x1b[>c\x1b[>q\x1b[?u");
  setTimeout(() => {
    process.stdout.write(`\r\nREPLIES=${Buffer.from(received, "latin1").toString("hex")}`
      + "\r\nPROFILE_DONE\r\n");
  }, 350);
}, 50);
