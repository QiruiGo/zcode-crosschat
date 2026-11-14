---
description: 查看本会话的协作收件箱并逐条摘要。
argument-hint: ""
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

调用 `xc_read({scope:"inbox"})`（当前连接未绑定时先按技能完成 `xc_identify` 再查收），把返回的消息**逐条摘要**给用户：每条注明来源（from）、关联任务（taskId）、要点与是否含回执/结果。若消息是任务回执，按技能纪律先用文件工具复核 evidence 与验收标准，再向用户汇报核对结论；若有待认领的新任务，询问用户是否认领，不要擅自 claim。
