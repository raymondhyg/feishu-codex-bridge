# 飞书 Codex 桥

这是一个非官方、面向 Windows 的轻量传输桥：把授权用户的飞书/Lark 私聊消息送入一个精确绑定、在 Codex Desktop 中可见的本地总控任务，再把对应轮次的结果回复到原会话。

Bridge 坚持只做传输：不理解业务意图、不按标题选择任务、不创建第二个 AI，也不根据消息内容决定工作应该交给谁。

## 工作链路

```text
授权用户的飞书/Lark 私聊
  -> 身份校验、去重、附件处理、FIFO
  -> 私下配置的精确 Codex 任务 ID 与工作目录
  -> Desktop 可见的 Codex 轮次
  -> 精确关联的轮次结果
  -> 回复到原飞书/Lark 消息
```

## 安全模型

本项目面向“单一可信使用者 + 白名单私聊入口”。绑定的 Codex 总控使用固定的无人值守全权限运行配置。

请不要：

- 把机器人开放给群聊或不可信用户；
- 使用面向大量人员的公共飞书应用；
- 把凭据、完整线程 ID、消息正文、日志、附件或运行状态提交到仓库。

安装前请先阅读 [安全说明](SECURITY.md)。

## 环境要求

- Windows 10 或 Windows 11
- Codex Desktop
- Node.js LTS
- 飞书/Lark CLI 与所需官方 Skills
- 已配置私聊消息事件的飞书/Lark 应用

## 安装、升级与修复

请从 [GitHub Releases](https://github.com/raymondhyg/feishu-codex-bridge/releases) 下载完整总包。解压外层总包后，先核对 SHA256 和 manifest，再解压内层 portable ZIP。

- 新电脑：阅读 [安装首读](README-FIRST.md)。
- 已有正常安装：
  `scripts/upgrade-or-repair-existing-computer.ps1 -Mode Upgrade`
- 旧源码被大量修改、损坏或无法判断：
  `scripts/upgrade-or-repair-existing-computer.ps1 -Mode Repair`

升级和修复会保留接收电脑上的私有配置与状态，备份旧公共源码，然后安装干净的 Release 源码；不会把未知的旧修改自动合并进新版。

## 本地验证

进入 `scripts` 目录运行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run preflight
.\health-check.ps1 -RequireClean -WaitSeconds 60
```

发布包验证通过，不等于接收电脑已经验收通过。每台电脑仍需完成一次真实私聊往返；按实际需要分别验收附件、文档/任务/妙记读回、FIFO、中断恢复和物理重启。

## 功能范围

包含：

- 私聊文字、图片和文件输入；
- 精确线程绑定；
- 去重、FIFO 和精确轮次关联；
- 固定总控未激活时的有界恢复；
- Windows 隐藏启动；
- 单消费者健康检查和脱敏诊断；
- 新安装、保留配置升级和可恢复修复。

不包含：

- 群聊路由；
- 飞书 IM 原始语音识别；
- 按语义选择任务；
- 远程任务系统；
- 确认码、任务码；
- Bridge 内部的第二个思考智能体。

## 当前版本

当前公开版本：**v0.12.7**。准确变更和验证证据见 [更新日志](CHANGELOG.md) 与 Release 附件。

本项目与字节跳动、飞书/Lark 或 OpenAI 不存在隶属、联合或官方背书关系。

## 许可证

本项目使用 MIT License。参见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
