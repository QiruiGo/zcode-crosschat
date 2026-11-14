# DESIGN-V0.6.md — v0.6.0 设计：多会话长期协作重定位

日期：2026-11-14 ｜ 状态：设计定稿（待实现） ｜ 前置：`reports/21-v060方案.md`（已批准）、E1/E2/E3 实验报告
范围：本文是 v0.6.0 的实现蓝图——工具面 26→10、砍除清单、C1-C5 模块设计、模块划分、ACCEPT10 六条验证方案。协议细节归 `docs/PROTOCOL.md`（本版新建），迁移操作归 `docs/MIGRATION.md`（本版新建）。

## 0. 输入与依据（每条设计决策的出处）

| 输入 | 位置 | 本文引用方式 |
|---|---|---|
| 批准方案 | `D:/tools/deepseek-crosschat/reports/21-v060方案.md`（§1 功能矩阵 / §2 工具面 / §4 验收 / §5 风险） | 「方案 §x」 |
| E1 介入链路 | `D:/tools/deepseek-crosschat/evidence/21-v060/e1/E1-介入链路实验报告.md` | 「E1 §x」 |
| E2 MCP 作用域 | `D:/tools/deepseek-crosschat/evidence/21-v060/e2/e2-mcp-scope-report.md` | 「E2 §x」 |
| E3 卸载与内存 | `D:/tools/deepseek-crosschat/evidence/21-v060/e3/E3-实验报告.md` | 「E3 §x」 |
| 现状代码 | 本仓 `plugin/src/`（v0.5.3，HEAD `6129885`） | `path:line` |
| 历史回归用例 | `evidence/17-v051/reverify`（18 例）、`18-v052/reverify`（19 例）、`19-v053/reverify`（12 例） | §5-2a |

本设计写作时实测的基线（本会话执行，非转述）：

- `cd D:/tools/zcode-crosschat/plugin && npm test` → **61 个测试文件 / 952 例全绿，exit 0**（v0.5.3 HEAD `6129885`）。这就是 §5-2b 的回归底座。
- `wc -l README.md` → **285 行**（≤300 的红线意味着 v0.6 重写时只有 ~15 行余量，必须把协议细节全部下沉）。
- MCP SDK 实测版本 `@modelcontextprotocol/sdk@1.32.2`（`plugin/node_modules/@modelcontextprotocol/sdk/package.json`）；`dist/esm/shared/protocol.js` 的 `setRequestHandler` 用 `this._requestHandlers.set(method, …)` 按 method 字面量**整体替换**（后设者赢）；`dist/esm/server/index.js:110-138` 对 tools/call 结果做 CallToolResultSchema 校验；`dist/esm/server/mcp.js:117,150` 在构造期安装 ListTools/CallTool 处理器。→ **§1.3 的弃用 alias 机制（tools/list 恰 10 个 + 旧名仍可调）在该 SDK 上可实现**，见 §4.2-M1。
- 历史用例总数盘点：18+19+12 = **49 例**（清单见 §5-2a）。任务书写的「48 个」与逐文件清点差 1，§5-2a 如实列出全部 49 个并说明处置——重放集合取**并集**（宁多勿漏），不做删减。

---

## 1. 工具面：10 个工具的完整签名与语义

### 1.1 总览与替代关系（方案 §2 的落地形态）

| # | 新工具 | 一句话语义 | 替代的旧工具（26→10） |
|---|---|---|---|
| 1 | `xc_identify` | 一次绑定队内 + 跨会话两轴身份（含改名） | `xc_register`、`xc_peer_register`、`xc_peer_rename` |
| 2 | `xc_dispatch` | 派发可检验任务（新增 `priority`） | `xc_dispatch` |
| 3 | `xc_claim` | 原子认领，返回 attempt 令牌 | `xc_claim` |
| 4 | `xc_report` | 回报进展/结果/阻塞（status 增 `blocked`） | `xc_report` |
| 5 | `xc_read` | 统一分页读（6 个 scope） | `xc_check_inbox`、`xc_mail_read`、`xc_task_read`、`xc_peer_inbox`、`xc_peer_read` |
| 6 | `xc_relay` | 发消息/用户介入传导（urgent 队列） | `xc_message`、`xc_peer_send` |
| 7 | `xc_overview` | 任务板/成员/peer 清单/容量/停滞一体 | `xc_status`、`xc_peers`、`xc_agents` |
| 8 | `xc_team` | 指挥族合一（action 分发） | `xc_team_init`、`xc_lead_transfer`、`xc_lead_release`、`xc_member_add`、`xc_member_stop`、`xc_idle`、`xc_cancel` |
| 9 | `xc_review` | 入站 hold 审阅（两轴合一） | `xc_inbound_review`、`xc_peer_review` |
| 10 | `xc_doctor` | 只读体检（不变） | `xc_doctor` |

现行 26 个工具的注册点（迁移表底账）：`tools.ts:1365-1429`（9 个）、`lead-tools.ts:744-774`（5 个）、`member-tools.ts:566-588`（2 个）、`guards.ts:211`（1 个）、`peer-tools.ts:1801-2029`（8 个）、`doctor-tool.ts:61`（1 个）。

### 1.2 完整签名与语义

所有 shape 仍用 zod 对象字面量（与现行 `server.tool(name, desc, shape, handler)` 形态一致，`tools.ts:1368`）。身份继续「≡连接绑定」：工具仍无 from/caller 参数（`tools.ts:112` 注释纪律不变），**但 `sessionId` 仍是 `xc_identify` 的必填入参**——MCP 连接无法自证 zcode sid：连接键是 SDK 传输层的 `extra.sessionId`（stdio 下 undefined → `"__stdio__"` 常量，`identity.ts:106-108`），与 zcode 的 `sess_*` 是两个命名空间，必须由调用方显式携带（钩子注入上下文 / wake prompt 显式给出）。regToken 硬闸随 §2.2-P1 砍除（替代校验见下）。

#### T1 `xc_identify` — 注册/重绑/改名/接管（两轴合一）

```ts
export const IdentifyShape = {
  name: z.string().min(1).describe("要注册的名字（sanitizeKey 归一；保留名 lead/default 拒绝）"),
  sessionId: z.string().min(1).describe("本会话的 sessionId——交互会话取 SessionStart 钩子注入的值；wake 回合取唤醒 prompt 显式给出的值。不要编造"),
  role: z.enum(["peer", "worker"]).optional().describe("队内角色；缺省 peer"),
  takeover: z.boolean().optional().describe("显式接管：name 在册但绑定旧 sid 已死（进程被杀/崩溃）时立即换绑并回池其未完任务。缺省 false=同名校验与现行一致（name_taken）。误判可恢复（见 T1 第 5 条）"),
  wakeToken: z.string().optional().describe("无头唤醒回合的引擎令牌；缺省走钩子锚定路径"),
  displayName: z.string().optional().describe("展示名（可含中文，不参与寻址）"),
  kind: z.enum(["interactive", "bg"]).optional().describe("会话类别；缺省 interactive"),
  modeClass: z.enum(["bypass", "prompting"]).optional().describe("权限档类兜底；仅钩子基记录无档类时生效"),
  contextChars: z.number().int().positive().optional().describe("上下文字符数声明（注入预算刻度，R-18；缺省 XC_CONTEXT_CHARS/200k）"),
};
```

语义（合并 `RegisterShape`（tools.ts:119-127）与 `PeerRegisterShape`（peer-tools.ts:1680-1698）+ 改名/接管）：

1. **三元绑定**：注册成功后 IdentityStore 把 `(connectionKey, sessionId, name)` 绑为 `BoundIdentity`（`identity.ts:69-77` 现行结构不动；Map 键=connectionKey，stdio 一进程一连接，`identity.ts:79-101`）。**同时**写队内注册表（registry/sessions + team.json 成员）与 peer 注册表。两轴状态文件与现行完全一致——本工具只是把两次注册合为一次调用，不合并存储（独立性边界 SKILL.md §9 不变）。
2. **双路径 sid 校验（保留，非对抗件）**：钩子路径校验 SessionStart 落盘的锚定记录 `registry/sessions/<sid>.json`；wake 路径消费一次性 wakeToken（unknown/used/expired/mismatch 四拒，`identity.ts` wake 分支现行）并由服务端代写锚定记录。**这两道是 wake/无人值守的身份命脉（方案 §1-B 保留件），不随 regToken 一起砍。**
3. **软身份校验（替代 regToken 硬闸，方案 §1-A 行 2）**：①同名冲突仍**显式拒**（`name_taken`）；②sid 已被**另一个活连接**绑定为不同名字 → `session_id_in_use`（v0.5.2 bug-12 语义保留）；③同 `(name, sid)` 重绑 → 幂等成功（bug-02 语义保留）；④sid 存在性=锚定记录在场；活性=锚定记录 lastSeen 新鲜度警戒（`identity.ts:53` STALE_LASTSEEN_WARN_MS=10min）+ ②的活冲突检查。regToken 参数从两个旧 Shape 删除，不设替代物。
4. **改名**：连接已有身份且 `name` 与现名不同 → rename 语义（旧名进 `formerNames` 仍可寻址、通知相关会话 `control:rename`，即 `xc_peer_rename`（peer-tools.ts:1970-1983）现状行为）；队内花名同步换绑。改名是显式动作、无独立参数。
5. **接管（M2 新增，长期任务接手的机制基础）**：`name` 已在队内花名册但绑定 sid ≠ 本次 `sessionId` 时的两条路（复核 M-new 修订：**不以 10min lastSeen 窗口为接管闸**——剧本②的「kill 后立即接管」会撞 name_taken，等待窗口不可接受）：
   - **缺省（无 `takeover`）**：语义与现行一致 → `name_taken`（不猜测旧持有者死活）。
   - **`takeover:true`（显式，对齐 `xc_team takeover` 的 R-1/F-4 先例：显式意图+全程审计）**：过两道**第二活信号闸**后立即换绑——①**在途唤醒标记**：`findInflightWakeNonce(stateRoot, toKey, …)`（`engine/wake.ts:484`，磁盘可跨进程读）在 `WAKE_INFLIGHT_MS=15min`（`wake.ts:8,80`）内命中 → 拒 `takeover_inflight`（旧持有者可能正跑长回合，不许抢）；②旧 sid 在本进程可判定的活连接冲突（`session_id_in_use` 语义）→ 拒。通过后：审计 + 面板标注（bug-14 语义）、花名册 sessionId 换绑、**该名下全部 claimed/in_progress/blocked 任务 `revokeAttempt` 回池**（`core/graph.ts:217-233` 现行复用；blocked ∈ OPEN 一并回池，history event `revoked-rebind`）、给每个任务创建者写 `task-receipt`（复用僵尸清扫回执路径 `task-edges.ts:184-190`）；**若被接管名==team.leadKey，追加 leadHistory 条目**（reason=`member-rebind-takeover`，`types.ts:180` 结构，L-n2）——lead 是绑名的元数据角色，角色随名走但审计链不能断。接手会话以全新 attempt 认领续作（剧本②判据基于此）。
   - **误判可恢复（README 同款声明）**：takeover 打在仍活着的成员上 → 其 attempt 已回池，下一份 `xc_report` 得 stale-attempt 硬拒 → 按成员守则停手重取单（SKILL §4.5 现行纪律）——不崩、不丢、可续，代价是该成员手头单重排队。**如实声明（L-n1 残余边界）**：在途闸只覆盖 wake 驱动的回合（无人值守主路径）；交互驱动中成员（owner 在场、无 wake 标记）不在闸内——其接管由「显式参数 + 误判可恢复」兜底。「kill 后 5s」与「活着但 5s 没调工具」在磁盘信号上不可区分（这是选显式参数而非活性窗口的根因）。**removed 成员名仍拒**（`identity.ts` member_removed 门不动）：接管≠复活，复活必须走 lead 的 `xc_member_add` 幂等重供给（E3 §③）。`STALE_LASTSEEN_WARN_MS`（`identity.ts:53`）降级为观测信号（面板标注「疑似失联」），不再是接管的必要条件。**轴作用域**：takeover 只作用于队内轴（任务回池是队内侧机制）；peer 轴同名仍按现行「先到者为准」拒（换名重试惯例不变），响应 payload 以 `takeoverApplied:["team"]` 如实披露实际生效范围。
