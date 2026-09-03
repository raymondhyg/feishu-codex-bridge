# Feishu/Lark Codex Bridge v0.12.7：安装、升级与修复首读

这是可直接外发的完整 Release，不是补丁包。一个 ZIP 同时支持新用户安装、
老用户保留配置升级，以及旧源码被改乱后的可恢复修复安装。

## 它实现什么

```text
授权用户的飞书私聊（文字 / 图片 / 文件）
  -> 轻量传输桥
  -> 一个按精确私有 ID 与 cwd 绑定的 Desktop 原生本地 Codex 总控
  -> 总控理解、调查、调用本机与飞书能力并完成工作
  -> 该轮准确结果回到原飞书私聊
```

包含私聊文字双向转达、图片/文件输入、去重、FIFO、精确轮次关联、恢复、
隐藏自启、单消费者和脱敏健康检查。总控可按已安装的官方 skills 使用飞书
文档、云盘、任务、会议、妙记和 Note。

桥只转达，不理解业务，不创建第二个 AI，不按标题或语义选择任务。当前不含
群聊入口、飞书 IM 原始语音识别、自动上传总控生成的任意本地文件。

## 先选择唯一入口

先核对 ZIP 的 SHA256 和 manifest，再解压。所有命令从解压包的 `scripts`
目录运行。

### 1. 新用户或干净电脑

先运行只读检查：

```powershell
.\bootstrap-prerequisites.ps1
```

若明确需要安装或更新官方 Lark CLI/skills：

```powershell
.\bootstrap-prerequisites.ps1 -InstallLarkTooling
```

人工完成飞书应用、权限、事件发布和 OAuth 后，由接收端 Codex 私下读回一个
Desktop 原生总控的精确 thread ID 与 cwd，再执行：

```powershell
.\prepare-new-computer.ps1 `
  -FixedControllerThreadId $privateThreadId `
  -FixedControllerWorkingDirectory $privateControllerCwd `
  -DesktopNativeControllerReadbackConfirmed
```

### 2. 老用户正常升级

保留现有私有配置和状态，用干净 Release 源码替换旧公共源码：

```powershell
.\upgrade-or-repair-existing-computer.ps1 -Mode Upgrade
```

### 3. 老用户改动较多、已损坏或无法判断

不要继续合并未知改动。修复入口会先清点并可恢复地备份旧公共源码，再安装
干净 Release；现有私有绑定与状态仍保留：

```powershell
.\upgrade-or-repair-existing-computer.ps1 -Mode Repair
```

升级/修复必须从“解压后的 Release”运行，不能从已安装目录运行。脚本会在
存在待处理消息、服务未安全退出或启动任务未回到 Ready 时停止；不会强杀
进程，也不会把朋友的自定义源码悄悄合并进新版。

## 隐私与边界

包内不含任何真实 config/state、secret、token、cookie、日志、附件、消息正文、
完整私人 ID、私人线程链接或制作电脑用户名。设备上的私有运行目录是：

```text
%USERPROFILE%\.codex\private\lark-im-codex-bridge
```

升级/修复会在本机 `.codex\backups` 下保留旧公共源码、私有配置/状态副本和
改造前文件摘要，便于人工回滚。包验证、设备安装、真实飞书往返、物理重启
和 Git/GitHub 发布是彼此独立的证据。

## 每台设备仍须验收

- `npm run check`、`npm test`、`npm run preflight` 通过；
- `health-check.ps1 -RequireClean -WaitSeconds 60` 为干净健康；
- 只有一个事件消费者，待处理项为零；
- 普通消息进入所选 Desktop 可见总控并准确回到飞书一次；
- 图片、文件、Doc/Task/Minutes 按实际需要分别读回；
- 若要求无人值守，物理重启后另做真实消息闭环。

更完整的设备路线与故障节点见
`references/new-computer-deployment-guide.md`。
