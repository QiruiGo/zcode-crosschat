# DESIGN-V0.7.md — v0.7.0 设计：C6 转办授权 / C7 审批最小集 / C8 离线转交 / C9 压缩联动 + 旧名移除

日期：2026-11-15 ｜ 状态：待用户批准 ｜ 前置：v0.6.1 已交付（tag v0.6.1，main=640220c；工具面恰 10；红队四番战 P0/P1 清零）

## 0. 输入与依据（每条设计决策的出处）

| 输入 | 关键结论 | 本设计对它的消费 |
|---|---|---|
| reports/21-v060方案.md §C（v0.6.0 方案） | C6/C7/C8/C9 列为 v0.7.0 批次；§5-3 承诺「改名旧名映射一个版本（v0.7 移除）」 | 本设计 = §C 四项 + MIGRATION §5 承诺的执行 |
| docs/MIGRATION.md §1/§3/§5（v0.6 迁移表） | 22 个别名 + 2 个命令存根（`/xc-agents`、`/xc-member`）**v0.7.0 移除**；§6 有自检口径 | §7 移除清单与 MIGRATION §1 逐行对账 |
| E2（evidence/21-v060/e2/e2-mcp-scope-report.md） | MCP 四级来源（项目/用户/插件/宿主注入）；「B 会话缺 MCP」**默认是放置问题不是转办问题**；只有宿主注入类（web_reader、官方 HTTP 插件 MCP）必须转办或 user 级 stdio 重建 | C6 的「配置优先」前置建议（§2.1）；转办的真实目标限定为宿主注入类 |
| E3（evidence/21-v060/e3/E3-实验报告.md） | 成员=回合制瞬态，就绪态零专属进程；成员 stop 内存意义=0；close→resume 可完整捡起 | C8「不能把空闲当离线」的机制依据（§4.1） |
| E4（evidence/23-v070/e4/E4-转办链路实验.md） | C6 最小链路在 v0.6.1 现有面**端到端跑通**（5 requestId、18 无头回合）；三个硬约束：①未登记具名帧被静丢弃（R1，最高优先级）②审批门是模型层执行（R2）③唤醒回合继承发起方环境（R6）；字段草案 + R1-R8 风险清单 | C6 帧格式、C7 审批文件格式、门下沉形态、风险逐条落位（§2/§3/§10） |
| reports/22-v061验收.md | v0.6.1 七项硬标准全过；工具面黑盒核数方法（MCP stdio tools/list 精确集合）；49 bug 重放 regression-battery 51/18 | §6 工具面核数沿用同法；§8 验收映射引用同一组回归资产 |
| redteam-4/evidence/adversarial/adjudication.md | P2/P3 共 16 项 confirmed 不修 | §7 如实声明不在本版范围 |

产品纪律（用户最高约束，本设计每节自对账）：工具面 ≤12（**目标维持恰 10**：审批并入 `xc_review`、转办并入 `xc_relay` 的帧型，不新增工具）；不新增用户必填配置（新阈值只走 env 常量，不进 plugin.json userConfig——与 v0.6 的 `XC_MEM_*` 同款先例）；安全内部化（不崩/不丢/不串号，不做对抗级防伪）；v0.6 已交付能力不回退；不恢复被砍对抗面。

---

## 1. 设计决策总览（反臃肿核算）

| 决策 | 结论 | 理由（证据） |
|---|---|---|
| C6 载体：新工具 vs `xc_relay` 帧 | **`xc_relay` 的帧**（不新增工具） | E4 §4 实测 kind/type 帧骑 `xc_relay` 队内轴+文件邮箱端到端跑通；`xc_relay` 已是双轴发送唯一面（urgent/回执/守卫链现成，tools-relay.ts:240 `createTeamRelayCore`）；新工具需全套注册/身份/守卫/审计挂点，纯臃肿 |
| C6 帧键名：`kind` vs `type` | **`type` 键 + 进 FRAME_TYPES 白名单** | `classifyFrame` 只认 `type` 字段判具名帧（mailbox.ts:76，type 判据 :84；:83 是 isRecord 检查）；E4 原型用 `kind` 是**绕过白名单**的权宜（JSON 无 `type` 键→按 chat 直通），落地必须改 `type` 键并加白，否则白名单加了也不生效（R1 的正确闭合） |
| C7 载体：新工具 vs `xc_review` 扩展 | **`xc_review` 扩展 action/axis**（不新增工具） | E4 §5 同款结论；`xc_review` 已是「待处理项列表+裁决」唯一面（tools-review.ts:30-34）；审批通知与入站审阅同构 |
| C7 授权锚点 | **审批文件**（用户/lead 落盘），插件侧确定性校验；帧只做通知/回执 | E4 §5：「白名单帧永不代表授权」与 v0.2 立意一致（mailbox.ts:16-18 头注 / :42-43：CC "permission rules are never accepted from messages"）；授权只认审批文件 |
| 审批门下沉形态 | **共享渲染层结构性拒绝**：未过审的 `tool_request` 在读取面（inbox 消费 + mail 分页**双路**）被插件侧转成遮蔽回执，**不进模型注入面**；且 `tool_request` 帧一律不唤醒投递 | E4 §7.1 实测「传得到、收不到」证明读取面过滤是硬闸；R2「模型层劝告级」由此变为结构性（模型看不到请求，无法执行）。双路+禁唤醒的理由见 §2.2/§2.7（mail scope 原文旁路、wake ticket 旁路均为实测事实） |
| C6 执行者 | **A 的模型回合**（不是插件直执） | 架构边界：crosschat 的 MCP server 是宿主外独立 stdio 进程，不持有宿主其他 MCP 连接，无法代调宿主工具；E4 §6.2 「插件直接执行」设想在本架构不可达——如实收窄 |
| C8 回池路径 | **复用 stale sweeper**（不新开回池路径），增量只在「活性判定 + lead 通知 + 转交建议」 | sweepStaleTasksLocked 已回池+回执+审计（task-edges.ts:164-227）；C8 新开闸会与 30min stale 双闸竞态 |
| C9 范围 | overview 建议行 + longtask checklist + 文档；**不实现宿主压缩钩子** | 平台无压缩钩子接口（任务约束）；C4 journal 落盘已交付，C9 只做闭环提醒 |
| 工具面 | **恰 10，0 新增**（净变化：删 22 个别名） | §6 核数结论 |

**模块数口径**（与 DESIGN-V0.6.md §4.1 一致，= 实现对账单元 = 本文件 §9.1 的 M1-M8）：**8 个模块**。

---

## 2. C6 转办授权

### 2.1 配置优先建议（E2 口径，先于一切转办）

「B 会话缺 MCP」的处置矩阵（E2 §4 四行，本设计原文采纳）：

| 缺失成因 | 配置层可解？ | 处置 |
|---|---|---|
| ① user/项目级都没配 | 可 | 放 `~/.zcode/cli/config.json` `mcp.servers`（user 级）→ 所有会话直接可用（E2-d 实测） |
| ② 只在项目级配了、未批 trust | 可 | 桌面 UI `/mcp` 批准一次（持久化在用户侧；批准后 headless/成员会话直接可用，E2-e 实测） |
| ③ user 已有同名 server | 可 | 用户级恒赢（E2-c）；改名或实现上移 |
| ④ 宿主注入（web_reader）、官方 HTTP 插件 MCP（trusted origin registry） | **不可** | 只能 A 会话模型转办；或为 B 重建 user 级 stdio 等价 server |

**落点**：本条是文档/skill 层建议，**不进代码**——如实理由：crosschat 的 MCP server 看不到宿主的其他 MCP server 清单（各 server 独立 stdio 进程），插件内无法枚举「B 缺什么」，故无法给出程序化诊断。落地三处：README「长期任务」章加处置矩阵表；PROTOCOL.md 新增 C6 节复述；skills/crosschat/SKILL.md 加一行纪律（「成员报缺工具时，先查放置，再考虑转办」）。