6. wake 回合（`wakeToken` 在场）：只绑队内轴（唤醒回合不监听 peer 管道，与现状 `xc_register` wake 路径一致）。

#### T2 `xc_dispatch` — 派发（增 priority）

```ts
export const DispatchShape = {
  to: z.string().min(1).describe("目标成员名"),
  title: z.string().min(1).describe("任务标题"),
  prompt: z.string().min(1).describe("任务内容（要做什么）"),
  acceptance: z.string().optional().describe("验收标准（可检验）"),
  dependsOn: z.array(z.string()).optional().describe("依赖的任务 id 列表"),
  priority: z.enum(["high", "normal", "low"]).optional().describe("任务优先级；缺省 normal（影响展示/取单顺序，不做抢占）"),
};
```

语义与 `DispatchShape`（tools.ts:128-134）一致，仅新增 `priority`（C2，见 §3.2）。返回保持 `taskId + delivered(wake|mailbox|duplicate)`（`engine/wake.ts:212` decideDelivery 三重条件不动）。

#### T3 `xc_claim` — 认领（不变）

```ts
export const ClaimShape = { taskId: z.string().min(1).describe("要认领的任务 id") };
```

逐字节沿用现行 `ClaimShape`（tools.ts:135）与 rollback_conflict 拒绝语义。

#### T4 `xc_report` — 回报（status 增 blocked；evidence 砍哈希）

```ts
export const ReportShape = {
  taskId: z.string().min(1),
  attemptId: z.string().min(1).describe("xc_claim 返回的 attempt 令牌；不匹配即硬拒"),
  status: z.enum(["in_progress", "completed", "failed", "blocked"]),
  result: z.string().optional().describe("completed 必填"),
  error: z.string().optional().describe("failed 建议填写；status=blocked 时必填=阻塞原因"),
  evidence: z.array(z.object({
    path: z.string().min(1).describe("证据文件绝对路径"),
    note: z.string().optional().describe("一句话说明（文件+摘要，方案 §1-B：砍哈希复核）"),
  })).optional().describe("completed 必须至少 1 条；文件必须真实存在且位于工作区内"),
};
```

语义变化（对照 `ReportShape` tools.ts:136-152）：
- `status` 枚举增 `"blocked"`（C2，§3.2）：任务转入 blocked 态，attempt **保留**（暂停而非作废）。
- `evidence` 砍 `sha256` 字段与现算复核（方案 §1-B「evidence 简化为文件+摘要」）。**保留**两道门：文件存在（`evidence_file_missing`）与工作区内路径（`evidence_path_outside_workspace`，v0.5.2 bug-05 修复）——这是「不丢/不串号」底线的一部分（round1 #03/#16 重放仍须过）。

#### T5 `xc_read` — 统一分页读

```ts
export const ReadShape = {
  scope: z.enum(["inbox", "mail", "task", "peer", "peer-msg", "journal"])
    .describe("inbox=读并消费本队邮箱；mail=邮箱历史单件分页；task=任务字段分页；peer=拉取跨会话消息（消费）；peer-msg=跨会话单件分页；journal=任务/留档日志"),
  id: z.string().optional().describe("mail/peer-msg=消息 id；task=任务 id；journal=任务 id 或 \"archive:<成员名>\""),
  field: z.enum(["result", "error", "prompt", "acceptance"]).optional().describe("仅 scope=task：要分页读的字段"),
  offset: z.number().int().min(0).optional().describe("起始偏移/条"),
  limit: z.number().int().min(1).optional().describe("本次返回上限（字符或条，随 scope）"),
};
```

各 scope 的语义逐条对应旧工具（行为不改，只换入口；预算与分页口径全部沿用 `core/budget.ts:18-28` 的现行常数）：

| scope | 替代 | 消费性 | 语义要点 |
|---|---|---|---|
| `inbox` | `xc_check_inbox` | 消费 | 读自己邮箱；**urgent 消息排最前**（C1，§3.1）；坏行跳过+审计（round1 #10）；批量按注入预算开窗（round1 #17） |
| `mail` | `xc_mail_read` | 只读 | 单件全文分页（MailReadShape tools.ts:169-174 的 offset/limit 语义原样） |
| `task` | `xc_task_read` | 只读 | team.json 任务字段分页（TaskReadShape tools.ts:175-180 原样；field 缺省 `result`） |
| `peer` | `xc_peer_inbox` | 消费 | 跨会话队列排空；count=本次真实呈现数（v0.5.1 P3 口径）；urgent 优先（C1） |
| `peer-msg` | `xc_peer_read` | 只读 | 单件全文分页（PeerReadShape peer-tools.ts:1718-1722 原样） |
| `journal` | （新，C4） | 只读 | `id=<taskId>` → `.crosschat/tasks/<taskId>/journal.md`；`id="archive:<name>"` → `.crosschat/archive/<name>/journal.md`；分页同 mail |

#### T6 `xc_relay` — 发消息/介入传导（C1 载体）

```ts
export const RelayShape = {
  to: z.string().min(1).describe("目标名（队内成员或跨会话 peer；两轴同名时用 \"名字[team]\" / \"名字[peer]\" 消歧）"),
  msg: z.string().min(1).describe("消息正文（/xc-say 场景必须逐字引用用户原话——origin=user 盖章按字节匹配）"),
  urgent: z.boolean().optional().describe("插队：排到目标所有未读之前 + 尽力推送唤醒"),
  interrupt: z.boolean().optional().describe("请求打断目标当前回合（v0.6 平台限制下降级为 urgent+下一回合必读，payload 如实回报）"),
  summary: z.string().optional().describe("一句话摘要"),
  sourceTaskId: z.string().optional().describe("与 sourceAttemptId 成对；任务上下文关联（过期自动作废）"),
  sourceAttemptId: z.string().optional(),
};
```

语义（合并 `MessageShape`（tools.ts:153-159）与 `PeerSendShape`（peer-tools.ts:1704-1717）；**forwardOf 不再存在**——方案 §1-A 行 4 删除，转发请求返回参数错误并指向 MIGRATION 指引「批注另发一条」）：
- **路由**：先查队内花名册（team.json 成员 + engine 成员），命中 → 队内邮箱（`appendMailbox`，core/mailbox.ts:302）；未命中 → peer 注册表 → 命名管道投递（transport/pipe.ts）；两轴都命中 → `ambiguous` 错误 + 两个候选行（沿用 `[ref]` 消歧惯例，SKILL.md §9.2）。`to` 显式带 `[team]`/`[peer]` 后缀时跳过解析直接路由。
- **回执**：跨会话侧沿用六态（`peerenvelope.ts:143`）与 v0.5.2 SCALE-2「未投递不得自称已投递」的摘要口径（peer-tools.ts:1896-1905 逻辑平移）。
- **urgent / interrupt** 的完整设计在 §3.1。
- **origin=user 盖章保留**（方案 §1-A 行 5「轻量保留」）：`/xc-say` → `xc_relay` 路径继续经 uservoice 字节匹配盖章（`core/uservoice.ts`）；stamp authority 硬拒降级为软校验（§2.2-P1 第 2 项）。

#### T7 `xc_overview` — 全景观测（+容量/停滞）

```ts
export const OverviewShape = {
  view: z.enum(["team", "peers", "panel"]).optional().describe("缺省 team：任务板+成员+未读；peers：本机可寻址 peer 清单；panel：self+peers+members+tasks+入站策略+容量+停滞"),
  history: z.boolean().optional().describe("附 lead 角色变更史（R-7）"),
  offset: z.number().int().min(0).optional().describe("任务板/清单分页起点"),
};
```

- `team` ≈ `xc_status`（StatusShape tools.ts:160-168 的 teamId 丢弃——多团队从未启用，teamId 参数是 v0.1 遗留死参，随合并移除；snapshot.json 落盘、boardTruncated 分页指针全部保留）。
- `peers` ≈ `xc_peers`（PeerListShape peer-tools.ts:1699-1703 的行格式与 rowsTruncated 分页原样；旧 `kind` 过滤参数不保留——一次列全三类，按行首 `[self]/[member]/[session]` 标记自行辨识）实现归 M1（tools-overview.ts）。
- `panel` ≈ `xc_agents` + 追加两块：`capacity`（C3，§3.3）与 `stalled`（C5，§3.5）。
- 无需注册即可调用（只读纪律，SKILL.md §1 保留）。

#### T8 `xc_team` — 指挥族合一

```ts
export const TeamShape = {
  action: z.enum(["init", "transfer", "release", "member-add", "member-stop", "idle", "cancel", "unblock"]),
  takeover: z.boolean().optional().describe("仅 action=init：接管现任 lead（用户明确指令时；R-1/F-4）"),
  to: z.string().min(1).optional().describe("action=transfer：移交目标"),
  name: z.string().min(1).optional().describe("action=member-add/member-stop：成员名"),
  model: z.string().optional().describe("action=member-add：模型 id"),
  reasoningLevel: z.string().optional().describe("action=member-add：推理档位"),
  note: z.string().optional().describe("action=member-add：备注（仅审计）"),
  contextChars: z.number().int().positive().optional().describe("action=member-add：该成员上下文字符数声明（预算刻度，R-18；缺省 XC_CONTEXT_CHARS/200k）"),
  reason: z.string().optional().describe("action=transfer/member-stop：原因（入审计）"),
  taskId: z.string().min(1).optional().describe("action=cancel/unblock：任务 id"),
  summary: z.string().min(1).optional().describe("action=idle：空闲摘要（守则 v2 第 3 条）"),
  idleReason: z.enum(["no-claimable-task", "inbox-empty", "blocked-only"]).optional().describe("action=idle：缺省 no-claimable-task"),
  completedTaskId: z.string().optional().describe("action=idle：刚完成任务 id"),
  completedStatus: z.string().optional().describe("action=idle：刚完成任务状态"),
  failureReason: z.string().optional().describe("action=idle：失败原因"),
  result: z.string().optional().describe("action=idle：最终答案全文"),
  archive: z.boolean().optional().describe("action=member-stop：停止前先写留档（缺省 true，C4）"),
  unblockNote: z.string().optional().describe("action=unblock：解除说明（回投给认领者）"),
};
```

- 每个 action 的核心逻辑 = 现行对应工具原样平移：`init`←xc_team_init（lead-tools.ts:744-750，takeover 语义不动）、`transfer`←xc_lead_transfer、`release`←xc_lead_release、`member-add`←xc_member_add（member-tools.ts:566-577，含上限/幂等重供给）、`member-stop`←xc_member_stop（+停止前留档，§3.4）、`idle`←xc_idle（lead-tools.ts:750-756，R1 门/完整性警告不动）、`cancel`←xc_cancel（task-edges 取消边+回执+唤醒不动）。
- `unblock` 是新增 action（C2，§3.2）。
- 权限矩阵不变：init/transfer/release/member-add/member-stop 仅 lead；cancel 仅 lead 或任务创建者；idle 是成员自己上报；unblock 允许 lead、任务创建者或该任务认领者。

#### T9 `xc_review` — 入站审阅（两轴合一）

```ts
export const ReviewShape = {
  action: z.enum(["list", "accept", "discard"]).optional().describe("缺省 list"),
  axis: z.enum(["team", "peer", "all"]).optional().describe("缺省 all：两轴隔离件一起列出"),
  ids: z.array(z.string()).optional().describe("accept/discard 的消息 id；缺省全部"),
};
```

- list 合并展示队内 held 队列（policy.ts held 隔离件）与 peer hold 队列，每行标注 `axis`；两轴消息 id 命名空间不同，`ids` 按 id 形态自动路由，歧义时按 `axis` 参数裁决。
- hold 的默认态：`DEFAULT_INBOUND_MODE='accept'`（core/policy.ts:44-46）不变——审阅面保留但日常路径不出现（方案 §1-A 行 7）。

