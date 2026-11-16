import { createBrowserEngine } from "./engine/browser-engine.js";
import type { RenderMetadata, RendererKind } from "./core/types.js";
import { VERSION } from "./version.js";

export interface GlyphProbe {
  text: string;
  expectedWidth: number;
  width: number | null;
  pass: boolean;
}

export interface ProbeReport {
  ok: boolean;
  version: string;
  render: RenderMetadata | undefined;
  glyphs: GlyphProbe[];
}

const GLYPHS: { text: string; expectedWidth: number }[] = [
  { text: "A", expectedWidth: 1 },
  { text: "中", expectedWidth: 2 },
  { text: "🚀", expectedWidth: 2 },
  { text: "e\u0301", expectedWidth: 1 },
  { text: "·", expectedWidth: 1 },
  { text: "─", expectedWidth: 1 },
];

/**
 * 用一个固定样本检查字体实际落格宽度。它不是跨终端规范测试，
 * 而是把当前运行环境的缺失/宽度差异显式化成可比较的诊断结果。
 */
export async function runProbe(options: {
  fontFamily?: string;
  fontSize?: number;
  renderer?: RendererKind;
} = {}): Promise<ProbeReport> {
  const engine = await createBrowserEngine({
    cols: 80,
    rows: 8,
    onData() {},
    ...(options.fontFamily === undefined ? {} : { fontFamily: options.fontFamily }),
    ...(options.fontSize === undefined ? {} : { fontSize: options.fontSize }),
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
  });
  try {
    await engine.write(GLYPHS.map((glyph) => glyph.text).join(" "));
    const snapshot = await engine.snapshot(1, { cells: true });
    const cells = snapshot.cells[0] ?? [];
    const glyphs = GLYPHS.map((sample): GlyphProbe => {
      const cell = cells.find((candidate) => candidate.text === sample.text);
      const width = cell?.width ?? null;
      return {
        text: sample.text,
        expectedWidth: sample.expectedWidth,
        width,
        pass: width === sample.expectedWidth,
      };
    });
    return {
      ok: glyphs.every((glyph) => glyph.pass) && snapshot.render !== undefined,
      version: VERSION,
      render: snapshot.render,
      glyphs,
    };
  } finally {
    await engine.close();
  }
}
