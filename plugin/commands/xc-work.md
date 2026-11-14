---
description: 把当前会话注册进跨会话协作网络并返回花名册。
argument-hint: "[名字] [worker]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

把当前会话注册进协作网络：调用 `xc_identify`，`name` 用参数给定的名字（未给定则根据本会话上下文建议一个短小写英文花名并告知用户），`sessionId` 取钩子注入到你上下文中的本会话 sessionId（不要编造）。若参数含 `worker`，`role` 填 `worker`，否则填 `peer`。注册成功后向用户复述返回的花名册（成员名、角色、sessionId）；若注册被拒（名字/sid 冲突），换名重试一次，再失败则把错误如实报告给用户。