#### T10 `xc_doctor` — 体检（不变）

签名与行为逐字节保留（doctor-tool.ts:61-87）。新增两行输出：`capacity: os 水位采样器可用性` 与 `sampler: CIM 采样自检（进程分类计数）`（§3.3），便于现场诊断采样器失效（E3 踩坑 1 的 GBK 乱码场景）。

### 1.3 迁移映射表（26 旧名 → 10 新名）与弃用策略

| 旧名 | 新入口 | 参数映射 | 处置要点 |
|---|---|---|---|
| `xc_register` | `xc_identify` | `name→name`；`sessionId→sessionId`（**必填透传**——连接无法自证 zcode sid，H1）；`role→role`；`wakeToken→wakeToken`；`regToken` 忽略 | `regToken` 在响应 payload 以 `ignored:["regToken"]` 披露 |
| `xc_peer_register` | `xc_identify` | `name→name`；`sessionId→sessionId`（必填透传）；`displayName/kind/modeClass/contextChars→同名`；`regToken` 忽略 | `regToken` 以 `ignored` 披露 |
| `xc_peer_rename` | `xc_identify` | `name→name`（改名语义） | — |
| `xc_dispatch` | `xc_dispatch` | 原样（新工具多收 `priority`） | 同名保留（增参，无警告） |
| `xc_claim` | `xc_claim` | 原样 | 同名保留（无警告） |
| `xc_report` | `xc_report` | `evidence[].sha256` 忽略 + `ignored` 披露；其余原样 | 同名保留（evidence 简化，无警告） |
| `xc_check_inbox` | `xc_read` | `→{scope:"inbox"}` | — |
| `xc_mail_read` | `xc_read` | `messageId→id`；`offset/limit→同名`；`→{scope:"mail"}` | — |
| `xc_task_read` | `xc_read` | `taskId→id`；`field→field`；`offset/limit→同名`；`→{scope:"task"}` | — |
| `xc_peer_inbox` | `xc_read` | `limit→limit`；`→{scope:"peer"}` | — |
| `xc_peer_read` | `xc_read` | `msgId→id`；`offset/limit→同名`；`→{scope:"peer-msg"}` | — |
| `xc_message` | `xc_relay` | `content→msg`；`to/sourceTaskId/sourceAttemptId→同名` | `forwardOf` 参数 → 显式错误 `forwardOf_removed`（两个 relay 别名同守卫，M1） |
| `xc_peer_send` | `xc_relay` | `message→msg`；`to/summary→同名` | `forwardOf` 参数 → 显式错误 `forwardOf_removed`（附迁移指引） |
| `xc_status` | `xc_overview` | `history→history`；`offset→offset`；`teamId` 忽略 | — |
| `xc_peers` | `xc_overview` | `→{view:"peers"}`；`kind` 忽略（`ignored` 披露；新面一次列全三类，行自带类别标记） | — |
| `xc_agents` | `xc_overview` | `→{view:"panel"}` | — |
| `xc_team_init` | `xc_team` | `→{action:"init", takeover}` | — |
| `xc_lead_transfer` | `xc_team` | `to/reason→同名`；`→{action:"transfer"}` | — |
| `xc_lead_release` | `xc_team` | `→{action:"release"}` | — |
| `xc_member_add` | `xc_team` | `name/model/reasoningLevel/note→同名`；`context→contextChars 等价字段`；`→{action:"member-add"}` | — |
| `xc_member_stop` | `xc_team` | `name/reason→同名`；`→{action:"member-stop", archive:true}` | — |
| `xc_idle` | `xc_team` | `summary/idleReason/completedTaskId/completedStatus/failureReason/result→同名`；`→{action:"idle"}` | — |
| `xc_cancel` | `xc_team` | `taskId→taskId`；`→{action:"cancel"}` | — |
| `xc_inbound_review` | `xc_review` | `action/ids→同名`；`→{axis:"team"}` | — |
| `xc_peer_review` | `xc_review` | `action/ids→同名`；`→{axis:"peer"}` | — |
| `xc_doctor` | `xc_doctor` | 原样 | 不弃用，无警告 |

**弃用策略**（方案 §5-风险 3「一次性迁移表 + 旧名映射一个版本（v0.7 移除）」）：

1. 旧名**不注册**进 `server.tool()`（`tools/list` 恰好返回 10 个新名——硬验收条款 1 的字面要求）。
2. 旧名的可调用性由 **CallTool 处理器覆盖层**实现：在全部注册完成后用 `server.server.setRequestHandler(CallToolRequestSchema, dispatcher)` 整体替换 SDK 的分发器（SDK 1.32.2 的 `Protocol.setRequestHandler` 是 `Map.set` 整体替换——本会话实读 `dist/esm/shared/protocol.js` 确认；替换后 10 个新名的分发也走同一 dispatcher，实现见 §4.2-M1）。dispatcher 内：`name ∈ ALIAS` → 参数映射（未映射旧参一律进 `ignored` 披露、forwardOf 显式报错）→ 带 `extra` 调同一核心实现（**extra 必须透传**——`connectionKeyOf(extra)` 是身份锚，`identity.ts:106-108`）→ 结果首块文本前缀一行弃用警告 + payload 注入 `deprecated:{tool, replacement}`；`name ∈ PRIMARY` → 正常分发；其余 → 标准 `unknown tool` 错误。
3. 警告文本固定格式：`[DEPRECATED] xc_register 已更名为 xc_identify（v0.7.0 移除）。本次调用已正常执行。迁移表见 docs/MIGRATION.md。`
4. 命令面旧名是提示词文件，无运行时分发层——保留为**弃用存根**（内容=指引到新命令 + 转执行新命令流程），v0.7 删除文件（§1.4）。
5. 单测双保险：alias 覆盖**全部 22 个更名旧名**（26 旧名中 4 个同名保留：dispatch/claim/report/doctor）的「调用成功 + 警告在场 + payload.deprecated 在场」；`tools/list` 恰 10 名的快照断言（§5-1）。

### 1.4 命令面收敛（8 → 6 + 2 弃用存根）

| 现有命令 | v0.6 处置 | 说明 |
|---|---|---|
| `/xc-work` | 保留，改调 `xc_identify` | 注册=identify |
| `/xc-dispatch` | 保留（增 priority 提示） | — |
| `/xc-inbox` | 保留，改调 `xc_read({scope:"inbox"})` | — |
| `/xc-status` | 保留，改调 `xc_overview`（缺省 team；参数含「全景」时用 panel） | — |
| `/xc-team` | 保留，改调 `xc_team`；子形态吸收 `/xc-member` 的 add/stop | — |
| `/xc-say` | 保留，改调 `xc_relay`（urgent/interrupt 用法写入正文） | — |
| `/xc-agents` | **弃用存根**：正文=「已并入 /xc-status（全景视图）」，并按 /xc-status 流程执行 | 方案 §2 命令面收敛 |
| `/xc-member` | **弃用存根**：正文=「已并入 /xc-team add|stop」，并按 /xc-team 流程执行 | 同上 |

---

## 2. 砍除清单：实施顺序与删除边界

### 2.1 实施顺序（低风险先行；每批一道回归闸）

回归闸（每批完成必须全过才能进下一批）：`npm run typecheck` 0 错 → `npm test` 全绿（基线 61 文件/952 例，允许因改名更新的断言，不允许删除用例——删除须在重放台账登记改判）→ 已积累的历史重放用例全绿。

| 批次 | 内容 | 风险 | 为什么这个位置 |
|---|---|---|---|
| **P0 基线** | 冻结 `npm test`/重放台账基线；为 49 个历史用例建重放驱动（复用 `_redteam-replay/adj052` 的 MCP stdio 直驱骨架与隔离 env 手法） | 无 | 一切后续改判都需要「改前绿」的对照 |
| **P1 纯减法**（先做，行为面最小） | ①删邮箱哈希链（`core/mailintegrity.ts` + 调用点的 WARNING 分支 + `.int` sidecar 读写）②删信封对抗检测（`peerenvelope.ts:270 normalizeEnvelopeScan`、`:295 detectForgedEnvelope` + `peerenvelope-zw` 测试；**保留** `:221 stripNestedEnvelope` 渲染卫生）③删 forwardOf/hopChain（两个 Shape 的 forwardOf + `validateSendModeArgs` 的 forwardOf 分支 + 信封 hop 属性）④regToken 硬闸→软校验（删 `RegisterShape.regToken`/`PeerRegisterShape.regToken` 与 identity 硬拒路径；uservoice stamp authority 硬拒 tools.ts:936-954 降级为「不盖章 + 审计 + payload 警告」）⑤peer hold 默认确认（DEFAULT 已是 accept，policy.ts:46，只删文档噪声） | 低 | 每项都是独立小删除，可逐项提交、逐项过闸；先做减法让 P2 的合并建立在已收敛的代码上 |
| **P2 工具面合并**（breaking，一次到位） | §1 的 10 工具 + alias 覆盖层 + `mcp/tools*.ts` 拆分（§4.1）+ 命令面 8→6+2 存根 + `plugin.json`/`marketplace.json` 版本与描述更新 | 中 | alias 机制使 breaking 面可控；合并后 P3 的新能力直接落在新文件上，不再碰旧结构 |
| **P3 新增能力**（依赖 P2 落位） | 顺序：**C2** blocked+priority（纯 core，先做）→ **C5** stall（纯函数+overview 挂载）→ **C4** journal/archive + longtask skill → **C1** relay urgent（依赖 relay 工具与邮箱排序）→ **C3** capacity（依赖 overview 挂载点 + 采样器最重） | 中高 | 纯函数先于 I/O；C1/C3 依赖 P2 的工具壳，且 C3 的采样器要按 E3 踩坑记录实现、需真机验证 |
| **P4 文档与发布** | README 重写（≤300 行）、`docs/PROTOCOL.md`、`docs/MIGRATION.md`、ACCEPTANCE 台账回填、tag v0.6.0 + Release | 低 | 文档最后写，避免与实现漂移 |

每批内的删除前置纪律：删任何模块前先 `grep -rn "<符号>" plugin/src plugin/dist` 列出全部引用点进 PR 描述（例如 mailintegrity 的引用面：guards/tools 的 WARNING 分支、face B 注入、测试 3 处）；dist 重构建后跑 `node dist/mcp/server.mjs` 握手冒烟（stdio 纪律，server.ts:9）。

### 2.2 删除边界（砍什么 / 留什么 / 依据）

