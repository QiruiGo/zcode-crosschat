# GAP-V0.2：zcode-crosschat v0.1.0 与 Claude Code 协作模式差距分析

> 分析人：差距分析员（dynamic workflow 子代理）｜日期：2026-11-09
> 基准：Claude Code 官方文档本地快照（`<证据仓>\evidence\doc-agent-teams.html` / `doc-cross-session-messaging.html` / `doc-sub-agents.html`，2026-11-08 抓取）+ 能力锚定报告（`reports/02-能力锚定.md`，8 条能力清单）
> 对照对象：zcode-crosschat v0.1.0（本仓库 README/docs）+ 09 验证报告实测结论 + dsh-agent-teams 0.1.29 源码参考
> 纪律：每条结论给证据（引用快照原文 / 源码 `路径:行号` / 实测命令与输出）；查证不到的标「未确认」；差距只允许来自实测证明的平台限制，**不得以形态自选/简化为由降低能力范围（换栈不降效）**。
> 引用说明：CC 文档引用格式 `doc-*.html（提取文本行 N）`——提取文本为本会话由 HTML 快照解析生成（Temp 目录，解析脚本仅提取 script/style 外文本），引文均经 grep 在 HTML 原文复核存在。

---

## 1. 结论速览

| 判定 | 条目 |
|---|---|
| **已达标**（4 项子能力） | C5 状态机与原子认领、C3 消息通道本体（邮箱+未读注入）、C2 回执与证据链、C8 磁盘观测面 |
| **部分达标**（8 项） | C1 派发、C2 回传、C3 通道、C4 组队、C5 队列、C6 并行、C8 可视接管（详见 §3） |
| **缺失**（2 项） | C4 的 lead-队员控制关系（模式核心之最）、C7 执行环境隔离 |
| **核心差距**（6 条，必须闭合） | G1 lead-队员协调；G2 成员自动开工（事件驱动调度）；G3 动态成员创建与管理；G4 多任务并行驱动与并发上限；G5 团队进度可视与统一接管；G6 消息安全硬保证（详见 §5） |
| **可选差距**（13 条） | 质量门族、计划评审、worktree 隔离、会话发现扩展等（详见 §6） |

一句话定性：**v0.1.0 是一个真实可用的「对等邮箱协作」底座（磁盘真源+状态机+证据链质量高），但它不是 Agent Teams 模式**——Claude Code 协作模式的三根支柱（lead 自动拉起并协调成员、空闲成员自动开工、任务图事件驱动推进）在 v0.1.0 中全部缺位或退化为人工驱动；这些缺位**不是平台禁区**（§7 逐条给出已达成的实测证据链），属 v0.1.0 范围裁剪，必须在 v0.2 闭合。

---

## 2. Claude Code 协作模式能力清单（基准，逐项文档依据）

### 2.1 组队形态（agent-teams 文档，协作模式核心）

| # | 能力 | 文档依据（引文经 grep 复核） |
|---|---|---|
| T1 | lead+teammates 结构：一个 lead 会话拉起多个**完整实例**作队友，lead 协调/分派/汇总，队友各自独立上下文 | doc-agent-teams.html：「Agent teams let you coordinate multiple Claude Code instances working together. **One session acts as the team lead**, coordinating work, assigning tasks, and synthesizing results. Teammates work independently, each in its own context window」（提取文本行 52） |
| T2 | 自然语言组队 + **自动生成成员**：按 prompt 拉起队友；开启组队后被 Claude 命名的 subagent 自动升格为 teammate（「teams can form even when you didn't ask for one」） | 同上：行 100「describe the task and the teammates you want in natural language. Claude spawns them and coordinates work based on your prompt」；行 95、245「a subagent that Claude names launches as a teammate」 |
| T3 | 成员数量/模型/角色可指定；subagent 定义复用为 teammate 角色（tools/model/effort/body 应用） | 行 157-171（「Spawn 4 teammates… Use Sonnet for each teammate」与四级模型选择序）；行 274-295（「Use subagent definitions for teammates」） |
| T4 | 成员间**直接互发** SendMessage；每 agent 独立 mailbox JSON 文件，**写成功才算发送成功** | 行 75-77（对比表「Teammates message each other directly」）；行 257-258（mailbox 路径 `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`；「Claude Code reports a message as sent only when the write to the recipient's mailbox file succeeds」） |
| T5 | 共享任务列表 TaskCreate/TaskGet/TaskList/TaskUpdate；三态 pending/in_progress/completed；依赖产生 blocked 且**完成后自动解除** | 行 210（三态与 blocked）；行 259（「when a teammate completes a task that other tasks depend on, **it unblocks the dependent tasks** without any action from you」） |
| T6 | lead 显式指派 **或** 成员自领取未指派未阻塞任务；自领取**用文件锁防竞争** | 行 212-218：「after finishing a teammate picks up the next unassigned, unblocked task on its own」「**Task claiming uses file locking** to prevent race conditions」 |
| T7 | 空闲通知：队友完成后**自动回报 lead** 并附最终答案；API 错误也回报 | 行 331：「Idle notifications: when a teammate finishes and stops, it automatically notifies the lead and includes its final answer… A teammate whose turn ends on an API error notifies the lead that it failed」 |
| T8 | 自动投递：lead 无需轮询 | 行 329：「Automatic message delivery: … The lead doesn't need to poll for updates」 |
| T9 | 权限与消息安全：队友权限提示**冒泡到 lead 人工审批**；消息不能代批权限、不能代改配置、被拒动作不能经他人转包绕过；分类器审查 agent 间消息 | 行 312、316、317-321（「A teammate can't approve a permission prompt or supply consent on your behalf, and a teammate that was denied an action can't relay it to another teammate to bypass the check」） |
| T10 | 质量门钩子：TeammateIdle / TaskCreated / TaskCompleted，exit 2 阻断并发回反馈 | 行 233-237 |
| T11 | 计划先行：plan mode 下的 lead 生成的队友也 plan mode，计划批准后才实施 | 行 185-190 |
| T12 | 优雅关闭：shutdown request，队友可批准/拒绝 | 行 222-227 |
| T13 | 观测与接管：agent 面板（↑↓ 选择、Enter 看 transcript 并直发消息、Esc 中断当前回合、x 停止、Ctrl+T 任务列表）；in-process 或 split panes 两种展示 | 行 109-118、129-131、196-198 |
| T14 | 唤醒：lead/队友消息可唤醒等待重试的队友立即重试；点名队友请求关闭 | 行 479、222-227 |
| T15 | 模式边界（官方自述限制）：无嵌套 team、lead 固定、一 session 一 team、无 spawn 时 per-teammate 权限模式、agent teams **不自动 worktree 隔离**（靠文件归属划分） | 行 490-509（Limitations）；行 419-420（「Avoid file conflicts: Break the work so each teammate owns a different set of files」） |

