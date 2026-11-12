/** 性能采样统计。分位数使用线性插值，与常见的 p50/p95/p99 定义一致。 */
export interface SampleSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  const high = sorted[upper]!;
  return low + (high - low) * (position - lower);
}

/** 入参不要求有序；内部复制后排序，调用方的采样数组保持不变。 */
export function summarize(values: number[]): SampleSummary {
  if (!values.length) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: rounded(sorted[0]!),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
    max: rounded(sorted[sorted.length - 1]!),
    mean: rounded(total / sorted.length),
  };
}

export function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}
