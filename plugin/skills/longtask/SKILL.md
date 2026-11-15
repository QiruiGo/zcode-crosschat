---
name: longtask
description: 长期任务的三行约定——任务日志、交接、压缩前留档。当任务是长任务/长期任务、要跨天执行、新会话要接手或交接他人任务、成员即将休眠（xc_team member-stop）、上下文即将被压缩（先 /xc-checkpoint 落检查点、再落 journal）、或容量预警（xc_overview 容量标红 / capacity.red）需要先落盘再压缩时使用。
---

# longtask：长期任务三行约定（C4）

长期任务（跨天、换会话、无人值守是常态）唯一承诺落盘的副本是 journal：上下文随时可能被压缩、会话随时可能被替换，**没写进 journal 的进展等于没发生**。三行约定都是提示词纪律——工具不校验内容，但接手人读档时只看得到 journal。

## 1. 日志（进行中任务，每次实质进展追加一行）

- 路径：`.crosschat/tasks/<taskId>/journal.md`（目录不存在就创建；纯文件写入，不需要工具）。路径由任务 id 构成，不要自造。
- 每次实质进展追加一行，行格式：

  ```
  - YYYY-MM-DD HH:MM | 一行摘要 | 产物路径或指针
  ```

- 节奏：宁可碎、不可断——每完成一步、拿到一个中间产物、做出一个方向性决定就写一行；`xc_report({ "status": "in_progress" })` 之前先写。
- 文件顶部维护两节（随做随更）：

  ```markdown
  # <任务标题>（<taskId>）
  ## 当前进度
  - 2026-11-14 15:02 | 完成 X，产物 D:\ws\out\x.txt
  ## 交接注意
  - <下一个接手的人必须知道的事：坑、未验证的假设、产物位置>
  ```

## 2. 交接（新会话接手，三步内进入状态）

1. `xc_identify({ "name": "<原名>" })` 绑定本名——旧会话已被 kill/崩溃时加 `takeover: true`（立即换绑、其名下任务回池；误判可恢复，见 README 接管语义）；带 takeover 重绑被拒（`takeover_inflight`）说明旧会话回合还在跑，等它收尾。
2. `xc_read({ "scope": "handoff" })`（等价命令 `/xc-handoff`）**一次拿全七要素**：身份、我的任务（状态/attempt/最后进展/阻塞原因）、待领池前 10、未读摘要、容量水位、最近检查点路径与年龄、建议下一步。要收窄到单个任务或某个成员就加 `id:"<taskId|花名>"`。
3. 按 `suggestions` 行动：目标任务已回 pending 时以**新 attempt** `xc_claim` 认领续作（旧 attempt 已失效，直接用会得 stale-attempt；`xc_claim` 只接 pending，非 pending 得 `task_not_pending`）——仍是他人 in_progress/claimed/blocked 的任务走同名 `xc_identify({takeover:true})` 或等 stale 清扫回池，**别发出走不通的指令**；依赖未满足的记为等待项，blocked 的走 `xc_team({action:"unblock"})` 或 cancel。
4. 接手后在任务 journal 第一行记「接手」（时间 | 接手人 | 从哪一步继续）。

全文仍按 scope 分页取：`xc_read({scope:"journal", id:"archive:<名>"})` 读成员留档、`xc_read({scope:"journal", id:"<taskId>"})` 读单任务日志（「当前进度」与「交接注意」在这里）、`xc_read({scope:"task", id:"<taskId>", field:"prompt"})` 取任务原文。

一句话恢复模板：**接手 \<名\>：identify → /xc-handoff（xc_read handoff）→ 按建议下一步 claim/续作。**（工具调用口径 = 3 次：identify → handoff → claim/续作；handoff 响应带 `truncated` 时按响应末行的指针用 `xc_read` 对应 scope 取全文，不得当作「没有这些内容」。）

## 3. 压缩前 checklist（`xc_overview` 容量标红 / capacity.red，或自知即将压缩时，逐项过完再压缩）

- [ ] `/xc-checkpoint`（= `xc_team({action:"checkpoint"[, note:"<一句话>"]})`，**服务端直接落盘**）：一条命令把身份 / 我的任务 / 待领池 / journal 摘要 / 未读摘要 / 建议下一步 / note 写进 `.crosschat/checkpoints/<你>/<ISO>.md`（每 agent 保留最近 20 份）——接手所需七要素一次落齐，**不要自己写文件**；返回 `capacity.level = RED` 时本条更要先做；
- [ ] journal「当前进度」写全：此刻做到哪一步、下一步具体动作是什么；全部产物路径落成 journal 行（压缩后你记忆里的路径不作数）；再 `xc_report({ "status": "in_progress" })` 附 journal 路径——给 lead/创建者一个落盘指针；
- [ ] 以上完成**之后**才接受压缩；成员休眠走 `xc_team({ "action": "member-stop" })`（缺省先写 `.crosschat/archive/<名>/` 留档再停，任务回池不丢）。

> 容量预警（`xc_overview` 容量标红 / capacity.red）出现时，把本 checklist 当作压缩前置条件执行：journal 是唯一承诺落盘的副本，检查点是接手面的落盘副本。压缩联动是**建议级非拦截级**——**平台（zcode 3.18.2）无压缩钩子（无 PreCompact/PostCompact），插件只能「UserPromptSubmit 轻量提醒 + 一键 `/xc-checkpoint`」，拦不住压缩本身**：提醒默认开启（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次），不需要可设 `XC_CHECKPOINT_NUDGE=0`。规则靠回合自觉：看到标红或提醒，先 `/xc-checkpoint` 落盘、再落 journal，**之后**才接受压缩。

### lead 操作序（容量标红时，C9）

1. `xc_relay` 提醒目标成员：容量已标红，先按本 checklist 落检查点（`/xc-checkpoint`）与 journal；
2. 等目标 `xc_report({ "status": "in_progress" })` 附 journal 路径——板面上看到指针即算落盘（或该成员已落过检查点，见 `xc_overview({view:"status"})` 的 checkpoint 年龄行）；
3. 确认落盘后才允许其接受压缩；目标迟迟不落盘按任务流程处理（重派/接管），不反复催压缩。
