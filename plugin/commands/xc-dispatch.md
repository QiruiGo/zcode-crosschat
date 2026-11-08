---
description: 向另一个协作会话派发一个可检验任务（标题+内容+验收标准）。
argument-hint: "<目标名> <任务描述>"
skills: crosschat
---

按 `crosschat` 技能的派发纪律处理本请求：

$ARGUMENTS

向参数指定的目标会话派发任务：先把参数整理成**可检验任务**——`title`（一句话标题）、`prompt`（要做什么、写到哪个文件、以什么形式）、`acceptance`（验收标准，必须可由文件/数值核对）；参数没给全时先向用户确认，不要替用户编造验收标准。然后调用 `xc_dispatch`（`to` 为目标名），向用户回报 `taskId` 与 `delivered` 状态（`wake`=已推送唤醒；`mailbox`=已落邮箱等对方拉取；`duplicate`=同文消息已在效期内）。派发后按技能的等待纪律让位等待，不轮询。
