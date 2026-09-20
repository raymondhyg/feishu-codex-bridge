# macOS 部署说明

macOS 路线保持与 Windows 相同的固定总控安全模型：一个白名单飞书私聊身份、一个精确任务 ID、一个固定绝对工作目录，以及 Desktop 可见的轮次。

## 前提

- Apple Silicon 或 Intel macOS，以及正在运行的 ChatGPT/Codex Desktop；
- Node.js 22；
- `lark-cli` 已配置且 Bot/User 身份均可验证；
- 飞书应用已启用 `im.message.receive_v1` 和所需权限；
- 一个专门用于 Mac 飞书入口的 Desktop 原生 Codex 任务。

当前实机发现：`lark-cli 1.0.96` 在 macOS 26.6.2 上可能被系统以退出码 137 终止；`1.0.95` 已通过本机配置、身份、事件消费和真实往返验收。版本兼容性应在每台接收设备单独核实，不把该观察写成所有 Mac 的固定版本要求。

## 安装与绑定

在 `scripts` 目录运行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
node prepare-macos.mjs "<EXACT_THREAD_ID>" "<ABSOLUTE_CONTROLLER_CWD>"
npm run preflight
npm run install-startup
npm run health -- --require-clean --wait-seconds=60
```

若缺少 Node.js、Codex CLI 或 Lark CLI，先安装相应官方工具并确保命令可从
`PATH` 找到，再重跑上述检查。桥不会静默安装系统级依赖，也不会代替用户完成
飞书应用授权；这是为了避免在不知情时修改系统或绑定错误账号。

`prepare-macos.mjs` 从已经验证的飞书用户身份读取白名单 open_id，将完整私人 ID、绝对路径和 CLI 入口只写入 `~/.codex/private/lark-im-codex-bridge/config.json`。如果已有配置，会先在同一私密目录留下带时间戳的备份。

LaunchAgent 文件位于 `~/Library/LaunchAgents/com.openai.lark-codex-bridge.plist`。它只保存公开程序路径和私密日志位置，不包含飞书密钥、用户 ID 或任务 ID。

## 生命周期

```bash
npm start
npm run stop
npm run health
npm run startup-status
npm run uninstall-startup
```

正常停止通过 `stop.request` 让桥和事件消费者优雅退出，不强杀进程。

## 验收

安装成功只证明本机服务准备就绪。完整验收必须分别确认：

1. 健康检查中只有一个消费者，待处理计数为零；
2. 一条白名单私聊进入精确绑定任务的新轮次；
3. `last_transport` 为 `desktop-ipc`，且 Desktop 可见性为真；
4. 对应轮次的最终回答回复到原飞书消息；
5. 日志出现 `turn_started`、`reply_sent` 与 `relay_completed`；
6. 如要求无人值守，注销登录或重启后再做一次真实往返。

源码测试、预检、服务健康和真实飞书往返是不同证据，不得互相替代。