| # | 砍除项 | 砍到什么程度 | 保留的内部机制（删除边界） | 依据 |
|---|---|---|---|---|
| 1 | 邮箱哈希链完整性 | 删 `core/mailintegrity.ts` 与全部调用、`.jsonl.int` sidecar、check_inbox/mail_read 的 tampered WARNING 分支 | JSONL 追加式真源、坏行跳过+审计（`core/jsonl.ts`，round1 #10 修复不动）、msgstore 真源只读投影 | 方案 §1-A 行 1；「不丢」底线由 JSONL 健壮性承担 |
| 2 | regToken 身份锚定硬闸 | 删两个 Shape 的 regToken 入参与 identity 硬拒路径；uservoice 盖章的 authority 硬拒（tools.ts:936-954）降级为「不盖章+审计+警告」 | `name_taken` 同名显式拒、`session_id_in_use` 活性冲突拒（bug-12 语义）、幂等重绑（bug-02）、改名审计（bug-14）、引擎预绑名+一次性 wakeToken（wake 身份路径非对抗件） | 方案 §1-A 行 2；软校验=sid 存在性+活性 |
| 3 | NFKC/零宽/同形字信封检测 | 删 `normalizeEnvelopeScan`/`detectForgedEnvelope`/`TeamMessage.forged` 落盘标记与 `verified` 属性、`peerenvelope-zw` 测试 | `stripNestedEnvelope`（渲染卫生：正文不得伪装信封标签，peerenvelope.ts:221,235）、全部归因尾注（PEER_FOOTER_*，:66-126）、`origin/originSessionId` 属性 | 方案 §1-A 行 3；README 已知限制声明「不做对抗级防伪」 |
| 4 | forwardOf / hop-chain 溯源链 | 删两个 Shape 的 forwardOf、`validateSendModeArgs` 的 forwardOf 分支、信封 hop 属性与转发管道逻辑 | `sourceTaskId/sourceAttemptId` 任务关联与过期作废（task-edges §7.1——长期任务命脉，方案 §1-B） | 方案 §1-A 行 4 |
| 5 | CC 全协议帧家族（sandbox-permission/mode-set/approval 等） | 从不存在到继续不存在：**不引入**。v0.7 的 approval/interrupt 帧按方案 C7 另议 | 现行两套帧白名单原样保留：邮箱 `FRAME_TYPES` **七类**（task-assignment/task-receipt/idle-notification/unblock-notice/shutdown-request/delivery-refused/**lead-transfer**，core/mailbox.ts:52-60——本会话实读；SKILL.md §7.1 的「六类」是 v0.5 加 lead-transfer 后未同步的笔误，随 v0.6 SKILL 重写一并修正，见 §3.4 末段）；管道 `PEER_FRAME_TYPES=['auth','msg','control','status']`（transport/frames.ts:38）。**偏离方案声明（L4）**：方案 §1-A 行 6 将「shutdown 协议帧」列入砍除；本设计保留邮箱帧 `shutdown-request`——它是 xc_team member-stop 停机通知的唯一载体（砍它=砍停机通知，违反「成员可停」保留件）。被砍的是 CC 的 sandbox-permission/mode-set/approval 帧族（本就不存在）。此偏离需规划方追认 | 方案 §1-A 行 6；grep 全 src 无 sandbox/mode-set 实现（本会话核实） |
| 6 | hold 三态默认化 | `xc_inbound_review`/`xc_peer_review` 合并为 xc_review；文档日常路径移除 | 入站三态实现与配置（XC_INBOUND_MODE / XC_CROSSCHAT_INBOUND）完整保留——默认 accept 使日常不触达，hold 是可选配置 | 方案 §1-A 行 7；policy.ts:44-46 |
| 7 | 限速/队列上限/连接数闸 | 文档与日常路径移除（README 主文不提，下沉 PROTOCOL.md 一张表） | 实现全部保留（XC_PEER_MAX_QUEUE_DEPTH 等在 plugin.json env 模板与代码原样） | 方案 §1-A 行 8 |
| 8 | 证据哈希复核 | ReportShape 砍 `sha256` 与现算复核 | 文件存在门 + 工作区内路径门（`evidence_file_missing` / `evidence_path_outside_workspace`） | 方案 §1-B；round1 #03/#16 保留重放 |

**B 保留核心**（一条不少，方案 §1-B）：任务状态机（原六态+attempt 令牌，v0.6 扩为七态见 §3.2；types.ts:18-66,106-129）、dispatch/claim/report 闭环、无人值守 wake（engine/wake.ts + decideDelivery 三重条件）、文件真源（team.json/mailbox JSONL/msgstore）、入站三态（配置级）、`/xc-*` 命令面、大帧守卫（transport/mcpstdio.ts，round1 #06）、僵尸清扫（mcp/task-edges.ts:72-74,171-185）、注入预算（core/budget.ts）、peer 管道+心跳+优雅退出（transport/pipe.ts）。

---

## 3. C1-C5 模块设计

### 3.1 C1 `xc_relay`：urgent 优先队列与介入传导

**平台事实（E1，全部实测）**：wire 无 `sendToSession`/`interruptSession`（-32601）；忙时 `session/send` -32010 拒收、无队列；wire 唯一打断原语 `session/stop` 仅对本宿主装载会话有效；跨进程/桌面会话读写发停全 -32004；对宿主自己 wire-create 过的忙会话 `session/send` 会**盲收 accepted**（并发写风险）。E1 §5 给出 D1（邮箱优先队列统一退化）/ D2（同宿主 stop→send，可选）。

**本设计的可达性判定（新增论证）**：D2 需要插件持有「目标会话已装载」的 app-server wire。插件拓扑里不存在这样的 wire——每个会话有自己的 crosschat MCP server 进程（宿主 spawn），插件唯一的 app-server 连接是 member-add 期间的临时 keeper（provision.ts:381 finally kill，E3 §② 实测「成员就绪态零专属进程」）。维持常驻 keeper 会给每成员 +~300MB 常驻，与 E3 的内存结论相反。**故 v0.6.0 只实现 D1；D2 记为 v0.7 候选**（前提：常驻 keeper 模型立项），README 如实声明「打断=下一回合必读」。

**数据面**：

```ts
// core/types.ts — TeamMessage 增量
export interface TeamMessage {
  // …现行字段不动…
  /** v0.6（C1）：urgent 消息在一切读取面排最前。absent=false。 */
  urgent?: boolean;
}
// core/peermsg.ts — PeerQueueItem 增量
export interface PeerQueueItem {
  // …现行字段不动…
  /** v0.6（C1）：同上（peer 轴）。 */
  urgent?: boolean;
}
```

**读取序（三处，同一规则：urgent 先于普通，类内按 ts 升序，stable）**：
1. `xc_read({scope:"inbox"})` 的输出排序（mailbox 读取处排序，不动 JSONL 物理顺序——追加真源纪律）。
2. 钩子注入 `hooks/shared.ts:207 unreadSummary`：urgent 计数单列 + urgent 全文优先占预算（普通未读保持现有摘要形态）。
3. `engine/wake.ts:334 buildWakePrompt`：urgent 消息置于白名单携带段首位（预算内全文，普通件维持现状截断）。

**投递路径（D1，复用现行 decideDelivery，不新增协议）**：

| 目标状态 | 行为 | 依据 |
|---|---|---|
| 属主在场（owner-present） | 落邮箱，下一回合钩子注入首读 | wake.ts:222-224 三重条件不动；E1「忙→下回合」 |
| 属主不在场 ∧ wake 开 ∧ 无在途 nonce | 落邮箱 + `--resume` 唤醒携带（urgent 首段） | E1 §④ wake 路径 exit 0、REPORT 确认 |
| 有在途唤醒（inflight nonce） | 仅落邮箱；在途回合的工具间隙 face B 注入（urgent 排首） | nonce 防重复 resume 风暴；face B 现机制（mcp/peer-drain.ts） |
| peer 轴目标端点活 | 管道投递 + urgent 进队首 | transport/pipe.ts 现通道；排空面 urgent-first（M3） |
| peer 轴目标端点死 | 落 peer 队列（不丢），随目标下回合/下次上线取走 | peer 队列持久化（F-3 落盘纪律） |
| wake 关闭（XC_WAKE_ENABLED≠"true"） | 仅邮箱（现状 mail 模式） | wake.ts:217-221 |

**interrupt 参数语义（如实降级）**：`urgent:true` 的全部效果 + 「确保目标会被推醒」；返回 payload 固定携带：

```json
{ "delivered": "mailbox", "urgent": true,
  "interrupt": { "requested": true, "result": "deferred-next-turn",
                 "reason": "host wire has no interrupt primitive (E1 §1.1); stop->send requires same-host bookkeeping the plugin does not hold" } }
