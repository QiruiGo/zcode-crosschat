---
description: 查看跨会话协作任务板（任务六态、认领人、attempt 代数、未读数）。
argument-hint: ""
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

调用 `xc_status`（无需注册；参数可带团队 id，缺省 default），把返回的快照渲染成任务板给用户：每个任务一行——id、标题、状态（pending/claimed/in_progress/completed/failed/cancelled 六态）、认领人、attempt 代数；再附成员花名册（名字、角色、最近活跃）与各成员未读数。状态与磁盘快照为准，与用户记忆不一致时以工具返回为准并如实说明。
