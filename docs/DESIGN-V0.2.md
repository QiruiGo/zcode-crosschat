# DESIGN-V0.2：lead-成员协作、常驻驱动与核心差距闭合的增量设计

> 设计人：v0.2 设计师（dynamic workflow 子代理）｜日期：2026-11-09
> 基准：v0.1.0（`docs/DESIGN.md`，已交付并经 09 报告验证）+ 差距清单（`docs/GAP-V0.2.md`，核心差距 G1-G6）+ 可行性实测（`docs/FEASIBILITY-V0.2.md`，两条修复路径与动态成员链均端到端实测通过）+ CC 逆向（`deepseek-crosschat/reports/11-cc逆向.md`）+ 能力锚定（`reports/02-能力锚定.md`）。
> 最高纪律（任务书）：**换栈不降效**——实现手段随便换，能力范围不得低于参考对象；差距只允许来自实测证明的平台限制（须实验证据）。本文每条设计决策给出「依据 = 路径:行号 / 报告§ / 实验编号」，查证不了的标「未确认」。
> 本文档是 v0.2.0 的**增量**设计：v0.1.0 的磁盘真源布局（DESIGN §2.2）、六态状态机（§2.6）、并发纪律（§2.7）、7 个 xc_* 工具契约（§2.8）**全部原样保留**；本文只写增量与改动点，并逐一回应 G1-G6 与硬验收 5 条。

---

## 0. 结论速览