```

`interrupt:true` 且 `urgent` 未设 → 自动按 `urgent:true` 处理（interrupt 蕴含 urgent）。不做任何 stop→send 尝试——无执行点（本节首段论证），且 E1 §3.1 证明盲发有并发写风险，宁降级不冒险（安全底线优先）。

**KPI 对账（方案 §4「介入延迟可测」）**：urgent 发送 → 目标响应的延迟 = wake spawn + 回合时长（秒级，剧本④实测落盘）；在场目标的延迟 = 下一回合/下一工具间隙的注入（可测）。E1 的 1.5s idle 直发时序属宿主直发路径，插件不拥有该路径——如实声明，不用它当 KPI 承诺。

### 3.2 C2 blocked 态与优先级

**状态机（core/types.ts:18-66 的变更，完整代码块见 §4.2-M2）**：`TASK_STATUSES` 增 `'blocked'`（七态）；转移表：

```
pending    → claimed | cancelled          （pending→blocked 是死边：blocked 唯一入口=认领者 report，pending 无 attempt——L-n3 备忘，不设此边）
claimed    → in_progress | blocked | failed | cancelled
in_progress→ completed | blocked | failed | cancelled
blocked    → (回 preBlockedStatus∈{claimed,in_progress}) | cancelled   （blocked→pending 仅作 unblock 兜底的防御边）
```

- 进入：只有一条路——认领者 `xc_report(status:"blocked", error=阻塞原因必填)`（attempt 保留）。lead 不设「标阻塞」入口（lead 想叫停走 relay 沟通或 cancel）——责任清晰：谁卡住谁申报，`unblock` 只出不进。
- 退出（三条，共享同一清理 `clearBlockedMarkers`——L5，见 §4.2-M2）：①`xc_team({action:"unblock", taskId, unblockNote?})` → 任务回 `preBlockedStatus`，**自动回投 unblock-notice 帧给认领者邮箱**（复用既有 `unblock-notice` 帧型，mailbox.ts:56——不新增帧类型，白名单不动）+ 尽力 wake；②认领者自解 `xc_report(status:"in_progress")`（同清理 + history `unblocked-self`）；③cancel。
- 与僵尸清扫的交互：blocked **不**被清扫——`staleTasks`（graph.ts:238-241）的过滤式从 `OPEN_TASK_STATUSES` 改用新常量 `SWEEPABLE_TASK_STATUSES=['claimed','in_progress']`（graph.ts:240 一行变更 + 单测；task-edges 调用点 `task-edges.ts:171` 不动）。注意这是 M2 的必要改动而非可选项：blocked 若留在 sweep 过滤式里，合法暂停的任务会在 30min 后被误回收。接管（T1 第 5 条）则相反：`revokeAttempt` 的可撤销域=OPEN（graph.ts:220），blocked 任务随接管一并回池。overview 对 blocked 任务展示 blockedAt 时长（C5 建议行不同）。
- 依赖死锁检测（graph.ts:93 deadlockedDependents）口径不变：blocked 不改变 DAG 边语义（dependsOn 只认 completed）。

**优先级**：`DispatchShape.priority` → `Task.priority`（缺省 normal）。定位是**排序建议不是抢占**（如实声明）：
1. `xc_overview` 任务板按 `priority → createdAt` 排序展示；
2. 未领池在 overview 与成员「取一单」指引（SKILL.md §4.2a 改为「按 priority→ts 序取第一单」）中的呈现顺序；
3. `unblock-notice`/回执唤醒时的建议序。
claim 仍是显式 taskId——不实现自动指派（避免与「成员自主认领」的现行心智冲突，方案 §1-B 保留件不动）。

### 3.3 C3 内存采样、预警与卸载

**采样器（新 `core/capacity.ts`，纯插件侧、无定时器）**：

- 触发：`xc_overview` 调用时惰性采样，缓存文件 `.crosschat/capacity/sample.json`，最小间隔 `XC_MEM_SAMPLE_MIN_MS`（缺省 60_000，期内直接回缓存并标注 sampledAt）。
- 设备水位：`os.totalmem()` / `os.freemem()`（E3 §① 实测口径：31.72GB 总 / 11.2-11.4GB 可用稳定）。
- 进程树分类：PowerShell CIM（`Get-CimInstance Win32_Process`，按 CommandLine 分类）——分类规则按 E3 §① 踩坑 3：`main`（Electron 主）、`shell`（renderer/gpu/audio/network/crashpad）、`desktop-appserver`（含 `--surface desktop`）、`plugin-host`（`__zcode-plugin-host`）、`headless-turn`（`zcode.cjs ∧ ¬app-server ∧ ¬--surface`，即 wake 回合树）。**采样 ps1 必须纯 ASCII**（E3 踩坑 1：无 BOM UTF-8 被 PS5.1 按 GBK 解码→静默空结果）；tasklist 仅做总量交叉验证（E3：两通道 ±0.1%）。
- CIM 失败降级：只报 os 水位 + `capacity.degraded:"cim-unavailable"`（不虚报进程数据）。

**预警公式（E3 §实施建议 1/5 + 方案 C3 阈值）**：

```ts
watermark = os.freemem() / os.totalmem();
red1 = watermark < XC_MEM_WARN_WATERMARK;            // 缺省 0.15（方案 C3「可用内存<15%」；E3 实测 ≈4.76GB@31.72GB）
red2 = max(headless-turn 单进程 WS) > XC_MEM_SESSION_LIMIT_BYTES;   // 缺省 800MB（方案 C3「单会话>800MB」）
red3 = headlessTurnCount * XC_TURN_ESTIMATE_BYTES > os.freemem();   // 缺省 1.5GB（E3 实测：每并发成员 wake 回合瞬时 +~1.5GB）
// capacity 标红 = red1 || red2 || red3；panel 文本给出具体 violated 规则与数字。
```

注意 red3 用**活进程数**（此刻存在的 headless-turn 树），不做 >60s 稳态过滤——瞬态回合树恰恰是 red3 要抓的对象；E3 的 60s 规则只适用于「常驻基线」统计列（本设计的 `steadyTreeBytes`），两列分开呈现，不混口径。

**卸载动作（工具不自动杀进程——P0 越权写底线）**：

| 对象 | v0.6.0 行为 | 依据 |
|---|---|---|
| 引擎成员 | `xc_team({action:"member-stop", archive:true})`：先写留档（§3.4）→ 现行 stop（收任务回池+回执+shutdown 通知） | E3 §③：成员零常驻进程，stop 即回收；「成员休眠的内存意义=0，杠杆是回合本身」→ 预警建议同时给「减少并发回合」 |
| headless 会话 close/resume | **不做**（v0.7 候选）：E3 §② 已证 `session/close` 卸 runtime + keeper kill 两步回收、resume 完整捡起，但引入常驻 keeper/生命周期管理超出本轮最小改动 | E3 §②/§实施建议 2 |
| 桌面 UI 会话 | 仅「休眠建议 + 留档 prompt」（overview 红灯时给指引文本）；远程 close 需精确 workspace+先 resume，活跃 UI 会话不支持 | E3 §②C + §实施建议 3 |
| 压缩联动 | 预警时 overview 建议成员「先落 journal 再压缩」（longtask skill 压缩前 checklist，§3.4）；C9 的强制联动留 v0.7 | 方案 C9 分批 |

### 3.4 C4 archive 留档格式与 longtask skill

**任务日志（成员写，纯文件工具）**：`.crosschat/tasks/<taskId>/journal.md`

```markdown
# <任务标题>（<taskId>）
## 当前进度
- 2026-11-14 15:02 | 完成 X，产物 D:\ws\out\x.txt | sha256 略
## 交接注意
- <下一个接手的人必须知道的事>
```

行格式约定：`- YYYY-MM-DD HH:MM | 一行摘要 | 产物路径或指针`。属提示词约定（skill），工具不强制校验内容；`xc_report(in_progress)` 的响应文本带一行提醒「journal 落盘了吗」（零成本 nudge）。

**成员留档（`xc_team member-stop` 且 `archive:true`（缺省 true）时由工具写）**：`.crosschat/archive/<name>/`

```
journal.md        # 三节聚合：负责任务 / 当前进度 / 交接注意（E3 §④ 实证读档三要素全中的形态）
meta.json         # {name, sessionId, archivedAt, reason, tasks:[{taskId,title,status}], unread:[{msgId,from,ts,preview≤200}]}
```

- `<name>` 过 `sanitizeKey`（core/sanitize.ts 现行），taskId 同——**路径穿越探针进 P0 对抗清单**（§5-4）。
- 未读索引：stop 时把该成员邮箱未读消息的 id/from/ts/预览抄进 meta（读档会话可据此判断要不要找 lead 补课；不搬运原文——邮箱真源不动）。
- 捡起三步（E3 §④ 16s 实证）：①`xc_identify({name})` ②`xc_read({scope:"journal", id:"archive:<name>"})` ③按 journal 指针 `xc_read({scope:"task", id, field:"prompt"})`。同名重加=全新生命周期（provision.ts:54，E3 §③），读档是唯一续上下文路径——写进 MIGRATION/SKILL。

**longtask skill（新 `plugin/skills/longtask/SKILL.md`，三行约定）**：

1. **日志**：进行中任务每次实质进展，往 `.crosschat/tasks/<taskId>/journal.md` 追加一行（格式如上）；宁可碎、不可断。
2. **交接**：接手 = identify → read journal（archive:<名> 或 taskId）→ read task prompt，三步内进入状态；接手后在 journal 第一行记「接手」。
3. **压缩前 checklist**：容量预警（xc_overview 标红）或自知即将压缩时——先把 journal 写全（当前状态/下一步/产物路径），再接受压缩；journal 是唯一承诺落盘的副本。

description 覆盖触发词：长任务、跨天、接手、交接、休眠、压缩、长期任务。crosschat SKILL.md 同步改：工具一览表换成 10 工具、`xc_member_stop` 增「先留档」、成员守则取单序增 priority、**帧白名单计数修正（六类→七类，L3）**、身份章增接管语义（T1 第 5 条：同名接手=旧任务回池+新 attempt 认领）。

### 3.5 C5 停滞检测

- **纯函数**（新 `core/stall.ts`）：`stalledTasks(tasks, now, thresholdMs): StallFlag[]`——非终态且 `now - lastProgressTs > thresholdMs`；`lastProgressTs = max(createdAt, history 末条 ts)`（teamstate `appendTaskHistory` 已逐转移落 ts，无需新埋点）。blocked 任务**不算 stalled**（阻塞是显式状态）——超阈的 blocked 以同数组内 `kind:'blocked-long'` 单列（建议行不同：解除/取消），实现见 §4.2-M5。
- **阈值**：`XC_STALL_MINUTES` 缺省 120（方案 C5「默认 2h，可配」）。钳制：`XC_STALL_MINUTES < XC_STALE_TASK_MINUTES`（缺省 30，task-edges.ts:72-74）时按 stale 阈值取值并在 payload 附 WARNING——stale-sweeper 会先把无在途唤醒的死任务收走，stall 阈值小于它就永远轮不到展示。
- **呈现**（xc_overview team/panel）：

```
stalled: [{taskId, title, status, assignee, idleForMin, suggestion}]
suggestion: claimed/in_progress → "relay 催办 / cancel / 重派（转交）"
            pending            → "检查依赖或 cancel"
            blocked(超阈)      → "处理阻塞原因（xc_team unblock）或 cancel"
```

- **发现时延**：读时计算、无定时器（平台纪律）。方案 KPI「发现时长 ≤阈值+15min」由剧本的 ≤15min 轮询节拍达成（§5-3 场景③/⑤），不是产品承诺常驻监控——如实声明。

---

## 4. 模块划分（互不重叠；共享文件给全代码块）

### 4.1 目录树与文件职责（✚=新增 ✏=改动 ─=删除）

```
plugin/src/
  core/
    types.ts        ✏ 状态机七态+Task.priority/preBlockedStatus/blockedAt/blockedReason+TeamMessage.urgent（M2）
    teamstate.ts    ✏ makeTask 带 priority；applyReport 加 blocked 分支；transitionTask 放行 blocked 边（M2）
    graph.ts        ✏ staleTasks 过滤式改用 SWEEPABLE_TASK_STATUSES（M2 一行+单测，见 §3.2）；revokeAttempt/deadlockedDependents 不动
    stall.ts        ✚ C5 纯函数（M5）
    capacity.ts     ✚ C3 采样与预警公式（M6）
    archive.ts      ✚ C4 留档写入/读取（M7）
    mailbox.ts      ✏ 读序 urgent-first（一个排序函数，M3）；FRAME_TYPES 白名单不动
    msgstore.ts jsonl.ts atomic.ts lock.ts log.ts paths.ts sanitize.ts budget.ts
                    snapshot.ts policy.ts registry.ts uservoice.ts ｜ 不动（uservoice 仅去硬拒，见 P1-④）
    peermsg.ts      ✏ PeerQueueItem.urgent（M3 同款规则）
    peerenvelope.ts ✏ 删对抗检测函数与 forged/verified，保留渲染卫生与尾注（P1）
    mailintegrity.ts ─ 删除（P1）
  engine/
    appserver.ts provision.ts lease.ts resume-cli.ts wake.ts wake-helper.ts zcode-locate.ts
                    ｜ wake.ts 仅 buildWakePrompt urgent 首位（M4）；其余不动
  hooks/
    session-start.ts prompt-submit.ts stop.ts shared.ts ｜ shared.ts unreadSummary urgent-first（M3 同款规则）
  mcp/
    server.ts       ✏ 组装：composeCore 不变；registerAll 调 10 家族注册器；+alias 覆盖层（M1）
    core.ts         ✚ 原 tools.ts 的 ToolDeps/createToolCore/composeCore/connectionKeyOf/resolveDeps（M1 顺手搬家，
                       注册器签名不变，旧测试 import 路径仅改模块名）
    tools-identify.ts ✚ T1   tools-tasks.ts ✚ T2/T3/T4   tools-read.ts ✚ T5   tools-relay.ts ✚ T6
    tools-overview.ts ✚ T7   tools-team.ts  ✚ T8   tools-review.ts ✚ T9   doctor-tool.ts ✏（+2 行诊断）
    alias.ts        ✚ 旧名映射+弃用警告（M1）
    identity.ts guards.ts task-edges.ts peer-drain.ts render.ts protocol.ts ｜ 随 P1/P2 最小改动
    tools.ts lead-tools.ts member-tools.ts peer-tools.ts ─ 内容拆入上列家族文件后删除
  transport/ frames.ts pipe.ts mcpstdio.ts ｜ 不动
plugin/
  skills/crosschat/SKILL.md ✏（10 工具表+取单序+stop 留档）  skills/longtask/SKILL.md ✚（C4）
  commands/ 6 个主命令 ✏ + xc-agents.md xc-member.md 弃用存根 ✏
  plugin.json ✏（0.6.0、env 增 XC_STALL_MINUTES/XC_MEM_WARN_WATERMARK/XC_MEM_SESSION_LIMIT_BYTES/XC_TURN_ESTIMATE_BYTES/XC_MEM_SAMPLE_MIN_MS）
  hooks/hooks.json dist/ ｜ 重构建产物
docs/ DESIGN-V0.6.md(本文件) PROTOCOL.md ✚ MIGRATION.md ✚ ACCEPTANCE.md ✏；README.md ✏ 重写≤300 行
```

**工作流模块（互不重叠的实现对账单元，也是 submit 的 moduleCount 口径）**：M1 工具面收敛与 alias、M2 状态机与优先级（C2）、M3 urgent 读取序（C1 数据面）、M4 relay 工具与投递（C1）、M5 stall（C5）、M6 capacity（C3）、M7 archive+skill（C4）、M8 砍除批（P1 五项）、M9 命令面与 manifest、M10 文档三件套、M11 回归重放台账（49 例）、M12 发布工程。**每个文件只属一个模块**；下述共享文件是模块间唯一交界，代码块给全。

### 4.2 共享文件完整代码块

#### M1 `mcp/alias.ts`（新文件，全量）

```ts
/**
 * v0.6 工具面收敛：旧名→新名弃用覆盖层（DESIGN-V0.6.md §1.3）。
 * 机制依据（本会话实测 SDK 1.32.2）：Protocol.setRequestHandler 以 method 字面量
 * Map.set 整体替换（dist/esm/shared/protocol.js）；McpServer 在构造期装好的
 * CallTool 处理器（dist/esm/server/mcp.js:150）被本覆盖层替换后，tools/list 仍由
 * McpServer 自家的 ListTools 处理器应答（:117）——它只读 server.tool() 注册的 10 个
 * 新名。旧名不注册、仅可在调用侧触达。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface AliasEntry {
  /** 新工具名。 */
  target: string;
  /** 旧参 → 新参；返回 [shape, ignoredKeys]。 */
  mapArgs: (old: Record<string, unknown>) => { args: Record<string, unknown>; ignored: string[] };
  /** 额外固定字段（如 scope/view/action/axis）。 */
  fixed?: Record<string, unknown>;
}

