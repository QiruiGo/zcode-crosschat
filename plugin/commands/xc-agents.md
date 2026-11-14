---
description: 【弃用存根，v0.7.0 删除】已并入 /xc-status（全景视图）——照 /xc-status 流程执行。
argument-hint: ""
skills: crosschat
---

按 `/xc-status` 的流程处理本请求：

$ARGUMENTS

> **弃用说明**：`/xc-agents` 已并入 `/xc-status`（v0.6.0 起，v0.7.0 删除本存根）。迁移表见 [docs/MIGRATION.md](../../../../docs/MIGRATION.md)。

即：调用 `xc_overview({view:"panel"})`（无需注册；只读观测），把返回体渲染成**一张**面板给用户：

1. 「可寻址会话」段：每行 `名字 [kind]  cwd  状态  最近活跃`——kind 为 self / member / session；
   同名行会带 `[ref]`，提醒用户发信时用完整的 `名字 [ref]`。
2. 「在队成员」段：每行 `花名  角色  状态  未读数`。
3. 「任务概览」段：pending / claimed / in_progress / blocked / completed / failed / cancelled 计数 + 阻塞项 + 停滞标红 + 容量水位。

面板以工具返回为准；与用户记忆不一致时以工具返回为准并如实说明。若入站策略不是 accept，
在面板末尾用一行提示当前跨会话入站策略（hold/refuse）与暂存条数。
