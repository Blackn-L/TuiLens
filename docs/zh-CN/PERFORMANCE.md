# 性能测量

[English](../PERFORMANCE.md) · [简体中文](PERFORMANCE.md)

浏览器终端用于功能和视觉验收。关闭截图仍有终端解析、浏览器通信和绘制开销。
测量结果应注明被测程序、终端引擎、平台与采集方式。

## 应用性能（`perf`）

`perf` 回答的是「我的 TUI 在长会话后是否变慢」，不是「TuiLens 本身有多快」。

```sh
node dist/src/interfaces/cli.js perf --file examples/perf.json --baseline perf/baseline.json
```

| 字段 | 含义 |
| --- | --- |
| `elapsedMs.p50/p95/p99` | 输入发出 → 目标条件成立；测量期间不截图、不读整屏字符格 |
| `stability` | `max ÷ p50`；小于 1.25 稳定，小于 2 有抖动，否则不稳定 |
| `processTree.peakRssBytes` | **被测程序**进程树的 RSS 峰值，每秒采样一次 |
| `startupMs` | 启动到声明的 `ready` 条件成立 |
| `session` | 每轮的接收/应用字节与写入批次 |
| `comparisons` | 每个指标相对基线的变化 |

运行器强制执行的测量纪律：

- 每个轮次重新启动被测程序，进程内缓存与历史不会跨轮次泄漏。
- `setup` 在每个轮次重建状态，因此「长历史」是真的重新构造，而不是累积出来的。
- `{{seq}}` 会替换为本次运行内的输入序号。固定证据文本会在第二次采样时立刻命中，
  把测量退化成接近 0 的假样本；每次采样必须等待**自己这一次**产生的新证据。
- 测量使用 `cells:false`，每次采样都不会读取 8000 个字符格。
- 实践中必须声明 `ready`：程序进入 raw mode 之前发送的输入会被吞掉，产生假超时。
- 采样超时会让整轮失败，绝不会被记录成一个偏大但「通过」的数字。

`processTree.peakRssBytes` 是**下界**：Windows 上单次采样约需数百毫秒，
因此默认间隔为 1 秒，报告始终标注 `approximate:true`。

基线记录 `platform`、`node`、`arch`、`cols` 与 `rows`。环境不一致时默认拒绝比较，
因为绝对耗时在不同 runner 之间没有可比性；确需比较时显式使用
`allowEnvironmentMismatch` / `--allow-env-mismatch`。

## 工具开销对照

```sh
npm run benchmark:overhead -- --frames 120 --repeats 3 --pace-ms 1 --out artifacts/overhead.json
```

同一个原生 PTY 夹具分别经过：

- `drain-only`：消费输出，不解析 ANSI、不绘制。
- `tuilens`：通过实际会话和浏览器终端，测量期间不截图、不轮询完整字符格。

每轮使用独立进程，交替执行顺序；最后读取一次画面检查完成标记，
这次读取不计入主测量窗口。

| 字段 | 范围 |
| --- | --- |
| startupMs | 模块、浏览器、PTY 启动及夹具就绪 |
| workload.elapsedMs | 夹具自身产出耗时 |
| controlToOutputAppliedMs | 发出控制动作到最后输出消费/解析完成 |
| rootCpuMs | 工具根进程 CPU 时间 |
| rootRssPeakBytes | 工具根进程采样 RSS 峰值 |
| sessionMetrics | 接收/应用字节、积压、背压与批次 |

根进程 CPU/RSS 不包含浏览器、PTY 宿主和被测程序。
解析完成不代表像素已经绘制。输出通道可能改写字节；
夹具产出字节与终端接收字节应分别记录。

## 快照传输

字符网格以两个压缩字符串跨浏览器边界传递（`snapshot-codec.ts`），而不是嵌套对象数组。
在桌面 Windows 主机、160×50 网格下实测：

| 操作 | 修复前 | 修复后 |
| --- | --- | --- |
| `observe`（不含网格） | ~770 ms | ~2.7 ms |
| `observe`（含网格） | ~770 ms | ~4.1 ms |
| `find` | ~940 ms | ~5 ms |
| `wait`（条件已满足） | ~940 ms | ~4 ms |
| `wait` 超时（1 秒） | ~2000 ms | ~1.1 秒 |

原先的开销来自 Playwright 序列化 8000 个嵌套字符格对象：同样内容约 660 ms，
改成扁平字符串后约 7 ms。打包在页面内完成，解包与校验在 Node 侧完成。

等待轮询现在从 2 ms 退避到 50 ms。原先固定 50 ms 的轮询既让短等待被量化，
也让 `perf` 结果偏大——4 ms 的观察只能每 50 ms 采样一次。

## 长任务

- 固定工作负载、字体、网格、引擎和浏览器版本。
- 分别采样被测程序与工具进程树资源。
- 记录采样成本、队列峰值及暂停时间，避免把背压归因于被测程序。
- 区分输入发送、应用输出、解析完成和画面可见时点。
- 使用持续负载检查资源增长；短时合成输出不能外推到数小时运行。
- 原生引擎或 Rust 处理层仍需开销校准，不承诺零干扰。

浏览器路径是观察环境，不是零开销性能探针。`perf` 通过该环境测量被测程序，
因此工具自身开销是固定偏移，而不是报告出来的指标。
