---
description: 使当前会话成为跨会话团队的队长（lead）、移交/释放/接管队长角色，或查看团队全景。
argument-hint: "[可选：transfer <成员名> | release | takeover | 一句话目标]"
skills: crosschat
---

按 `crosschat` 技能的 **lead 协议**处理本请求：

$ARGUMENTS

0. 子形态（v0.5 起 lead 是元数据角色，可指派可移交）：
   - `transfer <成员名>` → 调用 `xc_lead_transfer({ "to": "<成员名>" })`（仅现任队长可执行；任务/邮箱/注册一概不搬）；
   - `release` → 调用 `xc_lead_release()`（卸任，回到 founder 兜底态；协作照常）；
   - `takeover` → 调用 `xc_team_init({ "takeover": true })`（**仅用户明确指令时**：现任队长会话已退出/失联，或用户明确要求换帅；旧队长会被通知，全程审计）。
   其余参数走下方原盘点/拆解流程。
1. 调用 `xc_team_init` 使本会话成为队长（写 `team.leadKey`）。返回 `lead_exists` 说明已有其他队长——**不得抢位**，如实告知用户现任队长是谁，并按用户意愿选择：让现任队长执行 `/xc-team transfer <你>` 移交、等待其 `/xc-team release` 释放，或**若现任队长会话已退出/失联、或用户明确要求换帅，在任意会话执行 `/xc-team takeover` 接管**（通知旧队长并全程审计）；已是队长则幂等成功。
2. 成为队长后调用 `xc_status` 盘点现有成员与任务（技能 L2 纪律：能续用就不新建），把团队全景（队长、成员状态、任务板、DAG、未读数）汇报给用户。
3. 若参数给出了一句话目标：按技能 L3/L4/L5 拆解为可检验任务 DAG（每任务必须有可检验的 `acceptance`），缺角色则 `xc_member_add` 建员（受成员上限），然后 `xc_dispatch` 派发并结束回合等待回执——不要 busy-poll。
4. 若没有参数：停在盘点汇报，等用户给目标。
