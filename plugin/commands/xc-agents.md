---
description: 跨会话协作全景面板：本机可寻址 peer、在队成员与任务概览一次可见（对齐 CC 的 /list-agents）。
argument-hint: ""
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

调用 `xc_agents`（无需注册；只读观测），把返回体渲染成**一张**面板给用户：

1. 「可寻址会话」段：每行 `名字 [kind]  cwd  状态  最近活跃`——kind 为 self / member / session；
   同名行会带 `[ref]`，提醒用户发信时用完整的 `名字 [ref]`。
2. 「在队成员」段：每行 `花名  角色  状态  未读数`。
3. 「任务概览」段：pending / in_progress / completed / failed / cancelled 计数 + 阻塞项。

面板以工具返回为准；与用户记忆不一致时以工具返回为准并如实说明。若入站策略不是 accept，
在面板末尾用一行提示当前跨会话入站策略（hold/refuse）与暂存条数。
