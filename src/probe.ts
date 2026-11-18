import { createBrowserEngine } from "./engine/browser-engine.js";
import type { GlyphMetric, RenderMetadata, RendererKind } from "./core/types.js";
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
  /** 圈码字阶的 Canvas 度量；用于暴露逐字 fallback，不等同于字体来源验证。 */
  fontScale?: GlyphScaleProbe;
}

export interface MetricRange {
  min: number;
  max: number;
  ratio: number;
}

export interface GlyphScaleProbe {
  pass: boolean;
  texts: string[];
  advance: MetricRange;
  height: MetricRange;
}

const GLYPHS: { text: string; expectedWidth: number }[] = [
  { text: "A", expectedWidth: 1 },
  { text: "中", expectedWidth: 2 },
  { text: "🚀", expectedWidth: 2 },
  { text: "e\u0301", expectedWidth: 1 },
  { text: "·", expectedWidth: 1 },
  { text: "─", expectedWidth: 1 },
];

const FONT_SCALE_TEXT = "⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const FONT_SCALE_SAMPLE = [...FONT_SCALE_TEXT];
const FONT_SCALE_TOLERANCE = 1.25;

function range(values: number[]): MetricRange {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { min: 0, max: 0, ratio: 0 };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    ratio: Math.round((max / min) * 100) / 100,
  };
}

function summarizeGlyphScale(metrics: GlyphMetric[]): GlyphScaleProbe {
  const advance = range(metrics.map((metric) => metric.advance));
  const height = range(metrics.map((metric) => metric.ascent + metric.descent));
  const pass = metrics.length === FONT_SCALE_SAMPLE.length
    && advance.ratio > 0 && advance.ratio <= FONT_SCALE_TOLERANCE
    && height.ratio > 0 && height.ratio <= FONT_SCALE_TOLERANCE;
  return { pass, texts: [...FONT_SCALE_SAMPLE], advance, height };
}

/**
 * 用一个固定样本检查字体实际落格宽度。它不是跨终端规范测试，
 * 而是把当前运行环境的缺失/宽度差异显式化成可比较的诊断结果。
 * `strictFont` 还会把圈码字阶不一致（常见于逐字 fallback）视为失败。
 */
export async function runProbe(options: {
  fontFamily?: string;
  fontFile?: string;
  fontSize?: number;
  renderer?: RendererKind;
  strictFont?: boolean;
} = {}): Promise<ProbeReport> {
  const engine = await createBrowserEngine({
    cols: 80,
    rows: 8,
    onData() {},
    ...(options.fontFamily === undefined ? {} : { fontFamily: options.fontFamily }),
    ...(options.fontFile === undefined ? {} : { fontFile: options.fontFile }),
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
    const metrics = await engine.glyphMetrics?.(FONT_SCALE_SAMPLE);
    const fontScale = metrics === undefined ? undefined : summarizeGlyphScale(metrics);
    return {
      ok: glyphs.every((glyph) => glyph.pass) && snapshot.render !== undefined
        && (!options.strictFont || fontScale?.pass === true),
      version: VERSION,
      render: snapshot.render,
      glyphs,
      ...(fontScale === undefined ? {} : { fontScale }),
    };
  } finally {
    await engine.close();
  }
}
