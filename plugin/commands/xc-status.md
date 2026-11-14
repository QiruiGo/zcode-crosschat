---
description: 查看跨会话协作任务板（任务七态、认领人、attempt 代数、未读数、容量/停滞）。
argument-hint: "[全景]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

调用 `xc_overview`（无需注册；缺省 `view:"team"`；参数含「全景」时用 `view:"panel"`——一次列全可寻址 peer + 在队成员 + 任务 + 容量水位 + 停滞标红 + 入站策略），把返回的快照渲染成任务板给用户：每个任务一行——id、标题、状态（pending/claimed/in_progress/blocked/completed/failed/cancelled 七态；blocked 附阻塞原因）、认领人、attempt 代数、优先级；再附成员花名册（名字、角色、最近活跃）与各成员未读数。状态与磁盘快照为准，与用户记忆不一致时以工具返回为准并如实说明。
