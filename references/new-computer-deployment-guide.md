# Feishu/Lark Codex 固定总控转发：安装、升级与修复路线图

Status: external new/upgrade/repair release v0.12.7; package verification and receiving-device live acceptance are separate
Applies to: Windows 10/11 with Codex Desktop
Ownership: personal computer / global Codex capability
Source-computer live runtime: out of scope; this guide neither describes nor upgrades it
Last verified: 2026-09-01

## 给接收端 Codex 的任务

先读 `README-FIRST.md`、`SKILL.md` 和本文件，再调查接收电脑的真实环境。不要
把本文件当成逐屏教程；以当前官方安装入口、CLI 帮助、schema 和实际错误为
准处理设备、网络和飞书差异。

唯一产品路径是：

```text
授权飞书私聊
  -> 只做传输的 bridge
  -> 一个精确绑定的 Desktop 原生本地总控任务
  -> 总控理解并调用本地与飞书能力
  -> 该轮结果回到原飞书私聊
```

不要恢复旧秘书、隐藏会话、remote job、任务码、确认码、群聊路由或桥内
Feishu Task 操作。完整 ID、认证信息、private runtime 和消息正文不得出现在
聊天、报告或安装包。

## 功能范围

新设备部署完成后，目标能力是：

| 能力 | 执行者 | 当前范围 |
|---|---|---|
| 私聊文字双向转达 | bridge | 包含 |
| 飞书图片/文件作为本轮输入 | bridge | 包含；下载到私有目录 |
| 自然语言理解、调查、澄清和汇报 | 固定本地总控 | 包含 |
| 查阅/协调其他本地 Codex 任务 | 固定本地总控 | 包含，取决于 Desktop 原生任务工具 |
| 飞书文档与云盘 | 总控 + `lark-doc`/`lark-drive` | 包含，取决于 user OAuth 与资源权限 |
| 飞书任务/清单 | 总控 + `lark-task` | 包含，写后须读回 |
| 会议、妙记、Note 文字记录 | 总控 + `lark-vc`/`lark-minutes`/`lark-note` | 包含，取决于资源可见性 |
| 隐藏自启、单消费者、健康检查 | bridge | 包含 |
| 飞书 IM 原始语音识别 | — | 本版不包含 |
| 自动上传总控生成的本地文件/图片 | — | 本版不包含；可返回已有飞书链接 |

## 时间口径

人工完成飞书应用配置、权限、事件发布和浏览器 OAuth 是前置协作，不计入
本地 Codex 部署耗时。以接收端 Codex 连续执行计算：已有 Codex Desktop、
Node 和正常网络时通常约 35–70 分钟；连 `lark-cli` 和官方 skills 都没有时，
通常约 1–2 小时。环境或网络异常另算，不应靠改产品逻辑绕过。

## Gate 1：验证交付物

独立 release 目录应包含：

```text
README-FIRST.md
feishu-codex-bridge-v0.12.7-portable.zip
feishu-codex-bridge-v0.12.7-portable.zip.sha256
feishu-codex-bridge-v0.12.7-manifest.json
new-computer-deployment-guide.md
```

先交叉核对 zip SHA256、`.sha256` 和 manifest，再解压并核对 manifest 中的
逐文件路径、大小与摘要。不一致就停止并重新取得可信包，不在坏包上修补。

包内不得有 `node_modules`、真实 config/state、日志、附件、认证目录、旧机
private runtime 或完整私人 ID。不要从旧电脑复制 `%USERPROFILE%\.lark-cli`
或 `%USERPROFILE%\.codex\private`。

Exit：包和解压内容一致，来源可信。

## Gate 2：选择安装模式

- 新用户或不存在 canonical 安装：走 `prepare-new-computer.ps1`。
- 已有健康配置、正常升级：从解压包运行
  `.\upgrade-or-repair-existing-computer.ps1 -Mode Upgrade`。
- 旧公共源码被大量修改、损坏或无法判断：从解压包运行
  `.\upgrade-or-repair-existing-computer.ps1 -Mode Repair`。

升级和修复都会保留设备私有 config/state，先清点并备份旧公共源码，再安装
干净 Release；不会合并未知自定义改动。存在待处理消息、服务未安全退出或
启动任务未回到 Ready 时必须停止。旧源码备份用于人工回滚，不自动删除。

Exit：安装模式明确；如为已有设备，私有绑定完整且待处理项为零。

## Gate 3：建立当前 CLI 与 skills 基线

解压后从 `scripts` 运行只读检查：

```powershell
.\bootstrap-prerequisites.ps1
```

它只报告 Node/npm/npx、`lark-cli`、九个所需 skills、bot/user 身份与下一步，
不创建应用、不启动浏览器登录，也不输出完整 ID 或 token。