### 2.2 帧格式与载体（`xc_relay` 帧；FRAME_TYPES 加白）

帧骑在 `xc_relay` 的 `msg` 里（JSON 字符串；`to` = A 的队内花名）。**键名用 `type`**（与既有 7 个协议帧一致，如 task-edges.ts:190 的 `type:"task-receipt"`）：

```
tool_request  = {"type":"tool_request","requestId","from","tool","args","reason",
                 "approval":{"required":true,"file","ttlMs"},"maxResultChars"}
tool_result   = {"type":"tool_result","requestId","status":"ok|refused|error","tool",
                 "result"|"error"|"reason","ts"}
```

- `requestId`：uuid；同时作为台账文件名（`.crosschat/toolrequests/<requestId>.json`）与审批文件名（`.crosschat/approvals/<requestId>.json`）——天然可检索（E4 §5）。
- `from`：请求方（与信封 from 双写，队内信封本就有 from，mailbox 渲染面可核对）。
- `tool`：完整 MCP 工具名（`mcp__…__…`），自由字符串，不枚举（E4 §2：协议与工具无关，被测 probe_ping 非宿主注入类不外推实用性）。
- `args`：对象；**≤ 64KB**（序列化长度，见 §2.4）。
- `reason`：必填，进审计。
- `approval.file`：审批文件路径（缺省 `<stateRoot>/approvals/<requestId>.json`，可由请求方指定同状态根内路径）。
- `ttlMs`：请求有效期；缺省 3_600_000（1h），硬上限 86_400_000（24h）；env `XC_TOOL_REQUEST_TTL_MS` 可改缺省（**只走 env，不进 userConfig**）。
- `maxResultChars`：回投上限；缺省 64_000（= budget.ts:28 `READ_PAGE_MAX_CHARS`），上限同值。
- `tool_result.ts`：回投时刻（R7：resumed 会话记忆污染，接收方以邮箱原文+requestId+ts 自判新旧）。

**白名单改动（R1 闭合）**：`FRAME_TYPES`（mailbox.ts:51-59）扩 4 值：

```
'tool_request' | 'tool_result' | 'approval_request' | 'approval_result'
```

未加白的后果已被 E4 §7.1 实测（`type:"tool_request"` 落箱后 `xc_read` 永远看不到 + `frame-rejected` 审计）。加白后：**两个读取面都可见且都过门**——inbox 消费（tools-read.ts:108-135 的 renderTeamEnvelope + classifyFrame 渲染路径）与 mail 历史分页（tools-read.ts:231-252 的 `xc_mail_read`，当前实现直接 `paginateText(message.content, …)` 返回原始帧全文，**无门**——v0.7 必须改为经共享门渲染，见 §2.7）；**混合版本降级**：v0.6.1 端点收到新帧型 → 判未登记具名帧 → 剔除+审计（不崩、不静默错投），该降级行为写入 PROTOCOL。

**wake 投递禁令（旁路防护，实测事实）**：`tool_request` 帧**一律不唤醒投递**——relay 核心在发送侧强制 `delivered:"mailbox"`（payload 标注 `wake:"suppressed (approval-gate bypass guard)"`）。理由（本会话读码实测）：wake prompt 的正文由调用方 ticket 原样携带——`tools-relay.ts:443` 把 `out.content`（消息原文）当 ticket 传入，`engine/wake.ts:567` `bodyText: req.ticket` 原样进 prompt。**该路径与 urgent 无关**（任何 delivered="wake" 的 relay 消息都把全文带进唤醒 prompt），只禁 urgent 挡不住这条。 urgent=true 仍允许（仅作用于邮箱 urgentFirst 排序与回执标注，不触发唤醒）。转办不是紧急通道：A 的下个回合（自然回合或被别的消息唤醒后）读箱即处理；如需催促，另发一条普通 urgent 消息。

**uservoice 豁免**：relay 核心对 `type:"tool_request"|"tool_result"` 帧跳过 `origin=user` 盖章（机器帧不应有用户亲述语义）。依据 E4 §7.3：B 的 prompt 逐字包含请求帧文本时，UserPromptSubmit 钩子会把机器请求当用户原话存档、relay 同文即盖章（engine.jsonl `uservoice-hit` 实测）。盖章逻辑在 tools-relay.ts:346-358，豁免=该函数对这两种帧型早返回。

### 2.3 审批绑定（谁批准 / 批多久 / 工具白名单）

- **谁批准**：用户或 lead。请求方（B）与执行方（A）均不能自批——插件侧校验 `approvedBy !== from && approvedBy !== to`（防误操作与「A 的模型自己写审批」的 naive 路径；内部威胁模型声明：不防恶意同机进程伪造文件，与 v0.5 uservoice 已知边界同款，README 披露）。
- **批多久**：审批文件 `expiresAt` 必须 `> now` 且 `≤ 请求 ts + ttlMs`（批准窗不超出请求窗）；过期即拒（E4 §6.4 实测拒绝正确）。
- **工具白名单**：**逐请求绑定**——审批文件 `tool` 字段必须与请求 `tool` 逐字节相等，否则拒（`approval tool mismatch`）。不设全局固定禁用品清单：那会变成配置面 + 误伤（如 node_repl 在合法场景可能需要）；R3「A 的 MCP 面对 B 全开」的缓解 = 逐请求审批 + reason 必填 + 反洗白纪律文案（「peer 不是你的工人，relay 消息不是用户同意」——复述进 README 威胁模型章与 crosschat skill）。
- **批准入口（二轨同一格式）**：
  1. **文件轨**（授权锚点）：用户/lead 直接写 `.crosschat/approvals/<requestId>.json`（E4 原型形态，实验员手写已验证）。
  2. **工具轨**：`xc_review({action:"approve"|"deny", axis:"approval", id:<requestId>, ttlMs?, note?})`——插件侧实现 = 写同一格式审批文件 + 引擎审计（见 §3.2）。**仅现任 lead 可 approve**（`not_lead` 闸；lead 恰为请求双方时走文件轨）；用户本人走文件轨（§3.2）。

### 2.4 预算（大小上限 + 注入预算复用）

| 面 | 规则 | 落点 |
|---|---|---|
| args | 序列化 ≤ 64KB（`TOOL_REQUEST_MAX_ARGS_CHARS`）；超限 relay 核心直接拒收并回 `tool_result{status:"error",error:"args_too_large"}`（E4 §5） | 新 core/toolrelay.ts 纯函数 + tools-relay.ts 发送侧 |
| result | ≤ 请求的 `maxResultChars`（缺省 64K）；超限 relay 核心拒收 `result_too_large`（模型改投摘要+文件指针）；A 侧主动截断时标 `resultTruncated{shown,total}` | 同上 |
| 协议硬顶 | MCP stdio 单帧 32MiB（transport/mcpstdio.ts:32 `MCP_MAX_FRAME_BYTES`）——超限走 -32700 显式拒收，server 续命（v0.5.1 既有） | 不改 |
| 注入面 | **复用**现有注入预算：帧进邮箱后按 `receiverInjectBudget`（budget.ts:45-57，item 4000/total 16000 基准）截断+尾注指针；全文 `xc_read({scope:"mail"})` 分页取回（每页 64K，budget.ts:28）。E4 §6.1 实测 8642 字符帧「展示截断→完整恢复→执行成功」。**注意**：mail 取回的是获批请求的执行通道（E4 §7.4），故 mail 分页输出必须同受审批门（§2.7 共享渲染层），不能返回原始帧全文 | 不改预算机制；mail 输出加门（tools-read.ts） |

