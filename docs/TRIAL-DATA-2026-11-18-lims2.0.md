# 实测监督记录：lims2.0 生产工作区首日全量数据（2026-11-18）

> 监督者：独立监督会话（ZCodeProject 工作区，与被测团队零隶属，纯只读）｜对象：zcode-crosschat **v0.8.1** user 级安装｜方式：每小时例行读 lims2.0 `.crosschat/logs/engine.jsonl` 增量 + 注册表，三分类归因（已使用-成功 / 已使用-失败 / 未使用）。
> 本文档 = [TRIAL.md](TRIAL.md) 真实试用任务的**第一份生产数据包**；缺口分析结论见 [GAP-V0.9.md](GAP-V0.9.md)。
> 数据窗口：2026-11-18 11:00–18:40（9 轮监督，监督进行中，本文件为 18:40 快照）。

## 被测环境（一段话说清）

lims2.0（熙正 LIMS 2.0 工单专项，`D:\工作\work\xizheng\lims2.0`）：十会话团队——调度中枢 `master`（工单雷达）+ 执行成员 `form-fix-3` / `form-mods-4` / `audit-main-8` / `dev-code-5` / `cs-checker` / `qc-forms-7` / `instrument-6` / `xingtai` / `release-10`，各自独立会话、独立工单专责。当天从「全员组网」（11 花名注册）到「任务流水线」（t1~t29）全程经本插件协作，业务域为真实工单流转与 MR 放行链。

## 数据概要（截至 18:40）

| 维度 | 数值 |
|---|---|
| 观察时长 / 日志事件量 | 7.5h / 839 行（其中监督窗口内 717 行） |
| 任务 | t1~t29，**completed 20 单**，dispatch 29 次全部送达（mailbox） |
| 消息 | 队内邮箱 40+ 条全部 delivered；**urgent 插队 9 次**；跨会话 peer 管道 4 条 delivered |
| 花名注册 | 11/12 会话（未注册者为非协作会话） |
| **工具面失败** | **0**（无 error/failed/denied/expired/refused/dropped） |
| 系统性异常 | wake-skipped **128 次**（XC_WAKE_ENABLED=false）；task-swept **4 次**（误扫定性 2/4，见 GAP-V0.9 §5） |

## 时间线（监督轮次摘要）

- **10:35 基线**：插件已加载（hook 正常）但 0 花名 0 调用——「挂着没用」
- **11:00–11:40**：全员组网：11 花名注册，8 封注册回执，队内邮箱消息跑通
- **12:35–12:50**：首个任务闭环（t1：被清扫重做后 completed）
- **13:10–17:32**：流水线化：master 消费回执→批量派单→成员 3–11 分钟交单；MR 放行卡消息流（!7723/!7740/!7748）；urgent 催办启用
- **15:58–17:06**：t17 两度被扫（长任务死循环案例，主控改派收场）
- **17:32–18:28**：**N 系列 publish 上线**（t22：publish 成功+线上冒烟过+规则生效）——从派单到发布的完整链路由插件承载
- 主控于 18:23 转交五项能力缺口清单（本数据包的由来）

## 原始数据文件

`docs/trial-data/2026-11-18-lims2.0-records.jsonl` —— 9 行 JSONL，每行一轮监督。字段：

- `runTs / sinceTs / checkpointTs / logLines / newEvents`：轮次时间与增量范围
- `namedSessions`：花名→会话（及重绑说明）
- `usage`：按事件类型计数（dispatch/claim/report/message/urgent/inbox-check 等，delivered 单列）
- `failures`：失败事件原文（始终为空数组=零失败）
- `anomaly / conclusion`：当轮异常与结论（wake-skipped、task-swept 定性、staleDiscarded 等）
- `gaps`（19:00 起追加）：五缺口跟踪字段（wakeSkipped 累计、swept 逐条定性、误扫率）

## 监督方法备注

- 监督会话与被测团队**无协作关系**（不同工作区、未注册进 lims2.0 团队），只读 `.crosschat/` 状态目录；日志事件分类依据 `xc_overview timeline` 同源事件族。
- `hook-stop-probe`（v1 探针，DESIGN.md §9 V3 待验证项）为设计内行为，不计失败；其「消息送达不唤醒续跑」现象与 G-4 同根因。
- 业务编号（BD/!MR/YF/E 系）为 lims2.0 内部工单/MR 号，保留原样以便主控复盘时对账。