| 问题 | v0.2.0 决策（一句话） | 依据 |
|---|---|---|
| lead-成员模型（G1） | 三种身份：**lead**（`team.leadKey`，拆解/建员/派发/汇总）＋ **engine 成员**（引擎程序化建会话，identity=engine）＋ **peer**（v0.1.0 自注册形态保留）；lead 协议与成员守则写入技能与唤醒 prompt | CC「One session acts as the team lead…」doc-agent-teams.html；本文 §3 |
| V9 修复 | spawn 一律经**立即退出的 node 跳板**（helper 孤儿化，FEASIBILITY §2.1 路径 A，E3b 端到端实测）；WMI 逃逸为备选设计（E3c2 实测，P3 坑已解）；瞬态 app-server keeper 只用于成员供给 | FEASIBILITY §2，本文 §4 |
| 自动开工（G2/G4） | **无守护进程的 CC 式自驱**：成员守则 v2 驱动「回合内多单循环 + 完成即领下一单 + 无活回报 idle」，确定性边沿（terminal-report→依赖解除→unblock 唤醒、stale 清扫）在工具包装层实现 | 11-cc逆向 §3c-3「没有调度器守护进程——队友按系统提示协议主动轮询」；本文 §5 |
| 动态成员（G3） | `xc_member_add`：lead 调用 → 引擎经 app-server 协议 create+setModel+首轮欢迎回合（E4 全链实测）→ wakeToken 引擎签发身份 → 供给完成自动唤醒投产；`max_members` 上限默认 8 | FEASIBILITY §3（E4）+ dsh index.js:100；本文 §6 |
| 并发上限（G4） | `max_members`（默认 8）+ 每成员单开放任务（v0.1.0 已有 tools.ts:443-451）+ 每目标在途唤醒去重（v0.1.0 已有 wake.ts:324-332）——三层数量防线的等效性说明见 §5.5 | dsh index.js:100、CC `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（S2）；本文 §5.5 |
| 观测控制（G5） | `xc_status` 升级结构化全景（成员状态/lead/任务 DAG/未读/引擎信息）+ 新工具 `xc_cancel`（激活 cancelled 边）与 `xc_member_stop`；zcode 无 UI 注入点（PLATFORM §2.1）→ 数据面=磁盘真源+快照，控制面=工具 | GAP G5 闭合可行性段；本文 §7.3 |
| 消息安全（G6） | 帧类型白名单（未知帧一律拒收，CC 同款）+ 入站策略 accept/hold/refuse（held 消息独立存储不注入）+ 引擎签发身份（预绑名 + 一次性 nonce）+ 全工具来源校验矩阵成文 | doc-cross-session-messaging.html（crossSessionInbound）、11-cc逆向 §4.3-2；本文 §7.4 |
| 模块划分 | **6 个模块 W1-W6**，文件所有权互不重叠（§9 表），共享文件全文在 §10 | 本文 §9/§10 |
| 回归 | 7 工具行为不变（包装层叠加）、schema 只增可选字段（旧 team.json 兼容）、v0.1.0 全部 167 例测试保留全绿（09 §2:29 基线）+ pull 三环冒烟复刻 | 本文 §11 |

对硬验收 5 条的逐条演示/证据方案见 §8；对 CC 逆向 §4.3 增量清单的切分（哪些进 v0.2、哪些明确归 v0.3.0 backlog）见 §12——**不静默丢弃任何一项**。

---

## 1. 输入基线（本文结论的出处清单）

| 输入 | 位置 | 本文引用方式 |
|---|---|---|
| v0.1.0 设计 | `docs/DESIGN.md`（§2 通道/§2.6 状态机/§2.7 并发/§2.8 工具面/§7-8 模块与共享文件） | `DESIGN §x` |
| v0.1.0 源码 | `plugin/src/core/*.ts`（M1）、`plugin/src/engine/{wake,resume-cli}.ts`（M2）、`plugin/src/mcp/*.ts`（M3）、`plugin/src/hooks/*.ts`（M4） | `路径:行号` |
| 差距清单 | `docs/GAP-V0.2.md`（G1-G6 核心差距 + O1-O13 可选 + 平台限制表） | `GAP §x` |
| 可行性实测 | `docs/FEASIBILITY-V0.2.md`（E1-E4 实验、P1-P5 平台新事实）＋ 证据 `deepseek-crosschat/evidence/10-v020/feasibility/` | `FEASIBILITY §x` / `E#` |
| 09 验证 | `deepseek-crosschat/reports/09-zcode验证.md`（三环闭环、V9 现象、167 用例基线） | `09 §x` |
| CC 逆向 | `deepseek-crosschat/reports/11-cc逆向.md`（真实机制与 §4.3 十条增量清单） | `11-cc逆向 §x` |
| CC 文档快照 | `deepseek-crosschat/evidence/doc-agent-teams.html`、`doc-cross-session-messaging.html`、`doc-sub-agents.html` | `doc-*.html`（引文经本会话 grep 复核命中，见 §2 各处） |
| dsh 参考源码 | `deepseek-crosschat/src/dsh-agent-teams-0.1.29/lib/{scheduler,tools,members,index}.js` | `dsh 路径:行号` |
| 能力锚定 | `deepseek-crosschat/reports/02-能力锚定.md`（C1-C8 判据） | `02 §C#` |
| 平台事实 | `docs/PLATFORM.md`（§2.1 能力面/§2.2 钩子事件/§4 会话脚本化机制） | `PLATFORM §x` |

本环节为设计环节：除源码/文档读盘与 CC 快照引文 grep 复核外，未运行任何 zcode 运行时实验；所有运行时判据标注为「实现期验证点」（§13）或直接复用 FEASIBILITY/09 已完成实验。

---

## 2. 总体架构与关键决策

### 2.1 增量架构图（v0.1.0 底座不变，虚线为新增）

```
┌─ 用户 ─┘
   │ 单条指令（目标/一句话）
   ▼
┌─────────── lead 会话（peer/worker 之外的第三个角色：team.leadKey）───────────┐
│ 技能 crosschat v2：lead 协议（拆解目标→建员→派发→核收回执→汇总上报）          │
│ 工具：xc_team_init  xc_member_add  xc_dispatch(+dependsOn)  xc_status v2    │
│       xc_cancel  xc_check_inbox（收回执）                                    │
└──────────┬───────────────────────────────────────────────────────┘
           │ xc_member_add（W2）                    │ xc_dispatch（v0.1.0 工具不变）
           ▼                                       ▼
┌─ 瞬态 app-server keeper（W2）─┐      ┌─ 文件邮箱真源 <ws>/.crosschat/ ─┐
│ session/create → setModel     │      │ inbox/<key>.jsonl（帧白名单 W5） │
│ → 首轮欢迎回合（成员守则）     │      │ team.json（+leadKey/成员状态 W2）│
│ → kill（P4：send 后 ≤3s 落库）│      │ engine.jsonl / snapshot.json    │
└──────────────┬────────────────┘      └───────────────┬─────────────────┘
               │ 成员 sid + 引擎签发身份                │ 消息真源
               ▼                                       ▼
┌─ 成员会话（headless --resume，owner-absent）──────────────────────────────┐
│ 成员守则 v2（W3，嵌在唤醒 prompt）：                                        │
│   注册(wakeToken) → 查收件箱 → 认领 → 心跳 → 报告 → 领下一单 → 无活 xc_idle│
└──────────────┬────────────────────────────────────────────────────────────┘
               │ xc_report(completed)（终态）
               ▼
┌─ 工具包装层（新文件，不改 tools.ts 主体）────────────────────────────────┐
│ W3 withTaskEdges：终态报告 → ① 僵尸清扫 ② 依赖解除→unblock-notice→唤醒    │
│ W5 withGuards：移除成员硬拒 / 入站策略(hold/refuse) / 帧白名单联动        │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ attemptWake（W3 场景扩展）
               ▼
┌─ W1 spawn-escape（V9 修复）───────────────────────────────────────────────┐
│ MCP server → spawn node wake-helper（立即退出）→ detached ZCode.exe 回合   │
│ = 孤儿化：派发方 CLI/app-server 退出清杀不到唤醒回合（E3b 实测）            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键决策 D0-D5（每条一句依据，复核员对照检查点）

| # | 决策 | 依据（为什么这样选） |
|---|---|---|
| D0 | **不引入常驻守护进程做调度器**；调度闭环 = 成员守则自驱循环（回合内）+ 工具层确定性边沿（跨回合）+ 唤醒传输（跨进程） | CC 真实机制即如此：tmux 后端下「队友进程启动后 InboxPoller 拾取初始指令开跑；此后**没有调度器守护进程**——队友按系统提示协议主动轮询 TaskList」（11-cc逆向 §3c-3，`@15629161`/`@19539020`）；dsh 的 scheduler.js 是作者自述的「对 CC 轮询的等价闭环」（11-cc逆向 §4.2 自动开工行）。zcode 侧拿不到宿主 `agent/status` 事件总线（GAP §7 引 PLATFORM §2.2），复刻 dsh 调度器反而需要新造常驻进程——CC 式自驱是实测可行的最小机制面 |
| D1 | V9 修复主路径 = **helper 孤儿化**（W1）；WMI 逃逸（E3c2 已验证）作为预设计的备选方案不进 v0.2 代码；常驻属主形态对**派发侧**照常可用（09 §4.2 实测范围＝wake-b 存活），但本设计**不 resume 活属主会话**（运行守则见 §8.1/§13 末行） | FEASIBILITY §2.3 三形态表：「helper 孤儿化……推荐默认：任何派发方形态（含 CLI 单发）通用，零依赖」；「MCP server 自身直接 spawn 不可行（E3a，即 v0.1.0 现状）」；V5 边界＝DESIGN.md:195 |
| D2 | 成员供给（建会话）在 **lead 的 MCP server 进程内同步执行**（app-server 四步 + 欢迎回合等待），不做异步常驻建员引擎 | FEASIBILITY §3.2 明示推荐：「引擎（MCP server 内）在派发回合同步执行『建员四步』……P4 保证 send 成功即持久化」；E4 全链一次跑通（dm-create.mjs）。异步引擎的收益（lead 进程死亡时供给继续）由 **幂等重供给**（§6.4）补齐 |
| D3 | 成员会话 = **owner-absent 的无头 `--resume` 会话**（每回合一个唤醒连接），不用 app-server 长持成员会话 | 规避 V5（活属主并发 resume 语义未确认，DESIGN §9-V5）：GAP §7 已注明「引擎托管成员后成员属主恒为引擎，V5 场景消解」——本设计以「不持有」实现「无冲突」；resume-after-owner-exit 形态 v0.1.0 已实测（PLATFORM §4.4） |
| D4 | 新行为一律走**新文件 + 包装层**，`tools.ts`/`teamstate.ts`/`mailbox.ts` 的 v0.1.0 主体不动（tools.ts 仅 1 处 2 行的注册缝隙，见 §10.3） | 模块并行不重叠（§9）；回归风险最小化（§11） |
| D5 | 任务认领原语**保留 v0.1.0 的 team.json + 组合锁方案**，不复刻 CC 的「每任务一文件 + O_EXCL」，等价性明文注明 | 11-cc逆向 §4.3-3 建议升级为 CC 同款，但任务书允许「#3 认领原语若与现有 attempt 机制等价可保留并注明等价性」：v0.1.0 的原子认领 = 进程内 promise 链 + 跨进程 O_EXCL lockfile（含陈旧锁强夺）（README.md:143；tools.ts:414-463；09 §2 实测 167 用例含真实跨进程锁竞争）——保证的恰是 CC「Task claiming uses file locking to prevent race conditions」（doc-agent-teams.html，本会话 grep 复核命中）的同一条性质：**跨进程认领恰好一个赢家**。差异只在锁粒度（整文件 vs 单任务文件），在 v0.1.0 全部写路径本就走 `withTeamLock` 的前提下不构成能力缺位 |

### 2.3 换栈不降效自查（对照 GAP §5 六条核心差距）

G1→§3；G2→§5；G3→§6；G4→§5.5；G5→§7.3；G6→§7.4。六条全部给出实现设计（非「简化/裁剪」），逐条闭合证据方案在 §8.5。

---

## 3. lead-成员协作模型（闭合 G1）

### 3.1 三种身份与角色（对齐 CC T1/T2 与 dsh captain/member）

| 身份 | 来源 | 落盘 | 能力 |
|---|---|---|---|
| **lead** | 会话调用 `xc_team_init`（或首个建员动作隐式成为 lead） | `team.json.leadKey`（新可选字段，W2 schema）；engine.jsonl `lead-set` | 拆解目标建任务、`xc_member_add`/`xc_member_stop`（lead 专属）、派发、核收回执、汇总、`xc_cancel` |
| **engine 成员** | lead 调 `xc_member_add` → 引擎程序化建会话（§6） | `team.json.members[]` 增记录 `{state:"ready", identity:"engine", sessionId}`；names.json 预绑定 `{issuedBy:"engine"}` | 收派发→自驱工作→回报；不可建员 |
| **peer / 自注册 worker** | v0.1.0 路径原样：用户手动开会话 `/xc-work` → `xc_register`（hook 锚定） | `members[]` `{identity:"self", state:"ready"}`（缺省兼容，§6.5） | 与 v0.1.0 完全一致：可被派发、可自领取、可互发消息；**不可建员** |

对齐说明：CC 是「lead 固定名 team-lead + Agent 工具带 name 生成 teammate」（11-cc逆向 §3c-1：`@2355944`、`@5060470`）；dsh 是 `agent_teams_add_member` 且 captain 专属（dsh tools.js:1197 `requireCaptain(exec)`）。zcode 无 Agent 工具与子代理宿主 API（PLATFORM §2.1），故「生成成员」落在 lead 的 MCP 工具 `xc_member_add` 上——能力（lead 生成完整成员实例）不缺位，形态换成引擎程序化建会话（可行性已实测，D2）。

CC 保留名纪律等效移植：`lead`/`default` 为保留名（`xc_member_add` 与 `xc_register` 均拒绝）；命名经既有 `sanitizeKey`（core/sanitize.ts）。

### 3.2 lead 生命周期（技能协议，落 `skills/crosschat/SKILL.md` v2 的 lead 章，W4 交付）

```
lead 协议（摘自 SKILL.md v2，全文由 W4 实现）：
L1  成为 lead：/xc-team（= xc_team_init）。已存在其他 lead 时返回 lead_exists，不得抢位。
L2  接到目标后先盘点：xc_status 看现有成员/任务，能续用就不新建（dsh index.js usageSectionText
    第 1 条同款纪律：「Continue existing work without duplicating its roster/tasks」）。
L3  拆解：把目标拆成最小可用任务 DAG——每任务 title/prompt/acceptance（可检验），
    有先后关系写 dependsOn；可并行的任务不制造假依赖。
L4  建员：缺哪个角色补哪个（xc_member_add），受 max_members 上限；不加人也能干的就派给现有成员。
L5  派发：xc_dispatch（可并行多单一次回合内连续派发）；派发后结束回合等待回执唤醒，
    不 busy-poll（v0.1.0 派发纪律 3 原样保留）。
L6  收回执：回执唤醒到达后 xc_check_inbox → 按 acceptance 独立复核证据（读文件/算 sha256）
    → 未完成继续等；成员 xc_idle 且任务全部终态 → 汇总上报用户。
L7  异常：failed 回执 → 阅读错误决定重派（新任务，或修复后重派）；
    收到 stale-swept 回执（§5.4）说明成员回合丢失，按需重派。
```

「lead 自动拆解目标→生成任务→指派/汇总」的达成方式：lead 是完整 LLM 会话，拆解发生在 lead 的回合内，由 L3 纪律 + 技能注入驱动——与 CC「describe the task and the teammates you want in natural language. Claude spawns them and coordinates work based on your prompt」（doc-agent-teams.html，本会话 grep 复核命中「Spawn 4 teammates」「describe the task and the teammates」）同构。

### 3.3 成员生命周期

```
provisioning ──供给成功──▶ ready ──xc_member_stop──▶ removed
     │                        │  ▲                       │
     └──供给失败/超时──▶ failed ┘（重试 xc_member_add 同名幂等重供给）
```

- **provisioning**：记录已入 roster（占用名额），app-server 供给进行中（§6.2）。
- **ready**：欢迎回合完成（已注册+已查箱，无单即结束回合——就绪由供给完成判定与 roster `state:"ready"` 表达，不发 xc_idle，§6.2 ③；或欢迎回合内已开工）。此后每次被唤醒进入守则 v2 工作循环（§5.2）。
- **failed**：供给失败（建会话/setModel/欢迎回合超时或报错），错误进记录；同名重调 `xc_member_add` 走幂等重供给（§6.4）。
- **removed**：`xc_member_stop` 后；工具面硬拒（W5 guards）、不再被唤醒、开放任务回收（§7.3.3）。记录保留在 roster（历史可查），花名不释放（与 dsh remove_member「Catalog rows deliberately remain discoverable」一致，dsh members.js:979）。

### 3.4 成员守则 v2（唤醒 prompt 内嵌文本，W3 交付于 `wake.ts`，替换 v0.1.0 MEMBER_RULES）

这是 G2「成员自动开工」的执行协议本体，逐条对应 CC 队友工作流（11-cc逆向 §4.3-5「TaskList 的 Teammate Workflow 五条：轮询→找 pending 无 owner 无 blockedBy→低 id 优先→TaskUpdate(owner) 认领→阻塞通知 lead」，`@19539020`）：

```
成员守则 v2（多任务自驱版）：
1) 身份：先 xc_register（本 prompt 已给出 name/sessionId/wakeToken），再 xc_check_inbox 读消息。
2) 工作循环（一个回合可以做多单，做完一单领下一单）：
   a. 取一单：优先看收件箱未读的 task-assignment / unblock-notice；
   b. xc_claim(taskId) 拿 attemptId → xc_report(in_progress) → 执行；
   c. 预计超过 10 分钟的任务每 ≤10 分钟 xc_report(in_progress)（心跳，附一句进展）；
   d. 完成：xc_report(completed, result=结果摘要, evidence=[文件路径+至少一条]);
      失败：xc_report(failed, error=原因)。回执发出后回到 a 取下一单。
3) 没有可做的活：向 lead 发 xc_idle（summary 必填；刚完成的单附 completedTaskId/
   completedStatus），然后立即结束回合。不要空转轮询。（例外：首次供给的欢迎回合
   无单直接结束回合、不发 xc_idle——就绪由 roster state 表达，§6.2 ③。）
4) xc_claim 被拒：task_not_pending（已被领）→ 不重试，回到 a；
   dependencies_unmet → 该任务等 unblock-notice 再做，回到 a 看有没有别的活；
   already_has_open_task → 先把手头的单做完报掉。
5) stale attempt（attemptId 不匹配）→ 立即停手，该任务已被重置，回 a 取别的；
   error:"busy" → 稍后重试一次，仍忙则 xc_idle 结束回合。
6) 依赖任务的输出：claim 后如需上游产出，用 xc_status 看依赖任务的 result 字段；
   unblock-notice 里也会带上游结果摘要（有截断预算）。
7) 收到 shutdown-request 帧 → 不再领取新任务，把手头单报告（或直接 failed）后结束回合。
8) 一切与协作有关的状态只经 xc_* 工具读写；.crosschat/ 状态目录是只读诊断面
   （dsh assignmentPrompt 的 State policy 同款，scheduler.js:178）。
```

与 v0.1.0 MEMBER_RULES（wake.ts:181-187）的差异：新增「回合内多单循环」「心跳」「idle 通知」「unblock-notice 处理」「shutdown 帧」。全部不需要新平台能力——v0.1.0 的唤醒回合已实证单回合内 register→check_inbox→claim→report 多工具链（09 §4.2），循环只是同一回合内更多次工具调用。

### 3.5 与 CC / dsh 的能力对照（G1 收口表）

| 能力 | CC | dsh | v0.2.0 | 缺口？ |
|---|---|---|---|---|
| lead 协调、成员独立上下文 | T1 | captain+members | lead + 独立成员会话（各自完整上下文） | 无 |
| 自然语言组队、自动生成成员 | T2 | agent_teams_add_member | lead 技能 L3/L4 + xc_member_add（引擎建会话） | 无（形态=引擎建会话，E4 实测） |
| 成员直接互发 | T4 | send_message | xc_message（v0.1.0 已有） | 无 |
| 空闲通知回 lead 附结果 | T7 | send_message 报告 | xc_idle + 回执唤醒（§5.3） | 无 |
| 完成后自动领下一单 | T6 | scheduler kickMember | 守则 v2 第 2 条（回合内循环）+ unblock 唤醒（回合间） | 无 |
| 统一汇总 | T1 | captain 邮箱 | 回执入 lead 邮箱 + L6 | 无 |
| 无嵌套 team / lead 固定 | T15（官方限制） | 同 | 单队 default + lead_exists 拒抢位 | 形态差异（CC 亦如此） |

---

## 4. V9 修复与 spawn 体系（W1）

### 4.1 问题与实测结论（一段话收口）

v0.1.0 的唤醒子进程由 MCP server 直接 spawn（resume-cli.ts:108-114），被派发方 CLI 退出连带清杀（09 §4.3）。可行性实验修正机理并给出修复路径：清杀沿**活父链**传播（P5）——CLI 退出时 MCP server 仍活着，其 detached 子进程可沿父链被找到；而「已退出的中间进程」留下的孤儿链杀不到（E1-direct 孤儿存活 vs E3a MCP-server 之子死亡）。修复路径 A「helper 孤儿化」端到端实测（E3b：派发方 CLI 在派发后 5.7s 退出，孤儿化唤醒子进程全自动完成任务 t2）；路径 B「WMI 逃逸」亦实测通过（E3c2）但需处理 P3（WMI 子进程继承 WmiPrvSE 的 SYSTEM 环境，须落盘/回读用户 env）。

### 4.2 设计：`spawnResume` 内部改走 helper（签名与编排不变）

```
现形态（E3a 证明被清杀）：MCP server ──detached spawn──▶ ZCode.exe（--resume 唤醒回合）
新形态（E3b 证明存活）：  MCP server ──spawn node──▶ dist/mcp/wake-helper.mjs（立即退出）
                                              └─detached+unref spawn──▶ ZCode.exe（孤儿）
```

- **改动集中在 W1**：`engine/resume-cli.ts`（spawnResume 内部实现 + 新文件 `engine/wake-helper.ts`）+ `scripts/build.mjs`（新增入口）。`wake.ts` 的 attemptWake 编排（nonce/租约/降级/markDelivered，wake.ts:307-406）**一行不改**——spawnResume 对外仍是同步 `spawnResume(opts): {pid, logFile}`：
  - spawnResume 用 `spawn(process.execPath, [helperPath, "--exe", …, "--cjs", …, "--sid", sessionId, "--prompt", prompt, "--cwd", cwd, "--log", logFile])` 拉起 helper（参数数组不经 shell；prompt ≤4000 字符远低于 Windows ~32k 命令行上限，FEASIBILITY §2.1 同口径），即挂 `error`/`exit` 监听并返回 `{pid: helperPid, logFile}`；
  - helper 以 `--mode` 无关的固定行为执行：detached+unref 拉起 ZCode.exe（stdio → logFile）后立即 `exit(0)`，stdout 单行 JSON `{ok:true, pid:<唤醒子进程pid>}`；
  - 父进程（MCP server）读 helper stdout：`ok:true` → 经新增回调 `onHelperSpawned?(childPid)` 由 attemptWake 追记 engine.jsonl `{event:"wake-child", pid}`；helper 失败（exit≠0 / spawn error / 超时 5s）→ 走既有 `onAsyncError` → attemptWake 的 `releaseOnFailure`（wake.ts:353-367）释放投递租约 + 消费 nonce + 降级 mailbox。
- **helper 失败路径的投递语义（精确表述，v0.2 复核修正）**：helper 失败的检测（exit 事件 / 5s 超时）晚于 attemptWake 成功路径的 `markMailboxDelivered`（wake.ts:392-393），而 `releaseMailboxDelivery` 只清 `deliveryClaimedAt` 不清 `deliveredAt`（mailbox.ts:165-171），`readPendingMailbox` 的自动重试资格要求 `deliveredAt === undefined`（mailbox.ts:121-125）——故该消息**不再获得「投递租约 60s 到期自动重试」资格**。它仍然**不丢**：留在收件人邮箱，由该目标的**下一次唤醒回合整体消费**（唤醒回合首动作 `xc_check_inbox` 消费全部未读，tools.ts:389-394）或 pull 补做——E3b 对 E3a 遗留票 t1 的自动补做即实证（FEASIBILITY §2.1）。nonce 已被 `releaseOnFailure` 消费（wake.ts:358-362），15min 在途窗口不阻塞下次唤醒。可选加固（实现期可选项，归 W5）：mailbox.ts 增加同时清 `deliveredAt` 的 release 变体（markDelivered 的逆操作）恢复自动重试资格；v0.2 主线不依赖它。
- **helper 路径解析**：`join(process.env.ZCODE_PLUGIN_ROOT ?? "", "dist/mcp/wake-helper.mjs")`（plugin.json 已注入该 env，见 §10.1）；文件缺失 → spawnResume 同步抛错 → 降级 mailbox（不回退到「直接 spawn」的 V9 危险路径）。
- **残余风险（如实声明，FEASIBILITY §2.1 同款）**：派发方进程在 helper 拉起唤醒子之前的毫秒级窗口内被清杀 → 唤醒丢失；兜底 = 邮箱真源（消息留箱，由下次唤醒整体消费或 pull 补做——E3b 对 E3a 遗留票 t1 的自动补做即实证；nonce 已消费，下次唤醒不受在途窗口阻塞，见上一条投递语义）。竞态概率未量化（FEASIBILITY §6-2）。
- **审计**：engine.jsonl `wake` 行的 pid 改记 helper pid，另发 `wake-child` 行记录唤醒子 pid；两者并排可查，验证时可对照 `Get-Process`。

`engine/wake-helper.ts` 全文（W1 交付基准，安全关键件直接给全）：

```ts
/**
 * wake-helper —— V9 修复（FEASIBILITY §2.1 路径 A「helper 孤儿化」，E3b 实测）的中间跳板。
 * 链路：MCP server ──spawn node──▶ 本进程 ──detached+unref spawn──▶ ZCode.exe 无头 --resume 回合
 *       本进程立即退出 → 唤醒子进程成为孤儿 → 派发方 CLI/app-server 退出的沿活父链清杀（P5）杀不到它。
 * 协议：argv 参数数组（不经 shell，resume-cli.ts 同纪律）；stdout 单行 JSON；
 *       退出码 0=已拉起；2=参数缺失；1=spawn 失败（调用方降级 mailbox，消息不丢）。
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : "";
}

function fail(code: number, payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ ok: false, ...payload }) + "\n");
  process.exit(code);
}

const exe = arg("--exe");
const cjs = arg("--cjs");
const sessionId = arg("--sid");
const prompt = arg("--prompt");
const cwd = arg("--cwd");
const logFile = arg("--log");

if (exe.trim() === "" || cjs.trim() === "" || sessionId.trim() === "" || prompt.trim() === ""
  || cwd.trim() === "" || logFile.trim() === "") {
  fail(2, { error: "missing-args" });
}

const fd = openSync(logFile, "a");
try {
  const child = spawn(exe, [cjs, "--resume", sessionId, "--prompt", prompt, "--cwd", cwd, "--output-format", "json"], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  const pid = child.pid;
  closeSync(fd); // 子进程持有继承句柄，父进程句柄即刻关闭（resume-cli.ts:138-141 同纪律）
  if (pid === undefined) fail(1, { error: "child pid undefined" });
  process.stdout.write(JSON.stringify({ ok: true, pid }) + "\n");
  process.exit(0);
} catch (err) {
  closeSync(fd);
  fail(1, { error: String(err instanceof Error ? err.message : err) });
}
```

### 4.3 备选路径 B（WMI 逃逸）——预设计保留，不进 v0.2 代码

E3c2 已验证（父进程=WmiPrvSE，t3/t4 在派发方退出后 20s 内 completed），但须处理 P3（SYSTEM env）：派发方回合把 `process.env` 落盘 → wrapper 读回整体替换（E3c 失败→修复的完整记录见 FEASIBILITY §2.2）。设计保留：同一 helper 接口可扩展 `--mode wmi`（wrapper 逻辑 = evidence `_scripts/wake-wrap.mjs` 的产品化），触发条件 = 未来某机器上 helper 路径验证失败。v0.2 不实现，README 已知限制注明。

### 4.4 瞬态 app-server keeper（成员供给专用，W2）

- 用途仅限：成员建会话（session/create + setModel + 首轮欢迎 send）与重供给（session/resume + setModel + 欢迎 send）。
- 生命周期：xc_member_add 工具调用内 spawn → 完成四步 → kill。持久化依据 P4（send accept 后 ≤3s 落库，硬杀 app-server 会话仍在，FEASIBILITY §3.1-3）与 09 §2.1 发现 A（只 create 不 send 不落库——本设计永远 send）。
- 协议实现直接产品化自实测脚本：回调应答 `session/requestRuntimePreferences`/`interaction/requestOfficialMcpAuthHeaders`（demo/bootstrap-sessions.mjs:106-109）；模型枚举按 P1 从 `session/create` 结果 `settings.model.available[].ref` 取（不再等 state.updated，FEASIBILITY §4-P1）；回合完成判定按 P2 过滤（finish∈{completed,stop} **且含 ≥1 个 text part** 的 assistant 消息才算数，FEASIBILITY §4-P2）。
- **并发红线**：供给期间该成员的 sessionId 处于 provisioning 态 → 对它的派发只投邮箱不唤醒（§6.3），杜绝「app-server 持有 + --resume 并发」踩 V5 未验证区。供给完成（步骤④ kill）后成员即恒为 owner-absent——本设计的唤醒路径**从不** resume 一个正被持有的会话（运行守则见 §8.1/§13 末行）。

---

## 5. 自动开工与调度闭环（闭合 G2/G4）

### 5.1 驱动模型：五个确定性边沿（无守护进程，D0）

| # | 边沿 | 触发点（代码位置） | 动作 | 对齐 |
|---|---|---|---|---|
| E-a | 派发边沿 | `xc_dispatch`（v0.1.0 tools.ts:272-374 原样） | 建任务+入箱+（wake_enabled 时）逃逸唤醒 | CC lead 指派；v0.1.0 已有，W1 使唤醒存活 |
| E-b | 终态报告边沿 | `xc_report` 终态（包装层 W3 withTaskEdges） | ① 僵尸清扫（§5.4）② completed → 依赖解除：给每个变为可领的下游任务写 unblock-notice 入其收件人邮箱，若收件人无开放任务则唤醒 ③ failed → 仅回执 lead（下游保持阻塞，lead 决定重派） | CC T5「when a teammate completes a task that other tasks depend on, it unblocks the dependent tasks without any action from you」（doc-agent-teams.html，grep 复核命中）+ dsh D10 依赖输出注入（scheduler.js:35-93） |
| E-c | 空闲边沿 | `xc_idle`（新工具 W4） | 写 idle-notification 帧入 lead 邮箱 + 唤醒 lead。**唤醒门控（R1 修复）**：调用者自身 roster state ∈ {provisioning, failed} → **只入箱不唤醒**（磁盘可检测，纯插件侧，与 §6.3 同思路）；欢迎回合不发 idle（§6.2 ③） | CC T7「automatically notifies the lead and includes its final answer」（grep 复核命中）+ 11-cc逆向 §4.3-4 idle_notification 语义 |
| E-d | 自驱循环 | 成员守则 v2 第 2 条（回合内） | 报完一单 → 查箱 → 领下一单；无活 → xc_idle + 结束回合 | CC T6「after finishing a teammate picks up the next unassigned, unblocked task on its own」（grep 复核命中） |
| E-e | 投产边沿 | `xc_member_add` 供给完成（W2） | 供给期间积压在该成员邮箱的派发消息 → 立即逃逸唤醒投产（含「先派发后建员」时序） | 动态成员「自动投入工作」（硬验收 2） |

> 与 dsh 调度器的对应关系：dsh 的 `ctx.on('agent/status')` 空闲边沿（scheduler.js:465）+ kickMember 原子认领 + 失败回滚（scheduler.js:358-393）三项职责，在本设计中分别由 E-d（守则自驱）+ E-b/E-e（确定性唤醒，认领仍走 v0.1.0 原子 `xc_claim`）+ §5.4 清扫（重置语义对齐 scheduler.js:380 的回 pending）承担。认领的原子性不依赖调度器（tools.ts:414-463 组合锁），因此**没有调度器不会丢失认领安全**。

### 5.2 成员一个唤醒回合的完整行为（验收 1 的「零人工输入」执行体）

```
唤醒回合（引擎 escape-spawn，prompt ≤4000）：
  xc_register(wakeToken) → xc_check_inbox
  → [有 task-assignment/unblock-notice] → claim → in_progress → 执行（心跳）→ completed/failed
  → 查箱 → [还有活] → 循环 …
  → [无活] → xc_idle(summary) → 结束回合
回合 stdout 全量落盘 logs/wake-<key>-<ts>.json（v0.1.0 机制，resume-cli/W1 保留）
```

### 5.3 idle-notification 帧格式（W4/W5 契约）

```json
{"type":"idle-notification","teamId":"default","from":"m1","idleReason":"no-claimable-task",
 "summary":"…最终答案摘要…","completedTaskId":"t2","completedStatus":"completed",
 "failureReason":null,"result":"…"}
```
收件人 = `team.leadKey`（未设置则 founderKey）。字段对应 CC idle_notification 结构（11-cc逆向 §3c-4：`{from, idleReason, summary, completedTaskId, completedStatus, failureReason, result}`），idleReason 取值约定：`no-claimable-task` / `inbox-empty` / `blocked-only`。lead 侧由 UserPromptSubmit 钩子照常注入未读（v0.1.0 机制），wake 回合直接消费。

### 5.4 僵尸任务清扫（dsh D11「G2 落地时必须一并补齐」的对应物）

- **心跳协议**：守则 v2 第 2c 条要求长任务 ≤10 分钟一次 `xc_report(in_progress)`（刷新 task.updatedAt）。
- **清扫规则**（W3，随 E-b 边沿执行；阈值 `XC_STALE_TASK_MINUTES` 默认 30）：任务 status∈{claimed,in_progress} ∧ `now - task.updatedAt > 阈值` ∧ 该成员无在途 wake nonce → 引擎特权重置：status→pending、assignee→null、attemptId→null、attempt 代数 +1、history 记 `revoked-stale`；给 lead 邮箱写 `{type:"task-receipt", status:"failed", error:"stale-swept: no update for N min"}` 回执 + 唤醒 lead。
- **状态机豁免声明**：`claimed|in_progress → pending` 不是 xc_report 可走的转移（TASK_TRANSITIONS 无此边，types.ts:42-49）；它是**引擎特权重置**，对齐 dsh 派发失败回滚（scheduler.js:381 `task.status = 'pending'`）与 parked-attempt 冷恢复语义（scheduler.js:273-310 注释）。xc_report 的校验路径（reportTransitionError）一字不改。误杀风险如实声明：30 分钟无心跳即重置，误杀代价 = 任务回池 + lead 收 failed 回执（可重派），守则心跳把概率压到低位。

### 5.5 并发上限（G4 收口）

| 层 | 上限 | 实现位置 | 对照 |
|---|---|---|---|
| 成员数 | `max_members`，默认 **8**（userConfig → env XC_MAX_MEMBERS） | W2 xc_member_add 计数 `state!=="removed"` 的成员 ≥ 上限即硬拒 `team_at_member_cap`（dsh tools.js:1214-1215 同文案同语义；dsh index.js:100 默认 8） | dsh maxMembers |
| 每成员并行任务 | **1**（一开放任务规则） | v0.1.0 已有：xc_claim 拒绝 `already_has_open_task`（tools.ts:443-451） | CC 每队友串行领单 |
| 唤醒风暴 | 每目标 15min 在途 nonce 去重 | v0.1.0 已有：attemptWake inflight 检查（wake.ts:324-332） | CC「queues at most 50 accepted messages」（doc-cross-session-messaging.html，grep 复核命中）的防刷等效 |
| 单会话内并发子代理 | 不适用（成员是独立会话，不是单会话内 subagent） | — | CC `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（默认 20，02 §C6）的等效物即成员数上限——CC 的 20 限的是「一个会话能同时跑几个 subagent」，本设计的成员各自是顶层会话，等效约束就是「队里能有几个成员」，故 `max_members` 承担同一条防线 |

---

## 6. 动态成员创建与管理（闭合 G3）

### 6.1 工具契约（W2）

**`xc_member_add`**（lead 专属）：`{name*, model?, reasoningLevel?, note?}`
1. 身份必须是 lead（`team.leadKey`，未设置时 founder 视为 lead）→ 否则 `not_lead`；
2. 校验名：sanitizeKey 非空、非保留名（lead/default）、不与现有成员重名（dsh tools.js:1206-1212 同序）；
3. 名额：`state!=="removed"` 成员数 ≥ XC_MAX_MEMBERS（默认 8）→ `team_at_member_cap`（dsh tools.js:1214-1215 对应物）；
4. 锁内写 roster：`{key, sessionId:"", role:"worker", state:"provisioning", identity:"engine", provisionedAt:now}`（占名额，防并发重复建）；
5. 供给（§6.2，app-server 四步，welcome prompt 含**引擎签发 wakeToken**）；任一步失败 → state=failed + error + 返回结构化错误（可重试）；
6. 成功 → 锁内更新 `{sessionId, state:"ready"}` + names.json 预绑定 `{sessionId, role:"worker", issuedBy:"engine"}` + sessions/<sid>.json 代写（wakeToken 路径同款，identity.ts:162-163 形态）→ engine.jsonl `{event:"member-added"}`；
7. **投产边沿 E-e**：该成员邮箱若有未读 → 逃逸唤醒（scene "post-provision"）。

**`xc_member_stop`**（lead 专属）：`{name*, reason?}` → 成员 state=removed + 写 shutdown-request 帧入其邮箱 + 尽力唤醒（成员按守则 7 收尾）+ 开放任务处理（§7.3.3）+ engine.jsonl `{event:"member-stopped"}`。花名不释放；重新 add 同名 = 幂等重供给（§6.4）。

### 6.2 供给四步（app-server 协议，全部实测依据）

| 步 | 协议 | 实测依据 |
|---|---|---|
| ① create | `session/create {workspace:{workspacePath,workspaceKey}, mode:"yolo", titleGenerationEnabled:false}` | E4（FEASIBILITY §3.1）；demo/bootstrap-sessions.mjs:164-181 |
| ② setModel | 枚举 create 结果 `settings.model.available[].ref`（P1）→ 命中 XC_MEMBER_MODEL 否则首个 → `session/setModel {sessionId, model:{providerId,modelId,options:{reasoningLevel}}}` | E4：回合 modelId=glm-5.3-flash = setModel 生效实据（FEASIBILITY §3.1-1） |
| ③ 欢迎 send | `session/send {sessionId, content: welcome prompt}`；welcome prompt = 身份行（name/sid/wakeToken，nonce 由引擎先写 registry/wake/）+ 守则 v2 摘要 + 「注册→查箱→有单按守则开工；**无单直接结束回合，本轮不发 xc_idle**——就绪状态由供给完成判定（步骤④）与 roster `state:"ready"` 表达（xc_status v2 已含 state 字段）」 | E4 m1 无人工干预自注册：engine.jsonl `register m1 via hook`、names.json/team.json 入册（FEASIBILITY §3.1-2）；与 dsh spawnMember 的 `initialPrompt ?? memberWelcome`（members.js:861-894，GAP G3 引）同构。**R1 修正说明**：E4 实测的欢迎 prompt 是「无任务回 READY」的**文本回复**（当时无 xc_idle 工具，不产生唤醒边）；设计不得把它改写成工具调用后凭空引入对引导中 lead 的唤醒边——CC 同构佐证：队友进程启动后 InboxPoller 拾取初始指令开跑，**没有**向 lead 发 READY 通知的帧（11-cc逆向 §3c-3，`@39642020` 帧分类中无 ready 帧） |
| ④ 等待+收尾 | 轮询 `session/messages`（4s 间隔，超时 XC_MEMBER_BOOTSTRAP_TIMEOUT_MS 默认 300s）；完成判定=P2 过滤（assistant ∧ finish∈{completed,stop} ∧ ≥1 text part）→ kill app-server | P4（send 后 ≤3s 落库，硬杀不丢）；P2（timeline 事件过滤，FEASIBILITY §4） |

wakeToken 签发细节：供给前引擎按 v0.1.0 格式写 `registry/wake/<nonce>.json {teamId, agentKey, sid, ts}`（registry.ts createWakeNonce 同构）→ welcome prompt 携带 → 成员 xc_register 走 wake 路径（via="wake"，identity.ts:145-163）→ **身份=引擎签发的一次性 nonce + 预绑名双重背书**（G6 §7.4）。

### 6.3 与派发/唤醒的互斥（时序安全）

- **lead→成员方向**：成员 state=provisioning 期间，`xc_dispatch` 正常入箱（requireMember 通过，成员已在 roster），但唤醒路径检查 state → **mailbox-only**（防止 app-server 持有会话时 --resume 并发，V5 未验证区，D3）。
- **成员→lead 方向（R1 修复新增，双向门控）**：
  1. 欢迎回合**不发 xc_idle**——「无单直接结束回合」，就绪由供给完成判定与 roster `state:"ready"` 表达（§6.2 ③）；消除「欢迎回合 idle → E-c 唤醒引导中 lead」的边；
  2. `xc_idle` 的唤醒路径防御门控：调用者自身 roster state ∈ {provisioning, failed} → 只入箱不唤醒（E-c 行，§5.1）；
  3. E-b wakeBack 对引导中 lead 的残余竞态（成员在 keeper 退出前极快完成 report → 回执唤醒持有中的 lead）：窗口=成员需先被唤醒并完成整个模型回合，极小；由 §8.2 的 **owner-absence 审计**（逐条核对 wake-to-lead 时间戳 vs keeper 退出时刻）暴露，runbook 以「任务内容 ≥ 分钟级执行时长」压缩窗口；审计若发现违例则该场景重跑并如实记录。
- 供给完成（ready）→ E-e 边沿补唤醒 → 积压任务投产。两段合起来 = 「先建员后派发」与「先派发后建员」两种时序都自动收敛。

### 6.4 幂等重供给（lead 进程中途死亡的自愈）

`xc_member_add` 同名重调：names.json 已绑定该名 ∧ db 会话已存在（P4 保证 send 过即落库）→ 跳过 create，改走 `session/resume`（wake-chain-run.mjs:105 实测）+ setModel + 重发欢迎 → 完成。半程死亡（create 后未 send）→ 名额释放（state=failed）+ 下次 add 全新 create。判定「db 会话已存在」的轻量探针：app-server `session/messages` 可读即存在（09 §2.1 发现 A 的反向应用）。

### 6.5 旧数据兼容

v0.1.0 的成员记录（无 state/identity 字段）经 coerceMember 读入 → 访问器 `memberState(m)=m.state??"ready"`、`memberIdentity(m)=m.identity??"self"`——旧花名自动获得 peer 语义，行为不变（§11）。

---

## 7. 逐条差距闭合设计（G1-G6 → 设计回应）

| 差距 | v0.2.0 回应（实现落点） | 验收证据 |
|---|---|---|
| **G1 lead-队员协调** | §3 全节：leadKey 三身份模型、SKILL v2 lead 协议 L1-L7、xc_team_init、xc_member_add、汇总循环 L6 | §8.3 场景 A |
| **G2 成员自动开工/事件驱动** | §5 全节：守则 v2 自驱循环（E-d）、终态报告边沿→依赖解除→unblock 唤醒（E-b）、idle 通知（E-c）、清扫（§5.4） | §8.2/§8.3 |
| **G3 动态成员创建与管理** | §6 全节：xc_member_add/xc_member_stop、app-server 供给四步、maxMembers、幂等重供给 | §8.2（m3 动态建+投产） |
| **G4 并行自动驱动+上限** | §5.1 边沿表 + §5.5 三层上限；并行=多成员同时各持一单，唤醒互相独立（各自 escape-spawn） | §8.3（时间窗重叠证据） |
| **G5 进度可视与统一接管** | §7.3：xc_status v2 全景 + xc_cancel + xc_member_stop + snapshot v2 | §8.4 |
| **G6 消息安全硬保证** | §7.4：帧白名单、入站策略、引擎签发、来源校验矩阵 | §8.4 |

### 7.3 观测与控制面（G5 详设，W4）

**7.3.1 xc_status v2 全景**（结构化 structuredContent + 渲染文本双输出；每次调用刷新 snapshot.json——v0.1.0 行为保留，render.ts 由 W4 扩展）：

```jsonc
{
  "teamId": "default", "generatedAt": 0,
  "leadKey": "a",                        // 新
  "members": [{"key":"m1","sessionId":"sess_…","state":"ready","identity":"engine",
               "role":"worker","openTaskId":"t2","lastSeen":0}],   // state/identity/openTaskId 新
  "tasks": [{"id":"t1","title":"…","status":"completed","assignee":"m1",
             "dependsOn":[],"blockedBy":[],"attempt":1,"result":"…","evidenceCount":1,
             "createdBy":"a","updatedAt":0}],                     // blockedBy 派生字段新（快照时算）
  "dag": {"t2":["t1"]},                  // 新：id→依赖
  "unread": {"a":0,"m1":0},
  "engine": {"wakeEnabled":true,"maxMembers":8,"inboundMode":"accept"}   // 新
}
```
渲染文本 = 成员状态表（working/idle/provisioning/failed/removed）+ 任务板 + DAG 一行图（`t1 ─▶ t2`）。blockedBy/dag 为**派生视图**（claim 时动态查依赖的 v0.1.0 语义不变，GAP §3-C5 已认定等效）。

**快照刷新机制（对 GAP §8-3「快照定时刷新」的显式回应，无定时器）**：
1. **事件粒度**：W3 withTaskEdges 在每次边沿动作（清扫/unblock/派发）完成后刷新 snapshot.json——任务图每次真实变化都落盘一版快照；
2. **回合粒度**：v0.1.0 的 Stop 钩子当前是纯探针（README.md:154；stop.ts 仅观测不动作），v0.2 由 W4 扩展为「本会话在花名册中（**含 lead**——leadKey 亦是 roster 成员，判定=readNames 命中本 sid）时，回合收尾刷新 snapshot.json」（best-effort，失败走 `auditHookFailure` 静默降级、恒 exit 0——hooks 永不阻断会话，hooks/shared.ts:26-28/124-140 纪律）。每个会话每回合结束必触发 Stop → 等效「定时刷新」，粒度=回合；
3. 无空闲轮询定时器（D0：无守护进程）——成员无头工作期间每单 report 至少触发一次边沿刷新，快照新鲜度以事件为粒度；纯空闲期间快照静止但数据真源（team.json/engine.jsonl）本就恒新。
落地：新文件 `core/snapshot.ts`（**W3 承载**，见 §9.1 所有权表）承载 StatusSnapshot 类型 + build/write + `refreshSnapshot(stateRoot)`，**只 import M1**（遵守 DESIGN §8.1 rule 1「M4 hooks → 仅 M1」）；W3 的边沿包装与 W4 的 Stop 钩子都调用它（W4→W3 是既有依赖方向，无环）；`mcp/render.ts` 改从它导入类型。

**7.3.2 「从一处进入」**：全景给出每成员 sessionId；桌面端用户可直接打开该会话（成员本就是完整会话，DESIGN §3.3 的天然优势保留）。zcode 无 UI 注入点（PLATFORM §2.1）→ 等效方案 = 磁盘真源 + snapshot.json（权威数据面，09 §5 实测 62 行审计已证）+ 本节控制工具（数据与控制能力齐备，符合 GAP G5「实现手段待定但数据与控制能力必须补齐」的要求）。

**7.3.3 控制工具**：
- `xc_cancel {taskId*}`（W4）：调用者=lead 或任务 createdBy；pending/claimed/in_progress → cancelled（三条边均合法，types.ts:42-49）+ history `cancelled` + 回执（status:"cancelled"）入 createdBy 邮箱 + 唤醒。**激活 v1 保留的 cancelled 边**（core/types.ts:10 自证「no v1 tool entry」）。旧邮件因 isCurrentMail 的终态裁决自动失效（mailbox.ts:54-70）。
- `xc_member_stop {name*}`（W2，§6.1）：成员停止 = 不再被唤醒（E-a/E-b/E-c 唤醒路径检查 state）+ 工具面硬拒（W5 guards：removed 成员的连接调用身份类工具 → `member_removed`）+ 开放任务收回（claimed/in_progress → 引擎特权重置回 pending + 回执 lead，对齐 dsh remove_member「revoke its current attempts, return all unfinished owned tasks to the shared pending pool」，dsh tools.js:1268 工具描述原文）。在途唤醒回合无法被外部杀死（孤儿进程无句柄）——由 shutdown-request 帧 + 守则 7 让其自然收尾，如实声明为形态差异。

### 7.4 消息安全硬保证（G6 详设，W5）

**7.4.1 威胁模型与不变量**（对应 CC T9/M5 与 11-cc逆向 §4.2 安全不变量行）：
- I1 身份不可冒用：engine 成员身份 = 引擎预绑名（他者注册该名 → `name_taken`，identity.ts:187-194）+ 一次性 wakeToken（nonce 消费一次性，identity.ts:145-160）；peer 身份保持 v0.1.0 三重交叉（hook 落盘 + 新鲜度 + 绑名互斥）并在 README 明示其协作假设等级（v0.1.0 README.md:153 的诚实声明保留）。
- I2 **消息不能代批权限/代改配置**（CC 原文「A teammate can’t approve a permission prompt or supply consent on your behalf」doc-agent-teams.html，grep 复核命中 2 次——快照用弯引号 ’）：工具面不存在任何权限/配置变更语义——`xc_*` 全部 13 个工具的参数表（§9 各模块契约）不含授权类字段；帧白名单（I3）从数据面封死「以消息携带授权语义」的可能。这条是**结构性保证**，不是提示词纪律。
- I3 帧类型白名单（CC「team_permission_update 帧直接丢弃——permission rules are never accepted from messages」的 1:1 移植，11-cc逆向 §3b-1 `@39642020`）：mailbox 读取时解析 content JSON，`type` ∈ {task-assignment, task-receipt, idle-notification, unblock-notice, shutdown-request, delivery-refused} 之外的**具名帧一律丢弃 + 审计** `{event:"frame-rejected", type}`；不可解析文本按 chat 处理（向后兼容 v0.1.0 自由文本）。测试用例：伪造 `{type:"permission_grant"}` 消息 → 丢弃 + 审计行。
- I4 入站策略（CC crossSessionInbound=accept/hold/refuse，doc-cross-session-messaging.html，grep 复核命中 `crossSessionInbound`）：`policy.json`（新文件 `teams/<id>/policy.json`，W5 读写；默认 accept）。**只作用于 chat 帧**（协议帧 task-assignment/receipt/idle/unblock 是引擎介导、带 attempt 令牌，永不被拒——否则协作闭环自断）：
  - `hold`：chat 消息写入 `inbox/<key>.held.jsonl`（独立文件，**不进主邮箱**）→ 钩子注入与 wake prompt 天然看不到（它们只读主邮箱，v0.1.0 机制零改动）；`xc_inbound_review` 列出 held 消息 → accept（转主邮箱）/ discard；
  - `refuse`：不入目标邮箱，给发送者邮箱写 `{type:"delivery-refused", to, reason}` 回执 + 审计。
- I5 全工具来源校验矩阵（成文于 SKILL v2 安全章 + 各工具结构化错误码，代码依据 v0.1.0 已有 + W5 补充）：

| 工具 | 来源校验 | 位置 |
|---|---|---|
| xc_register | nonce 一次性 ∧ name+sid 匹配；hook 路径要求 sessions/<sid>.json 在盘；removed 成员拒 | identity.ts（W5 加 removed 检查） |
| xc_dispatch | 连接身份 ∧ to 必须在册 ∧ dependsOn 引用存在 | tools.ts:286-291（已有） |
| xc_claim | 会籍 ∧ pending ∧ 依赖满足 ∧ 单开放任务 | tools.ts:417-451（已有） |
| xc_report | assignee=我 ∧ attempt 令牌匹配（硬拒 stale）∧ completed 需 result+evidence≥1 | tools.ts:495-511（已有） |
| xc_message | sourceTaskId/sourceAttemptId 成对 ∧ source attempt 归属校验 | tools.ts:626-648（已有） |
| xc_idle / xc_cancel / xc_member_add / xc_member_stop | 连接身份 ∧ lead/creator 角色检查（新） | W4/W2 各工具实现 |
| 全部 | 帧白名单（读取时）+ 入站策略（chat 入箱时）+ removed 成员硬拒（W5 guards 包装） | W5 |

- I6 权限审批不绕过人：成员是完整会话，权限提示照常弹在其会话内（zcode 宿主行为，v0.1.0 已确立）；engine 成员为 owner-absent 无头回合，其权限语义由创建时 mode 决定（E4 用 mode:"yolo"——**demo 明示这是演示配置**，README 注明生产环境可用受限 mode + 成员工具面由 zcode 宿主权限系统约束；CC 的「队友权限提示冒泡到 lead」在 zcode 无对应宿主通道，如实声明为形态差异，等效物=成员自己的审批面 + G6 的消息隔离）。

---

## 8. 硬验收 5 条：演示怎么演、证据怎么落盘

> 证据根目录：`<证据仓>\evidence\12-v020-acceptance\`（沿用 08/10 编号惯例，12 未被占用）；验证报告：`reports/12-zcode-v0.2验收.md`。每场景先 `runbook.md` 记命令序列再执行；时间戳全部取自落盘文件。

### 8.1 场景总表

| 场景 | 形态 | 验收条目 |
|---|---|---|
| **Phase 0** | 构建+测试+校验+安装（09 §2 同款四步） | 验收 4 前半 |
| **Phase A：团队主演示** | lead = 常驻 app-server keeper **仅用于引导**：keeper 发送单条指令、等 lead 派发回合结束后**即退出**（P4 保证会话已落库）；此后成员与 lead 的全部回合均为 owner-absent 无头唤醒（PLATFORM §4.4 已实测形态）。成员 m1/m2/m3 全部 `xc_member_add` 动态建 | 验收 1/2/3 |
| **Phase B：V9 修复证明** | lead = **CLI 单发回合**（派发后主动退出） | 验收 1 的派发方形态 + V9 修复 |
| **Phase C：回归** | v0.1.0 pull 三环冒烟 + 全量单测 | 验收 4 |
| **Phase D：控制与安全** | xc_status v2 / xc_cancel / xc_member_stop / 入站 hold+refuse / 帧白名单 | 验收 5 的 G5/G6 证据 |

### 8.2 验收 2（动态成员）——先演，因为它同时供给 A 的成员

**怎么演**：keeper 启动 lead 会话并发送**唯一人工指令（=验收 1 的「派发方单条指令」）**「把 `1 到 10 的平方` 拆成三份给三个新成员做，结果写 result-m*.txt」→ lead 派发回合内执行 `xc_team_init`（如未初始化）→ 三次 `xc_member_add(m1/m2/m3)`（app-server 四步，欢迎回合自动注册；**无单直接结束回合、不发 xc_idle**，§6.2 ③/§6.3）→ 三次 `xc_dispatch` → **keeper 退出**（P4：session/send accept 后 ≤3s 落库，FEASIBILITY §3.1-3；会话不丢）→ E-e/E-a 唤醒（owner-absent resume）→ 成员自动开工。
**V5 边界声明（v0.2 复核修正）**：09 §4.2 只证明了派发侧（wake-b 在常驻属主形态下存活）；对 keeper 持有中 lead 的回程唤醒（09 §4.3 的 wake-a）当时死于 V9、且「resume 活属主」本身是 V5 未验证形态（DESIGN.md:195 明令禁用）。本设计因此**不在任何环节 resume 活属主会话**：keeper 在 lead 派发回合结束后即退出，成员回执对 lead 的唤醒全部落在 owner-absent 形态（与 PLATFORM §4.4 已实测的「属主退出后续聊、记忆连续」同构），存活由 W1 保证。lead 派发回合的完整记录在 keeper 退出前经 `session/messages` 导出留证。
**owner-absence 审计（R1 修复，把「不 resume 活属主」变成可验证反证）**：runbook 记录 `keeperExitAt` 时间戳；断言脚本核查 engine.jsonl 中**所有 `to=<leadKey>` 的 wake 行的 ts 均 > keeperExitAt**（可 grep 复核），同时核查全程无任何对 provisioning 成员的 wake 行（§6.3 双向门控）。若出现违例（极小竞态：成员在 keeper 退出前完成 report）→ 该场景重跑并如实记录。runbook 约定任务内容 ≥ 分钟级执行时长以压缩该窗口。本审计同样适用于 Phase B 的「独立工作区先以 keeper 引导建员」回退形态与 V20 的「拆引导+派发两回合」缓解形态。
**证明「不需要用户手动开窗口手动注册」**：
- `provision/member-add-*.json`：xc_member_add 工具返回（含 sessionId/model/state:ready）；
- `provision/db-rows.json`：db.sqlite session 表三行实查输出（P4 持久化）；
- `engine.jsonl` 全量副本：`member-added` → `register m# via wake`（成员自主注册，无人工）→ `dispatch` → `wake` 行；**且 keeperExitAt 之前无任何 wake-to-lead 行**（owner-absence 审计的落盘反证）；
- 成员欢迎回合与唤醒回合的 stdout JSON（`member-wake/*.json`）——成员侧的每一步都是模型自主工具调用，runbook 中**没有任何针对成员会话的人工命令**（runbook 全文即反证）。

### 8.3 验收 1 + 3（自动开工零人工 + lead 协调并行汇总）

**怎么演（Phase A 续）**：lead 单条指令（上面 §8.2 那条即唯一人工输入；若采用 V20 拆分形态，引导回合亦为 keeper 自动发送，见 §8.2）→ 三个成员并行执行（互不依赖）→ 各自 `xc_report(completed, evidence=[result-m#.txt+sha256])` → 成员 `xc_idle` → **回执与 idle 通知唤醒 lead**（owner-absent resume，存活由 W1 保证——09 §4.3 的 wake-a 死亡正是本设计修复的对象）→ lead 的唤醒回合 `xc_check_inbox` 读回执 → 按 acceptance 独立复核（读文件 + sha256 复算）→ `xc_status` 确认全部终态 → 在其最终唤醒回合输出汇总表。若三条回执分散在多个 lead 唤醒回合，汇总发生在最后一个（lead 以 `xc_status` 全终态判定回执齐备）。**验收 3 的「至少 2 个任务并行」**：m1/m2/m3 三单，执行时间窗从各自 wake 日志的起止时间戳导出重叠表（`parallel-window.json`：{task, member, wakeStart, wakeEnd, overlapWith}）。
**证明「全程零人工输入」**：
- 成员完整回合记录 = 每个 `logs/wake-m#-*.json`（非零字节，含模型自述的 register→claim→report 全链，形态同 09 §4.2 wake-b-auto-turn.json:1-1 的 1463B 实证）；
- 派发方单条指令记录 = keeper 的 `session/messages` 导出（`lead-turns/dispatch-turn.json`，keeper 退出前落盘），其中用户输入只有一条 prompt，其余全是 assistant 工具调用叙述；lead 的回程（核对/汇总）回合记录 = `logs/wake-a-*.json`（owner-absent 唤醒，引擎发起，非人工）；
- 链路反证 = `runbook.md`：人工命令仅「启动 keeper + 发送 lead 指令 + 收集落盘文件」，无任何 resume/输入到成员会话的动作。
**Phase B 补强（CLI 单发派发方）**：新会话 A 的无头回合 `xc_register`+`xc_dispatch`（派发 m1 一单；复用 Phase A 工作区与已就绪成员 m1，若独立工作区则先以 keeper 引导建员）→ A 的 CLI 进程退出（脚本记录退出时刻）→ m1 仍全自动完成（E3b 的产品化复刻）。证据：`phaseB/dispatcher-turn.json`（含退出时刻）、`phaseB/wake-m1-*.json` 非零字节、team.json history 四步自动推进。此场景同时证明 W1 修复（v0.1.0 在此形态 100% 卡 pending，09 §4.3）。

### 8.4 验收 5（G5/G6 证据，Phase D）与差距闭合总表

- **G5**：`phaseD/status-panorama.json`（xc_status v2 全景：成员状态/lead/DAG/未读）；`phaseD/cancel-demo.json`（对一单 in_progress 任务 xc_cancel → team.json history 含 cancelled → 成员收到回执帧）；`phaseD/stop-demo.json`（xc_member_stop m3 → 该成员后续工具调用得 `member_removed` → roster state=removed）。
- **G6**：`phaseD/inbound-hold.json`（policy.json=hold → chat 消息进 .held.jsonl、主邮箱与钩子注入为零 → xc_inbound_review accept 后可见）；`phaseD/inbound-refuse.json`（refuse → 发送者收 delivery-refused 帧，目标邮箱 0 条）；`phaseD/frame-reject.json`（注入 `{type:"permission_grant"}` 帧 → 读侧丢弃 + engine.jsonl `frame-rejected` 审计行）；`phaseD/identity.json`（他者会话抢注 m1 名 → `name_taken`；无 nonce 会话冒充 → `session_not_anchored`/nonce 校验失败）。
- **G1-G4 证据**：即 Phase A/B 的 team.json DAG history、engine.jsonl、成员回合记录、并行时间窗表。
- **「平台限制须证据」红线**：本设计**不宣称任何新平台限制**——所有「不实现」项（§12 backlog）均标注为「范围切分/增强延后」而非平台禁区；唯二形态差异（无 steer 注入 API → 唤醒粒度=新回合，DESIGN §5 对照表第 2 行；无 UI 注入点 → 快照+工具等效，PLATFORM §2.1）沿用 v0.1.0 已写入 README/PLATFORM 的实测记录。

### 8.5 验收 4（回归）

见 §11；证据 = `phaseC/typecheck.log`、`phaseC/unit-tests.log`（全绿，含 v0.1.0 167 例基线 + 新增用例，实际数记录在案）、`phaseC/pull-smoke/`（A→B 手动 `/xc-work` 注册 + `/xc-dispatch` + B 执行 + A 收核，全程不开启 wake，复刻 09 §3 三环）、`phase0/validate.log` + `plugins list` 输出。

---

## 9. 模块划分（moduleCount = 6，文件所有权互不重叠）

> 规则（继承 DESIGN §8.1）：每个文件至多属于一个模块；跨模块只允许 import（依赖方向：W1 ← W3 ← {W2, W4}；W5 只依赖 M1 与 tools.ts 的 `ToolCore` 类型；W6 组装全部）；v0.1.0 文件如需改动，改给它唯一的新属主，并在本节写明改动边界。接口签名如下，供并行实现对接。

### 9.1 文件所有权表（★ = 相对 v0.1.0 的新文件 / ▲ = 改动文件）

| 文件 | v0.1.0 | v0.2 模块 | 改动边界 |
|---|---|---|---|
| `plugin/src/engine/wake-helper.ts` ★ | — | **W1 spawn-escape** | 新建（§4.2 全文） |
| `plugin/src/engine/resume-cli.ts` ▲ | M2 | **W1** | spawnResume 内部改走 helper + `onHelperSpawned?` 回调 + helper 路径解析；导出签名不变；`resume-cli.test.ts` ▲ 同属 W1 |
| `plugin/scripts/build.mjs` ▲ | 共享 | **W1** | entries 增 wake-helper（§10.2 全文） |
| `plugin/src/engine/appserver.ts` ★ | — | **W2 member-engine** | app-server 行协议客户端（rpc/回调/事件） |
| `plugin/src/engine/provision.ts` ★ | — | **W2** | provisionMember / reprovisionMember（§6.2 四步 + §6.4 幂等） |
| `plugin/src/mcp/member-tools.ts` ★ | — | **W2** | xc_member_add / xc_member_stop 注册 + 名额/lead 校验 + E-e 投产唤醒 |
| `plugin/src/core/types.ts` ▲ | M1 | **W2** | TeamMember +{state,identity,provisionedAt,stopReason}、TeamState +{leadKey}、NameBinding +{issuedBy}、memberState/memberIdentity 访问器、coerce 兼容（全部可选字段） |
| `plugin/src/core/types.test.ts` ▲ | M1 | **W2** | coerce 新字段兼容用例 |
| `plugin/src/engine/wake.ts` ▲ | M2 | **W3 task-flow** | MEMBER_RULES→守则 v2、新增场景 unblock/idle/post-provision/shutdown 的 prompt 组装、buildWakePrompt 白名单兼容；wake.test.ts ▲ 同属 W3 |
| `plugin/src/mcp/task-edges.ts` ★ | — | **W3** | withTaskEdges(core, deps) 包装 xc_report/xc_dispatch：清扫 + 依赖解除 + unblock 唤醒 + 边沿后 `refreshSnapshot`（§7.3.1） |
| `plugin/src/core/snapshot.ts` ★ | — | **W3** | StatusSnapshot 类型 + build/write + `refreshSnapshot(stateRoot)`（自 render.ts 迁入）；**只 import M1**——归 W3 是为让边沿刷新直接调用，W4 的 render.ts/stop.ts 经既有 W4→W3 依赖方向导入，避免 W3↔W4 环 |
| `plugin/src/core/graph.ts` ★ | — | **W3** | 纯函数：downstreamReady / collectDependencyOutputs(2000/12000 预算) / revokeAttempt（引擎特权重置）/ staleTasks / findTaskRecipient 扫描辅助 |
| `plugin/src/core/graph.test.ts` ★ | — | **W3** | 上述纯函数用例（含依赖解除、清扫、预算截断） |
| `plugin/src/mcp/lead-tools.ts` ★ | — | **W4 lead-face** | xc_team_init / xc_idle / xc_cancel 注册 |
| `plugin/src/hooks/stop.ts` ▲ | M4 | **W4** | 纯探针 → 回合收尾刷新 snapshot（调用 W3 的 `refreshSnapshot`，best-effort，失败静默降级恒 exit 0；stop.test.ts ★ 同属 W4） |
| `plugin/src/mcp/render.ts` ▲ | M3 | **W4** | renderStatusTable v2 全景渲染 + snapshot 类型改从 core/snapshot.ts 导入；render.test.ts ▲ 同属 W4 |
| `plugin/skills/crosschat/SKILL.md` ▲ | 共享 | **W4** | v2：lead 协议章 + 成员守则章 + 安全章（§3.2/§3.4/§7.4 内容落地） |
| `plugin/commands/xc-team.md` ★、`plugin/commands/xc-member.md` ★ | — | **W4** | 新斜杠命令（/xc-team、/xc-member add|stop） |
| `plugin/src/core/mailbox.ts` ▲ | M1 | **W5 security** | 帧白名单读取过滤 + frame-rejected 审计；mailbox.test.ts ▲（伪造帧丢弃用例）同属 W5 |
| `plugin/src/core/policy.ts` ★ | — | **W5** | policy.json 读写（accept/hold/refuse）+ held 邮箱（`.held.jsonl`）+ xc_inbound_review 核心 |
| `plugin/src/mcp/guards.ts` ★ | — | **W5** | withGuards(core, deps) 包装（removed 成员硬拒 + chat 入站策略执行 + delivery-refused 回执）+ registerSecurityTools（xc_inbound_review）+ guards.test.ts ★ |
| `plugin/src/mcp/identity.ts` ▲ | M3 | **W5** | joinTeam/注册路径对 removed 成员拒绝；identity.test.ts ▲ 同属 W5 |
| `plugin/src/mcp/server.ts` ▲ | M3 | **W6 integration** | 组装链 + 新工具注册（§10.3 全文） |
| `plugin/src/mcp/tools.ts` ▲ | M3 | **W6** | 仅 1 处 2 行缝隙：registerTools 增可选 `coreOverride` 参数（§10.4 精确改动块；其余 815 行不动） |
| `plugin/.zcode-plugin/plugin.json` ▲ | 共享 | **W6** | 版本 0.2.0 + 新 userConfig + 新 env（§10.1 全文） |
| `plugin/src/mcp/protocol.ts` / `core/{lock,paths,registry,teamstate,atomic,jsonl,log,sanitize}.ts` / `hooks/{hooks.json,session-start.ts,prompt-submit.ts,shared.ts}` | M1/M4 | **不改** | 读用不改；hooks.json 不变 |
| `README.md` / `docs/PLATFORM.md` / `docs/DESIGN.md §9` ▲ | 共享 | **W6** | 已知限制回填（P1-P5、形态差异、WMI 备选、v0.2 新配置） |

依赖方向（无环）：W1（基础 spawn）← W3（wake.ts import resume-cli）← {W2（member-tools import graph.revokeAttempt、provision import wake 场景常量）, W4（lead-tools import wake.attemptWake）, W5（guards/policy 独立，mailbox 只依赖 M1 既有）} ← W6（组装）。并行排布：W1 先行（半天级），W3/W5 可立即并行（W3 对 W1 只依赖接口签名），W2/W4 随后，W6 收口。

### 9.2 各模块对外接口（并行对接签名）

```ts
// W1（resume-cli.ts 增量导出；其余不变）
type WakeSpawnMode = "helper" | "direct";            // direct 仅测试/对照（E1 基线）
export interface SpawnResumeOptions { /* 原字段不变 */ 
  onHelperSpawned?: (childPid: number) => void; }     // 新：helper 汇报的唤醒子 pid