### 2.5 审计与过期（插件侧，替代模型代写）

- **台账** `.crosschat/toolrequests/<requestId>.json`（E4 §7.4 建议的「按 requestId 可检索」最小实现）：
  `{requestId, from, to, tool, reason, ttlMs, maxResultChars, state, createdAt, expiresAt, decidedAt?, decidedBy?, decisionReason?, resultChars?, resultMessageId?}`。
  **统一状态枚举**（§3.1 同用此表，不设第二套词）：`pending`（已建待批）→ `approved`（门放行≥1 次）｜`denied`（审批文件 decision=denied）｜`refused`（门拒：缺失/畸形/过期/工具不符/自批）｜`executed`（收到 ok 回投）｜`error`（收到 error 回投）｜`expired`（sweeper 判 ttl 超期）。
  写入点：relay 核心（发送 create=pending；收到 `tool_result` 终填 executed/error）、工具轨 `xc_review` approve/deny（写 approved/denied）、读取面审批门（门拒时写 refused）、sweeper（标 expired）。读者：overview（待处理转办计数+老化）、`xc_review axis:"approval"`（pending 且无审批文件的请求）、mail/inbox 渲染门（按 state 决定放行或遮蔽）。
- **引擎审计**（engine.jsonl，替代 E4 原型的模型代写审计文件，R8）：`tool-request`（发送）、`tool-decision`（门裁决：approved/refused+reason）、`tool-executed`（回投：resultChars/status）、`tool-result-rejected`（回投帧 requestId 不匹配/from≠执行方/超限）。邮箱原文 + 审计双轨（「不丢/可核对」）。
- **过期**：请求 `expiresAt = ts + ttlMs`。A 消费时过期 → 拒（`request expired`）；A 不在线躺箱 → sweeper 节拍扫台账标 expired 并回投 B 一帧 `tool_result{status:"refused",reason:"request expired"}`（R5 与 C8 联动：见 §4）。

### 2.6 失败路径（E4 §6.4 全表 + 本设计裁决）

| 模式 | v0.7 行为 | 依据 |
|---|---|---|
| A 不在线（队内轴无活性闸） | 入箱异步等下个回合；台账 pending；超 ttl 由 sweeper 标 expired + 回投 | E4 §6.4；R5 |
| A 不存在 | `target_not_found`（队内名册先查、peer 后查，现成） | E4 §6.4 |
| 工具不存在 | 平台错误原样回投 `status:"error"`，不伪造结果 | E4 §6.4 |
| 审批缺失 | 门拒：回投 `refused` + `reason:"approval missing"`，审计 `tool-decision` | E4 §6.4（原型模型层，本版插件侧） |
| 审批过期 | `reason:"approval expired"` | 同上 |
| 审批畸形（不可解析 JSON） | `reason:"approval file malformed (unparseable JSON)"` | 同上 |
| 审批 tool 不符 / denied / 自批 | 分别 `approval tool mismatch` / `approval denied` / `self-approval refused` | §2.3 新增 |
| args 超限 | 发送侧即拒：`args_too_large` | §2.4 |
| result 超限 | 回投侧拒：`result_too_large`（模型改摘要+指针） | §2.4 |
| 结果陈旧（resumed 会话） | 回投帧带 requestId+ts；接收方以邮箱原文为准 | R7 |
| urgent 旁路 | wake 投递禁令（§2.2）：`tool_request` 强制 mailbox 投递，payload 标注 suppressed | R2 防绕过 |
| 伪造回投（`tool_result.from` ≠ 请求的 to） | relay 核心拒收：`tool-result-rejected`（审计）+ 不落箱、不终填台账 | §2.7 新增（回投发送方身份校验） |
| 混合版本（老端点收新帧） | frame-rejected 剔除+审计，不崩 | mailbox.ts:256-274 |

### 2.7 端到端链路（v0.7 目标态）

```
B: xc_relay({to:"aye", msg: JSON.stringify({type:"tool_request", requestId, from:"bee",
       tool, args, reason, approval:{required:true,file,ttlMs}, maxResultChars})})
   → relay 核心：帧识别 → args≤64K / requestId 未占用 / **禁 wake 投递** / uservoice 豁免
   → 建台账(pending) + 审计 tool-request + 邮箱投递 A（delivered=mailbox，附 suppressed 标注）
A: xc_read({scope:"inbox"})  或  xc_read({scope:"mail", id:<messageId>})
   → 共享渲染层门（core/toolgate.ts 的 gateToolRequestRender，两个读取面共用）：
      tool_request 帧按台账 state 裁决——
   → 拒（state ∈ pending/denied/refused/expired 或台账缺失，fail-closed）：
      插件侧写 tool_result{refused,reason} 进 B 邮箱 + 台账 refused + 审计 tool-decision；
      渲染输出遮蔽占位（`[gated tool_request <requestId>: state=<state> —— 未放行，正文不可见]`），
      **两个读取面都不出原始帧全文**；inbox 路的请求帧标记 discarded（不进注入面）
   → 放（state ∈ approved/executed/error）：输出「APPROVAL VERIFIED」头 + 全文（mail 分页同）
A 模型：调真实 MCP 工具 → xc_relay({to:"bee", msg: JSON.stringify({type:"tool_result",
       requestId, status:"ok", tool, result, ts, from:"aye"})})
   → relay 核心：帧的 from === 台账.to（执行方身份校验）/ requestId 在台账且已放行 /
      大小 ≤ maxResultChars / uservoice 豁免
   → 落 B 邮箱 + 台账 executed + 审计 tool-executed
B: xc_read 收 tool_result（requestId+ts 自判新旧）
```

**共享渲染层门（P1 修复的核心）**：门不挂在 inbox 消费路径，而是挂在**两个读取面共用的帧渲染函数**上（`core/toolgate.ts` 导出 `gateToolRequestRender(message, ledger, now)`：输入一条 TeamMessage + 台账快照，输出「遮蔽占位」或「加头全文」）：
- inbox 路（tools-read.ts:108-135 `renderTeamEnvelope` 前）与 mail 路（tools-read.ts:231-252 `xc_mail_read` 的 `paginateText(message.content, …)` 前）都先过它——修掉「mail scope 原文旁路」（当前实现直出原始帧 JSON，无门）；
- 台账缺失/不可读 → **fail-closed 遮蔽**（安全方向；审批原子写见 core/atomic.ts，丢失概率极低，遮蔽的代价仅是「重新批准」）；
- 遮蔽占位仍带 requestId/state，B 可自勘状态，不破坏「不丢」（审计+台账双轨可恢复事实）。
- 门只对 `type:"tool_request"` 帧生效；其他帧/chat 早返回原路径（零影响，纯函数）。

唤醒回合同样走 `xc_read` 消费（成员守则 prompt 读箱），门在读取面单点生效；wake 只作拉活且 tool_request 不唤醒投递（§2.2）；R6：执行回合是 A 自己的回合——隔离存储下唤醒回合继承发起方环境是平台现状（E4 §7.2），如实列为已知边界，生产单存储无此问题。

---

## 3. C7 审批帧最小集

### 3.1 帧与存储

- **帧型**：`approval_request` / `approval_result`（进 FRAME_TYPES，§2.2）。**只做通知与回执，不带授权语义**（mailbox.ts:16-18 头注 / :42-43 立意；授权只认审批文件）。
  - `approval_request`：A 的门在「无审批」时，除回拒 B 外，向 lead 发一条待批通知（`{type:"approval_request", requestId, from, tool, reason, expiresAt, approveHow}`；`approveHow` = 文件轨路径或 `xc_review({action:"approve",axis:"approval",id})` 文案）。
  - `approval_result`：批准/拒绝动作的回执（`{type:"approval_result", requestId, decision, decidedBy, decidedAt, expiresAt}`）——`xc_review` 的 approve/deny 落地后由插件侧写给请求方 B（通知性；授权效力已在审批文件里）。
