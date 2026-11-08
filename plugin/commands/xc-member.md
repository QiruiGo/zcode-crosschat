---
description: 队长专用：动态建员（add）或停止成员（stop）。
argument-hint: "<add|stop> <成员名> [model=模型id] [reason=停止原因]"
skills: crosschat
---

按 `crosschat` 技能处理本请求（两个动作都**仅队长可用**——本会话尚未成为队长时，先提示用户 `/xc-team`）：

$ARGUMENTS

**add**（`/xc-member add <名字> [model=...]`）：
1. 校验名字：短小写英文、非保留名（`lead`/`default` 不可用）、不与现有成员重名；`model` 只在用户显式给出时传递（缺省由引擎从可用模型表选择）。
2. 调用 `xc_member_add({ "name": "<名字>", ...(model ? { "model": "<模型id>" } : {}) })`。引擎会程序化创建成员会话并自动注册，返回 `{sessionId, model, state}`。
3. 成功：向用户汇报新成员的 sessionId/模型/状态，并说明「供给完成即自动投产——先派发后建员的任务会在成员就绪后自动开工」。若该成员邮箱已有积压任务，提示将立即被唤醒投产。
4. 失败：`team_at_member_cap`（成员数已达上限）→ 建议用户先 `xc_member_stop` 或提高上限；`name_reserved`/重名 → 换名重试一次；`not_lead` → 说明仅队长可建员；`member_provision_failed` → 如实报告错误，说明同名重试即可走幂等重供给。

**stop**（`/xc-member stop <名字> [reason=...]`）：
1. 调用 `xc_member_stop({ "name": "<名字>", ...(reason ? { "reason": "<原因>" } : {}) })`。
2. 成功：向用户说明该成员已被停止——不再被唤醒、其开放任务已收回待重派（如需继续这些任务，重新派发或建新成员）、花名保留在花名册可查、shutdown-request 帧已送达其邮箱（在途回合会自然收尾）。
3. 失败：`not_lead` → 说明仅队长可停员；成员不存在 → 如实报告。