export function spawnResume(opts: SpawnResumeOptions): SpawnResumeResult; // 签名不变

// W2
export interface ProvisionResult { sessionId: string; providerId: string; modelId: string;
  welcomeResponse: string; reprovisioned: boolean; }
export function provisionMember(deps: ToolDeps, spec: { key: string; model?: string;
  reasoningLevel?: string; }): Promise<ProvisionResult>;              // 内含 appserver 四步+P2 等待器
export function registerMemberTools(server: McpServer, deps: ToolDeps): void; // xc_member_add/xc_member_stop

// W3
export function withTaskEdges(core: ToolCore, deps: ToolDeps): ToolCore;
export const MEMBER_RULES_V2: string;                 // §3.4 全文
export { downstreamReady, revokeAttempt, staleTasks, collectDependencyOutputs } from "../core/graph.js";
// core/snapshot.ts（W3 承载；hooks/mcp 共用，只依赖 M1）
export function refreshSnapshot(stateRoot: string, teamId?: string): Promise<void>; // build+write snapshot.json，best-effort

// W4
export function registerLeadTools(server: McpServer, deps: ToolDeps): void; // xc_team_init/xc_idle/xc_cancel
export function renderPanorama(snapshot: StatusSnapshot & PanoramaExtras): string;

// W5
export type InboundMode = "accept" | "hold" | "refuse";
export function withGuards(core: ToolCore, deps: ToolDeps): ToolCore;
export function registerSecurityTools(server: McpServer, deps: ToolDeps): void; // xc_inbound_review
export const FRAME_TYPES = ["task-assignment","task-receipt","idle-notification",
  "unblock-notice","shutdown-request","delivery-refused"] as const;