- **存储**：
  - 授权文件 `.crosschat/approvals/<requestId>.json`：`{requestId, decision:"approved"|"denied", approvedBy, decidedAt, expiresAt, tool, note?}`（E4 §5 格式）。
  - 台账 `.crosschat/toolrequests/<requestId>.json`：状态机用 §2.5 的**同一套枚举**（`pending → approved|denied|refused → executed|error|expired`；不设第二套词表——`denied`=审批文件显式拒绝，`refused`=门自动拒，`executed`=回投 ok，`error`=回投 error，`expired`=ttl 超期）；审批相关字段 decidedAt/decidedBy/decisionReason。
  - 路径构建器进 `core/paths.ts`（`approvalsFile` / `toolRequestFile`，与 inboxFile/archiveJournalPath 同风格）。

### 3.2 用户批准入口（`xc_review` 扩展，不新增工具）

`ReviewShape`（tools-review.ts:30-34）增量：

```
action: z.enum(["list","accept","discard","approve","deny"]).optional()   // 缺省 list
axis:   z.enum(["team","peer","approval","all"]).optional()               // 缺省 all
ttlMs:  z.number().int().positive().optional()   // 仅 action=approve：批准窗（缺省=请求剩余 ttl，≤请求窗）
note:   z.string().max(512).optional()
```

- `approve`：**仅限现任 lead**（`leadKeyOf(team) !== me.agentKey` → `not_lead`，与 tools-team.ts:297 建员闸同口径；无 lead 时同拒并指引「先 `/xc-team` 立 lead 或走文件轨」——E4 §8 R3 缓解原文「审批文件必须由用户/lead 落盘」，第三方成员可批准会直接违反该缓解与 §2.3）。插件侧写审批文件（decision=approved，approvedBy=本连接 agentKey，expiresAt=now+ttlMs 且 ≤ 请求 expiresAt）+ 审计 + 台账 approved + 向 B 回投 `approval_result` 帧。**自批闸**：lead 恰为请求 from 或 to 时仍拒（`self-approval refused`，§2.3）——此时只能走文件轨（用户落盘）。
- `deny`：写 decision=denied 的审批文件 + 审计 + 台账 denied（门对 denied 文件拒之，reason `approval denied`）。deny 不设 lead 门（拒绝无放行效力，任何成员可代拒；审计留痕）。
- `list axis:"approval"`：列台账中 pending 且无审批文件的请求（requestId/from/tool/reason/剩余 tt）——待批清单。
- 权限纪律不变：审阅的是**本连接身份自己**的 held 队列（tools-review.ts:78 `identityStore.require`）；approve 的 lead 门是新增的唯一角色约束（§2.3「谁批准」的工具轨落地）。

### 3.3 过期与清理

- 过期判定两处：门内（`expiresAt` 过去→拒）+ sweeper 节拍（台账 pending 超 `expiresAt` → 标 expired + 回投 B `request expired` + 若 lead 收过 `approval_request` 通知，回投 `approval_result{decision:"expired"}` 收尾）。
- 清理：挂现有 `startStaleSweeper` 节拍（task-edges.ts:518-527，unref 定时器）顺带扫——终态（executed/refused/denied/expired）台账的审批文件与台账本身保留 `TOOL_APPROVAL_KEEP_MS = 7 天`（常量，不新增 env）后删除；邮箱帧不预清理（JSONL 追加真源纪律，v0.6 起不做 TTL）。无新定时器。

---

## 4. C8 离线任务转交

### 4.1 活性判定（进程死 vs 空闲；复用 v0.6.1 语义）

成员是回合制瞬态（E3 ③：就绪态零专属进程）——**空闲 ≠ 离线**。判定源全部现成：

| 证据 | 语义 | 出处 |
|---|---|---|
| peer 注册表记录 `reason:'pid-dead'`（sid 持有进程亡、记录未优雅摘除） | **进程死（硬证据）** | `scanPeers(root, now, {sweep:false})` 只读扫描，peerregistry.ts:357-395；`peerIsAlive` = pid 活 ∧ lastSeen 保鲜，peerregistry.ts:341-345 |
| 记录 `reason:'lastSeen-stale'`（pid 活、心跳过期） | **进程活着但空闲/长回合**——不是死 | 同上；心跳 15s（peerregistry.ts:59 `PEER_HEARTBEAT_MS`） |
| 无记录（回合间隙/从未 peer 注册） | **未知**——按空闲处理；**优雅退出也会摘记录**（transport/pipe.ts:518-521 `removePeerRecord`），故「用户主动关闭的会话」与「空闲」在注册表上同形，不可检出为离线（E3 ③） | E3 ③；pipe.ts:518-521 |
| 任务 `lastProgressTs` | 任务级无进展时长 | stall.ts:27-30 |
| 成员 `lastSeen` | 上次工具调用时刻（仅参考） | types.ts:224-226 |

**纯函数模块**（新 `core/offline.ts`，无 I/O、now 注入、无定时器——与 core/stall.ts 同纪律）：

```ts
memberLiveness(member, scan, now): 'live' | 'pid-dead' | 'heartbeat-stale' | 'no-record'
offlineVerdict(task, member, liveness, now, thresholdMs): { offline: boolean; evidence: 'process-dead' | 'idle-timeout' | null }
offlineMembers(team, scan, now, thresholdMs): OfflineMember[]   // 含其名下非终态任务
offlineThresholdMsFromEnv(env, staleThresholdMs): { ms, clamped }  // XC_OFFLINE_MINUTES 缺省 240；钳制 ≥ stale
```

- **判定规则（保守；含可达性如实分析）**：
  - `liveness === 'pid-dead'`（硬证据，仅崩溃残留：优雅退出会摘记录，pipe.ts:518-521）→ **免 240min 空闲阈值**：但 sweeper 只处理已超 stale 阈值（30min）的任务（graph.ts:255-260 `staleTasks` 按 `task.updatedAt`、`SWEEPABLE={claimed,in_progress}`、**不看会话活性**；节拍 60s，task-edges.ts:469-471），故动作仍随 30min 节拍发生——C8 的增量是「进程死」证据标注与 lead 通知，不是更快的回池（回池快刀已是 stale 的职责）；
  - `liveness ∈ {heartbeat-stale, no-record, live}` → 只有任务 `now - lastProgressTs > XC_OFFLINE_MINUTES`（缺省 240min，**长于 stall 120 与 stale 30**）才判离线。**可达性如实声明**：因 `updatedAt ≥ lastProgressTs`（stall.ts:27-30），满足 240min 空闲的任务必已在 30min 被 stale 回收（sweeper 常驻，只要任一会话在窗口内活跃即按时扫）——idle-timeout 分支**实际只在窄路径可达**：「全员静默 ≥240min 后某会话重启触发首轮清扫」。C8 的「这个成员没了」升级信号**实际由 process-dead 证据产生**，idle-timeout 是兜底而非常规路径；
  - 钳制：`XC_OFFLINE_MINUTES` < stale 阈值时按 stale 钳制并返回 `clamped`（挂载面附 WARNING，同 stall.ts:86-92 模式）。

### 4.2 回池、通知与转交选择