### 2.2 跨会话消息通道（cross-session-messaging 文档）

| # | 能力 | 文档依据 |
|---|---|---|
| M1 | 会话发现 ListAgents：列出本会话子代理、队友、**本机其他未注册的 zcode/CC 会话**、云会话、跨机会话 | doc-cross-session-messaging.html 提取文本行 145-155；`ListAgents` 在快照中出现 7 次（grep 复核） |
| M2 | SendMessage 任意两会话互发：同机走 per-session socket/命名管道（**不经服务器**）；跨机走 Remote Control | 行 175-180（传输方式表）；行 51（v2.1.224+/2.1.234+ 版本门槛） |
| M3 | 投递不打断：运行中会话在**工具调用间隙**读取；空闲则新开回合 | 行 93：「The receiving Claude reads the message between tool calls during an active turn, so a running tool is never interrupted」 |
| M4 | 入站策略 accept/hold/refuse + 审批对话框 + dialogExpiry（默认 5 分钟）；hold 上限 100 条 | 行 229-256（`crossSessionInbound` 在快照中出现 13 次，grep 复核） |
| M5 | 权限边界按会话硬保证：消息不能代批、不能改配置、消息内命令当纯文本不执行 | 行 200-206 |
| M6 | idle notice 订阅（`notify_when_idle`，12h 超时自动取消） | 行 118-134；`notify_when_idle` 在快照中出现 3 次（grep 复核） |
| M7 | 观测：一行暗色预览 + Ctrl+O 开 transcript 展开 | 行 210-218 |
| M8 | 通道限制：纯文本；同机单条约 100 万字符；burst 限流；**队列最多 50 条**；循环自动止息 | 行 373-379（「queues at most 50 accepted messages」grep 复核原文） |

### 2.3 执行体基线（sub-agents 文档）

| # | 能力 | 文档依据 |
|---|---|---|
| S1 | 独立上下文 + 自定义 system prompt + 工具集 + 模型；只回传摘要 | doc-sub-agents.html 提取文本行 47-53、250-273 |
| S2 | 前台阻塞/后台并发（并发上限默认 20，`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 可配）；后台完成以**完成通知**回报 | 行 840-880；行 996-998（变量名在快照出现 2 次，grep 复核） |
| S3 | **已结束子代理按 agent ID/名字用 SendMessage 恢复续聊**（保留完整历史） | 行 1040-1061（「Claude uses the SendMessage tool with the agent's ID or name as the `to` field to resume it」，注：HTML 内为弯引号） |
| S4 | transcript 落盘 JSONL（`subagents/agent-{agentId}.jsonl`） | 02-能力锚定.md §C2；官方文档摘要.md |
| S5 | 三种触发：自然语言 / `@agent-<name>` 显式 / `--agent` 会话级 | 行 794-830 |
| S6 | `isolation: worktree` 可选工作区隔离（临时 git worktree，无改动自动清理） | 行 274-285、312；`isolation: worktree` 在快照出现 4 次（grep 复核） |
| S7 | 嵌套上限 ≤3 层（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`） | 行 975-993 |
| S8 | 持久记忆：memory 字段（user/project/local 三作用域，「persistent directory that survives across conversations」） | 行 611-660 |
| S9 | maxTurns 上限→输出标 partial→可恢复续跑 | 行 303、1047 |
| S10 | 权限提示浮到主会话，命名哪个子代理在请求 | 行 845、878 |