const id = (k: string) => (o: Record<string, unknown>) => ({ args: { [k]: o[k] }, ignored: rest(o, [k]) });

// 仅收录「更名」的 22 个旧名；xc_dispatch/xc_claim/xc_report/xc_doctor 四个同名工具
// 不进本表（dispatcher 按 PRIMARY 正常分发）。
// 纪律（M1 修复）：每条目的 ignored 必须 = rest(o, 全部已消费键含被改名键)——
// 任何未被映射的旧参数一律显式披露，禁止静默丢弃（复核 M1：xc_message 的
// forwardOf 曾被静默丢参）。
export const ALIASES: Record<string, AliasEntry> = {
  xc_register:        { target: "xc_identify", mapArgs: (o) => ({ args: pick(o, ["name","sessionId","role","wakeToken"]), ignored: rest(o, ["name","sessionId","role","wakeToken"]) }) },
  xc_peer_register:   { target: "xc_identify", mapArgs: (o) => ({ args: pick(o, ["name","sessionId","displayName","kind","modeClass","contextChars"]), ignored: rest(o, ["name","sessionId","displayName","kind","modeClass","contextChars"]) }) },
  xc_peer_rename:     { target: "xc_identify", mapArgs: id("name") },
  xc_check_inbox:     { target: "xc_read",     mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { scope: "inbox" } },
  xc_mail_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["offset","limit"], { id: o.messageId }), ignored: rest(o, ["messageId","offset","limit"]) }), fixed: { scope: "mail" } },
  xc_task_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["field","offset","limit"], { id: o.taskId }), ignored: rest(o, ["taskId","field","offset","limit"]) }), fixed: { scope: "task" } },
  xc_peer_inbox:      { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["limit"]), ignored: rest(o, ["limit"]) }), fixed: { scope: "peer" } },
  xc_peer_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["offset","limit"], { id: o.msgId }), ignored: rest(o, ["msgId","offset","limit"]) }), fixed: { scope: "peer-msg" } },
  xc_message:         { target: "xc_relay",    mapArgs: (o) => ({ args: pick(o, ["to","summary","sourceTaskId","sourceAttemptId"], { msg: o.content }), ignored: rest(o, ["content","to","summary","sourceTaskId","sourceAttemptId"]) }) },
  xc_peer_send:       { target: "xc_relay",    mapArgs: (o) => ({ args: pick(o, ["to","summary"]), ignored: rest(o, ["to","summary"]) }) },
  xc_status:          { target: "xc_overview", mapArgs: (o) => ({ args: pick(o, ["history","offset"]), ignored: rest(o, ["history","offset"]) }), fixed: { view: "team" } },
  xc_peers:           { target: "xc_overview", mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { view: "peers" } },
  xc_agents:          { target: "xc_overview", mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { view: "panel" } },
  xc_team_init:       { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["takeover"]), ignored: rest(o, ["takeover"]) }), fixed: { action: "init" } },
  xc_lead_transfer:   { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["to","reason"]), ignored: rest(o, ["to","reason"]) }), fixed: { action: "transfer" } },
  xc_lead_release:    { target: "xc_team",     mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { action: "release" } },
  xc_member_add:      { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["name","model","reasoningLevel","note"], { contextChars: o.context }), ignored: rest(o, ["name","model","reasoningLevel","note","context"]) }), fixed: { action: "member-add" } },
  xc_member_stop:     { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["name","reason"]), ignored: rest(o, ["name","reason"]) }), fixed: { action: "member-stop", archive: true } },
  xc_idle:            { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["summary","idleReason","completedTaskId","completedStatus","failureReason","result"]), ignored: rest(o, ["summary","idleReason","completedTaskId","completedStatus","failureReason","result"]) }), fixed: { action: "idle" } },
  xc_cancel:          { target: "xc_team",     mapArgs: id("taskId"), fixed: { action: "cancel" } },
  xc_inbound_review:  { target: "xc_review",   mapArgs: (o) => ({ args: pick(o, ["action","ids"]), ignored: rest(o, ["action","ids"]) }), fixed: { axis: "team" } },
  xc_peer_review:     { target: "xc_review",   mapArgs: (o) => ({ args: pick(o, ["action","ids"]), ignored: rest(o, ["action","ids"]) }), fixed: { axis: "peer" } },
};

export const DEPRECATION_NOTE = (oldName: string, t: AliasEntry) =>
  `[DEPRECATED] ${oldName} 已更名为 ${t.target}（v0.7.0 移除）。本次调用已正常执行。迁移表见 docs/MIGRATION.md。`;

/** 安装覆盖层：必须在全部 server.tool() 注册之后、connect 之前调用。
 *  L1 纪律：extra 必须原样透传给 dispatcher——connectionKeyOf(extra)（identity.ts:106-108）
 *  是身份绑定的锚，丢掉 extra = 别名路径全部 notRegistered。 */
export function installAliasLayer(
  server: McpServer,
  dispatch: (name: string, args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
): void {
  const underlying = (server as unknown as { server: { setRequestHandler: (s: unknown, h: unknown) => void } }).server;
  underlying.setRequestHandler(CallToolRequestSchema, async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }, extra: unknown) => {
    const name = request.params.name;
    const rawArgs = request.params.arguments ?? {};
    if (ALIASES[name] === undefined) {
      // 新名与未知名都交回统一 dispatcher（新名正常执行；未知名抛标准错误）。
      return await dispatch(name, rawArgs, extra);
    }
    const alias = ALIASES[name];
    // M1 纪律：forwardOf 在两个 relay 别名（xc_message/xc_peer_send）上都显式报错，
    // 不许静默丢参——旧 MessageShape（tools.ts:153-159）与 PeerSendShape 都有 forwardOf。
    if (alias.target === "xc_relay" && rawArgs.forwardOf !== undefined) {
      throw new McpError(ErrorCode.InvalidParams,
        "forwardOf_removed: 转发机制已在 v0.6 移除——请直接 xc_relay 撰写正文（批注另发一条）。见 docs/MIGRATION.md。");
    }
    const { args, ignored } = alias.mapArgs(rawArgs);
    const merged = { ...args, ...(alias.fixed ?? {}) };
    const result = (await dispatch(alias.target, merged, extra)) as {
      content?: Array<{ type: string; text?: string }>;
      [k: string]: unknown;
    };
    const note = { type: "text" as const, text: DEPRECATION_NOTE(name, alias) };
    const deprecated = { tool: name, replacement: alias.target, ...(ignored.length > 0 ? { ignored } : {}) };
    // content[0] = 警告块；原首块顺延。结构化 payload 挂 deprecated。
    const content = [note, ...(result.content ?? [])];
    return { ...result, content, deprecated };
  });
}

function pick(
  o: Record<string, unknown>,
  keys: string[],
  renames: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  for (const [k, v] of Object.entries(renames)) if (v !== undefined) out[k] = v;
  return out;
}
function rest(o: Record<string, unknown>, keys: string[]): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined && !keys.includes(k));
}
```

> 实现注记（实现者须知）：①`messageId→id`、`taskId→id`、`msgId→id`、`content→msg`、`context→contextChars` 五处改名并入 `mapArgs`（第三个入参 renames），undefined 不落入 args——新工具 optional 语义不受影响；②每条目 `ignored = rest(全部已消费键)`——任何未映射旧参数显式披露、禁静默丢弃（复核 M1）；③覆盖层的 `fixed`（scope/view/action/axis）在入参合并**之后**生效，alias 调用方无法覆盖它们（条款 4 的 P0 探针⑤断言此点）；④`extra` 全程透传（L1），单测须断言别名路径下 `connectionKeyOf(extra)` 得到的身份与新名路径一致（同连接先 `xc_register` 后调 `xc_check_inbox`，能读到同一邮箱即证）。

#### M2 `core/types.ts` 与 `core/teamstate.ts` 的共享变更块（M2 独占写，M4/M7 只读）

```ts
// core/types.ts —— 状态机与任务字段（替换 :18-66 的对应区）
export const TASK_STATUSES = [
  'pending', 'claimed', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
/**
 * blocked 是暂停的开任务：认领者仍持有 attempt，不算终态。
 * OPEN=「占用成员的单开槽位」口径（one-open-task-per-member 与 revokeAttempt 的
 * 可撤销域，graph.ts:220）——blocked 在内，保证 unblock 复位不破坏单开不变量。
 * SWEEPABLE=僵尸清扫的候选口径（graph.ts:240 staleTasks 的过滤式改用本常量，
 * 一行变更+单测）——**必须**比 OPEN 窄：否则 M2 扩列后 blocked 会被 sweeper
 * 误回收（复核发现的原口径冲突）。
 */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['claimed', 'in_progress', 'blocked'];
export const SWEEPABLE_TASK_STATUSES: readonly TaskStatus[] = ['claimed', 'in_progress'];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // L-n3：pending 不列 blocked——blocked 唯一入口是认领者 report（需 attempt），
  // pending 无 attempt 无认领者，该边不可达（死边），删除而非保留死配置。
  pending:     ['claimed', 'cancelled'],
  claimed:     ['in_progress', 'blocked', 'failed', 'cancelled'],
  in_progress: ['completed', 'blocked', 'failed', 'cancelled'],
  // blocked→pending 保留为防御性回退边：unblockTask 的 preBlockedStatus 缺失兜底
  // （正常记录经 applyReportBlocked 必有 preBlockedStatus∈{claimed,in_progress}）。
  blocked:     ['pending', 'claimed', 'in_progress', 'cancelled'],
  completed:   [],
  failed:      [],
  cancelled:   [],
};

export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Task 接口（:106-129）追加：
//   priority?: TaskPriority;            // absent = normal（旧记录兼容）
//   blockedReason?: string;             // status=blocked 必有
//   blockedAt?: number;
//   preBlockedStatus?: TaskStatus;      // 解除目标态；unblock 时校验 ∈ OPEN_TASK_STATUSES

// TeamMessage（:215-242）追加：
//   urgent?: boolean;                   // C1：读取面 urgent-first
```

```ts
// core/teamstate.ts —— applyReport 的 blocked 分支（插入现行 applyReport :439 的 status 分派处）
export function applyReportBlocked(task: Task, reason: string, now: number): void {
  // 调用方已过 transitionError（claimed|in_progress → blocked 合法）。
  task.preBlockedStatus = task.status;
  task.status = 'blocked';
  task.blockedReason = reason;
  task.blockedAt = now;
  task.updatedAt = now;
  appendTaskHistory(task, 'blocked', /* by: reporter */ task.assignee ?? 'unknown', task.attemptId ?? undefined, now);
}

export function unblockTask(task: Task, now: number): string | undefined {
  if (task.status !== 'blocked') return 'task_not_blocked';
  const back = task.preBlockedStatus ?? 'pending';
  const err = transitionError('blocked', back);
  if (err) return err;
  task.status = back;
  task.updatedAt = now;
  clearBlockedMarkers(task);
  appendTaskHistory(task, `unblocked->${back}`, /* by */ 'lead-or-creator', task.attemptId ?? undefined, now);
  return undefined;
}

/** L5：两条解除路径共用的清理——解除目标标记必须清，防二次 unblock 误回跳；
 *  blockedReason/blockedAt 保留作历史痕迹（journal 之外的磁盘痕迹）。 */
