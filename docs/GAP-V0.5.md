# GAP-V0.5：zcode-crosschat v0.4.0 现状盘点与三项改进差距分析

> 分析人：现状侦察员（dynamic workflow 子代理）｜日期：2026-11-11
> 基准：本仓库 v0.4.0 源码（`plugin/src/**`，main @ `ffff0cf`）+ `docs/SPEC-V0.3.md` + CC 逆向实证（`deepseek-crosschat/reports/11-cc逆向.md`、`reports/13-cc消息来源区分.md`）
> 实测证据：`deepseek-crosschat/evidence/16-v050/recon/`（行为探针 `behavior-probe.json`、源码摘录）
> 纪律：每条结论给证据（源码 `路径:行号` / 实测命令与输出）；查证不到的标「未确认」；差距只允许来自实测证明的限制，不得以简化为由降低验收标准。
> 本次实测基线：`npx vitest run` → **38 个测试文件、544 测试全部通过**（2026-11-11，v0.4.0 源码）。

---

## 1. 结论速览

用户确认的三项改进（对等协作精神：权威属于用户）对应三条差距：

| # | 需求 | v0.4.0 现状 | 核心差距 |
|---|---|---|---|
| G-1 | lead 由用户指定且可灵活切换（元数据角色非系统中枢） | lead=先调用 `xc_team_init` 者得（先到先得），或建员时隐式材料化 founder；**无让位/切换路径**，第二 lead 被 `lead_exists` 硬拒 | 缺 `lead_transfer`/让位语义；lead 判定与 founderKey 纠缠；用户无法直接指定任意会话为 lead |
| G-2 | 「用户亲述」在传输链中始终可分辨、不可被会话消息冒充 | peer 轴有信封+归因尾注，但尾注把**一切** peer 消息断言为「not typed by your user」；队内域（`xc_message`/邮箱/`xc_check_inbox`）**无信封无 origin** | 两个域的消息模型都没有 origin/authority 字段；无 `kind:"user"` 通道；用户的话经会话转发后权威标记丢失（CC 的 `relay-human` 语义缺位） |
| G-3 | 大信息自适应截断 + 分页按需拉取 | 唯一的大小硬闸在传输层（1 MiB/行）；注入面（信封/邮箱/快照）**全文直灌**；四条入站 schema 均 `min(1)` 无 `max` | 截断只按发送侧固定预算（wake 4000、依赖输出 2000/12000），**没有「接收方上下文预算」概念**；`xc_check_inbox`/`xc_peer_inbox` 只有条数上限无分页续读 |

放大事实（实测，见 §4）：一条 5 MB 文本经 `xc_peer_send` 帧预算内分片或 file 通道入队后，`renderPeerEnvelope` **原样通过**（5,242,880 → 5,244,260 字符，无截断标记）；UserPromptSubmit 钩子一次最多灌 20 条全文（`prompt-submit.ts:57`）；队内邮箱 10×1 MB 实测拼出 10,486,088 字符的渲染体。

支撑性差距（需求③的输入数据缺口）：

| G-4 | 接收方模型信息可获取性 | 注册表（`TeamMember`/`NameBinding`）**无 model 字段**；app-server 模型枚举只保留 provider/model/reasoningLevels 三字段，上下文窗口信息（若平台枚举里有）在 `collectModelRefs` 被丢弃 | 任何「按接收方模型上下文预算截断」都没有数据来源；MCP 工具面无查询成员 model 的工具 |

---

## 2. 现状盘点一：lead 如何产生、能否切换、team.json 怎么存

### 2.1 产生：三个写入点，全是「先到先得」

`team.leadKey` 的全部写入点（`grep -rn "leadKey" plugin/src --include="*.ts"` 实测，非测试文件只有两处赋值）：

