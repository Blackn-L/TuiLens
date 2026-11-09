# 录制与场景

[English](../RECORDING.md) · [简体中文](RECORDING.md)

## 录制

通过 `launch.recording = { maxBytes: 16777216 }` 或 CLI `--record` 显式启用。
结果包含 recordingPath。NDJSON 记录版本头、输出、输入、resize、退出与结束事件。
文件头不复制命令、工作目录或环境变量；终端正文和输入本身仍可能包含敏感数据。

容量为 4 KiB–64 MiB。超限或关闭/失败时丢弃已接收输出，会标记 truncated。
缺少结束标记属于不完整录制；关闭录制时没有日志文件 I/O。

## 回放

回放先验证整个有界文件，再创建引擎；只应用输出和 resize，不执行输入。
speed=0 立即应用；正数按比例保留间隔，单步延迟超过 30 秒会拒绝。
缺少或提前结束、时间戳错误、版本不支持都明确失败。
截断回放须 allowTruncated:true，结果仍保留截断标记。
最多接受 100000 个事件；取消会关闭引擎并删除未完成的结果文件。
回放与实际会话共享最多八项任务的限制，并受管理器关闭约束。

回放检验终端渲染；应用行为测试需要实际程序和受控负载。

## 场景

场景包含 version:1、launch 和最多 500 个 steps。
支持 input、wait、resize、observe、clickText、compare，见[可运行示例](../../examples/scenario.json)。
执行器启动一个真实程序，各步骤复用会话接口。失败时尝试有界截图并生成报告；
成功、失败、取消都会关闭本次会话，清理异常单列记录。

CLI `scenario --file scenario.json` 直接读取规格；MCP terminal_scenario 接收 `{ "specification": { ... } }`。
场景会执行其配置命令，只运行你明确打算执行的规格。