// W6（组装见 §10.3）
```

新工具错误码（沿用 v0.1.0 结构化信封风格，protocol.ts ToolError 不改）：`not_lead / lead_exists / team_at_member_cap / name_reserved / member_provision_failed / member_removed / task_already_terminal / inbound_refused`。

---

## 10. 共享文件全文（多个模块行为流经的文件，直接给全）

### 10.1 `plugin/.zcode-plugin/plugin.json`（W6 交付）

```json
{
  "name": "zcode-crosschat",
  "version": "0.2.0",
  "description": "Agent-team collaboration for independent ZCode sessions: a lead coordinates engine-provisioned teammate sessions, members self-start via prompt protocol, and a file mailbox remains the source of truth.",
  "description_i18n": {
    "en": "Lead-teammate collaboration across independent ZCode sessions: engine-provisioned members, protocol-driven auto-start, dependency-aware task graph, structured team panorama, and hard message-safety guarantees on a file-mailbox source of truth.",
    "zh-CN": "跨独立 zcode 会话的队长-队员协作：引擎程序化建员、协议驱动自动开工、依赖任务图、结构化团队全景，以及基于文件邮箱真源的消息安全硬保证。"
  },
  "author": { "name": "QiruiGo" },
  "license": "MIT",
  "skills": "skills",
  "commands": "commands",
  "hooks": "./hooks/hooks.json",
  "mcpServers": {
    "crosschat": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "ZCODE_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "ZCODE_PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "ZCODE_PLUGIN_ID": "zcode-crosschat",
        "XC_WAKE_ENABLED": "${user_config.wake_enabled}",
        "XC_ZCODE_EXE": "${user_config.zcode_exe}",
        "XC_ZCODE_CJS": "${user_config.zcode_cjs}",
        "XC_MAX_MEMBERS": "${user_config.max_members}",
        "XC_MEMBER_MODEL": "${user_config.member_model}",
        "XC_MEMBER_PROVIDER": "${user_config.member_provider}",
        "XC_MEMBER_REASONING": "${user_config.member_reasoning}",
        "XC_MEMBER_BOOTSTRAP_TIMEOUT_MS": "${user_config.member_bootstrap_timeout_ms}",
        "XC_INBOUND_MODE": "${user_config.inbound_mode}",
        "XC_STALE_TASK_MINUTES": "${user_config.stale_task_minutes}"
      }
    }
  },
  "userConfig": {
    "wake_enabled": {
      "type": "boolean",
      "default": false,
      "title": "推送唤醒",
      "description": "派发/回传/解除阻塞后用 zcode --resume 无头唤醒目标会话（经孤儿化跳板，派发方退出不影响唤醒；fire-and-forget，失败自动回落邮箱投递）。团队自动开工演示必须开启；默认关闭以保护正被桌面持有的会话。"
    },
    "zcode_exe": {
      "type": "file",
      "default": "",
      "title": "ZCode 可执行文件",
      "description": "推送唤醒与成员供给用的 zcode 可执行文件绝对路径（随机器安装位置不同，需自行填写）。"
    },
    "zcode_cjs": {
      "type": "file",
      "default": "",
      "title": "zcode CLI 入口脚本",
      "description": "与 zcode_exe 配套的 CLI 入口脚本绝对路径。"
    },
    "max_members": {
      "type": "number",
      "default": 8,
      "title": "成员上限",
      "description": "团队最大成员数（含 lead 之外的全部成员，removed 不计）。超限的 xc_member_add 被硬拒。对照 dsh-agent-teams maxMembers 默认 8。"
    },
    "member_model": {
      "type": "string",
      "default": "",
      "title": "成员模型",
      "description": "新建成员会话使用的模型 id（如 glm-5.3-flash）。留空时引擎从 app-server 枚举的可用模型表选第一个。新会话默认模型可能是失效 key，建议显式指定（FEASIBILITY P1/E4）。"
    },
    "member_provider": {
      "type": "string",
      "default": "",
      "title": "成员模型 provider",
      "description": "成员模型的 providerId（如 opencode）。留空时按枚举表自动匹配。"
    },
    "member_reasoning": {
      "type": "string",
      "default": "max",
      "title": "成员推理档位",
      "description": "成员会话的 reasoningLevel（默认 max）。"
    },
    "member_bootstrap_timeout_ms": {
      "type": "number",
      "default": 300000,
      "title": "成员供给超时",
      "description": "xc_member_add 等待成员欢迎回合完成的上限（毫秒）。超时成员标记 failed，可同名重试（幂等重供给）。"
    },
    "inbound_mode": {
      "type": "string",
      "default": "accept",
      "title": "入站消息策略",
      "description": "对成员间自由消息（chat 帧）的入站裁决：accept 直接入箱；hold 进 .held.jsonl 待 xc_inbound_review 处置（钩子不注入、唤醒不携带）；refuse 直接拒收并给发送者回执。协议帧（派单/回执/空闲/解除阻塞）不受此开关影响。"
    },
    "stale_task_minutes": {
      "type": "number",
      "default": 30,
      "title": "僵尸任务阈值（分钟）",
      "description": "claimed/in_progress 任务超过该分钟数无任何状态更新且成员无在途唤醒时，被引擎清扫回 pending 并向 lead 发 failed 回执。成员守则要求长任务每 10 分钟心跳一次。"
    }
  }
}
```

### 10.2 `plugin/scripts/build.mjs`（W1 交付）

```js
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = [
  join(root, "src/mcp/server.ts"),
  join(root, "src/engine/wake-helper.ts"), // v0.2：V9 修复的孤儿化跳板（DESIGN-V0.2 §4.2）
  join(root, "src/hooks/session-start.ts"),
  join(root, "src/hooks/prompt-submit.ts"),
  join(root, "src/hooks/stop.ts"),
];
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  entryPoints: entries,
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
console.log("build ok -> dist/mcp/server.mjs + dist/mcp/wake-helper.mjs + dist/hooks/*.mjs");
```

### 10.3 `plugin/src/mcp/server.ts`（W6 交付，全文）

```ts
/**
 * M3 server：stdio MCP 入口（DESIGN.md §1.3、§2.8；v0.2 组装链见 DESIGN-V0.2.md §9）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 *
 * v0.2 组装链（DESIGN-V0.2 §9.1）：
 *   base(createToolCore) → W3 withTaskEdges（清扫+依赖解除+unblock 唤醒）
 *                        → W5 withGuards（removed 硬拒+入站策略）
 *   注册：v0.1.0 七工具（包装后）+ W2 member-tools + W4 lead-tools + W5 security-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolCore, registerTools, resolveDeps, type ToolCore, type ToolDeps } from "./tools.js";
import { withTaskEdges } from "./task-edges.js";
import { withGuards, registerSecurityTools } from "./guards.js";
import { registerMemberTools } from "./member-tools.js";
import { registerLeadTools } from "./lead-tools.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.2.0";

/** v0.2 工具核心组装链：包装顺序固定——先边沿后守卫，守卫（安全）最贴近工具入口。 */
export function composeCore(deps: ToolDeps): ToolCore {
  const base = createToolCore(deps);
  return withGuards(withTaskEdges(base, deps), deps);
}