- **回池**：不新开路径——stale sweeper 的 `sweepStaleTasksLocked`（task-edges.ts:164-227）已做「撤销 attempt + 任务回 pending + createdBy 回执 + task-swept 审计」。C8 的增量：
  1. sweeper 内对每个被扫任务算 `offlineVerdict`；`evidence:'process-dead'` 或 idle-timeout 命中的，除 createdBy 回执外**额外通知 lead**（邮箱消息 + 同一 `wakePlan` 机制现成扩展），消息体带转交建议（`xc_dispatch` 重派给指定成员=现有能力组合，不新增工具/动作——方案 C8「选择：回池/转交指定成员」由 lead 用 dispatch 完成）；
  2. `TaskEdgeOutcome` 增 `offline: OfflineMember[]`（进工具 payload 与 engine 审计 `task-offline` 事件）。
- **边界**：stale（30min，任务级，不论会话活否）保持不动——它是「在途 attempt 死了」的快刀；C8（240min/进程死）是「这个成员没了」的升级信号（实际由 process-dead 证据产生，见 §4.1 可达性声明）。30 < 240 保证 stale 先动，C8 永不抢先、无双闸竞态。豁免条件（在途 wake nonce，task-edges.ts:178-181）不动——进程死证据不绕过豁免（nonce 有 TTL，保守优先）。
- **「活着但空闲不被误回收」的前提（验收必读，P2 修复）**：该判据在**判定层**成立（offlineVerdict 不把 heartbeat-stale/no-record 判离线），但在**回收层**，缺省配置下活跃但空闲成员名下的 claimed/in_progress 任务**仍会被 30min stale 快刀回收**——`staleTasks` 不查会话活性（graph.ts:255-260），豁免仅限在途 wake nonce（task-edges.ts:178-181）。这是 v0.5.3 起的既有设计（「无进展 attempt 回收」），本版不改。故验收剧本若要验「alive-idle 任务超 30min 仍在」，必须显式把 `XC_STALE_TASK_MINUTES` 调到大于测试窗口（**别用 0**——已知问题边界-10：`=0` 反而不清扫）或依赖 nonce 豁免制造在途；否则该判据在缺省配置下有被判失败的风险——设计在此写明前提，不留暗礁。
- **并发安全**：全部裁决在 `withTeamLock` 内（sweeper 现有机制）；台账/审批清扫同锁外顺带（best-effort，失败不影响回池）。

### 4.3 观测挂载

`xc_overview` team 视图（tools-overview.ts:246 capacity 挂载旁）增 `offlineMembers` 块 + 文本行（`offline: <名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)`），与 stalled 行同风格；`xc_doctor` 不加（体检免注册只读，不涉活性判定）。

---

## 5. C9 压缩联动（最小闭环）

- **overview 容量建议行**：`formatCapacityLines`（capacity.ts:333-346）在 `verdict.red` 时追加固定建议行：
  `compress-advice: 容量预警——先按 longtask checklist 落 journal（.crosschat/tasks/<taskId>/journal.md）再接受压缩；lead 可 relay 要求目标先 xc_report(status:"in_progress") 附 journal 路径`
  （team/panel 两视图都经 capacityMount，tools-overview.ts:68-97，改一处两处生效。）
- **longtask skill checklist**：§3（plugin/skills/longtask/SKILL.md:39-46）已存在「压缩前 checklist」；C9 增量两行：①显式触发条件补「`xc_overview` 容量标红（capacity.red）」；②补 lead 操作序（relay 催 → 等目标 `xc_report(in_progress)` 附 journal 路径 → 才允许其接受压缩）。
- **不实现宿主压缩钩子**：平台无此接口（任务约束）——插件只能「预警 + 建议 + 落盘副本」，不能拦截/触发压缩；README 已知限制如实写明「压缩联动=建议级，非拦截级」。
- **文档**：README 长期任务章 + PROTOCOL §5 容量节各补一段。

---

## 6. 工具面核数结论

**结论：恰 10 个，0 新增；不需要第 11 个。**

| 工具 | v0.7 变化 |
|---|---|
| `xc_identify` / `xc_dispatch` / `xc_claim` / `xc_report` / `xc_doctor` | 不变 |
| `xc_read` | **inbox+mail 双路审批门**（签名不变；§2.7 共享渲染层，AC3 双路用例） |
| `xc_relay` | 帧型扩展（tool_request/tool_result/approval_* 的发送侧校验），签名不变 |
| `xc_overview` | team 视图增 offlineMembers 块；capacity red 增建议行 |
| `xc_team` | 不变 |
| `xc_review` | action 增 approve/deny；axis 增 approval |

- C6 转办进 `xc_relay` 帧（§1 理由）；C7 审批进 `xc_review`（§1 理由）；C8 复用 sweeper + overview；C9 = 文本行 + skill。
- 若做第 11 个（如 `xc_approve`/`xc_tool_relay`）：与 `xc_review`/`xc_relay` 语义重叠，且需全套注册/身份/守卫/审计挂点——违反「维持恰 10」目标，**不采纳**。
- 净变化：**删除 22 个别名**（§7）。黑盒核数方法沿用 v0.6.1（MCP stdio `tools/list` 精确集合比较，22-v061验收.md §六）。

---

## 7. 旧名移除（breaking；MIGRATION §5 承诺执行）

### 7.1 清单（与 docs/MIGRATION.md §1 对账）

**22 个别名**（MIGRATION §1 表逐行）：xc_register / xc_peer_register / xc_peer_rename / xc_check_inbox / xc_mail_read / xc_task_read / xc_peer_inbox / xc_peer_read / xc_message / xc_peer_send / xc_status / xc_peers / xc_agents / xc_team_init / xc_lead_transfer / xc_lead_release / xc_member_add / xc_member_stop / xc_idle / xc_cancel / xc_inbound_review / xc_peer_review。
**2 个命令存根**（MIGRATION §3）：`/xc-agents`、`/xc-member`（删文件）。
**4 个同名保留工具不动**：xc_dispatch / xc_claim / xc_report / xc_doctor。

### 7.2 代码改动面

- `mcp/alias.ts` **整文件删除**（130 行：ALIASES/DEPRECATION_NOTE/installAliasLayer，alias.ts:28-107；注意 356 行是 alias.test.ts，§7.3 引用正确）。
- `mcp/server.ts`：删 `installAliasLayer` 调用与 import（server.ts:23,101）；`SERVER_VERSION → "0.7.0"`（server.ts:37）。未知名走既有 dispatcher 路径 → `Tool <name> not found`（InvalidParams，server.ts:132）——**未知名返回标准错误**，无需新码。
- `mcp/tools-relay.ts`：删 `relayArgsFromLegacyMessage` / `relayArgsFromLegacyPeerSend`（tools-relay.ts:134-157）；**保留** `assertNoForwardOf`（tools-relay.ts:118-126）并在 `xc_relay` 主路径调用——`xc_relay` 带 `forwardOf` 仍显式 `forwardOf_removed`（否则 zod object 默认 strip 会静默丢参，违反「不静默丢参」纪律）。
- `mcp/guards.ts`：删 `registerSecurityTools` 死代码（guards.ts:206-208 起，注册 `xc_inbound_review`；server.ts:59-69 的注册清单未调用它，实测工具面不受影响——红队/迁移期遗留，顺手清）。
- `commands/xc-agents.md`、`commands/xc-member.md`：删。
- 数据兼容：v0.6 的 team.json/邮箱/注册表照常读写（新字段全部 optional 缺省化，MIGRATION §5-4 口径不变）。

### 7.2.1 模型可见面旧名（本版实测全量；删除时必改，否则供给/唤醒的成员会调死工具名）

以下不是注释，是**运行时注入模型上下文/可行动的文案**——别名层删除后，照旧文本行事的回合会逐个撞 `Tool not found`。分两类：

**A 类：可行动指令（死工具指令，删除后直接坏行为，必修）**——均在本会话读码确认：

