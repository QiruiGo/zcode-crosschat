---
description: 使当前会话成为跨会话团队的队长（lead），或查看团队全景。
argument-hint: "[可选：一句话目标，作为队长的首个拆解输入]"
skills: crosschat
---

按 `crosschat` 技能的 **lead 协议**处理本请求：

$ARGUMENTS

1. 调用 `xc_team_init` 使本会话成为队长（写 `team.leadKey`）。返回 `lead_exists` 说明已有其他队长——**不得抢位**，如实告知用户现任队长是谁，并询问是否改为向现任队长会话传话或接手其任务；已是队长则幂等成功。
2. 成为队长后调用 `xc_status` 盘点现有成员与任务（技能 L2 纪律：能续用就不新建），把团队全景（队长、成员状态、任务板、DAG、未读数）汇报给用户。
3. 若参数给出了一句话目标：按技能 L3/L4/L5 拆解为可检验任务 DAG（每任务必须有可检验的 `acceptance`），缺角色则 `xc_member_add` 建员（受成员上限），然后 `xc_dispatch` 派发并结束回合等待回执——不要 busy-poll。
4. 若没有参数：停在盘点汇报，等用户给目标。
