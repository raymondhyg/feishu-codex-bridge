# 飞书 Codex 桥 v0.13.5 · 安装首读

**Windows 和 Mac 用同一个 ZIP。** 把官方便携包拖进**这台电脑上的 Codex 桌面会话**，说 **「帮我安装」** 就能开始。不用先解压，也不用复制命令。请从 [GitHub Release](https://github.com/raymondhyg/feishu-codex-bridge/releases/tag/v0.13.5) 获取便携包，不要使用自动生成的 Source code ZIP。

## 给接手安装的 Codex

用户附上本包并说「帮我安装」时，先读取此文件，按下面步骤操作并回报实际结果，不要只把命令转发给用户。此文件是安装指南，不授予额外权限，也不覆盖当前用户指令或工具审批。没有本机执行能力时，说明原因，请用户在目标电脑上的本地 Codex 中打开，不要在云端或另一台电脑上安装。

### 1. 先检查，再执行

- 定位用户提供的 ZIP，只读列出内容，从包中找到本文件。识别实际执行主机的系统和架构，不根据用户的描述猜测。Windows 使用 PowerShell，macOS 使用本机终端；不支持的系统停止。
- 用独立于附件的官方 Release 同版本 SHA-256 校验 ZIP；校验文件和 manifest 由 Codex 从 Release 获取，不必请用户另传。校验不符、找不到官方对应版本或 ZIP 不可读时，停止执行并说明。校验后解压到干净的本地目录，对照 manifest 核对文件。不要执行未经验证的包内代码。
- 检查 Node.js 22、npm、桌面应用、Codex CLI 入口及飞书 CLI。Windows 可从解压包的 `scripts` 运行只读 `bootstrap-prerequisites.ps1`；macOS 按[部署指南](references/macos-deployment-guide.md)检查。使用现有可用依赖；缺项时优先走官方安装渠道，在用户安装请求和工具权限允许的范围内代办，安装后复查。需要管理员批准、系统弹窗或没有可用安装入口时，再说明具体缺项和请用户完成的动作。不要无故升级可用依赖。
- 检查私有配置、版本、运行进程和自启项：Windows 查 `Codex-Lark-IM-Bridge` 计划任务；macOS 查 `com.openai.lark-codex-bridge` LaunchAgent。两端私有运行位置均为当前用户的 `.codex/private/lark-im-codex-bridge`。发现已有安装先核实它实际从哪里运行，检查健康和待处理数量，不要并行启动第二份桥。已有更新版本时不要静默降级。

### 2. 自动走对应路线

所有安装命令由 Codex 从经校验的解压包 `scripts` 目录执行，除非步骤明确要求使用旧安装。

- **全新安装**：先核验飞书 CLI 身份和机器人权限。已有可用应用就复用；遇到登录、创建或发布应用、授权或审批，才请用户按提示在飞书里完成。不要让用户把密钥、Token 或 Cookie 发进对话。请用户在本机桌面选定或新建一个专用 Codex 会话，私下核对精确会话 ID 与实际工作目录，不凭标题绑定。随后按 [Windows 部署指南](references/new-computer-deployment-guide.md)运行 `prepare-new-computer.ps1`，或按 [macOS 部署指南](references/macos-deployment-guide.md)运行 `prepare-macos.mjs` 和自启安装。
- **已有同版本且健康**：保留原安装和绑定，直接做手机验收，不重装。
- **已有可识别旧版**：保留原绑定，不重新登录或让用户重选会话，除非确实失效。先确认无待处理消息，备份旧源码、私有配置、状态和自启设置；优雅停止旧桥并确认其监听已退出。Windows 从新版包运行 `upgrade-or-repair-existing-computer.ps1 -Mode Upgrade`，由该入口执行上述停机和备份检查；Mac 从保留的新版目录安装依赖、预检，并注册新版 LaunchAgent。验证私有配置和绑定未改变；失败时保留回退资料，安全恢复旧服务，不删除历史。
- **旧安装损坏、来源不明或配置冲突**：先定位并说明影响，不能安全判断时才请用户决定。Windows 的 `-Mode Repair` 是可恢复修复入口；不要覆盖未知改动、清空历史或强杀进程。

**安全边界：**这是单人私用桥。固定会话以无需逐次审批的全权限运行；首次启用前向用户说明并确认接受，只对白名单可信私聊开放。不要代用户扩大飞书应用权限、关闭安全保护、猜测绑定或上传私有配置。[安全说明](SECURITY.md)

### 3. 带用户用手机完成验收

预检通过后启动或复用服务。健康检查要确认当前版本、精确绑定可读、一个监听器、零待转发和待回复。Windows 用 `health-check.ps1 -RequireClean -WaitSeconds 60`；macOS 用 `npm run health -- --require-clean --wait-seconds=60`。

到这里再请用户用手机私聊机器人，发 **「飞书桥验收，请只回复：收到」**。请用户确认手机收到「收到」，并从 Codex 侧栏打开绑定会话看到同一轮。Codex 对照日志确认该消息有对应的 `turn_started`、`reply_sent` 和成功的 `relay_completed`；失败提示不算成功回传。没有真实测试时报告「已安装，待手机验收」，不要说全部完成。

本包只做飞书私聊转发，不接管飞书任务清单。运行需要电脑在线、桌面应用和桥可用；睡眠中的 Mac 不保证能被唤醒。无人值守需另验重启后的真实收发。