> 8 条验收锚定（C1-C8）即 02-能力锚定.md §3，与上表 T/M/S 项的映射在 §3 对照表中逐行标注。

---

## 3. 逐项对照：v0.1.0 现状判定

> v0.1.0 证据约定：README = `<仓库路径>\README.md`；tools.ts = `plugin/src/mcp/tools.ts`；09 = `<证据仓>\reports\09-zcode验证.md`；DESIGN = `docs/DESIGN.md`。判定分三档：**达标 / 部分 / 缺失**。

### C1 任务委托派发 —— **部分**

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 显式指名派发 | **达标**：`xc_dispatch` 把可检验任务（标题+内容+验收标准+dependsOn）投进目标邮箱，幂等去重；`/xc-dispatch` 斜杠命令整理描述 | README.md:95、:107；tools.ts:272（`xc_dispatch` 实现入口）；09 §3 第一环实测 | C1/T2 | — |
| 可检验任务规格 | **弱于基准**：只有 标题+内容+验收标准；dsh 派单含完整合同（objective/inScope/outOfScope/acceptance/verify）与依赖输出注入 | README.md:95；对照 dsh scheduler.js:125-179（assignmentPrompt） | dsh 补充 | 见 §6 O-11 |
| 自动拆解与分派 | **缺失**：无 lead 角色，无「lead 自动把工作拆成任务并分派给成员」 | README.md:12「没有队长-队员控制关系」；DESIGN §3 形态乙 | T1/T2、T6（「The lead breaks work into tasks and assigns them to teammates automatically」doc-agent-teams.html 行 406） | **G1** |

### C2 结果回传 —— **部分**

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 回执与证据链 | **达标**：`xc_report` completed 必须 result+≥1 evidence（工具侧现算 sha256）；回执落派发方邮箱、readAt 消费盖章；09 t1 三环实测 sha256 一致 | README.md:19-20；tools.ts:475（`xc_report`）；09 §3 第二/三环 | C2/S2 | — |
| 完成自动回报（空闲通知） | **部分**：pull 兜底完整（回执入箱+下一回合注入）；push 自动推醒受 **V9** 阻断——CLI 单发派发方触发的 wake 子进程被连带清杀（引擎唤醒 B 成功、B 完成后唤醒 A 死亡）；且 `wake_enabled` 默认 false | 09 §4.3（V9 定位实验：死亡时刻≈派发者 CLI 退出时刻；常驻属主形态 wake-b 全自动跑通）；README.md:117（默认关）；DESIGN §2.5（wake 仅属主缺席会话） | T7（自动回报 lead） | **G2/G4** |
| 已结束执行体唤醒续聊 | **部分**：`xc_message` 可对等发消息（会话独立、`--resume` 记忆连续已实测），但无「按 agent ID 恢复子代理并保留其执行上下文」的子代理形态 | README.md:108；tools.ts:603（`xc_message`）；PLATFORM.md §4.4（resume 记忆连续 391→782→…实测）；对照 S3 | S3 | 形态差异，随 G1 一并评估（成员改为引擎托管会话后此能力自然补齐） |

### C3 会话间消息通道 —— **部分**（通道本体达标，安全与发现缺位）

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 互发文本消息 | **达标**：`xc_message` 对等自由消息；邮箱 JSONL 全生命周期字段（投递/已读/作废）；isCurrentMail 过期裁决；损坏行跳过容错 | README.md:108、:130；tools.ts:603；core/mailbox（DESIGN §2.4 移植 dsh createMessage） | M2、T4 | — |
| 投递不打断 | **达标（等效形态）**：未读经 UserPromptSubmit 钩子 `additionalContext` 注入下一回合，不打断当前回合 | README.md:18；09 §5（hook-prompt-submit-unread×11 审计行） | M3 | — |
| 会话发现 | **缺失（范围）**：只见 `/xc-work` 自注册进网络的花名（roster），**不能发现本机其他未注册 zcode 会话** | README.md:94、:132；对照 M1 | M1 | 见 §6 O-4 |
| 入站策略 | **缺失**：消息无条件进邮箱，无 accept/hold/refuse 分级与审批对话框 | tools.ts:603-700（无入站裁决分支）；对照 M4 | M4 | 见 §6 O-5 |
| 消息安全硬保证 | **缺失（协作假设级）**：身份=钩子落盘+wakeToken+新鲜度三重交叉，「模型理论上可以谎报会话 id」；无「消息不能代批权限/代改配置」的工具侧硬校验 | README.md:153（已知限制自述）；对照 T9/M5 | T9/M5 | **G6** |
| 容量与限流 | 未实现（无单条上限、无队列上限、无循环限流）；但 isCurrentMail+幂等去重已防同文刷屏 | README.md:111（重复派发幂等去重）；对照 M8 | M8 | 见 §6 O-13 |
| idle notice 订阅 | **缺失** | — | M6 | 见 §6 O-6 |
| 跨机/云 | **缺失**（v1 明确单 workspace，跨 workspace 都留 v2） | DESIGN §3.3（v1 要求两会话同一 workspace） | M2 跨机部分 | 见 §6 O-7 |