1. **`xc_team_init`**（`plugin/src/mcp/lead-tools.ts:141-186`）：把当前连接身份设为 lead。已有其他 lead → `lead_exists` 硬拒（lead-tools.ts:158-164：「a second lead cannot take over」）；已是 lead → 幂等成功。落盘 `team.json.leadKey` + `engine.jsonl {event:"lead-set"}`（lead-tools.ts:174-179）。
2. **`xc_member_add` 隐式材料化**（`plugin/src/mcp/member-tools.ts:239-240`）：`if (team.leadKey === undefined) team.leadKey = me.agentKey;` —— lead 主动建第一个成员时，founder 被写成显式 leadKey。
3. **兜底读取**（`plugin/src/mcp/member-tools.ts:102-104`）：`leadKeyOf(team) = team.leadKey ?? team.founderKey` —— 未显式设置时 founder 天然被视为 lead（xc_member_add/xc_member_stop 的 `not_lead` 校验、xc_cancel 的 isLead、xc_idle 收件人都走这条，lead-tools.ts:212、303-305）。

**没有引擎指定路径**：lead 从来不是引擎按模型/能力挑选的；引擎（app-server）只负责成员供给（`provision.ts:241-376`），成员一律 `role:"worker"`（member-tools.ts:219/229）。

**用户入口**：斜杠命令 `/xc-team`（`plugin/commands/xc-team.md:11`）执行 `xc_team_init`，遇 `lead_exists` 明确「不得抢位」——只建议向现任队长传话。**没有任何命令/工具能让用户把 lead 指定为任意会话，或把 lead 移交给别的会话。**

### 2.2 切换：不存在

- `leadKey` 的赋值只有上述两处；全仓 `grep` 无 `leadKey = undefined`、无 delete/transfer/step-down 语义（`xc_member_stop` 停掉 lead 自己也不清 leadKey——member-tools.ts:464-471 只改 members 行）。
- 后果：首任 lead 会话退出/停止后，`lead_exists` 依旧拒绝新 lead；唯一恢复途径是手改磁盘 team.json（无工具支持）。
- 这与 CC 的形态一致（CC 官方也自述「lead 固定」是 Limitation，GAP-V0.2.md §2.1 T15），但用户需求①恰恰要求打破它——CC 实证（reports/11-cc逆向.md）同样确认 CC「无总调度器」，team-lead 只是派发汇总的**角色**而非系统中枢：v0.4.0 的架构（磁盘真源 + 去中心认领 + 任何成员可 `xc_dispatch`/`xc_message`）本身已经不依赖 lead 存活，把 lead 变成可切换元数据角色没有架构障碍。

### 2.3 team.json 存储（实测样本）

实测文件 `evidence/12-v030/acceptance/phaseD/ws/a/.crosschat/teams/default/team.json`：

```text
leadKey: panel-lead | founderKey: panel-lead
member keys: ['joinedAt', 'key', 'lastSeen', 'role', 'sessionId']
```

schema 定义在 `plugin/src/core/types.ts:168-180`（`TeamState`）：`teamId/name/founderKey/phase/leadKey?/members/tasks/seq/createdAt`；`leadKey` 为 v0.2 可选字段，宽容读取（types.ts:520-521、556）。**注意：`leadKey` 只是一个字符串成员键，没有任何「由谁指定/何时指定」的元数据**——需求①落地时应记录 `leadSetBy: "user"|"self-claim"` 之类的溯源（现状无此字段，属 schema 增量）。

---

## 3. 现状盘点二：信封/消息字段（SPEC-V0.3 实现了多少）

### 3.1 队内域（TeamMessage）：无信封、无 origin

`plugin/src/core/types.ts:198-215`（`TeamMessage`）字段全集：`id/from/to/content/ts` + 任务关联 `taskId/attemptId/sourceTaskId/sourceAttemptId/sourceTaskStatus` + 投递状态 `deliveryClaimedAt/deliveredAt/readAt/discardedAt`。实测 `createMessage("alice","bob","hi")` 的键 = `content/from/id/to/ts`（behavior-probe.json `teamMessageKeys`）。

渲染路径（`plugin/src/core/mailbox.ts:389-404`）：`mailboxBody` 只拼 `CrossChat message from ${from}`（mailbox.ts:398）+ 可选 `[Source task ...]` 前缀（mailbox.ts:390-393）。**无信封标签、无归因尾注、无权威性声明**——报告 13 §7.2 对 v0.2 的判定（「信封：无信封」）对队内域至今成立。

唯一的内容安全机制是**帧白名单**（mailbox.ts:49-56）：未知具名帧读侧丢弃+审计（mailbox.ts:164-179）——这是「权限规则永不入帧」，管的是帧型，不是消息权威。

