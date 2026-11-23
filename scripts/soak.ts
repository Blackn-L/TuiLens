import { createBrowserEngine } from "../src/engine/browser-engine.js";

const frames = Number(process.env.TUILENS_SOAK_FRAMES ?? 500);
if (!Number.isInteger(frames) || frames < 1 || frames > 100_000) {
  throw new Error("TUILENS_SOAK_FRAMES must be an integer between 1 and 100000");
}

const engine = await createBrowserEngine({ cols: 160, rows: 50, onData() {} });
try {
  const started = performance.now();
  let lastPaintMs: number | undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    await engine.write(`\x1b[?25lSOAK ${frame}\r\n`);
    await engine.paint?.();
    const snapshot = await engine.snapshot(frame, { cells: false });
    lastPaintMs = snapshot.render?.paintMs ?? lastPaintMs;
    if (frame % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const memory = process.memoryUsage();
  process.stdout.write(
    JSON.stringify({
      frames,
      elapsedMs: Math.round(performance.now() - started),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      lastPaintMs,
    }) + "\n"
  );
} finally {
  await engine.close();
}