export function clearBlockedMarkers(task: Task): void {
  task.preBlockedStatus = undefined;
}
```

> 认领者自解路径（`xc_report(status:"in_progress")`，blocked → in_progress 转移合法）在 `applyReport` 的 in_progress 分支同样调用 `clearBlockedMarkers(task)` 并追加 history `unblocked-self`——与 `xc_team unblock` 共用同一清理，不留悬空 `preBlockedStatus`。

> unblock 后的「自动回投 unblock-notice + 尽力 wake」在 `mcp/tools-team.ts` 的 action=unblock 分支实现（邮箱帧组装复用现行 unblock-notice 通道，wake 复用 attemptWake）；core 层只管状态。

#### M3 urgent-first 排序（`core/mailbox.ts` / `core/peermsg.ts` / `hooks/shared.ts` 三处共用同一规则）

```ts
// core/mailbox.ts —— 新增导出；inbox 读取、unreadSummary、peer 排空统一调用
export function urgentFirst<T extends { ts: number; urgent?: boolean }>(items: readonly T[]): T[] {
  // stable：urgent=true 在前，两类内部按 ts 升序（JSONL 到达序）。物序不动，只动呈现序。
  const rank = (m: T) => (m.urgent === true ? 0 : 1);
  return items
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.m.ts - b.m.ts || a.i - b.i))
    .map((x) => x.m);
}
```

`hooks/shared.ts:207 unreadSummary` 与 `mcp/peer-drain.ts` 的注入排布在取数后套同一函数（预算排布沿用 `layoutInjectBlocks`，urgent 块置首且优先全文——M4 负责 relay 写入侧，M3 只保证读出侧）。

#### M4 `mcp/tools-relay.ts` 的 urgent 投递判定（核心 15 行）

```ts
// urgent 落邮箱后的推送决策：不绕过 decideDelivery 的三重条件（E1：忙→下回合）。
const decision = decideDelivery({
  duplicate: false,                       // dedup 已在上游查过（urgent 不豁免 dedup）
  wakeEnabledRaw: deps.env.XC_WAKE_ENABLED,
  ownerAbsent: await isOwnerAbsent(deps, to),   // 现行 owner-present 判定原样复用
  inflight: isInflightWake(deps, to),
});
if (decision.mode === "wake") await attemptWake({ /* …现行 WakeRequest…，prompt 由 buildWakePrompt 携带 urgent 首段 */ });
// interrupt 参数不触发任何 stop/send：payload 固定报 deferred-next-turn（§3.1）。
```

#### M5 `core/stall.ts`（新文件，全量）

```ts
/**
 * v0.6 C5：停滞检测纯函数（DESIGN-V0.6.md §3.5）。无 I/O、无时钟副作用（now 注入）。
 */
import type { Task, TaskStatus } from './types.js';

export interface StallFlag {
  taskId: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  idleForMin: number;
  kind: 'stalled' | 'blocked-long';
}

export function lastProgressTs(task: Task): number {
  const last = task.history.length > 0 ? task.history[task.history.length - 1]!.ts : 0;
  return Math.max(task.createdAt, last);
}

export function stalledTasks(tasks: readonly Task[], now: number, thresholdMs: number): StallFlag[] {
  const out: StallFlag[] = [];
  for (const t of tasks) {
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') continue;
    const idleForMin = Math.round((now - lastProgressTs(t)) / 60_000);
    if (idleForMin <= Math.round(thresholdMs / 60_000)) continue;
    if (t.status === 'blocked') {
      const blockedMin = t.blockedAt !== undefined ? Math.round((now - t.blockedAt) / 60_000) : idleForMin;
      if (blockedMin > Math.round(thresholdMs / 60_000)) {
        out.push({ taskId: t.id, title: t.title, status: t.status, assignee: t.assignee, idleForMin: blockedMin, kind: 'blocked-long' });
      }
      continue; // blocked 未超阈不算 stalled（阻塞是显式状态）
    }
    out.push({ taskId: t.id, title: t.title, status: t.status, assignee: t.assignee, idleForMin, kind: 'stalled' });
  }
  return out;
}

/** 阈值钳制：stall 阈值不得小于 stale 阈值（否则 sweeper 先收走、stall 永不展示）。 */
export function stallThresholdMs(env: NodeJS.ProcessEnv, staleThresholdMs: number): { ms: number; clamped: boolean } {
  const raw = Number(env['XC_STALL_MINUTES']);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 120;
  const staleMinutes = Math.round(staleThresholdMs / 60_000);
  if (minutes < staleMinutes) return { ms: staleThresholdMs, clamped: true };
  return { ms: minutes * 60_000, clamped: false };
}
```

#### M6 `core/capacity.ts`（新文件，关键签名——完整实现按 E3 §①/§实施建议 1）

```ts
export interface CapacitySample {
  sampledAt: number;
  totalBytes: number; freeBytes: number; watermark: number;        // os 口径
  steadyTreeBytes: number | null;                                   // CIM 常驻树（main+shell+desktop-appserver+plugin-host+cli-utility）
  headlessTurnCount: number; headlessTurnMaxRssBytes: number | null;// 瞬态回合树（E3 分类：zcode.cjs ∧ ¬app-server ∧ ¬--surface）
  degraded: 'cim-unavailable' | null;                               // CIM 失败→仅 os 水位，如实标注
}
export interface CapacityVerdict { red: boolean; violated: Array<'watermark'|'session-limit'|'turn-concurrency'>; detail: string[]; }

export async function sampleCapacity(env: NodeJS.ProcessEnv, cacheFile: string, now: number): Promise<CapacitySample>;
export function judgeCapacity(s: CapacitySample, env: NodeJS.ProcessEnv): CapacityVerdict;
// 公式与阈值：watermark < XC_MEM_WARN_WATERMARK(0.15)｜maxRss > XC_MEM_SESSION_LIMIT_BYTES(800MB)
//             ｜headlessTurnCount * XC_TURN_ESTIMATE_BYTES(1.5GB) > freeBytes（§3.3）
```

#### M7 `core/archive.ts`（新文件，关键签名）

```ts
export interface ArchiveMeta {
  name: string; sessionId: string; archivedAt: number; reason: string;
  tasks: Array<{ taskId: string; title: string; status: TaskStatus }>;
  unread: Array<{ msgId: string; from: string; ts: number; preview: string }>; // preview ≤200 字符
}
export async function writeArchive(stateRoot: string, member: { name: string; sessionId: string }, input: {
  reason: string; tasks: ArchiveMeta['tasks']; unread: ArchiveMeta['unread']; journalSections: string; // 三节正文由调用方（tools-team）从 tasks/journal 聚合
}): Promise<{ dir: string; journalPath: string; metaPath: string }>;
export function archiveJournalPath(stateRoot: string, name: string): string;   // name 须先过 sanitizeKey
export function taskJournalPath(stateRoot: string, taskId: string): string;
```

路径安全：`name`/`taskId` 在拼路径前过 `sanitizeKey`（core/sanitize.ts）并拒绝 `..`/分隔符——P0 探针覆盖（§5-4）。

#### M8 `mcp/server.ts` 的组装块（替换 :63-89 的注册段）

```ts
const deps = resolveDeps(process.cwd(), process.env);
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
const core = composeCore(deps);                       // 组装链不变：edges → guards → peerDrain（server.ts:42-47）
registerIdentify(server, deps, core);
registerTasks(server, deps, core);                    // dispatch/claim/report
registerRead(server, deps, core);
registerRelay(server, deps, core);
registerOverview(server, deps, core);
registerTeam(server, deps, core);
registerReview(server, deps, core);
registerDoctorTool(server, { version: SERVER_VERSION, env: process.env, cwd: process.cwd() });
// L1：dispatcher 签名 (name, args, extra)——extra 透传给每个 handler，
// handler 内 connectionKeyOf(extra) 取连接键（与现行 tools.ts:1372 同款）。
installAliasLayer(server, (name, args, extra) =>
  dispatchPrimary(server, deps, core, name, args, extra));   // §1.3；必须在 connect 前