若工具缺失，在确认网络、代理和 npm 环境后明确运行：

```powershell
.\bootstrap-prerequisites.ps1 -InstallLarkTooling
```

该开关会实际调用现行官方 AI-agent 安装入口
`npx @larksuite/cli@latest install`。若官方 README 已更改入口，接收端应使用
新的官方入口并记录实际版本，不能盲目固定制作机版本。安装/刷新后重新开始
一个 Codex 任务，或重新读取本轮需要的 skills。

必须能读到：`lark-shared`、`lark-event`、`lark-im`、`lark-doc`、
`lark-drive`、`lark-task`、`lark-vc`、`lark-minutes`、`lark-note`。

Exit：CLI 可执行，所需 skill 在 CLI 目录与 Codex skill 目录均可发现。

## Gate 4：人工完成飞书侧前置

由用户按接收端 Codex 的清晰指引完成必要的开放平台和浏览器操作：

- 复用或新建一个只面向授权用户的飞书应用；
- bot ready，机器人启用；
- 长连接事件包含 `im.message.receive_v1`；
- 私聊接收、机器人回复以及附件读取/下载能力按需可用；
- user OAuth ready，使总控能以用户身份操作文档、云盘、任务、会议和妙记；
- 新增权限或事件后的应用版本已经发布并生效。

不要预猜一整套 scope。先读对应 skill，再以 CLI/API 返回的
`missing_scopes`、授权 URL 和资源权限错误为准，只补当前功能所需权限。

身份前置与实际能力必须分开：

- `bot_identity_ready` 只证明 bot 凭据在线有效；
- `user_oauth_identity_ready` 只证明个人 OAuth 身份在线有效；
- `lark_skill_prerequisites_ready` 只证明九个操作入口已安装。

这些是选择总控前的前置，不是业务能力完成证据。传输要再通过 preflight、
health 和真实消息往返；文档/任务/妙记要再通过对应 API 的最小读回。

若已有旧/残缺 skills，官方 installer 可能跳过刷新。使用当前 CLI 明示的
`npx skills add larksuite/cli -g -y` 修复入口，再运行 bootstrap；以重检结果
为准，不以安装命令“运行过”为准。

Exit：bootstrap 报告 bot/user 身份与九个 skills 的选择前置均已通过。

## Gate 5：创建并锁定唯一总控

固定总控必须是 Codex Desktop 原生创建、在侧边栏可见且能用原生任务工具
读回的任务。不要用 standalone App Server `thread/start` 冒充 Desktop 任务。

接收端可以向用户展示标题和少量区别供选择，但必须在本机私下读回并同时
保存：

- 精确完整 thread ID；
- 该任务的精确绝对 cwd。

标题仅用于人选，绝不参与运行时路由。重名时先消歧；目标不清楚时停止，
不要自动再建一个总控。总控应具备本机任务读取/创建/发送/等待能力，并能读取
上述 Lark skills。

正常 `require` 模式每轮都需要 Codex Desktop IPC owner。bridge 登录启动只
负责 bridge，不自动假设 Desktop 的安装路径。若目标是重启后完全无人值守，
接收端必须调查并使用该机当前受支持的 Desktop 登录启动方式，确认 Desktop
进程启动后固定总控能够取得 owner。不要把 App Server 可读误当成 IPC owner
已经存在。

Exit：同一个 Desktop 原生任务的 ID 与 cwd 均已工具读回。

这一 native 事实来自 Desktop 原生 create/list/read-back 证据，不来自 bridge
的 App Server preflight。安装脚本会要求接收端显式声明这一步已经完成；不要
在没有工具证据时传入确认开关。

## Gate 6：安装 canonical source 与隐藏自启

解压后的根目录应直接成为：

```text
%USERPROFILE%\.codex\skills\lark-im-codex-bridge
```

不要多套一层同名目录。确认 `scripts/package.json` 版本为 `0.12.7`。新安装再从
`scripts` 运行：

```powershell
.\prepare-new-computer.ps1 `
    -FixedControllerThreadId $privateThreadId `
    -FixedControllerWorkingDirectory $privateControllerCwd `
    -DesktopNativeControllerReadbackConfirmed
```

真实 ID 只存进当前进程变量，不写入示例、聊天或报告。脚本验证 bot/user
身份、skills、lockfile 依赖、固定任务与 cwd，并要求 native read-back 已被
显式确认；随后写入私有配置并注册当前用户登录启动任务。失败时恢复原配置。

启动任务必须是：

```text
Task Scheduler -> wscript.exe //E:JScript //B //NoLogo
  -> run-bridge-hidden.js -> hidden PowerShell -> Node bridge