### C4 多实例组队（lead+teammates）—— **缺失**（模式核心差距之最）

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| lead-队员控制关系 | **缺失**：README 与 DESIGN 显式声明「全独立对等会话」「没有队长-队员控制关系」——这是形态选择，不是实现缺憾，但对照 Claude Code 模式即能力缺位 | README.md:12；DESIGN §3.1-3.2（形态乙及四条理由） | T1 | **G1** |
| lead 拉起成员实例 | **缺失**：成员必须是用户手动打开的既有会话自注册（`/xc-work`）；无「lead 生成完整成员实例」 | README.md:74-85（两会话各自手动 /xc-work）；tools.ts:255（`xc_register` 仅登记自荐身份） | T2 | **G3** |
| 成员动态 add/remove | **缺失**：无 add_member/remove_member 工具；花名只在注册时增、无主动移除 | 工具面仅 7 个（tools.ts:214-220 接口清单） | dsh agent_teams_add_member/remove_member（tools.js:1190-1260） | **G3** |
| 成员上限 | **缺失**：无 maxMembers 类配置，成员数不设防 | tools.ts 全文无成员数上限检查 | dsh index.js:100（默认 8）+ tools.js:1214-1215（超限抛错） | **G3** |
| 子代理定义复用为队友角色 | **缺失**：无角色定义文件机制；角色只有 `/xc-work a worker` 一个「值班执行」标记 | README.md:94 | T3 | 见 §6 O-12 |

### C5 共享任务队列与状态跟踪 —— **部分**（状态机达标，事件驱动缺位）

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 任务状态机 | **达标**：六态（pending/claimed/in_progress/completed/failed/cancelled）+ attempt 代数 + history 时间线，全落盘跨会话持久 | README.md:129；core/teamstate.ts:99-171（建单/认领/历史） | C5/T5 | 无 blocked 显式态属可接受差异（claim 时动态检查依赖，功能等效，§6 O-14 附带说明） |
| 原子认领防竞争 | **达标**：进程内 promise 链 + 跨进程 O_EXCL lockfile（含陈旧锁强夺），真实双进程用例 | README.md:143；tools.ts:414-449（`xc_claim`）；09 §2（167 用例含锁竞争） | T6（「Task claiming uses file locking」） | — |
| 依赖门控 | **达标**：claim 时 `dependencies_unmet` 硬拒（dependsOn 引用校验 + 未完成依赖清单返回） | tools.ts:434-441（实测读源：`const unmet = unsatisfiedDependencies(team.tasks, task.dependsOn); if (unmet.length > 0) throw …`）；core/teamstate.ts:130-134 | T5 | — |
| 依赖完成自动解除并**自动开工下游** | **缺失**：解除靠下次 claim 时动态检查，**无事件驱动重派**——依赖完成后不会唤醒/触发下游成员；下游要等用户回合或 wake 才知道 | tools.ts:434（仅被动检查）；无任何任务完成事件→派发路径（grep 全 tools.ts 无完成事件回调） | T5（「it unblocks the dependent tasks without any action from you」）+ dsh scheduler.js:465（`ctx.on('agent/status')` 边沿驱动） | **G2** |
| 成员自领取 | **部分**：协议上成员可在待领任务中挑（claimed 状态语义存在），但「完成一单自动领下一单」无人驱动——每单都需人工回合触发 | README.md:19（人工 claim 流程）；09 §3（t1 链条每环由脚本回合驱动） | T6（自动自领取） | **G2** |
| 任务钩子族 | **缺失**：无 TaskCreated/TaskCompleted 类门禁钩子（zcode 插件钩子事件只有 7 个会话级事件，无任务事件——PLATFORM.md §2.2：SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop） | 对照 T10 | T10 | 等效门禁可在工具实现内做（dsh 即工具内实现，quality-gates.js 纯函数零 I/O），见 §6 O-1 |
| reassign / amend | **缺失** | 工具面无此二工具 | dsh agent_teams_reassign_task/amend_task | 见 §6 O-10 |

