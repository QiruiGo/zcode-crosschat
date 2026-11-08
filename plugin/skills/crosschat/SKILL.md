---
name: crosschat
description: 在独立 zcode 会话之间派发、认领、执行、回传任务。当用户要跨会话派活、查看协作收件箱、报告任务结果或询问任务状态时使用。
---

# CrossChat 跨会话协作协议

你在参与跨会话协作：本工作区下可能有多个**互相独立**的 zcode 会话（各自有独立的对话历史，互不归属），通过同一套文件邮箱（`<workspace>/.crosschat/`）互相派发任务、执行并回传结果。你的会话身份与协作状态由插件钩子与 MCP 工具维护，本文件是你必须遵守的协议。

## 1. 身份与注册

- 每条 MCP 连接必须先 `xc_register` 绑定身份，之后所有需要身份的工具（xc_dispatch / xc_claim / xc_report / xc_message / xc_check_inbox）都**不需要也不能传 from/caller 参数**——身份一律取当前连接的绑定身份。
- 交互会话的正常路径：SessionStart / UserPromptSubmit 钩子已经把你的 sessionId 写入注册表并注入给你的上下文。注册用 `xc_register({ "name": "<花名>", "sessionId": "<注入给你的 sid>" })`。
- 花名建议用短小写英文（如 `a`、`b`、`builder`）；同名或同 sid 已被绑定会被拒绝，换一个名字重试即可。
- 被 `--resume` 无头唤醒的回合：唤醒 prompt 里会**显式给出你的 sid 与一次性 wakeToken**，注册时一并带上 `wakeToken`（该路径不依赖钩子，且每个被驱动的回合都要重新注册——这是正常现象，不是故障）。
- `xc_status` 无需注册即可调用（只读观测）。

## 2. 工具一览（7 个 xc_* 工具）

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `xc_register` | `name*`, `sessionId*`, `role?`(peer/worker), `wakeToken?` | 把当前连接绑定为一个协作身份并加入 default 队 |
| `xc_dispatch` | `to*`, `title*`, `prompt*`, `acceptance?`, `dependsOn?` | 派发新任务给目标成员 |
| `xc_check_inbox` | — | 读自己邮箱，读到的消息即刻标记已消费 |
| `xc_claim` | `taskId*` | 认领 pending 任务，返回 attemptId（能力令牌） |
| `xc_report` | `taskId*`, `attemptId*`, `status*`(in_progress/completed/failed), `result?`, `error?`, `evidence?[]` | 汇报任务进展/结果 |
| `xc_message` | `to*`, `content*`, `sourceTaskId?`, `sourceAttemptId?` | 对等自由消息（横向沟通） |
| `xc_status` | `teamId?` | 任务板快照：成员、任务六态、attempt 代数、未读数 |

## 3. 派发纪律（你是派发方）

1. **任务必须可检验**：`title` 一句话；`prompt` 写清要做什么、写到哪个文件、以什么形式；**必须写验收标准**（`acceptance`，如「`result-a2b.txt` 存在且内容为 `391`」）。没有验收标准的任务不许派发。
2. 派发返回 `{taskId, delivered}`：`delivered=wake` 表示已推送唤醒目标会话；`delivered=mailbox` 表示消息已落盘、等对方下一回合拉取注入或主动查收；`duplicate` 表示同文消息已在效期内存在，没有重复投递。三种都是正常态。
3. 派发后**耐心等待**：任务完成或对方回消息时你会被唤醒（或下一回合自动注入未读提示）。**不要 busy-poll**（不要反复调 xc_check_inbox / xc_status 空转），把回合让位给用户。
4. 收到回执后：`xc_check_inbox` 读回执 → `xc_status` 看全程 → **按 acceptance 用自己的文件工具复核证据**（如直接读结果文件比对数值）→ 再向用户汇报。回执没核对前不要宣称任务完成。

## 4. 执行纪律（你是执行方）

1. 被唤醒或收到未读注入后，**先 `xc_check_inbox`**，再决定动作。
2. `xc_claim(taskId)` 成功后返回的 `attemptId` 是你唯一的工作凭证：后续 `xc_report` 必须携带它。
3. 认领后先 `xc_report(status="in_progress")`（可选但推荐），执行完成后必须 `xc_report(status="completed", result=..., evidence=[...])`。
4. **报告 completed 必须带**：`result`（结果摘要）+ 至少 1 条 `evidence`。evidence 条目格式 `{"path": "<绝对路径>", "sha256": "<hex|null>", "note": "…"}`——文件类证据尽量带上 sha256（工具会帮你算）；执行类任务把验收点写进 note。
5. 做不到/失败也要报告：`xc_report(status="failed", error=...)`，不要静默消失。
6. 任务被别人先认领（`xc_claim` 返回失败）→ **立即 `xc_check_inbox` 看是否还有其他未读；没有就直接结束回合**。不得重试同一任务，不得 busy-poll——派发方或调度会再来找你。
7. `xc_report` 返回 stale/attempt 不匹配 → **立即停手**：你的工作已被重派接管，旧成果不要再写入任何共享位置。

## 5. 等待纪律（所有人）

1. 等待期间**让位不空转**：不要为「等回执」而反复轮询任何工具。你的回合该结束就结束——报告会唤醒你，或你下一回合开始时钩子自动注入未读提示。
2. 变更类工具返回 `{"error":"busy"}`（跨进程锁被占）→ **稍后重试一次**；仍忙则如实上报用户，不要连环重试。
3. `xc_message` 用于对等沟通（澄清需求、同步进展）；带任务上下文时填 `sourceTaskId`/`sourceAttemptId`，过期的任务关联消息会被自动作废，不影响新 attempt 的工作。

## 6. 独立性边界（必须知道）

- 协作各方是**对等独立会话**：没有「队长-队员」控制关系，你不受其他会话指挥，只受本协议与用户约束。
- 你看不到其他会话的对话历史；跨会话可见的只有对方主动写入邮箱/任务报告的内容。**不要把敏感内容写进邮箱**。
- 任务状态以 `xc_status` 与磁盘真源为准；对任务归属/状态有疑问时先查快照，不要凭记忆争论。