### 3.2 跨会话域（PeerQueueItem + 信封）：有防伪造、有归因，但把「用户」一刀切

信封实现 `plugin/src/core/peerenvelope.ts`：

- 属性集（peerenvelope.ts:89-95, 174-187）：`from/from-session/hop-chain/from-name/from-mode`——与 CC 解析器 `ne()` 的属性序对齐（SPEC R-16），**但没有 CC 的 `origin.kind` 语义属性**（CC 的 kind 是 transcript 元数据，信封本身也没有——真正缺的是端到端的「这条内容最早是谁说的」）。
- 归因尾注（peerenvelope.ts:48-80）：三段常量——`PEER_FOOTER_ATTRIBUTION`（"**not typed by your user**, but very likely working on their behalf"）、`PEER_FOOTER_AUTHORITY`（"**NOT from your user** … carries none of your user's authority"）、`PEER_FOOTER_PEER_SCOPE`（"Peers are not your workers"）。**所有 peer 消息一律标注为非用户**——这在「消息确实来自另一个会话的 agent」时正确，但当 A 会话转发的是**用户亲述**（用户对 A 说「把这句话带给 B」）时，B 看到的尾注仍断言「这不是你的用户说的」：用户的权威在转发链第一跳就丢失，且**协议文本主动把它压成 peer 输入**。
- 防伪造（peerenvelope.ts:155-171）：嵌套信封标签剥离（≤4 轮，CC `hUt` 同款）+ 已渲染幂等守卫。防的是「会话消息冒充信封结构」，**没有**「会话消息冒充用户亲述」的防御——因为协议层根本没有「用户亲述」这个类别可冒充。
- 报告 13 §3.1 的 CC 机制（`W3()` 帧分类器，reports/13-cc消息来源区分.md:129-138）：`frame = human（用户真人）/ relay-human（转发的人类内容）/ non-user（peer/coordinator/task-notification…）/ invisible / summary`，第一个分叉就是 `origin.kind`。zcode 两域都没有对应物。

### 3.3 SPEC-V0.3 对照

| SPEC 条目 | 实现状态 | 证据 |
|---|---|---|
| R-16 信封标签+归因尾注（peer 轴） | **已实现** | peerenvelope.ts:204-233；注入面 A/B/C 三处共用 |
| R-13 帧 `{type:"msg", msgId, from, fromSessionId?, text, summary?, senderMode?}` | **已实现**（senderMode→fromMode） | peer-tools.ts:1001-1005、frames.ts |
| R-23 四闸（限速/去重/环深/队列上限） | **已实现** | peermsg.ts:350-367；实测 30 条/10s、256 去重、深度 2、容量 64 |
| R-30 行协议 1 MiB 预算 + `too_large` | **已实现** | frames.ts:99、262-263、314-325；实测 2MB 帧 `peer frame too large: 2097208 bytes > 1048576` |
| R-32 发送错误七分类 | **已实现** | pipe.ts:65、transport/frames.ts |
| hold 三态审阅 | **已实现** | peermsg.ts:414-465（12h TTL、容量 100 驱逐最旧）、xc_peer_review |
| SPEC:125 CC `origin {kind:"peer",…}` 入队结构 | **部分**：只有 hopChain/fromMode，无 kind 语义、无用户通道 | peermsg.ts:60-81；实测 `peerQueueItemKeys = [from, hopChain, msgId, text, ts, via]` |
| SPEC R-31 队列项 `{mode:"prompt", value, uuid, priority, origin:{…}}` | **未按此形状实现**（实现是自有 PeerQueueItem，功能等价） | peermsg.ts:60-81 |
| （SPEC 未要求）`origin.kind:"user"` / relay-human | **无**——SPEC 本身也没有定义用户亲述通道 | SPEC-V0.3.md 全文无 origin.kind 枚举 |

### 3.4 转发链现状（需求②的靶点）

转发=会话把收到的内容放进自己的 `xc_peer_send`/`xc_message` text 重发。这条链上：