### C6 并行多会话编排 —— **部分**

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 多任务并行 | **部分**：状态机支持多任务并存（t1/t2/t3 实测），但并行执行靠**多个用户回合人工驱动**，无自动推进 | 09 §3-§4（三任务、每环脚本回合） | C6/T5 | **G4**（与 G2 同根：自动驱动） |
| 并发/成员上限 | **缺失**：无 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`、dsh maxMembers 的任何等效 | 全源码无上限配置 | S2（默认 20 可配）；dsh index.js:100 | **G3/G4** |
| 统一派发/监控/停止入口 | **缺失**：`xc_status` 是只读快照，不能从一处派发、停止或进入某成员 | README.md:109；tools.ts:700 | T13、C6（「claude agents」agent view） | **G5** |
| 批量编排（/batch、dynamic workflows 等效） | **缺失**（v1 边界外，DESIGN §5 明示不把编排放动态工作流并给出理由） | DESIGN §5 末段 | C6 | 见 §6 O-13 注：DESIGN 已论证动态工作流实例不持久、不能承载模型自主协调，等效物应是引擎内调度器（G2），本项不单列核心 |

### C7 执行环境隔离 —— **缺失**

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 工作区隔离 | **缺失**：成员共享同一 workspace 文件系统（共享面=磁盘真源目录），无 worktree/分支隔离选项 | DESIGN §3.3（共享面正面清单） | S6（子代理可选 worktree） | 注意：CC **agent teams 本身也不自动隔离**（T15：官方要求文件归属划分，doc-agent-teams.html 行 419-420）——故本项不列核心，见 §6 O-3 |
| 路径归属审计 | **缺失**：无 in-scope/out-of-scope 路径审计（dsh 有 classifyChangedPath/工件指纹） | tools.ts `xc_report` 仅查 evidence 存在性与 sha256 | dsh quality-gates.js:139-149（classifyChangedPath）、:868（artifactDrift） | 见 §6 O-1（随质量门族） |

### C8 人可观测、可接管 —— **部分**

| 项 | v0.1.0 现状 | 证据 | 对照基准 | 缺口 |
|---|---|---|---|---|
| 过程落盘记录 | **达标（等效形态）**：engine.jsonl 每步动作一行（09 实测 62 行：register/dispatch/claim/report/wake/hook 全链可查）+ team.json history + inbox 全生命周期字段 | 09 §5；README.md:125-134 | S4/C8 | 无逐 token transcript（形态差异：成员本就是用户可见的完整会话，transcript 在各自窗口内） |
| 统一面板 | **缺失**：无 agent 面板等效（行选择/看 transcript/直发/停止/任务列表一体）；zcode 无插件 UI 注入点（ui.surfaces 是面板资源非任意 DOM，PLATFORM.md §2.1） | 对照 T13；PLATFORM.md §2.1 | T13 | **G5**（需文件真源+快照+常驻渲染等效方案） |
| 进入单个执行体干预 | **部分（形态差异）**：全独立会话形态下每个成员本来就是用户桌面上可见的完整会话，可直接切窗口对话——这是形态乙的天然优势；缺的是「从一处进入」 | DESIGN §3.3 | T13 | — |
| 停止成员/取消任务 | **缺失**：无停止某成员会话、取消在途任务的工具（cancelled 态存在于状态机但无工具入口——源码自证：core/types.ts:10「pending -> cancelled edge that has no v1 tool entry (kept for v1.5」；grep 全 tools.ts 无 cancel 字样） | core/types.ts:10；tools.ts:214-220 工具接口清单 | T13（x 停止） | **G5** |
| 权限审批不绕过人 | **达标（形态差异）**：每成员是完整会话，权限审批在各自会话内照常弹（zcode 宿主行为）；对比 CC 冒泡到 lead——v0.1.0 无 lead 故无冒泡目标；G1 落地后需补冒泡等效 | DESIGN §3.3（对等会话本就拥有完整工具权限与审批面） | T9 | 随 G1/G6 评估 |

---

## 4. dsh-agent-teams 有而 v0.1.0 无的能力（参考补充，逐项源码行号）

> dsh 源码根：`<证据仓>\src\dsh-agent-teams-0.1.29\`。全部为本会话亲读源码确认。

| # | 能力 | dsh 证据 | v0.1.0 现状 |
|---|---|---|---|
| D1 | **事件驱动调度器**：监听 `agent/status` 边沿→kickMember 原子认领→唤醒 durable 成员；成员队列串行化；空闲即领下一单 | scheduler.js:181-471（`installTeamScheduler`；:465 `ctx.on('agent/status', …)`） | **无**（G2） |
| D2 | **动态成员管理**：`agent_teams_add_member` / `remove_member` 运行时增删；maxMembers 上限默认 8，超限硬拒 | tools.js:1190-1260（add_member 全流程：查重/上限/LLM 选择/工具策略/入队）；tools.js:1214-1215（`is at its member cap` 抛错）；index.js:100（`maxMembers: z.natural().min(1).default(8)`） | **无**（G3） |
| D3 | **durable continuable 成员**：每成员是 captain 的持久子会话，引擎持句柄可 steer/interrupt/followup；成员报告持久进 captain 邮箱与任务记录 | members.js:2-10（模块注释明示）；:944-984（deliverToMember/interruptMember） | 无（成员=独立顶层会话；resume 可部分等效「可续聊」但无宿主级托管） |
| D4 | **质量门族**：任务 kind 族（requirements/implementation/verification/review/repair/integration）；合同字段；verdict=pass/needs_revision 拒收发现；结构化完成载荷（acceptanceResults/commandsRun/changedPaths）；修复轮次（requirements 1-4 轮、code 3 轮、repair 2 次）；覆盖率矩阵；工件指纹与漂移；评审绑定修订版快照 | quality-gates.js:7-27（kind 与默认评审策略）；:206（validateCreateTask）；:356（evaluateQualityCompletion）；:684（planQualityFollowUp）；:801（buildCoverageMatrix）；:868（artifactDrift）；:1252（contractStaleness）；:894（bindReviewToRevision，issue #161 verdictStartSnapshot 在 scheduler.js:298-302 应用） | **无**（v1 只移植 evidence+sha256 极简版；DESIGN §5 自述「完整族延后 v1.5」） |
| D5 | **计划评审**：staged plan → Approve & Run（Web 路由+steer 批准消息+计划编辑器） | index.js:258-404；client/StagingPlanEditor.js | **无**（v1 以派发前对话确认等效；DESIGN §5） |
| D6 | **14 个 agent_teams_\* 工具** vs v0.1.0 的 7 个 xc_*：多出 add_member/remove_member/reassign_task/amend_task/approve/edit_plan/resume/delete | tools.js（grep `agent_teams_[a-z_]+` 共 14 个） | 7 个（tools.ts:214-220） |
| D7 | **成员工具策略与派生深度护栏** | tool-policies.js；members.js:992（installMemberDelegationGuard） | **无**（DESIGN §5 自述 v1 弃用，理由=对等会话完整权限是形态语义） |
| D8 | **兜底模型路由与失败代际归属**：模型失败自动切 fallback 路由；错误归类与 durable captain note；失败成员开放 attempt 处置 | members.js:106-214（isFallbackFailureCode/selectFallbackRoute/classifyMemberFailure/failMemberOpenAttempt） | **无**（v1 错误经 xc_report(failed) 正常回传；DESIGN §5） |
| D9 | **Web 面板**：花名册/DAG/活动流/审批 UI | client.js（4640 行）+ ActivityPanel.js 等 | **无**（zcode 无注入点；xc_status 快照+磁盘真源替代） |
| D10 | **依赖输出注入派单**：派单 prompt 自动携带已完成依赖的输出（单依赖 2000 字符、总 12000 字符截断预算） | scheduler.js:20-23（常量）、:35-93（collectCompletedDependencyOutputs/formatDependencyOutputs）、:344（装配进 ticket） | **无**（依赖任务只记录 id，不传输出） |
| D11 | **派发失败自动回滚与恢复**：dispatch 失败按 attemptId 精确回滚（恢复上一代或回 pending）；恢复代 parked 防无限重试；captain 接管的未完成任务回合结束自动回池 | scheduler.js:358-393（回滚）、:273-310（parkedAttempts）、:405-434（captain 回池） | **无**（v0.1.0 无引擎派发，故无此失败面；G2 落地时必须一并补齐） |
| D12 | **halt 双 cancel 竞态窗处理** | tools.js:437-454 | 无（v1 无 halt，DESIGN §5） |

---

## 5. 核心差距（coreGaps，必须闭合）

> 判定依据：任务指令点名的模式核心（lead-队员协调、成员自动开工、动态创建、多任务并行、团队进度可视）+ 文档证明的模式支柱（§2 T1/T2/T5/T6/T7/T13）+ 「换栈不降效」规则。每条附**闭合可行性**证据——这是与「平台限制」的关键区分（§7）。

### G1 lead-队员协调关系（C4 核心）
v0.1.0 无队长：无人拆解目标→生成任务→指派/汇总，README.md:12 自述「没有队长-队员控制关系」。对照 T1/T2/T6（lead 自动拆解分派 + 队友自领取）与 dsh D1/D3。
**闭合可行性（非平台禁区）**：① zcode app-server 可脚本化建会话且插件 MCP 在其中可用——09 §2.1 实测（发现 A：首轮 session/send 才持久化；发现 B：A/B 首轮注册回合真实调用 xc_register）；② 常驻属主持有派发方时全自动链已跑通——`demo/wake-chain-run.mjs`（README 可复现）+ 09 §4.2（wake-b 无人干预完成 xc_register→check_inbox→claim→report 全链）。

### G2 成员自动开工 / 事件驱动调度（C5+C6 核心）
v0.1.0 的一切推进都等用户回合或受限 wake：依赖完成不触发下游（tools.ts:434 仅被动检查）、成员完成一单不自动领下一单（09 §3 每环脚本驱动）。对照 T5（依赖自动解除无须动作）/T6（自动自领取）/T7（完成自动回报）与 dsh D1。
**闭合可行性**：同 G1（常驻 keeper/app-server 引擎持有成员会话，引擎内实现 idle 边沿→认领→唤醒循环）；V9 只阻断「CLI 单发进程做派发者」形态，常驻形态已实测免疫（09 §4.3 关键时序对照）。

### G3 动态成员创建与管理（C4 核心）
v0.1.0 成员只能人工开窗口自注册，无 add/remove、无 maxMembers（对照 T2 lead 自动生成成员；dsh D2）。
**闭合可行性**：app-server `session/create` 实测可用（09 §2.1）；成员上限为纯插件侧逻辑（dsh tools.js:1214-1215 同型实现可移植，v0.1.0 已有同源的成员花名与校验基建）。

### G4 多任务并行的自动驱动 + 并发上限（C6 核心）
状态机支持多任务但推进全靠人工回合；无并发/成员数上限配置。对照 S2（并发上限 20 可配）/dsh D2。与 G2 同根：自动驱动闭环成立后，并行才从「多个人工回合」变成「多成员同时干活」；上限随 G3 一起落。

### G5 团队进度可视与统一接管（C8 核心）
无统一面板：不能从一处看全员状态（working/idle）、看任务 DAG、进入某成员、停止某成员/取消任务；`xc_status` 只是只读快照（README.md:109）。对照 T13（agent 面板与任务列表一体）。
**闭合可行性（平台边界已核）**：zcode 插件无任意 DOM/UI 注入点（PLATFORM.md §2.1：`ui.surfaces` 是桌面面板资源，仅 documents/zcode-site 有）——需等效方案：磁盘真源+快照已是权威数据面（09 §5 实测 62 行审计），v0.2 需补「常驻可读视图 + 控制入口」（如 xc_status 强化为结构化全景 + 引擎级 cancel/stop 工具 + 定时快照渲染），**实现手段待定但数据与控制能力必须补齐**。

### G6 消息安全硬保证（C3 安全面，文档证明的模式属性）
v0.1.0 身份是协作假设（README.md:153 自述模型可谎报 sid），消息无入站裁决、无「消息不能代批权限/代改配置」的工具侧硬校验。对照 T9/M5（CC 是平台硬保证）与 M4（accept/hold/refuse）。
**闭合方向**：成员经引擎托管（G1/G3）后，身份从「自荐注册」升级为「引擎签发」；在工具面实现消息来源校验与权限动作隔离（消息只携带任务/文本，不携带授权语义——v0.1.0 的 attempt 令牌已是此思路，需覆盖全部工具）。最低线：入站 hold/refuse 配置 + 身份硬校验升级为引擎侧签发验证。

---

## 6. 可选差距（optionalGaps，非模式核心或 CC agent teams 形态本身不自动提供）

| # | 差距 | 依据与说明 |
|---|---|---|
| O-1 | 质量门族完整移植（verdict/结构化完成载荷/修复轮次/覆盖率矩阵/工件漂移/路径归属审计） | dsh D4（1832 行纯函数零 I/O，可整体复制，DESIGN §5 已注「延后无迁移成本」）；CC 对应物是任务钩子族（T10）。用户未明示要求，属增强 |
| O-2 | 计划评审（staged plan → Approve & Run） | dsh D5；CC 对应 plan mode 传递（T11）。当前以派发前对话确认等效 |
| O-3 | worktree 执行隔离选项 | CC 子代理有 isolation: worktree（S6）但 **agent teams 不自动隔离**（T15）；dsh 亦无 worktree。不闭合不构成对 agent-teams 形态的降效 |
| O-4 | 会话发现扩展（发现本机未注册 zcode 会话，ListAgents 等效） | M1；v0.1.0 只见自注册花名。引互操作便利，非组队核心 |
| O-5 | 入站策略 accept/hold/refuse 分级与审批对话框 | M4；随 G6 的最低线一并考虑，但分级对话框非核心 |
| O-6 | idle notice 订阅（notify_when_idle，12h 超时） | M6；G2 落地后由调度器的空闲事件自然覆盖大半场景 |
| O-7 | 跨机/云消息 | M2 跨机部分；v1 明确单 workspace（DESIGN §3.3），用户未要求 |
| O-8 | 成员工具策略 / 派生深度护栏 | dsh D7；CC 对应 subagent tools 限制（S1）。对等全独立形态下由宿主权限面部分承担 |
| O-9 | 兜底模型路由 / 失败代际归属 | dsh D8；G2 落地后的可靠性增强 |
| O-10 | reassign / amend 任务工具 | dsh D6 差集；当前无 lead 故无重派语义 |
| O-11 | 派单合同完整化（objective/inScope/outOfScope/verify + 依赖输出注入） | dsh D10 + scheduler.js:125-179；提高派单质量，非核心 |
| O-12 | 角色定义文件复用（subagent definition → teammate 角色） | T3；v0.1.0 只有 worker 标记 |
| O-13 | 通道容量/限流参数（单条上限、队列 50 条、burst 限流）与批量拆分（/batch 等效） | M8；v0.1.0 已有幂等去重防同文刷屏，容量防御属加固 |

---

## 7. 平台限制清单（实测证据）与「不得据此降效」边界

| 限制 | 证据 | 影响与边界 |
|---|---|---|
| **V9：CLI 单发回合进程退出连带清杀其触发的 wake 子进程**（疑似 Windows 作业对象/树清杀） | 09 §4.3 定位实验：死亡时刻≈派发者 CLI 退出时刻；detached 心跳跨 28 跳存活排除「detached 失效」；独立复现同 spawn 形态正常（repro-b.log PONG） | 只阻断「派发方=CLI 单发会话」形态的推送实时性；**常驻属主形态免疫**（wake-chain-run.mjs + 09 §4.2 全自动链）。修复方向已给（脱离派发方作业对象/常驻引擎统一 spawn）。**不构成免做 G2/G4 的理由** |
| zcode 插件钩子事件仅 7 个会话级事件，无 agent/status 类宿主事件总线 | PLATFORM.md §2.2（引 zcode-configuration-guide SKILL.md:72） | 插件内拿不到宿主成员状态边沿——但**引擎自持成员会话即可自产边沿**（G2 方案），非禁区 |
| 插件无全局工具注册入口（工具只能经 MCP server）；`agents` 清单字段文档矛盾不可依赖 | PLATFORM.md §2.1（mcpServers 两种实测形态；agents 字段「Recorded but not executed」） | v0.1.0 已用 MCP 承载 7 工具证明可行；不限制工具数量与语义 |
| 插件无任意 DOM/UI 注入点 | PLATFORM.md §2.1（ui.surfaces 是面板资源） | 影响 G5 实现手段选择，不影响 G5 数据与控制能力的达成 |
| 会话持久化时序：`session/create` 后立即杀 app-server 会话不落库，首轮 `session/send` 才持久化 | 09 §2.1 发现 A（db.sqlite 三批实查） | G3 建成员时必须先发首轮消息——是**实现约束**不是禁区 |
| 活属主会话被跨进程 resume 的并发语义未验证（V5） | DESIGN §9 V5；09 §6 未复核项 | 引擎托管成员后，成员属主恒为引擎，V5 场景消解 |
| zcode 无 steer（注入驻留回合）API | DESIGN §5 机制对照表第 2 行 | 唤醒粒度=新回合而非注入当前回合——形式差异，dsh scheduler 语义（唤醒干活）可达 |

---

## 8. v0.2 能力目标（由本差距清单导出，供设计环节取用）

1. **引擎常驻化 + 成员托管**（闭合 G1/G3）：常驻 keeper（app-server 客户端，已验证协议面）代表 lead 创建/持有成员会话（session/create + 首轮 send 持久化约束遵守），成员身份由引擎签发（闭合 G6 的身份硬校验）；
2. **调度器**（闭合 G2/G4）：引擎内实现「任务图变更/成员空闲边沿 → 原子认领 → 交付成员 → 完成回调 → 解除依赖 → 领取下一单」循环；maxMembers 上限；派发失败按 attempt 精确回滚（对齐 dsh D11）；依赖输出注入派单（O-11 可同批）；
3. **观测与控制面**（闭合 G5）：xc_status 升级为结构化全景（成员状态/任务 DAG/未读）+ 引擎级 stop/cancel 工具 + 快照定时刷新；
4. **消息安全**（闭合 G6 最低线）：入站策略配置（至少 hold/refuse）+ 全工具消息来源校验（attempt 令牌思路推广）；
5. 明确不做（本轮）：质量门族（O-1）、计划评审（O-2）、worktree（O-3）、跨机（O-7）——除非用户明示。

---

## 附：本报告核查方式说明

- CC 文档：三份 HTML 快照（478,897 / 375,844 / 989,183 B）全文提取为纯文本后逐节精读；所有中文报告中的英文引文均以 grep 在 HTML 原文复核命中（§2 各行标注 grep 计数或原文片段）；引文标注「提取文本行 N」可由同款提取脚本复现。
- dsh 源码：scheduler.js（471 行全文）、quality-gates.js（前 150 行 + 导出函数清单）、members.js（导出清单+关键行）、tools.js（add_member 段 1190-1260 + 工具名清单）、index.js:100、state.js/mailbox.js（导出清单）均为本会话 Read/grep 亲读。
- v0.1.0：README.md 全文、DESIGN.md（§0/§3/§5/§9/§10）、IMPLEMENTATION.md（§3.6/§6）、PLATFORM.md（§2.1/§2.2/目录）、09 验证报告全文；源码核读 tools.ts（工具接口 214-220、xc_dispatch 272-324、xc_claim 414-449、xc_report 475、xc_message 603、xc_status 700）、core/teamstate.ts（建单/依赖/认领 99-171）、demo/wake-chain-run.mjs（头部注释与用法）。
- 本环节未运行任何 zcode/插件运行时实验（对照判据全部采用 09 报告已完成实验的记录与本会话源码/文档读盘）；未实测项已在文中标「未确认」。