// GuardedStdioTransport / startStaleSweeper / stdin EOF 纪律全部原样保留（server.ts:76-97）。
```

---

## 5. ACCEPT10 六条逐条验证方案

> 口径：每条给出**命令与判据**；「重放」= MCP stdio 黑盒直驱（复用 `evidence/adversarial/adjudication/adj051` 与 `_redteam-replay/adj052/cases/*.mjs` 的连接骨架：逐连接独立 `ZCODE_PLUGIN_DATA`/`XC_MESSAGING_DIR`/`ZCODE_STORAGE_DIR`，`XC_WAKE_ENABLED=false`，产品目录 `git status --porcelain` 前后一致）。直驱驱动脚本落 `_脚本/accept10/`（产物目录内，不入 plugin/src）。

### 条款 1【工具面收敛】MCP 恰 10 个 + 旧名迁移表完整 + 旧名可调且打印弃用警告；命令面同步

- **T1-a 恰 10 个**：`node plugin/scripts/build.mjs` 后直驱 `dist/mcp/server.mjs`：initialize → `tools/list` → 断言 `result.tools.length === 10` 且名字集合 = `{xc_identify, xc_dispatch, xc_claim, xc_report, xc_read, xc_relay, xc_overview, xc_team, xc_review, xc_doctor}`（精确集合比较，顺序不敏感）。判据：exit 0 + 断言输出落盘。
- **T1-b 旧名可用+警告**：对 §1.3 表中 **22 个更名旧名**（dispatch/claim/report/doctor 四个同名保留不在内）逐个 `tools/call`（xc_register 用干净 scratch 身份等——驱动脚本按迁移表准备前置态），断言：①结果非 isError；②首 text 块前缀 `[DEPRECATED]`；③payload `deprecated.tool/replacement` 正确；④两个 relay 别名（xc_message/xc_peer_send）带 `forwardOf` → 显式 `forwardOf_removed` 错误、**且不静默丢任何旧参**（每条目的 `ignored` 披露逐一断言——M1）；⑤同名四工具调用**无**弃用警告；⑥别名路径的身份连续性：同一连接先 `xc_register` 后 `xc_check_inbox` 能读到同一邮箱（extra 透传，L1）。
- **T1-c 迁移表完整性**：脚本比对 §1.3 表的旧名集合与 v0.5.3 源码的注册名清单：`git show v0.5.3:plugin/src/mcp/{tools,lead-tools,member-tools,peer-tools,guards,doctor-tool}.ts | grep -A1 'server.tool(' | grep -oE '"xc_[a-z_]+"'`（26 个——名字在 `server.tool(` 的下一行，必须带 `-A1`）——集合相等才算表完整。
- **T1-d 命令面**：`ls plugin/commands` = 8 文件（6 主 + 2 存根）；存根正文 grep 含新命令名；`plugins validate`（v0.4 验收命令）通过。

### 条款 2a【全量历史回归】49 用例重放全绿（一次性跑全）

用例底账（本轮清点，**任务书说 48、逐文件清点为 49**——以并集执行，宁多勿漏）：

- 一轮 18：`evidence/17-v051/reverify/01…18-*.md`（19-回归抽验、20-README一致性核查为非 bug 项，不计数）。
- 二轮 19：`evidence/18-v052/reverify/bug-02…bug-16, bug-18…bug-21`（bug-01 未复现项加固、bug-17 ≡ bug-03 合并项，README.md 台账口径「19/19 确认」）。
- 三轮 12：`evidence/19-v053/reverify/a2…a13-*.md`（a1 为观察项；回归-防回退抽验为非 bug 项）。

处置三分类（完整 49 行台账落 `evidence/21-v060/replay-ledger.md`，此处列分类与特例）：

| 处置 | 数量 | 明细 |
|---|---|---|
| **重放（1:1，断言不变）** | 39 | 一轮 #01,02,03,05-18（17 项）＋二轮 bug-03,04,05,06,07,08,09,10,11,13,14,18,19,20,21（15 项）＋三轮 a2,a3,a4,a5,a9,a12,a13（7 项） |
| **改编（行为收敛后改断言）** | 5 | 一轮 #04（sha256 复核已砍→断言文件存在门仍在、`evidence[].sha256` 为未知参数）；二轮 bug-02（幂等重绑在软校验下保持）、bug-12（`session_id_in_use` 活性冲突仍拒）；三轮 a6、a8（冒充/sid 族：断言收敛到 `name_taken`/活性冲突/审计留痕三硬点，regToken 伪造步骤断言改为「不再存在该闸」+ 底线三问不破） |
| **N/A（对抗面已随 §2.2 砍除）** | 5 | 二轮 bug-15（forged 零宽）、bug-16（forwardOf 所有权）；三轮 a7（零宽信封）、a10（回执哈希链篡改）、a11（同形字）——每条登记砍除依据（§2.2 行 1/3/4）+ 替代底线检查（信封渲染卫生仍在：正文内嵌伪造标签被剥离=round 3 验收 #7 的正向断言保留重放） |

- 执行命令：`node _脚本/accept10/replay-all.mjs --ledger evidence/21-v060/replay-ledger.md`（顺序 1:1 复刻各轮 reverify 的步骤；隔离 scratch 同现口径）。
- 判据：39 重放全绿 + 5 改编按新断言绿 + 5 N/A 有登记与替代检查绿 → 台账全绿；任何一条无法复刻（环境/用例缺失）如实记 `not-run`，不得改判通过。

### 条款 2b【回归底线】全量单测绿 + v0.5 硬标准行为抽验

- **基线（本设计阶段已跑）**：`cd plugin && npm test` → 61 文件/952 例全绿、exit 0；`npm run typecheck` 0 错。
- **交付时**：同命令重跑，判据全绿且用例数 ≥952（改名更新的断言逐条登记，零删除）。
- **v0.5 硬标准抽验**（docs/ACCEPTANCE.md v0.5.0 五条，直驱抽验非全量复验）：①lead 可指派可移交：`xc_team init/transfer/release` 直驱断言 team.json `leadKey/leadHistory` 与 `not_lead` 拒绝（原 85 断言抽 12 条核心）；②origin=user：钩子记录原话 → `xc_relay` 逐字发送 → payload `origin:"user"`；自称发送 → 无 origin；③防卡死：614KB 消息直驱 → 注入 ≤预算 + `xc_read(scope:"mail")` 分页拼回 sha256 一致；④回归=本条单测；⑤限制条款=条款 5 的 grep。命令统一落 `_脚本/accept10/t2b-v05-sample.mjs`。

### 条款 3【长期任务剧本】六场景全过（隔离 scratch）

隔离：独立 workspace + 每连接独立 `ZCODE_PLUGIN_DATA/XC_MESSAGING_DIR/ZCODE_STORAGE_DIR` + 独立 `.crosschat`；驱动=真实 headless 会话（`zcode.cjs -p --mode yolo`）或 MCP 直驱（场景①③以直驱为主控成本，②④⑤⑥至少一次真会话）。产物落 `evidence/21-v060/scenario/`（timeline JSONL 可复核）。

| # | 场景 | 步骤要点 | 通过判据（KPI 落盘） |
|---|---|---|---|
| ① | 3 会话协作 20+ 任务 | lead 拆 22 任务（含 dependsOn 链与 priority 混布）→ 2 成员+1 peer 认领执行回报 | 22/22 任务终态；无人工干预（驱动日志）；回执 evidence 文件存在 |
| ② | 新会话接手 2 个 in_progress | 中途**进程级 kill** 成员 A（非 xc_member_stop——roster 仍 ready，模拟崩溃）→ 新会话三步接管：①`xc_identify({name:"a", sessionId:<新sid>, takeover:true})`——**必须带 takeover:true**：kill 后 A 的在途唤醒标记很快过期/不存在、lastSeen 仍新鲜（10min 窗口内），无参重绑会得 `name_taken`（M-new）；显式接管立即生效：A 名下 2 个 claimed/in_progress 任务 `revokeAttempt` 回池+创建者收回执（T1 第 5 条）②`xc_read({scope:"journal", id:"archive:a"})` 或任务 journal ③`xc_read({scope:"task", id, field:"prompt"})` → 认领（新 attemptId）→ report in_progress → 完成至少 1 单。负例同场：不带 takeover 的重绑 → 断言 `name_taken`；kill 后 60s 内对 B 的在途回合发 takeover → 断言 `takeover_inflight` 拒绝（活信号闸实测） | **进入状态 ≤3 步**（identify/journal/task prompt）；journal 可读且含接手前进展；**接手可续作**（M2 补洞）：接管回执到场、2 任务以新 attempt 重新认领成功、≥1 单最终 completed 且 evidence 过门、journal 出现「接手」行——只验「进入状态」不验「续作」不算过 |
| ③ | 无人值守段 | 关闭所有交互会话，仅 wake 推进 ≥5 任务；其中 **1 单刻意停滞**：成员 B 对它 `xc_report(status:"blocked")`（reason=等待一个本段内不会出现的输入）后回 idle——**不 stop B**（member_stop 会把 OPEN 任务收回归池、blocked 在 OPEN 内，停 B 反而让样本被别的成员领走）；blocked 有属主不可他领、不进 SWEEPABLE 不会被 sweep，滞留确定。drill 临时设 `XC_STALL_MINUTES=30`（=stale 缺省阈值不触发钳制；产品缺省仍 120，方案「可配」） | 可完成任务完成率 100%；**停滞任务发现时长 ≤30min+15min**（overview 轮询节拍 ≤15min，该单以 stalled/blocked-long 标出+建议行）；wake 日志（logs/wake-*.json）齐全 |
| ④ | 用户介入插队 | 对忙/闲/离线成员各一次 `xc_relay(urgent:true)`（interrupt:true 一次，记录 payload） | 响应延迟可测落盘（在场=下回合/工具间隙注入；离线=wake 回合响应复述标记）；interrupt payload=`deferred-next-turn` 如实在场 |
| ⑤ | 方向纠偏打断 | urgent 纠偏消息 + `xc_team({action:"unblock"})` 演练 | **E1 已证平台限制：退化路径记为通过**——判据=纠偏消息在目标下一回合首读（时间线首行复述标记）+ 文档声明「打断受宿主限制（E1 §1.1）」 |
| ⑥ | 容量预警+压缩前留档+休眠捡起 | 制造预警（临时调低 XC_MEM_WARN_WATERMARK）→ **压缩前留档显式步骤（L-n4）**：被预警成员按 longtask checklist 把 journal 写全（当前状态/下一步/产物路径）并 `xc_report(in_progress)` 附 journal 路径——留档动作落盘时间戳必须早于压缩/休眠事件 → member-stop(archive:true) → 新会话捡起 | overview 标红含 violated 规则；**留档先行可核对**：journal 末次修改时间戳 < member-stop 时间戳（文件 mtime 对比落盘）；`.crosschat/archive/<name>/journal.md+meta.json` 在场；捡起三步后复述任务/进度/交接注意三要素全中（E3 §④ 同判据）；休眠前后进程树采样落盘 |

### 条款 4【安全底线】P0 轻量对抗零发现 + 威胁模型声明

- 范围只查 P0：**崩溃 / 数据丢失 / 越权写**。探针集（直驱，≥8 例）：①64MiB 巨帧（大帧守卫回归）；②team.json 截断损坏（自愈/拒绝路径）；③跨 workspace 路径穿越：`xc_read(scope:"journal", id:"../../etc")`、archive name 带 `..`（C4 新面）；④邮箱毒行/巨行（#10/#17 回归面）；⑤alias 层注入：旧名带未知参数、`fixed` 字段被入参覆盖尝试（scope/view/action 不可被 alias 入参覆盖的断言）；⑥并发双连接抢同一任务（rollback_conflict）；⑦member-stop 未留档失败时的行为（不丢任务回池）；⑧unblock 越权（非 lead/创建者/认领者 → 拒绝）。
- 判据：零 P0 发现（崩溃/丢数据/越权写任一出现即不通过，修复后全量重跑）。
- README 威胁模型节（必写）：不做对抗级防伪（同机进程可伪造盖章记录/注册表——v0.5 L2 口径延续）、打断=下一回合必读、peer 通道「沉默不等于同意」、敏感内容不进邮箱、**接管语义声明（M-new）**：成员崩溃后无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；`takeover:true` 立即换绑但受在途唤醒活信号闸保护（15min 内有在途回合→拒），误判接管可恢复（旧 attempt 回池、其下份 report 得 stale 按守则停手），不崩不丢。

### 条款 5【文档】README ≤300 行 + PROTOCOL.md + MIGRATION.md

- `wc -l README.md` ≤ **300**（现 285，重写后不得超）；结构：快速开始 / 10 工具一览 / 已知限制 / 威胁模型。
- `docs/PROTOCOL.md`：帧白名单、信封属性、邮箱/管道文件布局、回执六态、注入预算公式、配置 env 全表（从 README 迁入，正文引用不复制）。
- `docs/MIGRATION.md`：§1.3 迁移表全文 + 命令映射 + forwardOf/regToken 行为变化说明 + 弃用移除时点（v0.7.0）。
- 一致性 grep：README/PROTOCOL 主文出现旧工具名仅允许在 MIGRATION 与弃用说明语境；「已支持」类宣称零无证据项（v0.4 验收 #5/#6 的脚本复用）。

### 条款 6【交付】main + tag v0.6.0 + Release

- `git log --oneline -1` = tag v0.6.0 且在 main；`scripts/pack-release.mjs` 产预构建包 + SHA256（`sha256sum -c` 过）；Release notes 含迁移要点（§1.3 表 + 弃用时点 + 剧本 KPI 摘录）；资产可匿名下载（v0.4 #1 命令复用）。

---

## 6. 风险与如实声明的边界

1. **「48 vs 49」**：任务书 48，逐文件清点 49（§5-2a）。按并集执行并已在台账标注——若规划方确认某例不计，删行不影响其余判定。
2. **D2（stop→send）不做**的论证链是设计判定而非实验缺失：E1 证明了 wire 原语可用（同宿主 stop→send 实测成立），但插件架构不持有任何目标会话的常驻 wire（provision.ts:381 keeper kill；E3 §③ 零常驻进程）。若 v0.7 立项常驻 keeper（+~300MB/成员，E3 容量画像反证其代价），D2 方可落地。
3. **E1/E2/E3 的未测项**照抄进 README 限制条款：桌面会话主动 interrupt 未实测（E1 §6）；`--surface desktop` 投影未取证（E2 §5）；活跃 UI 会话远程 resume+close 未测（E3 §limits 1）；ERA 失败根因未二分（E1 §6）——悬挂执行态会话卡 wake 通道的清理路径在 C3 的 member-stop 留档里有兜底（stop 可达的场景），跨进程硬杀场景留 v0.7。
4. **状态机扩列的兼容**：旧 team.json（六态无新字段）读取必须无损——`priority/preBlockedStatus/blockedAt/blockedReason/urgent` 全部 optional 缺省化（M2 代码块注释），v0.5.3 数据在新版下照常读写（历版「旧数据可读写」口径延续）。
5. **alias 层是行为面**不是糖：它替换了 SDK 的 CallTool 分发器，任何 dispatcher bug 都会打穿全部工具——T1-a/b 必须在条款 2a/2b 之前先绿（§2.1 批序已保证），且 dispatcher 对新名的路径与直连注册路径共用同一实现函数（双入口单实现）；`extra` 全程透传（L1），单测断言别名路径身份与新名路径一致。
6. **两处对批准方案的偏离，需规划方追认**（复核 L4 后显式化）：①邮箱帧 `shutdown-request` 保留（§2.2 行 5）——方案 §1-A 行 6 列「shutdown 协议帧→删」，但它是 member-stop 停机通知的唯一载体，砍除即砍「成员可停」保留件；②`xc_report` 的 evidence 哈希复核砍除后，round1 #04 类「伪造 sha256」用例失去原断言对象（§5-2a 改编处置）。两处都已在正文标注，规划方不追认则回退对应设计（①保留帧、②恢复改编为 N/A+替代检查不变）。