1. 队内域：source* 字段只追踪**任务**来源（sourceTaskId/attemptId），不追踪**说话人**来源。
2. 跨会话域：hopChain 只记录**会话路径**（防环），hop 间传递的 text 是自由文本——A 转述用户的话和 A 自己的话在 wire 上零差异。
3. 结论：「用户亲述」目前**在源头就无载体**（没有任何字段能装它），在每一跳都不可分辨，在接收端还被归因尾注统一否定。这与 CC 形成结构性差距：CC 至少有 `origin.kind`（机器可读）+ 信封属性（文本可读）双层。

---

## 4. 现状盘点三：截断与注入路径（实测）

### 4.1 已有的截断点（全部是发送侧固定预算，与接收方无关）

| 位置 | 预算 | 证据 |
|---|---|---|
| 唤醒 prompt（`buildWakePrompt`） | 总 4000 字符，正文先截、兜底硬切 | engine/wake.ts:287-312；**实测** 1MB 正文 → 输出恰好 4000 + `…[truncated]`（behavior-probe.json `wakePrompt_1MB_body`） |
| unblock-notice 依赖输出 | 单项 2000、总 12000，超限丢最上游 | core/graph.ts:83-85、120-150 |
| xc_member_add 返回 | welcomeResponse 400、失败详情 500 | member-tools.ts:61、144-146、336、357 |
| peer 行协议 | 1 MiB/行（含 auth 开销） | transport/frames.ts:99、314-325；实测 2MB 帧报 `too_large` |

### 4.2 无截断的直灌点（实测确认）

| 路径 | 上限 | 实测/证据 |
|---|---|---|
| **面 A** UserPromptSubmit 信封注入 | 条数 20/次，**每条全文** | hooks/prompt-submit.ts:57-59（`drainPeerQueue(root, sid, 20)` → `renderPeerEnvelope` 逐条 join）；**实测 5MB 正文通过信封零截断**（`envelope_5MB`：input 5,242,880 → output 5,244,260，bodyPreserved=true，无 truncated 标记） |
| **面 B** 工具回合间隙信封注入 | 条数 5/次，每条全文 | mcp/peer-drain.ts:74（`PEER_DRAIN_LIMIT = 5`）、106-143（追加为 content[2]） |
| **面 C** `xc_peer_inbox` | 条数 ≤50（缺省 10），每条全文 | peer-tools.ts:1006-1008（`limit: z.number().int().min(1).max(50)`） |
| `xc_check_inbox`（队内域） | **无任何限制**，全量返回+即消费 | mcp/tools.ts:377-412（`messages: consumed` 全量入 structuredContent）；**实测 10×1MB → `mailboxBody` 拼出 10,486,088 字符**（`mailboxBody_10x1MB`，无 truncated 标记） |
| `xc_status`/全景快照 | tasks[].result/error **全文**进 structuredContent 与 snapshot.json | tools.ts:727-728；core/snapshot.ts:169（人可读表只截 24 列显示，render.ts:156，但机器负载不截） |
| 入站四闸 | 只闸频率/条数/深度/队列长度，**不闸内容大小** | core/peermsg.ts:350-367；**实测 1MB 与 8MB 文本均 `ok:true`**（`admission_1MB`/`admission_8MB`） |
| 入参 schema | `xc_dispatch.prompt`/`xc_report.result`/`xc_message.content`/`xc_peer_send.message` 全部 `z.string().min(1)` **无 max** | tools.ts:105-135；peer-tools.ts:1001-1005 |

换算成攻击面：file 通道（`via:"file"`）不经过 1 MiB 行闸（frames.ts 的预算只辖 pipe 帧），单条消息体积上限实际是磁盘；面 A 一次注入 = 20 条 × 任意大小。这就是「大信息卡死对话」的机制通道。

### 4.3 CC 实证对照（reports/13 §5.2，需求③的机制蓝本）

