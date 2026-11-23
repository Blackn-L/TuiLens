# TuiLens 架构与首版契约

[English](../ARCHITECTURE.md) · [简体中文](ARCHITECTURE.md)

TuiLens 提供面向 Agent 的终端运行环境。首版复用 PTY 与 xterm.js，
提供会话、观察、等待、操作协议、CLI 和 MCP。

浏览器引擎默认使用 xterm.js DOM renderer；显式启用 WebGL 时加载 `@xterm/addon-webgl`，
上下文创建失败则回退 DOM。引擎回传实际 renderer，并传播到会话、录制头、scenario/perf 环境和视觉元数据。

## 分层

- `src/core/`：公开类型、协议、校验、定位、输入编码和有界文件读取。
- `src/engine/`：浏览器版 xterm.js 适配器；同一实例维护字符格与可见画面。
- `src/profiles/`：内置终端 preset、JSON profile 继承、能力与应答解析。
- `src/session/`：PTY、可选 PTY worker、输出顺序、观察屏障、等待、进程退出和证据。
- `src/recording/`、`src/visual/`、`src/scenario/`：有界录制回放、视觉比较和声明式场景。
- `src/transport/`：本机 IPC 与守护进程；CLI 多次调用共享会话。
- `src/interfaces/`：JSON CLI 与 MCP stdio，调用相同应用服务。
- `src/doctor.ts`：本地诊断运行时、浏览器、PTY、存储和 daemon 状态，不启动 daemon。
- `src/probe.ts`：固定字形渲染探针，输出字体/网格指纹。
- `tests/`：协议、生命周期、原生 PTY 与浏览器验收。
- `scripts/`：基准与维护工具，运行参数显式传入。

## 渲染器边界与替换条件

浏览器后端是有意选择：xterm.js 与 Chromium 为终端解析、WebGL/DOM 绘制、字体、图片和截图提供了
经过实测的保真度。接受的成本是 Chromium 冷启动、内存占用和跨平台字体回退。

浏览器无关或原生引擎不是短期重构。替换前至少需要证明：

1. 解析、模式、光标、宽字符和图片协议与现有夹具等价。
2. 用相同工作负载测得的启动、空闲 RSS 和长会话 RSS 预算。
3. Windows、Linux、macOS 上稳定的字体/网格指纹，或明确降级的平台支持契约。
4. 有界图片子集在遇到未实现能力时返回协议错误，而不是静默宣称支持。

在这些条件满足前，公共边界只有 `TerminalEngine`；调用方不应依赖 Playwright 内部对象。
参见[性能](PERFORMANCE.md)、[图片](IMAGES.md)和[路线](ROADMAP.md)。

## 关键契约

1. 对外坐标从 0 起算，以字符格计量。宽字符续格保留 width=0，定位不能按 JS 字符串长度计算列。
2. PTY 输出与用户操作按会话串行处理。观察在队列屏障内读取状态并截图，期间新输出排队。
3. 截图与状态具有相同 frameId；截图前等待终端解析和浏览器绘制完成。不能以“收到字节”代表界面就绪。
4. resize 只表示尺寸已送达；调用方用文本区域、底栏位置或局部稳定条件等待应用完成重排。
5. 输入按实际终端模式编码，滚轮必须携带位置；未启用鼠标时明确报错。
6. 图片默认关闭，按需启用 SIXEL 与文档列出的 Kitty 子集，仅声明已启用能力。
   终端身份由 profile 统一驱动环境、图片、回滚缓冲和 DA1/DA2/XTVERSION/Kitty 应答；
   Windows 使用随包 ConPTY DLL，并在应答进入 PTY 前按 profile 做最终改写。
7. 等待支持组合条件、超时和取消；稳定等待可限定区域，避开持续动画。
8. 默认保存当前观察和操作元数据；原始正文可能包含用户内容，不自动上传或将启动环境写入日志。
9. 会话关闭释放 PTY、监听器、页面与浏览器。正常容量下退出的会话仍允许观察最后画面；
   新启动遇到容量上限时优先回收最旧的已退出会话，运行中的会话不会被自动关闭；显式 close 会立即释放。
10. 运行时文件位于用户数据目录或指定 artifactDir，应用路径通过调用参数传入。
11. 输入仅读取轻量模式；输出按最多 32K UTF-16 单元合批。8 MiB 排队触发暂停，
    低于 4 MiB 恢复，超过 16 MiB 明确失败。metrics 不访问浏览器。
12. 同步输出尚未提交时，引擎返回 FRAME_PENDING；会话在队列外重试，
    确保后续结束序列能被消费，超时与取消有界。
    clickText 可显式读取未提交字符缓冲，仍保留目标区域指纹；截图不放宽此约束。
13. Windows 命名管道、Linux abstract Unix socket 与 macOS 文件 socket 共用私有令牌认证。
    启动失败回收监听端点；macOS 绑定失败后探测并清理崩溃残留，客户端用原子启动锁串行拉起守护进程。
14. CLI/MCP 默认只回传文字与截图信息，完整字符格按需请求；SDK 保留完整数据模型。
15. 回放和会话共享最多八项任务与管理器生命周期；会话满载启动时先回收已退出会话，回放计入同一预算；
    录制截断和不完整状态明确标记。
16. 视觉比较基准只读；场景失败保存有界证据并回收本次进程。
17. 普通文本等待先在引擎中轻量查询，命中后才传输完整字符格；真正截图仍等待绘制完成。
18. 终端自动应答可按时延策略转发或丢弃；suppress 仅过滤已知应答而非全部输入。
    滚轮支持按页及有界首尾导航，但不虚构跨应用的绝对滚动偏移。
    截图默认隐藏光标，但快照保留可见性、样式和闪烁元数据。
19. 截图前强制刷新并校验字符网格与 PNG 尺寸；resize 后等待画布几何连续稳定。
20. inputAndWait 发送一次输入后等待可观测条件，不自动重发；超时保留已接收证据。
21. `doctor` 只做本地诊断，不启动 daemon；`ping` 返回运行时长和活动会话计数；
    没有 daemon 时 `shutdown` 幂等成功。
22. `observe.compact` 保留行数但裁剪行尾、省略字符格并默认不截图；区域文本/样式等待走引擎侧
    `probeText`，不在未命中时传输整屏网格。
23. `snapshot.render` 记录绘制后端、字体/网格度量、与时间无关的指纹和最近一次 `paintMs`；
    `probe` 用固定字形样本比较实际落格宽度和圈码字阶。字体文件有大小上限，在 xterm 启动前
    以内联 `FontFace` 加载，并以 SHA-256 前缀进入渲染元数据；带 `unicode-range` 的符号字面只接管圈码，
    不改变主字体选择。
24. `TUILENS_PTY_WORKER=1` 把 `node-pty` 放进每会话子进程；默认仍在进程内运行。两种模式都不是安全沙箱。
25. `watch` 默认只输出只读 JSONL；`--control` 需要 TTY，并显式进入人工输入接管。

## 首版边界

Node.js 22+，Windows ConPTY 与 Linux PTY；真实验收分别记录。
CLI 返回结构化 JSON，MCP 使用 stdio。没有远程公开 HTTP 控制服务。
浏览器依赖通过 Playwright 安装或显式指定已有 Chrome/Chromium。
新增命令复用 core/session 接口，避免在 CLI 与 MCP 内复制业务逻辑。

浏览器模式不作为低干扰性能宿主。长任务性能设计与原生引擎扩展见
[性能边界](PERFORMANCE.md) 和 [后续迭代](ROADMAP.md)。