```

不要改回计划任务直接启动 `powershell.exe`；Windows 11 默认终端委派可能在
隐藏参数生效前先弹出 Terminal。

默认 `fixedControllerDesktopVisibility=require`：消息必须进入 Desktop 可见
总控。不可见 App Server fallback 只保留为显式诊断模式 `off`，不用于正常
新机部署。

Exit：安装脚本读回的启动 action 是 `wscript.exe` + JScript，且固定任务和
cwd preflight 通过。

已有设备使用 Gate 2 的升级或修复入口，不重复运行新机绑定脚本。

## Gate 7：接收端证据链

从 `scripts` 运行：

```powershell
npm run check
npm test
npm run preflight
Start-ScheduledTask -TaskName 'Codex-Lark-IM-Bridge'
.\health-check.ps1 -RequireClean -WaitSeconds 60
```

若刚停止过服务，先等待计划任务状态回到 `Ready` 再启动，避免 `IgnoreNew`
丢掉请求。首次冷启动不要立即做一次性 health 判断；`-WaitSeconds 60` 会有界
轮询 PID、listener-ready 和 consumer。最终 health 必须同时报告：

正式启动只经过 `start-bridge.ps1`、`npm start` 或上述计划任务链路，不直接把
`node bridge.mjs` 当运行入口；启动脚本会先核对 PID 对应的真实进程身份。

```text
ok: true
service_healthy: true
acceptance_clean: true
bridge_pid_identity: bridge
bridge_version: 0.12.7
state_schema: 6
relay_mode: fixed-controller-only
fixed_controller_target_readable: true
active_consumers: 1
pending_fixed_relays: 0
pending_replies: 0
```

同时观察启动过程没有新增 Windows Terminal/OpenConsole 窗口。源码测试、
preflight、health、单消费者和窗口观察是不同证据。

Exit：上述事实全部成立。

## Gate 8：最小真实验收

让用户从手机飞书发一句普通自然语言。必须看到：

1. 原话作为新一轮出现在所选 Desktop 总控；
2. 总控完成这一轮；
3. 该轮准确结果只返回飞书一次；
4. 没有隐藏会话、任务码、确认码或第二套解释。

随后按实际使用需要分别做最小验证：一张图片、一个文件、一次有权限的文档
读取、一次任务读回、一次妙记/会议记录读取。外部写操作必须以返回对象或
读回为证据。

物理重启、快速连续消息 FIFO、在途恢复另行验收，不与首次安装混报。只有
用户明确同意才做物理重启。

无人值守重启验收必须在不手工打开总控任务的情况下发送一条真实消息；若
无法进入可见总控，先修复 Desktop 登录启动/owner 获取，不得静默改回
headless fallback。

## 失败时走事实节点

| 现象 | 先查 |
|---|---|
| zip/manifest 不一致 | 交付来源、摘要和逐文件清单 |
| Node/npm 或安装失败 | 当前 LTS、PATH、网络/代理、npm 错误原文 |
| skills 缺失 | 官方 installer、`lark-cli skills list/read`、Codex skill 根目录 |
| bot 未 ready | `lark-shared`、config、应用发布、网络 |
| user 未 ready | OAuth 状态、缺失 scope、资源身份 |
| 总控不可读或 cwd 不符 | Desktop 是否运行、原生任务 read-back、精确 cwd |
| PID identity 不是 bridge | 残留 PID、复用 PID、Node 命令行与 canonical 脚本路径 |
| consumer 为 0 或大于 1 | `lark-cli event status`、计划任务、优雅 stop/start |
| 开机弹终端 | 计划任务 action 是否仍为 `wscript.exe` + JScript |
| 收到消息但未回传 | 脱敏 pending 数、关联错误、固定总控对应轮次 |
| 附件失败 | `lark-im` scope、大小限制、私有附件路径 |
| 文档/任务/妙记失败 | 对应 skill、user OAuth、资源权限、API 返回错误 |

正常维护使用 bridge 的 stop/start 脚本。只有 bridge 已退出且 event status 明确
显示孤儿消费者时，才清理孤儿后单次启动；不要把强杀当常规维护。

## 部署收据

```text
Feishu/Lark Codex Bridge v0.12.7 设备安装收据

Package hash/manifest:
Install mode (New / Upgrade / Repair):
Installed canonical path:
Node / lark-cli actual version:
Required companion skills:
Bot transport ready:
User personal Feishu operations ready:
Desktop-native controller read back:
Exact cwd bound:
Source check/tests:
Preflight:
Health / state schema / active consumers:
Windowless startup action:
Live text round trip:
Image / file input:
Doc / Task / Minutes minimal read-back:
Physical restart / FIFO / recovery:
Secrets or full private IDs printed: no
Open item:
Next action:
```

包验证、当前电脑运行版本、新电脑真实往返、物理重启和 Git sync 必须分别
报告，不能互相代替。