| CC 机制 | 证据（reports/13-cc消息来源区分.md） | zcode v0.4.0 对应 |
|---|---|---|
| idle result 单帧截断 `G9=4000` 字符，超长附 **`[result truncated — ask the agent for the rest via SendMessage]`**（按需续读指引） | §5.2 第一条（@9950531） | wake 的 4000 截断只有标记**没有续读指引** |
| 排水预算 pass `gca()`（@9949350）：总预算 `LLi=16000`，超限**从最旧开始替换**为截断标记，兜底 `[result truncated]`；遥测 `budget_truncated` | §5.2 第二条 | 无总预算概念；面 A 20 条/次是条数预算不是字符预算 |
| idle detail 截断 + 控制字符/尖括号清洗 + **循环剔除自引用字样**（防伪造/自引用） | §5.2 第四条（@36089300-36090600） | 信封剥离只剥标签，无自引用字样剔除 |

CC 的分页按需拉取 = 「截断标记 + 明示的取回通道（SendMessage）」，接收方按需再取——这正是需求③要的形态，且 CC 数值（4000/16000）可作为 zcode 预算的量级参照。

---

## 5. 现状盘点四：接收方模型信息可获取性（G-4）

1. **注册表无 model**：`TeamMember`（types.ts:144-160）与 `NameBinding`（types.ts:234-240）均无 model/上下文窗口字段。实测 v0.3 验收 team.json 的 member keys = `joinedAt/key/lastSeen/role/sessionId`。
2. **model 现在只流经四处**（拿完即丢）：
   - `xc_member_add` 入参（member-tools.ts:69）→ `provisionMember` setModel（provision.ts:244, 318-333）；
   - engine.jsonl 审计事件（member-tools.ts:292-296：providerId/modelId/reasoningLevel）；
   - `xc_member_add` 返回 structuredContent（member-tools.ts:334）——一次性，不落盘；
   - `XC_MEMBER_MODEL` env 回显（doctor-tool.ts:39、69）。
3. **app-server 枚举只取三字段**：`ModelRef = {providerId, modelId, reasoningLevels}`（appserver.ts:49-54）；`collectModelRefs` 明确只提取这三样（appserver.ts:78-95）。**app-server 原始枚举里是否携带上下文窗口字段：未确认**（需一次 session/create 实测原始 `settings.model.available[].ref` 全量 JSON——本侦察未起真实 app-server，未做）。
4. **MCP 工具面无查询口**：全部 20 个 `xc_*` 工具（server.ts:67-72 组装：队内 7 + lead 3 + member 2 + peer 7 + doctor 1）无一返回成员 model；快照 members 行（snapshot.ts:145-158）也无。
5. **平台事实**：本会话调宿主 ListModels 得到 `model_catalog_unavailable: this session cannot list models — the host did not provide a model catalog`——说明「模型目录」在宿主侧不是普遍可得的能力，自适应预算不能假定一定能拿到窗口数值，需要（a）枚举实测 +（b）查不到时的保守缺省预算两条腿。
6. 推论：需求③落地前必须先补 G-4（注册表加 model 字段 + 枚举实测窗口信息 + 查不到时的缺省预算表），否则「按接收方模型上下文预算」没有数据来源。

---

## 6. 差距清单（v0.5 待闭合项，按需求映射）