| 文件:行 | 旧名 | 触发时机 |
|---|---|---|
| `engine/wake.ts:265-282` MEMBER_RULES_V2（:267 xc_register+xc_check_inbox、:274/:275/:281 xc_idle、:282 xc_status） | 4 个 | 每次唤醒 prompt 附成员守则 |
| `engine/wake.ts:350-354` buildWakePrompt 身份行（`先调用 xc_register … 调用 xc_check_inbox`） | 2 个 | 每次唤醒 prompt |
| `engine/provision.ts:109-113`（欢迎回合 prompt） | xc_register/xc_check_inbox/xc_idle | 每次建员 |
| `hooks/session-start.ts:86`（xc_register）、`:90`（xc_dispatch/xc_check_inbox/xc_status）、`:91`（xc_peer_register/xc_peers/xc_peer_send）、`:97`（regToken 段 xc_register/xc_peer_register） | 7 个 | 每个会话启动 |
| `core/peerenvelope.ts:279,436`（信封回复指引） | xc_peer_send / xc_message | 每条外来 peer 消息注入 |
| `core/budget.ts:64-65` `truncateNote()`（调用点 budget.ts:99,141,159 + tools-read.ts:124） | xc_peer_read / xc_mail_read | **每条被截断消息都带这句**（设计初版误列为「纯注释」，实为可行动指令——复核修正） |
| `hooks/prompt-submit.ts:122` | xc_check_inbox | 每次有未读即注入 |
| `mcp/protocol.ts:38-39` `notRegisteredError()` | xc_register | 未注册调用任何工具时的错误文案 |
| `mcp/tools-tasks.ts:151` | xc_register | not_a_member 错误 |
| `mcp/render.ts:227` `renderBoardTruncationNote()` | xc_status | overview 板面截断时注入 |
| `mcp/tools-relay.ts:307` | xc_inbound_review | hold 暂存回执文案 |
| `mcp/guards.ts:89-90`（= `mcp/tools-relay.ts:763-764` 同文案） | xc_member_stop / xc_member_add | removed-member 错误（发送侧） |
| `mcp/identity.ts:199-200`（`xcRegister` 内 member_removed ToolError，经 tools-identify.ts:98 `xc_register` 核心方法到达 `xc_identify` 工具面） | xc_member_stop / xc_member_add | removed-member 错误（**注册侧变体**，二轮穷尽 grep 补入） |
| `mcp/peer-services.ts:1466-1470`（`admissionDropDetail` queue-full 分支，:1470 含旧名；:1458-1464 注释自述「发给发送方的**可行动** detail」，由发送摘要行透出） | xc_peer_inbox | peer 轴入队闸 queue-full 回执（二轮穷尽 grep 补入；替代为 `xc_read({scope:"peer"})`） |
| `mcp/peer-services.ts:663` | xc_message | peer 轴自发错误文案 |
| `core/teamstate.ts:666` | xc_status | 团队重建告警文案 |

**B 类：描述性历史说明（模型经 tools/list/skill 可见，不诱导调用但应顺手改）**：
- 工具描述「replaces xc_*」六处：`mcp/tools-identify.ts:507`、`mcp/tools-relay.ts:897`、`mcp/tools-team.ts:1406`、`mcp/tools-review.ts:226`、`mcp/tools-read.ts:428`、`mcp/tools-overview.ts:453`；
- `skills/crosschat/SKILL.md:37`（「idle 替代旧 `xc_idle`」）——skill 内容模型会加载，AC10 的 grep 断言必须覆盖 skill 文件。

纯注释里的旧名（lock.ts、mailbox.ts、policy.ts、registry.ts、types.ts、sanitize.ts、peerdir.ts、peerregistry.ts 等）不破行为，顺手改不计入硬判据。

### 7.3 测试改动面

- `mcp/alias.test.ts` **整文件删除**（356 行；22 别名可调 + T1-a/b 系列，describe 起于 alias.test.ts:182）。
- `mcp/tools-relay.test.ts`：删迁移垫片用例；保留/新增 forwardOf 显式错误用例。
- **新增** `mcp/legacy-removal.test.ts`：22 旧名逐个 → `Tool <old> not found`（InvalidParams）；`/xc-agents`、`/xc-member` 命令文件不存在（静态断言）；`xc_relay({forwardOf})` → `forwardOf_removed`；tools/list 仍恰 10；`registerSecurityTools`/`xc_inbound_review` 不在任何注册路径（guards.ts 死码删除断言）。
- **新增模型可见面扫描用例**（§7.2.1）：对**全部 23 个来源**做旧名 grep 断言（读源文本断言不含 22 旧名）——A 类 16 个可行动来源（wake.ts×2、provision.ts、session-start.ts、peerenvelope.ts、budget.ts、prompt-submit.ts、protocol.ts、tools-tasks.ts、render.ts、tools-relay.ts、guards.ts、**identity.ts**、peer-services.ts（2 处：:1466-1470 与 :663）、teamstate.ts）+ B 类 6 个描述来源（tools-identify/relay/team/review/read/overview 的 replaces 描述）+ skills/crosschat/SKILL.md。防回归「文本还教旧名」。
- 其余测试中引用旧名的（identity/lead-tools/member-tools 等历史文件里的旧名直驱、tools-read.test.ts 的 `core.xc_mail_read` 等方法名调用）按新名改写；core 层方法名（`xc_message`/`xc_check_inbox` 等内部方法名）不在移除范围（非 MCP 工具名），测试直驱不动。

### 7.4 文档改动面

- `docs/MIGRATION.md`：§1/§3 表保留为历史对照，状态列改「v0.7.0 已移除」；§5 标记「移除已执行」并附未知名标准错误口径（`Tool <name> not found`）。
- `README.md`：工具与命令章（删旧名提示段，10 工具表描述增 kind/action）；版本记录加 v0.7.0；威胁模型章增转办反洗白纪律；已知限制增四条——①审批门边界（防流程缺失不防恶意伪造）②唤醒环境边界（隔离存储下唤醒回合工具面可能是发起方的）③压缩联动=建议级非拦截级④**桌面 UI 会话不可远程关闭**（E3 ②：直接 close 报 `Session is not active`；旧会话可先 resume 再 close，活跃 UI 会话未测——现行 README 11 条已知限制中确无此条，硬标准 7 要求补）。
- `docs/PROTOCOL.md`：§2 帧白名单加 4 帧型；新增「C6 转办帧与审批文件」「C8 离线判定」节；§9 env 表加 `XC_OFFLINE_MINUTES`/`XC_TOOL_REQUEST_TTL_MS`（标注：高级 env，不进插件设置面）。
- `docs/ACCEPTANCE.md`：v0.7.0 小节（验收后回填）。
- 版本五处（v0.6.1 交付纪律）：plugin/package.json、plugin/package-lock.json（root+packages[""]）、plugin/.zcode-plugin/plugin.json、marketplace.json、server.ts SERVER_VERSION。

---

## 8. 验收映射（ACCEPT12）

**如实声明**：本次设计输入中**未找到** ACCEPT12 正式清单（已检索 `zcode-crosschat/` 与 `deepseek-crosschat/evidence/**`、`reports/**`，无该文档；DESIGN-V0.6.md §5 的先例是 ACCEPT10 六条）。下表按**任务 7 项 + 产品纪律**推导 12 条可检验判据；如正式 ACCEPT12 有条目出入，按正式清单重新映射（结构不变：判据 → 模块/文件落点 → 测试落点）。

