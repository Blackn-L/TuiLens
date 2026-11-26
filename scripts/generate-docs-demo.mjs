// From the repository root: npm ci, npm run build, then node scripts/generate-docs-demo.mjs.
// Uses the same Chrome, Edge or Playwright Chromium installation as TuiLens screenshots.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "../dist/src/engine/visual-renderer.js";
import {
  createBrowserEngine,
  escapeHtml,
  jsonForScript,
  renderScenarioHtmlReport,
  SessionManager,
} from "../dist/src/index.js";

const scenario = JSON.parse(await readFile("examples/scenario.json", "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "tuilens-demo-"));
const manager = new SessionManager({ artifactDir: temporary });

async function publicReport() {
  const result = await manager.scenario(scenario);
  assert.ok(result.pass, JSON.stringify(result.steps.find((step) => step.error)?.error));
  const { html, manifest, inlineImages } = await renderScenarioHtmlReport(result);
  assert.equal(inlineImages, 2);

  // Publish only terminal metadata and short asset names, including in the embedded manifest.
  const { platform, arch, node, cols, rows, renderer, terminalProfile } = manifest.environment;
  const paths = new Map([[manifest.payloadPath, "scenario-result.json"]]);
  for (const artifact of manifest.artifacts.filter((item) => item.role === "screenshot")) {
    paths.set(artifact.path, `${result.steps[artifact.stepIndex].name}.png`);
  }
  const published = {
    ...manifest,
    environment: { platform: "redacted", arch: "redacted", node: "redacted", cols, rows, renderer, terminalProfile },
    payloadPath: paths.get(manifest.payloadPath),
    artifacts: manifest.artifacts.map((item) => {
      assert.ok(paths.has(item.path), `Unexpected scenario artifact: ${item.role}`);
      return { ...item, path: paths.get(item.path) };
    }),
  };
  let output = html
    .replace(jsonForScript(manifest), jsonForScript(published))
    .replace(escapeHtml(`${platform}/${arch} · ${node}`), escapeHtml(`${renderer} · ${cols} × ${rows}`));
  for (const [source, name] of paths) output = output.replaceAll(escapeHtml(source), name);
  assert.ok(!output.includes(escapeHtml(temporary)) && !output.includes(jsonForScript(temporary).slice(1, -1)));
  return output.replace(/^[\t ]+$/gmu, "");
}

async function heroImage() {
  // Capture at larger type for high-density displays while keeping the example's terminal grid.
  const live = new SessionManager({
    artifactDir: temporary,
    engineFactory: (options) => createBrowserEngine({ ...options, fontSize: 44 }),
  });
  try {
    const { id } = await live.launch(scenario.launch);
    await live.wait(id, { conditions: [{ kind: "text", text: "Type g to update." }] });
    const before = await live.observe(id, { screenshot: true, region: { x: 0, y: 4, width: 5, height: 1 } });
    assert.ok(before.snapshot.lines[4].startsWith("READY"));
    const action = scenario.steps.find((step) => step.name === "update").action;
    await live.input(id, action);
    await live.wait(id, { conditions: [{ kind: "text", text: "UPDATED" }] });
    const { diff, screenshot } = await live.observe(id, {
      view: "diff",
      fromFrameId: before.snapshot.frameId,
      screenshot: true,
      region: { x: 0, y: 7, width: 7, height: 1 },
    });
    assert.deepEqual(diff.changedLines, [{ y: 7, before: "", after: "UPDATED" }]);
    const ready = await readFile(before.screenshot.path, "base64");
    const updated = await readFile(screenshot.path, "base64");
    return await frameCapture(action.text, diff.changedLines[0], ready, updated);
  } finally {
    await live.closeAll();
  }
}

async function frameCapture(input, change, ready, updated) {
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable() });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      * { box-sizing: border-box }
      body { margin: 0; padding: 16px; color: #eaf6f4; background: #102a2c;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace }
      main { border: 1px solid #416367; border-radius: 14px; overflow: hidden; background: #101114 }
      header, .trace { display: flex; align-items: center; gap: 14px; padding: 0 25px }
      header { height: 64px; background: #152326; border-bottom: 1px solid #33494a; font-size: 25px }
      .prompt { font-weight: 700; color: #74e9d5 }
      .pty { margin-left: auto; font-size: 21px; color: #a1c5c1 }
      .screen { display: grid; height: 125px; align-content: center; padding: 0 25px; gap: 8px 0;
        grid-template-columns: 1fr 1.1fr 1.2fr; justify-items: start; align-items: center }
      .screen small { color: #a4b8b8; font-size: 20px }
      .screen .mid { justify-self: center }
      .key { display: flex; align-items: center; gap: 12px; color: #739693; font-size: 24px }
      kbd { font: 28px/1 monospace; color: #ecf9f8; border: 1px solid #648584; border-bottom-width: 3px;
        background: #233a3a; border-radius: 7px; padding: 4px 11px 6px }
      .screen img { display: block; height: 44px; width: auto }
      section { background: #102426; border-top: 1px solid #385254; padding: 19px 0 22px }
      .trace { font-size: 23px; color: #afd1cd }
      .trace::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: #72debb }
      pre { font: 27px/1.35 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        margin: 13px 25px 0; color: #ccdedc }
      b { color: #98f0ca; font-weight: 600 }
    </style><main>
      <header><span class="prompt">&gt;_</span>echo-tui.mjs<span class="pty">PTY</span></header>
      <div class="screen"><small>y = 4</small><small class="mid">input</small><small>y = ${change.y}</small>
        <img alt="Initial terminal crop" src="data:image/png;base64,${ready}">
        <div class="key mid">→ <kbd>${escapeHtml(input)}</kbd> →</div>
        <img alt="Updated terminal crop" src="data:image/png;base64,${updated}">
      </div>
      <section><div class="trace">diff.changedLines[0]</div>
      <pre>{ "y": ${change.y}, "before": ${escapeHtml(JSON.stringify(change.before))},
  "after": <b>${escapeHtml(JSON.stringify(change.after))}</b> }</pre></section>
    </main>`);
    await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    return await page.locator("body").screenshot();
  } finally {
    await browser.close();
  }
}

try {
  const report = await publicReport();
  const image = await heroImage();
  await mkdir("docs/public/examples", { recursive: true });
  await writeFile("docs/public/examples/scenario.html", report);
  await writeFile("docs/assets/agent-demo.png", image);
} finally {
  await manager.closeAll();
  await rm(temporary, { recursive: true, force: true });
}
