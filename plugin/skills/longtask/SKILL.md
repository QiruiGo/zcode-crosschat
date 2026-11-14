---
name: longtask
description: 长期任务的三行约定——任务日志、交接、压缩前留档。当任务是长任务/长期任务、要跨天执行、新会话要接手或交接他人任务、成员即将休眠（xc_team member-stop）、上下文即将被压缩、或容量预警（xc_overview 标红）需要先落盘再压缩时使用。
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
2. `xc_read({ "scope": "journal", "id": "archive:<名>" })` 读成员留档，或 `xc_read({ "scope": "journal", "id": "<taskId>" })` 读单任务日志——当前进度与交接注意在这里。
3. `xc_read({ "scope": "task", "id": "<taskId>", "field": "prompt" })` 取任务原文，然后以**新 attempt** `xc_claim` 认领续作（旧 attempt 已失效，直接用会得 stale-attempt）。
4. 接手后在任务 journal 第一行记「接手」（时间 | 接手人 | 从哪一步继续）。

一句话恢复模板：**接手 \<名\>：identify → 读 archive:\<名\> journal → 按 journal 指针读 task prompt → 认领续作。**

## 3. 压缩前 checklist（容量预警或自知即将压缩时，逐项过完再压缩）

- [ ] journal「当前进度」写全：此刻做到哪一步、下一步具体动作是什么；
- [ ] 全部产物路径落成 journal 行（压缩后你记忆里的路径不作数）；
- [ ] `xc_report({ "status": "in_progress" })` 附 journal 路径——给 lead/创建者一个落盘指针；
- [ ] 以上完成**之后**才接受压缩；成员休眠走 `xc_team({ "action": "member-stop" })`（缺省先写 `.crosschat/archive/<名>/` 留档再停，任务回池不丢）。

> 容量预警（`xc_overview` 标红）出现时，把本 checklist 当作压缩前置条件执行：journal 是唯一承诺落盘的副本。