| ID | 差距 | 关键证据 | 闭合方向提示（供 SPEC-V0.5 讨论，非本报告结论） |
|---|---|---|---|
| G-1a | lead 无让位/移交路径；lead_exists 一票终身 | lead-tools.ts:158-167；xc-team.md:11 | 增 `lead_transfer`（或 xc_team_init 加 `--takeover` 语义）：当前 lead 主动让位 / 用户显式指定接管；同步记录 leadSetBy 溯源字段 |
| G-1b | lead 判定与 founderKey 纠缠（兜底语义掩盖「无主」状态） | member-tools.ts:102-104 | 区分「无 lead」与「founder 默认 lead」两种状态，切换后才算显式角色 |
| G-2a | 两域消息模型无 origin/authority 字段 | types.ts:198-215；peermsg.ts:60-81；behavior-probe.json `teamMessageKeys/peerQueueItemKeys` | 队内 TeamMessage 与跨会话 PeerQueueItem 增 `origin{kind:"user"\|"peer", assertedBy,…}`（schema 只增可选字段，§11.1 兼容纪律） |
| G-2b | 归因尾注把一切 peer 消息断言为非用户，用户亲述经转发必被压成 peer 输入 | peerenvelope.ts:48-69 | kind=user 的转发消息换用户亲述尾注（CC `relay-human` 等价物）；防伪造：只有 origin.kind=user 的消息可携带该尾注，接收端可校验 assertedBy 链 |
| G-2c | 队内域无信封（xc_check_inbox 返回裸 JSON 数组） | tools.ts:377-412；mailbox.ts:397-399 | 复用 peerenvelope 渲染器（报告 13 §7.3 建议 1 的队内版） |
| G-3a | 注入面全文直灌：信封/邮箱/快照三条路径无字符预算 | behavior-probe.json（5MB 信封、10MB 邮箱体）；prompt-submit.ts:57 | 引入接收方预算 pass（CC `gca` 等价）：总预算 + 从旧到新替换为截断标记 |
| G-3b | 截断无续读指引，无分页取回 | wake.ts:271-276 只加标记 | 截断标记附取回指令（CC 「ask the agent for the rest via SendMessage」等价：xc_message/xc_peer_send 定向索取或 xc_inbox_read 分页参数） |
| G-3c | `xc_check_inbox`/`xc_peer_inbox` 无分页参数（只有条数上限，一次消费即 ack） | tools.ts:377-412（即消费语义）；peer-tools.ts:1006-1008 | 分页需配套「读而不 ack」或「按 id 分页 ack」语义，避免分页破坏即消费语义 |
| G-3d | 入站 schema 无 max、入站四闸无大小闸 | tools.ts:105-135；peermsg.ts:350-367；admission 实测 | 增内容大小闸（入队拒 + `too_large` 回执已具备错误分类，frames.ts/pipe.ts 现成） |
| G-4a | 注册表无 model/上下文窗口字段 | types.ts:144-160、234-240 | TeamMember/NameBinding 增可选 model 字段；xc_member_add 已收 model 参数，落盘即可（member-tools.ts:69, 252-257） |
| G-4b | app-server 枚举的窗口信息有无：未确认 | appserver.ts:78-95（丢弃未知字段） | 一次 session/create 实测原始枚举 JSON（侦察遗留项，见 §7） |
| G-4c | 宿主模型目录非普遍可得 | 本会话 ListModels → `model_catalog_unavailable` | 预算机制必须有查不到 model 时的保守缺省（表驱动） |

---

## 7. 未确认项（如实标注）

1. **app-server 模型枚举是否携带上下文窗口字段**：`collectModelRefs`（appserver.ts:78-95）只保留三字段，原始 `settings.model.available[].ref` 的完整形状未实测（需起真实 app-server 做 session/create 抓全量 JSON）。
2. **「命令行场景下大输出曾卡死对话」的原始现场记录**：仓库内（evidence/14-release、15-live-debug、reports/15-用户现场诊断.md）未找到该现场的事故记录（pain-audit.md 的「卡死」指配置卡死，无关）；本报告以机制通道实测（§4.2）代替现场复现。
3. **宿主给插件 MCP server 注入的环境变量里有无模型信息**：server.ts 未读取任何 MODEL 类 env（`grep -rn "MODEL" plugin/src/mcp/server.ts` 仅命中 `@modelcontextprotocol/sdk` import）——按代码不存在，但宿主是否**会**注入未在文档记载（docs/PLATFORM.md 无此变量，未实测）。

---

## 8. 本次侦察的实测命令清单

| 命令 | 结果 |
|---|---|
| `cd plugin && npx vitest run` | 38 files / 544 tests passed（v0.4.0 基线全绿） |
| `grep -rn "leadKey" plugin/src --include="*.ts"`（排除测试） | 写入点仅 lead-tools.ts:167、member-tools.ts:240 |
| `python` 解析 `evidence/12-v030/acceptance/phaseD/ws/a/.crosschat/teams/default/team.json` | leadKey=panel-lead、member 无 model 字段 |
| 行为探针（`evidence/16-v050/recon/_scripts/recon-check.ts`，esbuild bundle 后 node 执行，输出 `recon/behavior-probe.json`） | 5MB 信封零截断；wake 4000 截断生效；10×1MB 邮箱体零截断；1MB/8MB 入闸放行；2MB 帧被 1 MiB 行闸拒绝 |
| `npx esbuild` 版本 | esbuild 0.25.x（本仓库 devDependencies） |