| # | 判据 | 模块/文件落点 | 测试落点 |
|---|---|---|---|
| AC1 | 配置优先建议成文（E2 四行矩阵；转办仅限宿主注入类） | README/PROTOCOL/skills/crosschat；无代码（§2.1 如实理由） | 文档静态走查（矩阵表 + 「放置优先」文案在场） |
| AC2 | C6 帧型进 FRAME_TYPES（4 个，type 键）；老版本收新帧降级不崩 | M1：core/mailbox.ts | mailbox.test.ts（白名单集合+classifyFrame）；混合版本降级用例 |
| AC3 | C6 端到端：B→门→放行→A 模型执行→回投 B（复刻 E4 五请求：无审批/批准/过期/畸形/工具不存在）；**门覆盖 inbox+mail 双路**（mail scope 不得出未放行帧原文） | M1+M2：tools-relay.ts / tools-read.ts / core/toolrelay.ts / core/toolgate.ts | 新 tool-gate.test.ts（七步校验矩阵+遮蔽占位+回投内容+审计事件）；tools-read.test.ts（inbox 门集成 + **mail 门集成**：pending 请求经 scope:"mail" 只得遮蔽占位、approved 得全文）；黑盒 stdio 集成脚本（复刻 E4） |
| AC4 | C6 预算：args≤64K 拒收；maxResultChars+resultTruncated；注入预算复用 | M1：core/toolrelay.ts | toolrelay.test.ts（大小边界+截断标记） |
| AC5 | C7 审批绑定：批者≠请求方/执行方；批准窗≤请求窗；tool 逐字节绑定 | M2+M3：core/toolapproval.ts | toolapproval.test.ts（全矩阵：缺失/畸形/过期/denied/不符/自批/放行） |
| AC6 | C7 入口与生命周期：xc_review approve/deny/axis:approval；过期回投；7 天清理 | M3：tools-review.ts / task-edges.ts / core/paths.ts | tools-review.test.ts；task-edges.test.ts（清理） |
| AC7 | C8 活性四态判定 + 阈值可配且保守（240min 缺省、钳制≥stale）；**heartbeat-stale/no-record 不得判离线** | M4：core/offline.ts | 新 offline.test.ts（四态+钳制+边界+heartbeat-stale/no-record 不判离线） |
| AC8 | C8 回池/通知/边界/并发：复用 sweeper、lead 通知、锁内裁决、与 stale 不竞态；**alive-idle 任务不被 offlineVerdict 误标**（回收层前提见 §4.2：验收需 env 覆盖 XC_STALE_TASK_MINUTES 或 nonce 豁免） | M4：task-edges.ts / tools-overview.ts | task-edges.test.ts（死进程任务回池+lead 通知；alive-idle 任务 offline=false）；overview.test.ts（offlineMembers 行） |
| AC9 | C9 压缩联动：red 建议行 + skill checklist + 文档；无宿主钩子宣称 | M5：capacity.ts / skills/longtask / docs | capacity.test.ts（建议行文案）；skill 静态走查 |
| AC10 | 旧名移除：22+2 删、未知名标准错误、**模型可见面无旧名**（§7.2.1 全量 23 来源：A 类 16 可行动 + B 类 6 描述 + skill）、guards.ts 死码清、测试/文档同步 | M6：alias.ts 删 / server.ts / wake.ts / provision.ts / session-start.ts / peerenvelope.ts / budget.ts / prompt-submit.ts / protocol.ts / tools-tasks.ts / render.ts / tools-relay.ts / guards.ts / identity.ts / peer-services.ts / teamstate.ts / tools-{identify,relay,team,review,read,overview}.ts / skills / commands / 测试 | legacy-removal.test.ts（22 旧名→not found + forwardOf + 命令文件断言 + 死码断言 + **23 来源旧名 grep 断言**）；grep 走查（README/PROTOCOL/MIGRATION 无「v0.7.0 移除」式待办残留） |
| AC11 | 工具面恰 10 + 合法流程不回退（任务状态机/长任务六场景/lead 移交/archive/relay urgent） | M8 | toolface 黑盒核数（tools/list 精确集合）；六场景重放（21-v060/acceptance/scenarios 只读拷贝）；合法流程抽验 |
| AC12 | 回归底线、限制条款与交付：单测全绿+tsc+build+manifest+版本五处+tag+Release；**硬标准 7：平台限制如实写入 README 已知限制**（§7.4 四条含桌面 UI 会话不可远程关闭） | M8 + M7 | `npx vitest run`、`npx tsc --noEmit`、`npm run build`、plugins validate；49 bug 重放（_lib 只读拷贝，**脚本需按 v0.7 寻址文法适配**——旧名直调路径已删，与 v0.6 验收「适配」列同款处理，如实记录）；README 已知限制静态走查（四条在场+无「已支持」式无证据宣称） |

---

## 9. 模块划分（互不重叠；文件级落点）

### 9.1 目录树（✚=新增 ✏=改动 ─=删除）

```
plugin/src/
  core/
    mailbox.ts     ✏ FRAME_TYPES 扩 4 帧型（M1，:51-59）；读面审计注释同步
    toolrelay.ts   ✚ C6 帧编解码/校验纯函数（args 上限/requestId 冲突/ttl/result 截断标记/帧识别）（M1）
    toolgate.ts    ✚ 审批门七步校验 + 裁决结果构造 + **共享渲染门 gateToolRequestRender（inbox/mail 双路共用）**（M2）
    toolledger.ts  ✚ 台账读写（create/decide/finalize/expire/listPending/readForGate）（M2）
    toolapproval.ts✚ 审批文件读写 + 校验纯函数（M3）
    offline.ts     ✚ C8 活性四态/离线判定/阈值纯函数（M4）
    paths.ts       ✏ approvalsFile / toolRequestFile（M2）
    capacity.ts    ✏ formatCapacityLines red 建议行（M5，:333-346）
    task-edges.ts  ✏ sweeper 挂 offline 判定+lead 通知+审批/台账清理（M3/M4，:164-227/:518-527）
    budget.ts      ✏ truncateNote 旧名改新名（M6，:64-65——可行动指令非注释）
    teamstate.ts   ✏ 重建告警旧名（M6，:666）
    peerenvelope.ts ✏ 回复指引旧名改 xc_relay（M6，:279/:436）
    stall.ts archive.ts log.ts jsonl.ts atomic.ts lock.ts graph.ts ｜ 不动
  engine/ wake.ts ✏（MEMBER_RULES_V2 :265-282/身份行旧名改新名，M6；R6 已知边界文档声明） provision.ts ✏（欢迎 prompt 旧名，M6，:109-113） ｜ 其余不动
  hooks/ session-start.ts ✏（注入上下文旧名，M6，:86/:90/:91/:97） prompt-submit.ts ✏（未读提醒旧名，M6，:122） ｜ 其余不动
  mcp/
    tools-relay.ts ✏ 帧发送侧校验+台账 create/finalize+**禁 wake 投递**+uservoice 豁免+assertNoForwardOf 保留+删垫片+hold/removed 文案旧名（M1/M6，:307/:763-764）
    tools-read.ts  ✏ inbox 消费路径审批门 + **mail 分页同受门**（共享渲染层，两路都过 gateToolRequestRender；:108-135 与 :231-252）（M2）；描述 replaces 旧名（M6，:428）
    tools-review.ts✏ action 增 approve/deny（lead 闸）+ axis 增 approval（M3，:30-34/:78）；描述旧名（M6，:226）
    tools-overview.ts ✏ team 视图 offlineMembers 挂载（M4，:246 旁）；描述 replaces 旧名（M6，:453）
    render.ts      ✏ tool_request 放行/遮蔽渲染分支（M1/M2）+ renderBoardTruncationNote 旧名（M6，:227）
    protocol.ts    ✏ notRegisteredError 旧名（M6，:38-39）
    tools-tasks.ts ✏ not_a_member 文案旧名（M6，:151）；描述 replaces（M6）
    tools-identify.ts ✏ 描述 replaces 旧名（M6，:507）
    tools-team.ts  ✏ 描述 replaces 旧名（M6，:1406）
    identity.ts    ✏ xcRegister member_removed 文案旧名（M6，:199-200）
    peer-services.ts ✏ admissionDropDetail queue-full 旧名（M6，:1466-1470）+ 自发错误文案旧名（M6，:663）
    guards.ts      ✏ removed 文案旧名（M6，:89-90）；**registerSecurityTools 死代码删除**（M6，:206-208 起）
    server.ts      ✏ 删 alias 安装+import；版本 0.7.0（M6）
    alias.ts       ─ 整文件删除（M6，130 行）
  transport/                                    ｜ 不动
plugin/
  skills/longtask/SKILL.md  ✏ 压缩 checklist 增容量触发序（M5）
  skills/crosschat/SKILL.md ✏ 「放置优先」纪律一行（M1）+ idle 替代旧名注记改写（M6，:37）
  commands/xc-agents.md ─ xc-member.md ─（M6）
  plugin.json ✏（版本 0.7.0；**不新增 userConfig 项**——XC_OFFLINE_MINUTES/XC_TOOL_REQUEST_TTL_MS 只走 env）
docs/
  DESIGN-V0.7.md ✚（本文件）  PROTOCOL.md ✏  MIGRATION.md ✏  README.md ✏  ACCEPTANCE.md ✏（M7）
```