export async function main(): Promise<void> {
  const deps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const core = composeCore(deps);
  registerTools(server, deps, core); // v0.1.0 七工具，注入包装后的 core（tools.ts §10.4 缝隙）
  registerMemberTools(server, deps); // W2：xc_member_add / xc_member_stop
  registerLeadTools(server, deps);   // W4：xc_team_init / xc_idle / xc_cancel
  registerSecurityTools(server, deps); // W5：xc_inbound_review

  const transport = new StdioServerTransport();
  // 连接关闭（宿主会话结束/无头回合退出）→ 本进程随之退出：绑定随连接消亡（§2.3-2）。
  transport.onclose = () => {
    process.exit(0);
  };
  await server.connect(transport);
  // connect 返回后保持事件循环存活（stdin 未关即继续服务），不需要额外定时器。
}

// 只在直接执行（dist 产物被 node 运行）时启动；被测试 import 时不自启。
// ESM 下没有 require.main，用 import.meta.url 与 argv[1] 对比近似判断。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stdout 被协议占用，错误只能去 stderr。
    console.error("[zcode-crosschat] mcp server failed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
```

### 10.4 `plugin/src/mcp/tools.ts` 的唯一缝隙（W6 执行；精确改动块，其余 815 行不动）

```ts
// 现状（tools.ts:763-765）：
/** 注册全部 7 个工具（DESIGN §2.8）。core 层已做信封映射，handler 只透传。 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const core = createToolCore(deps);

// 改为（唯一改动；其余不动）：
/** 注册全部 7 个工具（DESIGN §2.8）。coreOverride 供 v0.2 组装链注入包装后的核心（DESIGN-V0.2 §10.3）。 */
export function registerTools(server: McpServer, deps: ToolDeps, coreOverride?: ToolCore): void {
  const core = coreOverride ?? createToolCore(deps);
```

### 10.5 `plugin/hooks/hooks.json`：**不变**（3 个钩子原样；held 消息因独立文件天然不被注入，见 §7.4-I4）。

---

## 11. 与 v0.1.0 的兼容与回归策略

### 11.1 兼容保证（逐条）

| 面 | 保证 | 机制 |
|---|---|---|
| 7 个 xc_* 工具行为 | 不变（pull 邮箱闭环原样） | 包装层只叠加（terminal 报告后追加动作、chat 入箱前置裁决），v0.1.0 校验与写盘路径不触碰；tools.ts 主体不动（§10.4） |
| 磁盘 schema | 旧文件可读 | types.ts 新字段全部**可选**且 coerce 缺省容忍（§6.5）；新文件 policy.json/.held.jsonl 独立于旧文件；team.json 旧副本无需迁移 |
| 协议摘要 | PROTOCOL_DIGEST 会随新增帧/规则变化（identity.ts:51-58 规范串）→ 升级后两端摘要不一致属预期，xc_register 返回值仅作核对提示，不构成兼容断点（如实声明） | identity.ts（W5） |
| 斜杠命令 | 4 个旧命令语义不变 | 不改旧命令文件；新增 /xc-team、/xc-member |
| 配置 | 旧 userConfig 三项保留；新七项（max_members / member_model / member_provider / member_reasoning / member_bootstrap_timeout_ms / inbound_mode / stale_task_minutes）有默认值，零配置仍可用 pull 路径 | §10.1 |
| Stop 钩子 | v0.1.0 纯探针行为被扩展（回合收尾刷新快照），失败静默降级、仍恒 exit 0，不改变会话行为 | hooks/shared.ts 纪律（auditHookFailure，shared.ts:124-140）；§7.3.1 |
| 邮箱内容 | 旧消息（JSON 帧两类 + 自由文本）读取不受白名单影响 | 白名单只拒「具名未知帧」，自由文本按 chat（§7.4-I3） |

### 11.2 回归执行清单（验收 4 的操作定义）

1. `npm run typecheck` → 零错误；
2. `npm test` → **v0.1.0 全部 17 文件 167 例全绿**（09 §2:29 验证基线；README.md:147 自测口径记 168 例，相差 1 例属统计口径，回归判定以 09 基线 167 为准并记录实际通过数）+ 新增模块用例（graph/guards/policy/types 兼容/wake v2 prompt/helper spawn/resume-cli helper 路径/snapshot 刷新）；
3. `zcode plugins validate <repo>/plugin` → `Plugin manifest is valid`；`plugins install zcode-crosschat@dev-zcode-crosschat`（09 §2 V4 实测语法）→ 0.2.0 enabled；
4. **pull 三环冒烟**（无 wake）：两会话手动 `/xc-work a`、`/xc-work b` → A `/xc-dispatch b 计算 17*23…` → B 查箱/认领/报告 → A 核对 sha256 汇报——复刻 09 §3，判断据 = team.json history 四步 + 回执 readAt 落盘 + 引擎.jsonl 无 wake 行；
5. **旧数据装载回归**：把 09 留存的工作区 `.crosschat/`（evidence/08-zcode-plugin/phase1/snapshots/final/）拷入新插件环境跑 `xc_status`/`xc_check_inbox`/一次派发——旧 team.json/inbox 无 coerce 报错、旧成员以 peer 身份照常工作（state/identity 缺省兼容实证）。

回退策略：包装层与全部新工具彼此独立，任一模块缺陷可单独下线（server.ts 组装链注释掉对应注册行即为该模块的功能开关），v0.1.0 行为立即恢复——组装点只有 §10.3 一处。

---

## 12. v0.3.0 backlog（CC 增量清单与可选差距的明确去向，不静默丢弃）

按任务书要求：11-cc逆向 §4.3 十条增量清单中，#5（队友提示词协议）、#4（idle_notification）、#6（命名规则）进 v0.2（§3.4/§5.3/§3.1）；#3（认领原语）以等价性保留（§2.2-D5）；以下各项**明确归 v0.3.0**：

| 项 | 内容 | 去向理由 |
|---|---|---|
| #1 | 跨会话消息传输层（UDS/命名管道 + peer 注册表 + SendMessage/ListAgents 名字即地址） | 独立轴（CC 自身也是 teams 与 cross-session 两套独立机制，11-cc逆向 §2 架构图）；v0.2 的队内邮箱已闭合组队核心；GAP O-4/O-7 同栏 |
| #2（余量） | 六类协议帧中未实现的：plan-approval / permission-request / sandbox-permission / mode-set（task_assignment 与 shutdown-request 已在 v0.2：ticketText 与 shutdown-request 帧） | 依赖计划评审与权限冒泡的宿主面；zcode 侧等效实现手段待定——形态差异已记录在 GAP §3-C8（权限审批不绕过人：审批在成员各自会话内照常弹，v0.1.0 形态），非新宣称的平台禁区；GAP O-2/O-5 同栏 |
| #6（余量） | 命名规则的剩余项：重名 `-2` 后缀、颜色调色板、`<name>@<team>` 身份串 | v0.2 采纳的是更严的一面：重名 `name_taken` 硬拒（identity.ts:187-194）而非 `-2` 自动派生；颜色是 zcode 无 pane 形态下的纯装饰项；身份串可由 xc_status v2 字段派生（`key@teamId`）。剩余部分随 #9 面板项在 v0.3 评估 |
| #3（余量） | 每任务一文件 + `.highwatermark` id 分配器 + 「先读后改」纪律 | 等价保留（§2.2-D5）；若未来多队/海量任务出现锁粒度瓶颈再升级 |
| #7 | 成员 worktree 隔离（`isolation: worktree` + EnterWorktree） | CC agent teams 亦不自动隔离（T15：靠文件归属划分，doc-agent-teams.html 行 419-420）——不构成 agent-teams 形态降效（GAP O-3）；作为成员派发可选项延后 |
| #8 | spawn 安全硬化（deny 规则 argv 重放校验等） | CC 特有的 tmux argv 重放面；本设计成员=引擎经 app-server 建会话，参数面为受控协议（§6.2），等价面在 §7.4-I2/I5 成文 |
| #9 | agent view 式交互面板（行选择/transcript 预览/Esc 中断） | zcode 无 UI 注入点（PLATFORM §2.1）；v0.2 已交付数据面+控制面（§7.3），交互面板待宿主能力 |
| #10 | 独立进程后端（tmux 等价） | 成员即独立无头进程（D3 形态），已达成 CC in-process 之外的独立进程形态；窗口化呈现待宿主 |
| O-1 | 质量门族完整移植（verdict/修复轮次/覆盖率矩阵/工件漂移） | dsh 1832 行纯函数可整体移植（GAP O-1「延后无迁移成本」）；v0.2 保留 evidence+sha256 极简门 |
| O-8 | 成员工具策略 / 派生深度护栏（dsh tool-policies.js + memberMaxDepth） | session/create 的 toolAllowlist/toolDenylist 安全面未实测（FEASIBILITY §6-3、本文 V15），作为 v0.2 实现期验证点先行；策略机制本身随 #1/#2 批次归 v0.3。v0.2 的等效防线=§7.4-I2/I5（工具面无授权语义 + 来源校验矩阵） |
| O-11（余量） | 派单合同字段（objective/inScope/outOfScope/verify + 路径归属审计） | v0.2 只进了依赖输出注入半边（W3 graph.ts `collectDependencyOutputs`，2000/12000 预算）；合同字段与路径归属审计随 O-1 质量门族归 v0.3（dsh scheduler.js:125-179 派单合同为移植源） |
| O-9/O-10/O-12/O-13 | 兜底模型路由 / reassign+amend / 角色定义文件 / 通道容量限流参数 | 增强项，v0.3 与 #1/#2 同批评估；O-13 的防刷核心（幂等去重+在途唤醒去重）已在 v0.2 生效 |
| O-6 | idle notice 订阅（notify_when_idle，12h 超时） | E-c 空闲边沿已覆盖队内场景；跨会话订阅随 #1 传输层 |

---

## 13. 实现期验证点与风险（如实声明）

| # | 事项 | 影响 | 验证/回退 |
|---|---|---|---|
| V12 | helper 孤儿化在本机 zcode 0.17.1 的产品化复现（E3b 是实验件） | W1 正确性 | Phase B 场景即验证；失败 → WMI 备选（§4.3 预设计） |
| V13 | app-server `settings.model.available[].ref` 的 providerId/modelId 字段形态（P1 仅一 build 实测） | W2 setModel | provision 内枚举 + setModel 后回读校验（E4 以回合 modelId 验证生效的手法）；失败 → XC_MEMBER_MODEL 显式指定兜底 |
| V14 | 成员欢迎回合在 yolo 模式下的权限面与生产模式差异 | 演示/生产口径 | README 明示；生产建议受限 mode + 宿主权限面（§7.4-I6） |
| V15 | maxMembers 上限与 toolAllowlist/toolDenylist（session/create 安全面）未实测（FEASIBILITY §6-3 明示属实现期验证点） | W2 安全面 | 上限逻辑为纯插件侧（单元测试覆盖）；toolAllowlist 列为 v0.2 实现期实验项，不进硬验收 |
| V16 | 清扫误杀（长任务无心跳 >30min） | E-e 边沿 | 心跳守则 + 阈值可配 + 误杀可重派（§5.4 已声明代价） |
| V17 | lead 的 MCP server 中途死亡时的 member_add 半程状态 | W2 | 幂等重供给（§6.4）；failed 态可见可重试 |
| V18 | `${user_config.*}` 数值型展开形态（V7 只实测过布尔/字符串） | W6 | 引擎对非有限正整数的任何值取默认值（resume-cli.ts:37-44 wakeSpawnConfigFromEnv 的同款防御），原始值记 engine.jsonl |
| V19 | 单回合多单循环的回合时长上限（宿主对单回合时长/token 的限制未测） | G2 自驱 | 未确认；守则允许回合内做完即收（xc_idle），多单跨回合由 unblock/idle 唤醒接续——闭环不依赖超长回合 |
| V20 | **MCP 工具调用内同步等待成员欢迎回合（≤300s）的宿主时长上限未测**——E4 是脚本直跑 dm-create.mjs，非 MCP 工具路径；§8.2 单回合 3×member_add + 3×dispatch 还叠加 lead 单回合时长风险（与 V19 同类） | W2/演示 | 验证：Phase A 实测单回合供给全链。缓解（runbook 预备形态）：拆成「引导回合（xc_team_init + 3×member_add）+ 派发回合」两个 keeper 自动发送的回合——**「派发方单条指令」以派发回合的指令计**，两条回合记录在 runbook 并列留证，成员侧零人工输入不变；两形态均执行 §8.2 的 owner-absence 审计；仍受限 → member_add 改异步（写 provisioning 记录即返回，xc_status 观察 provisioning→ready，供给由后续唤醒回合内的工具调用续跑） |
| — | V3/V8 维持 v0.1.0 未确认口径；**V5（resume 活属主）维持未确认且本设计所有路径不依赖它**：成员恒 owner-absent（§4.4/§6.3），lead keeper 仅存在于引导阶段并在派发回合结束后退出（§8.1）。运行守则：**任何唤醒路径不得打到活属主会话**——交互式 lead 靠 wake_enabled 默认 false 保护（DESIGN §2.5-2 约束沿用），V5 若将来要支持须先按 DESIGN §9-V5 实测 | — | 见 DESIGN §9 |

---

## 14. 与硬验收的最终对照

| 验收 | 设计保证 | 证据产出 |
|---|---|---|
| 1 自动开工零人工 | §5 边沿模型 + §3.4 守则 v2 + §4 W1 存活唤醒 | 成员唤醒回合 stdout 全记录 + lead 单条指令记录 + runbook 反证（§8.3） |
| 2 动态成员 | §6 xc_member_add 四步 + E-e 投产 | provision 记录 + db 行 + 成员自注册审计（§8.2） |
| 3 lead 协调并行汇总 | §3.2 lead 协议 + 并行派发/回执/汇总 | lead 回合记录 + 时间窗重叠表 + team.json DAG（§8.3） |
| 4 回归 | §11 兼容表 + 回归清单 | typecheck/全量单测/pull 冒烟/validate（§8.5） |
| 5 GAP 闭合 | §3/§5/§6/§7 逐条回应 G1-G6；无新平台限制宣称 | §8.4 证据 + §12 backlog 显式化 |
