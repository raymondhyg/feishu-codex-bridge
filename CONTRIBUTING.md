# 贡献指南

欢迎提交遵守“固定总控、Bridge 只做传输”架构的贡献。

提交 Pull Request 前请确认：

1. 不包含凭据、私人 ID、消息正文、日志、附件或设备运行状态。
2. 不把业务理解和判断塞进 Bridge；这些工作属于绑定的本地总控。
3. 保持精确线程路由、FIFO、去重，以及未知投递结果时的失败关闭原则。
4. 为修改补充或更新回归测试。
5. 在 `scripts` 目录运行：

   ```powershell
   npm ci --ignore-scripts --no-audit --no-fund
   npm run check
   npm test
   ```

6. 分开报告源码验证、真实飞书/Lark 验收和接收电脑验收。

请保持 Pull Request 聚焦。无关重构、任务语义路由、隐藏总控创建和群聊扩展不能作为顺手修改混入。
