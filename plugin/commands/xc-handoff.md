---
description: 读一份 30 秒接手包（身份/我的任务/待领池/未读/容量/最近检查点/建议下一步），新会话接手或换人续作时用；可按任务 id 或花名收窄。
argument-hint: "[任务id|花名]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

1. 已注册则直接调用 `xc_read({scope:"handoff"[ , id:"<任务id或花名>" ]})`；未注册先 `xc_identify`（接手三步：identify → handoff → claim/续作）。
2. 把七要素渲染给用户：我的任务（状态/attempt/最后进展/阻塞原因）、待领池前 10、未读摘要、容量水位、最近检查点路径与年龄、建议下一步。
3. 按 `suggestions` 行动：可认领的先 `xc_claim`（注意单在途任务规则）；blocked 的走 `xc_team unblock` 或 cancel；依赖未满足的记为等待项。
4. 若响应带 `truncated`，如实说明哪些章节被预算裁掉，并指引用 `xc_read({scope:"inbox"})` / `xc_overview` / `xc_read({scope:"task"})` 取全文——不得当作「没有这些内容」。