**工作流模块（互不重叠；每个文件只属一个模块；submit moduleCount=8）**：
M1 C6 帧与载体（mailbox/toolrelay/tools-relay 帧 hunk/render 渲染分支）、M2 审批门插件侧下沉（toolgate/toolledger/tools-read/paths）、M3 C7 审批入口与帧（toolapproval/tools-review/审批清扫）、M4 C8 离线判定与转交（offline/task-edges/tools-overview）、M5 C9 压缩联动（capacity/skill/文档）、M6 旧名移除（alias 删/server/commands/§7.2.1 全量文案/guards 死码/测试）、M7 文档四件套、M8 回归重放与发布工程。

### 9.2 共享文件唯一交界

- `core/mailbox.ts`：M1 改 FRAME_TYPES；M2 的读取面门只**消费** classifyFrame 结果，不改 mailbox 本体（门在 tools-read.ts 调 toolgate.ts）。
- `mcp/tools-read.ts`：M2 的两个 hunk（inbox 门 + mail 门）共用同一个 `gateToolRequestRender` 调用点形态，不写两份门逻辑。
- `mcp/task-edges.ts`：M3（审批/台账清理）与 M4（offline 通知）同改 sweeper——两处 hunk 分开注释、同一把团队锁内，无交叠。
- `mcp/tools-relay.ts`：M1（C6 帧+禁 wake）与 M6（删垫片+文案旧名）同文件——删除先行、帧逻辑另起 hunk，垫片函数（relayArgsFromLegacy*）无 C6 依赖，可独立删。
- `mcp/render.ts`：M1/M2（门的放行加头/遮蔽占位渲染）与 M6（板面注旧名）同文件——分属不同函数（gate 渲染分支 vs renderBoardTruncationNote），无交叠。

---

## 10. 风险与如实声明的边界

### 10.1 E4 风险清单逐条落位

| # | 风险 | 落位 |
|---|---|---|
| R1 帧型忘加白 | FRAME_TYPES 4 值 + mailbox 单测 + AC2 硬判据（最高优先级，E4 已实测复现） |
| R2 审批门模型层可绕过 | 共享渲染层门（inbox+mail 双路遮蔽）+ **tool_request 禁 wake 投递**（wake.ts:567 bodyText=req.ticket、tools-relay.ts:443 ticket=out.content 实测：任何 wake 投递都把消息原文带进 prompt，只禁 urgent 挡不住）+ 插件侧审计；**残余**：批准后的执行仍是模型层（架构必然，见下） |
| R3 A 代执行=权限借用 | 逐请求 tool 绑定 + 禁自批 + reason 必填 + 反洗白纪律文案；**不设**全局禁用品清单（取舍如实记录） |
| R4 超大结果截断 | maxResultChars + resultTruncated + mail 分页指针（已验证可用） |
| R5 请求躺死会话邮箱 | ttl + sweeper 标 expired 回投 + C8 离线判定联动 |
| R6 唤醒回合跑在发起方环境 | 已知边界（E4 §7.2）：门在读取面单点生效不依赖唤醒；隔离存储场景的唤醒工具面错配**未修**，文档声明；生产单存储无此问题 |
| R7 resumed 会话记忆污染 | 回投帧 requestId+ts；接收方以邮箱原文为准 |
| R8 模型代写审计 | 插件侧 engine.jsonl 事件四件套（tool-request/decision/executed/result-rejected） |

### 10.2 架构边界（本设计最重要的如实收窄）

**crosschat 的 MCP server 不能代执行宿主工具**——它是宿主 app-server 之外的独立 stdio 进程，不持有 zcx-probe/web_reader 等其他 MCP 连接。E4 §6.2 设想的「插件侧直接执行白名单工具、省掉 A 的整个模型回合」在本架构**不可达**（除非 app-server 协议新增「以会话身份代调工具」方法，E2 §2.5 未见此能力）。因此 v0.7 的 C6：**门与审计确定性化（插件侧），执行仍是 A 的模型回合（模型层）**——R2 的「结构性拒绝」针对「未审批请求」，「批准后执行」依赖模型遵从（E4 实测 18/18 回合按脚本执行、零次无审批调用）。此边界写入 README 已知限制，不夸大。

### 10.3 未验证项（不硬凑）

1. web_reader 实转未验（本环境工具面无它；node_repl 不无害）——协议与工具无关（tool 自由字符串），但「宿主注入类实用转办」本身未闭环；
2. peer 轴转办未验（隔离下 peer 根孤立；C6 最小链路按任务要求走队内轴+文件邮箱）；
3. 桌面/交互会话作为 A 或 B 未测（全部无头回合）；
4. 并发多转办、A 多请求排队、审批竞态（同一 requestId 双重批准）未测——v0.7 实现时补「双重批准后写者胜/后者拒」单测，集成竞态留待验收剧本；
5. 红队四番战 P2/P3 共 16 项（adjudication.md 确认不修）不在本版范围；
6. 同形字残余（U+212A 类）与改名撞名（22-v061验收.md §9.2）维持已知，本版不碰。

### 10.3.1 C8 可达性边界（P2 复核补充，如实声明）

- **优雅退出与空闲在注册表上同形**：会话优雅退出会摘除 peer 记录（pipe.ts:518-521），与「回合间隙无记录」不可区分——「用户主动关闭的会话」检不出离线，**可检出的进程死只有崩溃残留**（pid-dead 记录）。故 C8 的 lead 通知实际覆盖「成员崩溃」而非「成员主动离开」；主动离开的场景靠 stale 回池 + createdBy 回执既有链路兜底。
- **idle-timeout 分支窄可达**：240min 空闲任务必已被 30min stale 先回收（§4.1），idle-timeout 仅在「全员静默 ≥240min 后重启触发首轮清扫」时命中——是兜底，不是常规路径。设计不把它当通用机制呈现。

### 10.4 威胁模型口径（v0.7 增量声明）

审批门防的是**流程缺失与误操作**（无审批执行、过期执行、畸形执行、自批），不防恶意模型或同机进程直接伪造审批文件——与 v0.5 uservoice「同机进程可伪造盖章记录」同一边界（ACCEPTANCE v0.5.0 §5-L2）。个人/内部场景「不崩/不丢/不串号」底线由：JSONL 追加真源 + 团队锁 + 帧白名单 + 台账/审计双轨承担。
