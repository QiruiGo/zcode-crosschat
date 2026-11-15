# PROTOCOL：zcode-crosschat 协议细则（v0.7.0）

> 本文是协议细节的唯一下沉处（主 README 只作导航，不复制正文）。
> 除特别注明外，路径与常量以 `plugin/src/core/paths.ts`、`peerdir.ts`、`budget.ts`、
> `mailbox.ts`、`types.ts`、`stall.ts`、`capacity.ts`、`archive.ts` 为准。

## 1. 状态根与磁盘布局

### 1.1 队内轴（工作区级）

状态根 = `<工作区>/.crosschat/`（`STATE_DIR_NAME`；MCP server 的 cwd 即 `ZCODE_PROJECT_DIR`）：

```
<workspace>/.crosschat/
├── registry/sessions/<sessionId>.json   ← 会话基记录（钩子写；权限档类真源）
├── registry/names.json                  ← 花名 → 绑定（含 formerNames 别名）
├── registry/wake/<nonce>.json           ← 唤醒票据
├── teams/<teamId>/team.json             ← 任务/成员/lead 真源（原子写 + .bak 镜像）
├── teams/<teamId>/team.json.bak         ← last-known-good 镜像（真源损坏时自愈源）
├── teams/<teamId>/team.json.corrupt     ← 损坏现场保全件
├── teams/<teamId>/inbox/<agentKey>.jsonl← 成员邮箱（append-only JSONL）
├── teams/<teamId>/snapshot.json         ← 观测快照（派生，可重建）
├── toolrequests/<requestId>.json        ← v0.7 C6 转办台账（发送时建，状态机真源）
├── approvals/<requestId>.json           ← v0.7 C7 审批授权文件（用户/lead 落盘；授权锚点）
├── tasks/<taskId>/journal.md            ← 任务日志（成员用文件工具写；xc_read journal scope 读）
├── archive/<name>/journal.md            ← 成员留档日志（C4；member-stop archive 时写）
├── archive/<name>/meta.json             ← 留档元数据
├── capacity/sample.json                 ← 内存采样缓存（惰性采样，无定时器）
├── locks/<name>.lock                    ← 跨进程锁（registry → team 固定加锁序）
└── logs/engine.jsonl | wake-<to>-<ts>.json
```

v0.6 起 inbox 侧不再有 `.jsonl.int` 哈希链 sidecar（防磁盘篡改机制已砍；存量 sidecar 成为无害孤儿，不再读写）。

### 1.2 跨会话 peer 轴（机器全局）

peer 根目录解析优先级（`peerdir.ts`）：`XC_MESSAGING_DIR` > `${ZCODE_PLUGIN_DATA}/peers` > `~/.zcode/cli/plugins/data/zcode-crosschat@dev-zcode-crosschat/peers`：

```
${ZCODE_PLUGIN_DATA}/peers/
├── sessions/<pid>.json              ← peer 注册记录（文件名即 pid）
├── keys/<pid>.<sha256(sock)>.key    ← 传输令牌发布文件
├── base/<sessionId>.json            ← 钩子写的会话基记录（档类真源）
├── inbox/<sessionId>.jsonl          ← 传输级收件箱（退化投递目标）
├── queue/<sessionId>.jsonl          ← 投递级队列（过闸后，模型可见）
├── held/<sessionId>/<msgId>.json    ← hold 隔离区
├── uservoice/<sid>.json             ← 钩子写的用户原话记录（盖章链）
├── messages/<msgId>.json            ← 消息全文 store（接收入队即幂等落盘）
└── logs/peer.jsonl                  ← 跨会话域审计
```

命名管道是传输真源（`transport/pipe.ts`）；队列/文件是投递与持久化面。

## 2. 邮箱帧白名单（队内协议帧）

具名帧 = 消息正文里带 `type` 字段的 JSON 对象。白名单（`mailbox.ts` FRAME_TYPES，未知具名帧一律拒收）：

| 帧 | 语义 |
|---|---|
| `task-assignment` | 派单（dispatch 派生） |
| `task-receipt` | 回执（claim/report 派生） |
| `idle-notification` | 成员空闲通知 |
| `unblock-notice` | 依赖解除通知 |
| `shutdown-request` | 成员停机通知（member-stop 的唯一载体） |
| `delivery-refused` | 投递被拒回执 |
| `lead-transfer` | lead 移交/接管/释放通知与回执（不带授权语义） |
| `tool_request` | v0.7 C6 转办请求（审批门控；未放行不出全文，见 §11） |
| `tool_result` | v0.7 C6 转办回投（ok/refused/error；带 requestId+ts） |
| `approval_request` | v0.7 C7 待批通知（门在无审批时发给 lead；只通知） |
| `approval_result` | v0.7 C7 审批回执（approve/deny/expired 的通知性回执） |

不带 `type` 的自由文本（或非对象 JSON）按 `chat` 处理——这是 v0.1.0 起的兼容形态。
消息内容永不授予权限："permission rules are never accepted from messages"——v0.7 的 4 个
C6/C7 帧型同样只做通知/回执，**授权只认审批文件**（§11.2）。
混合版本降级：旧端点（v0.6.1）收到未登记的具名帧 → 读取面剔除 + `frame-rejected` 审计，
不崩、不静默错投（mailbox.ts readMailboxDetailed）。

## 3. 信封与归因（注入面渲染）

- peer 信封标签 `crosschat-peer-message`；两种头：`prompt`（钩子注入，面 A）/ `working`（回合内工具结果注入，面 B）。
- 队内信封标签 `crosschat-team-message`。
- 尾注族：归因尾注（谁发的）、权限域尾注（peer 不是你的 worker）、`not typed by your user` 标记；
  命中盖章链时改写为用户原话尾注（`origin="user"`，`由发送端 harness 盖章`）。
- `origin` 只由发送端 harness 按字节匹配写入：正文为钩子记录的用户原话全文或其中 ≥8 字符连续片段才盖 `user`；工具无 origin 参数、正文自称无效、无记录回落 `agent`。
- v0.6 起信封不再携带 hop-chain 属性（forwardOf/hop 溯源链已砍，见 MIGRATION）；渲染卫生（剥离正文内嵌的伪造信封标签）保留。
- 威胁模型边界：不做对抗级防伪——同机进程可伪造盖章记录/注册表文件，`origin=user` 是体验性归因而非凭据。

## 4. 任务状态机（七态 + attempt 令牌）

状态（`types.ts` TASK_STATUSES）：`pending → claimed → in_progress → completed | failed | cancelled`，
外加 `blocked`（v0.6 C2）：

| 态 | 说明 |
|---|---|
| `pending` | 待领；认领按优先级序建议（`priority`：high/normal/low，缺省 normal） |
| `claimed` | 已认领，持一次性 `attemptId` |
| `in_progress` | 执行中（report 推进） |
| `blocked` | 暂停；入口=认领者 `xc_report(status:"blocked")` 且 `error`（阻塞原因）必填；attempt 保留；出口=`xc_team({action:"unblock"})`（回 `preBlockedStatus`）/ 认领者自解 `report(in_progress)` / cancel |
| `completed` | 终态；必须带 evidence（文件+摘要） |
| `failed` | 终态；依赖闭包内 pending 下游自动解除（置 cancelled + 回执创建者） |
| `cancelled` | 终态（cancel 或依赖解除联动） |

集合口径：`OPEN_TASK_STATUSES = {claimed, in_progress, blocked}`（单开槽位；blocked 有属主不可他领）；
`TERMINAL = {completed, failed, cancelled}`；`SWEEPABLE = {claimed, in_progress}`——**blocked 不进僵尸清扫**（合法暂停不得被误回收）。
attempt 令牌：claim 时铸造一次性 attemptId，report 不匹配即硬拒；接管/停机经 `revokeAttempt` 回池并回执创建者。
`priority` 只影响呈现与取单建议顺序，**不做抢占**——claim 始终是显式 taskId。

## 5. 停滞检测（C5）与容量水位（C3）

- 停滞：`lastProgress` 超 `XC_STALL_MINUTES`（缺省 120 分钟）的任务在 `xc_overview` 标 `stalled` 并附建议（催/转交/取消）。
- 容量采样（无定时器，仅在 `xc_overview`/`xc_doctor` 调用时惰性采样，缓存 `capacity/sample.json`，最小间隔 `XC_MEM_SAMPLE_MIN_MS` 缺省 60s）：
  设备水位 `os.totalmem/freemem` + ZCode 进程树 working set（CIM 采样）。
- 预警规则：可用内存 < `XC_MEM_WARN_WATERMARK`（缺省 0.15）或单会话 working set > `XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）时 overview 标红并给出 violated 规则明细；CIM 不可用时降级为只报 os 水位 + `degraded:"cim-unavailable"`，进程类数据不虚报。
- 压缩联动（C9，**建议级非拦截级**）：verdict 标红时 `formatCapacityLines` 追加固定 `compress-advice` 建议行——先按 longtask checklist 落 journal（`.crosschat/tasks/<taskId>/journal.md`）再接受压缩；lead 可 `xc_relay` 要求目标先 `xc_report(status:"in_progress")` 附 journal 路径。平台无宿主压缩钩子接口，插件**不能拦截或触发压缩**，只做「预警 + 建议 + 落盘副本」最小闭环；team/panel 两视图都经 `capacityMount`，改一处两处生效。

## 6. 跨会话投递回执六态

`xc_relay` 对 peer 轴的投递回执（`PeerReceipt`）：`delivered | held | denied | refused | dropped | expired`。
非送达终态（dropped/expired/refused/denied）在摘要行如实改口为「未投递」并附原因与恢复动作——不自称「已投递」。
`held` 件进隔离区待 `xc_review({axis:"peer"})` 放行；`expired` 为 hold 超 `XC_HOLD_TTL_MS`（缺省 12h）到期。

## 7. urgent 优先队列（C1）

`xc_relay({urgent:true})`：消息在目标一切读取面排所有未读之前（队内邮箱与 peer 队列同一规则），
并尽力推送一次 wake。`interrupt:true` 请求打断目标当前回合——宿主 wire 无中断原语（E1 实测），
**平台限制下降级为 urgent + 下一回合必读**，payload 以 `interrupt:{requested:true,result:"deferred-next-turn",reason}` 如实回报。
离线目标由 wake 回合响应并复述 urgent 标记。

## 8. 注入预算公式（防卡死）

磁盘真源永远全文；注入面按**接收方声明**的上下文预算自适应截断（`budget.ts`）：

```
scale = clamp(contextChars / 200000, 0.25, 4)          # XC_CONTEXT_CHARS，非法/未设=200000
item  = clamp(4000  × scale, 1000, 16000)              # 单条基准；XC_INJECT_ITEM_CHARS 可覆盖
total = clamp(16000 × scale, 4000, 64000)，且 total ≥ item  # 批次基准；XC_INJECT_TOTAL_CHARS 可覆盖
```

分页读取单次上限 `READ_PAGE_MAX_CHARS = 64000`。被截内容一律带指针（`xc_read` 对应 scope 取全文/分页），
窗口外消息保持未读或留在队列，绝不做「已省略」占位省略。成员/peer 可在 identify 时用 `contextChars` 逐会话覆盖声明值。

## 9. 配置 env 全表

以下环境变量由插件 manifest 从用户设置注入 MCP server 进程（`plugin/.zcode-plugin/plugin.json` mcpServers.crosschat.env）；`XC_*` 亦可直接设在环境里（隔离测试/演练用）。

| env | 来源设置 | 缺省 | 说明 |
|---|---|---|---|
| `XC_WAKE_ENABLED` | `wake_enabled` | `false` | 推送唤醒总开关（无人值守时无头回合唤醒目标；失败回落邮箱投递） |
| `XC_ZCODE_EXE` | `zcode_exe` | 空 | zcode 可执行文件绝对路径；空=自动探测，显式配置后严格校验不回落 |
| `XC_ZCODE_CJS` | `zcode_cjs` | 空 | CLI 入口脚本；空时从 `zcode_exe` 同目录推导 |
| `XC_MAX_MEMBERS` | `max_members` | `8` | 活成员上限（lead/failed/removed 不计） |
| `XC_MEMBER_MODEL` | `member_model` | 空 | 成员模型 id；空=引擎枚举表选第一个 |
| `XC_MEMBER_PROVIDER` | `member_provider` | 空 | 成员模型 providerId |
| `XC_MEMBER_REASONING` | `member_reasoning` | `max` | 成员推理档位 |
| `XC_MEMBER_BOOTSTRAP_TIMEOUT_MS` | `member_bootstrap_timeout_ms` | `300000` | 建员等待欢迎回合上限（ms） |
| `XC_INBOUND_MODE` | `inbound_mode` | `accept` | 队内自由消息入站裁决：accept/hold/refuse（协议帧不受影响） |
| `XC_STALE_TASK_MINUTES` | `stale_task_minutes` | `30` | 僵尸任务清扫阈值（分钟；blocked 不在清扫域） |
| `XC_CROSSCHAT_INBOUND` | `cross_session_inbound` | 空 | peer 入站用户层：accept/hold/refuse；与项目层/会话层取最严，三显式层都未设走 mode-parity 自动档，非法值按 hold |
| `XC_PEER_RECEIVE` | `peer_receive` | `on` | peer 接收 kill-switch；`off` 一律拒收 |
| `XC_HOLD_TTL_MS` | `hold_ttl_ms` | `43200000`（12h） | hold 件存活时长，到期回执 `expired` |
| `XC_MESSAGING_DIR` | `messaging_dir` | 空 | peer 注册表根目录覆盖（绝对路径） |
| `XC_PEER_MAX_QUEUE_DEPTH` | `peer_max_queue_depth` | `0`（=1024） | 单会话 peer 待投递队列深度上限；超限投递被丢弃并回执 `dropped` |
| `XC_CONTEXT_CHARS` | `context_chars` | `0`（=200000） | 注入预算刻度（声明值） |
| `XC_INJECT_ITEM_CHARS` | `inject_item_chars` | 空 | 单条预算覆盖（0/非法=自动） |
| `XC_INJECT_TOTAL_CHARS` | `inject_total_chars` | 空 | 批次预算覆盖（0/非法=自动） |
| `XC_USERVOICE_TTL_MS` | `uservoice_ttl_ms` | `600000`（10min） | 盖章链匹配窗口；每条原话 ≤3 次 |

仅代码读取、无用户设置项的演练 env：`XC_STALL_MINUTES`（停滞阈值，缺省 120）、`XC_MEM_WARN_WATERMARK`（缺省 0.15）、`XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）、`XC_MEM_SAMPLE_MIN_MS`（缺省 60000）、`XC_TOOL_REQUEST_TTL_MS`（v0.7 C6 转办请求缺省有效期，缺省 3600000=1h，硬上限 86400000=24h）、`XC_OFFLINE_MINUTES`（v0.7 C8 离线判定空闲阈值，缺省 240min；低于 `XC_STALE_TASK_MINUTES` 时按 stale 钳制并附 WARNING——见 §12）。均为高级 env，不进插件设置面。

## 10. 身份与安全底线（v0.6 口径）

- 注册 = `xc_identify(name, sessionId)`：两轴合一（队内 + peer）。`sessionId` 取钩子注入值，不要编造。
- regToken 硬闸已砍（个人/内部场景无恶意进程模型）：sid 存在性 + 活性软校验；**同名冲突显式拒**（`name_taken`）保留。
- 成员崩溃后接管：无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；
  `xc_identify({takeover:true})` 立即换绑并回池其未完任务（受在途唤醒活信号闸保护：15min 内有在途回合 → `takeover_inflight` 拒绝）。
- 证据门（v0.6）：evidence = 文件 + 摘要；文件必须真实存在且位于工作区内（`evidence_path_outside_workspace` / `evidence_file_missing` 硬拒）；**sha256 复核已砍**（旧参忽略并披露）。
- 底线三不：不崩（大帧守卫/截断有界）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚 = 连接 extra 的 connectionKey，别名路径透传不变）。

## 11. C6 转办授权与 C7 审批（v0.7）

> 依据：E2（MCP 四级来源——「B 缺 MCP」默认是放置问题，转办只做宿主注入类）、
> E4（最小链路实测：5 requestId / 18 无头回合；R1 帧型加白 / R2 门下沉 / R6 唤醒环境）。
> 载体纪律：C6 帧骑 `xc_relay`（队内轴），C7 入口并入 `xc_review`——**0 新增工具**。

### 11.1 帧格式（`xc_relay` 的 msg，JSON 字符串，`type` 键）

```
tool_request  = {"type":"tool_request","requestId","from","tool","args","reason",
                 "approval":{"required":true,"file"?,"ttlMs"?},"maxResultChars"?}
tool_result   = {"type":"tool_result","requestId","status":"ok|refused|error","tool",
                 "result"|"error"|"reason","ts"}
approval_request = {"type":"approval_request","requestId","from","tool","reason","expiresAt","approveHow"}
approval_result  = {"type":"approval_result","requestId","decision":"approved|denied|expired","decidedBy","decidedAt","expiresAt"?}
```

- `requestId`：uuid 形态的安全路径段（`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）；同时是台账文件名
  （`toolrequests/<requestId>.json`）与审批文件名（`approvals/<requestId>.json`）——天然可检索。
  重复占用即拒（`requestId_in_use`）。
- `from`：必须 === 发送连接身份（请求方）；`tool_result.from` 必须 === 台账的 `to`（执行方）——
  伪造回投在 relay 核心拒收（审计 `tool-result-rejected`，不落箱不终填）。
- `args`：对象，序列化 ≤ 64KB（`TOOL_REQUEST_MAX_ARGS_CHARS`）；超限发送侧即拒 `args_too_large`。
- `reason`：必填，进审计。`maxResultChars`：缺省/上限 64_000（= `READ_PAGE_MAX_CHARS`）。
- `ttlMs`：缺省 3_600_000（env `XC_TOOL_REQUEST_TTL_MS` 可改缺省），硬上限 86_400_000。
- `tool_result.ts`：回投时刻（由插件侧落章）；resumed 会话的记忆污染由接收方以邮箱原文 +
  requestId + ts 自判新旧（R7）。

**wake 投递禁令**：`tool_request` 一律不唤醒投递（relay 核心强制 `delivered:"mailbox"`，
payload 标注 `wake:"suppressed (approval-gate bypass guard)"`）。理由：wake prompt 正文由
调用方 ticket 原样携带（`engine/wake.ts` bodyText=req.ticket），任何 wake 投递都把请求全文
带进 prompt——与 urgent 无关，只禁 urgent 挡不住。urgent=true 仍允许（仅排序与回执标注）。
**uservoice 豁免**：4 个 C6/C7 帧型跳过 `origin=user` 盖章（机器帧不应有用户亲述语义；E4 §7.3
实测 relay 同文即盖章）。**入站策略豁免**：C6/C7 帧免 `XC_INBOUND_MODE` hold/refuse
（「协议帧不受影响」口径；转办的控制点是审批门）。**peer 轴不收**：4 帧型只走队内轴
（审批门/台账以队内状态根为锚；peer 轴转办未验，E4 §9.3）。

### 11.2 审批文件（授权锚点）与台账（状态机）

- 授权文件 `.crosschat/approvals/<requestId>.json`：
  `{requestId, decision:"approved"|"denied", approvedBy, decidedAt, expiresAt, tool, note?}`。
  **谁批准**：用户或 lead（文件轨直接落盘；工具轨 `xc_review({action:"approve",axis:"approval",id})`
  由插件代写同格式）。请求方（from）与执行方（to）均不能自批（`self-approval refused`；
  lead 恰为双方时也只能走文件轨）。**批多久**：`expiresAt` 必须 > now 且 ≤ 请求 expiresAt
  （批准窗不超出请求窗）。**工具绑定**：`tool` 与请求逐字节相等（`approval tool mismatch`）；
  不设全局禁用品清单（逐请求审批 + reason 必填 + 反洗白纪律承担 R3 缓解）。
- 台账 `.crosschat/toolrequests/<requestId>.json`：状态机
  `pending → approved｜denied｜refused → executed｜error｜expired`（`refused`=门自动拒，
  `denied`=审批文件显式拒绝；显式批准可从 refused/denied 转入——后者写者胜）。
- 失败路径全表（§2.6）：A 不在线→入箱异步等 + sweeper 过期回投；A 不存在→`target_not_found`；
  工具不存在→平台错误原样回投 `status:"error"`；审批缺失/过期/畸形/denied/工具不符/自批→
  门拒 + 对应 reason（`approval missing` / `approval expired` /
  `approval file malformed (unparseable JSON)` / `approval denied` / `approval tool mismatch` /
  `self-approval refused`）；args 超限→`args_too_large`；result 超限→`result_too_large`；
  伪造回投→`tool-result-rejected`。

### 11.3 审批门（读取面单点生效；inbox + mail 双路）

`xc_read({scope:"inbox"})` 与 `xc_read({scope:"mail"})` 都先过共享渲染门
（`core/toolgate.ts` gateToolRequestRender）——v0.6.1 的 mail 路直出原始帧全文（无门），
v0.7 修掉该原文旁路：

- **拒**（台账缺失/目标不符/请求过期/denied/refused/expired/审批校验失败，fail-closed）：
  首次拒绝（pending→refused 迁移）由插件侧回投请求方 `tool_result{refused,reason}` +
  台账 refused + 审计 `tool-decision`；无审批时另向 lead 发一条 `approval_request` 待批通知
  （一次性，`approvalNotifiedAt` 记档）。两个读取面都只出遮蔽占位
  （`[gated tool_request <id>: state=<state> —— 未放行，正文不可见（<reason>）]`）；
  inbox 路的请求帧标记 discarded（不进注入面）。
- **放**（approved/executed/error）：输出 `[CrossChat APPROVAL VERIFIED …]` 头 + 全文；
  pending 态持有效审批文件的，门放行时把台账记 approved（门放行≥1 次）。
- 门只对 `type:"tool_request"` 生效；其他帧/chat 早返回原路径（零影响）。

### 11.4 预算、审计与清理

- args ≤ 64KB；result ≤ 请求 `maxResultChars`（A 侧主动截断时在帧内标 `resultTruncated{shown,total}`，
  模型改投摘要+文件指针）；协议硬顶 MCP stdio 单帧 32MiB（-32700 显式拒收）不改。
- 注入面复用现有预算（item 4000/total 16000 基准，§8）：获批全文超限时截断 + 尾注指针，
  `xc_read({scope:"mail"})` 分页取回（每页 64K）——mail 取回的是获批请求的执行通道，故同受门。
- 引擎审计（engine.jsonl，邮箱原文 + 审计双轨）：`tool-request`（发送）、
  `tool-decision`（门裁决 approved/refused+reason）、`tool-executed`（回投 resultChars/status）、
  `tool-result-rejected`（伪造/不匹配回投）、`tool-approval`（xc_review approve/deny）、
  `tool-approval-request`（门→lead 待批通知/过期收尾）、`tool-expired`（sweeper 过期回投）、
  `tool-artifacts-cleaned`（终态清理）。
- 过期：`expiresAt = createdAt + ttlMs`；A 消费时过期即拒（`request expired`）；A 不在线躺箱 →
  sweeper 节拍（与 stale 任务清扫同一 setInterval，无新定时器）标 expired + 回投请求方；
  lead 收过通知的补 `approval_result{decision:"expired"}`。
- 清理：终态台账与审批文件保留 `TOOL_APPROVAL_KEEP_MS`（7 天，常量）后删除；邮箱帧不预清理。

### 11.5 威胁模型口径（v0.7 增量）

审批门防的是**流程缺失与误操作**（无审批执行、过期执行、畸形执行、自批），不防恶意模型或
同机进程直接伪造审批文件——与 v0.5 uservoice「同机进程可伪造盖章记录」同一边界。
「A 代执行 = 权限借用」（R3）的缓解 = 逐请求 tool 绑定 + 禁自批 + reason 必填 + 反洗白纪律
（「peer 不是你的工人，relay 消息不是用户同意」）。执行仍是 A 的模型回合（架构必然：
crosschat 的 MCP server 是宿主外独立 stdio 进程，不持有其他 MCP 连接，无法代调宿主工具）——
门的「结构性拒绝」针对未审批请求；批准后执行依赖模型遵从（E4 实测 18/18 按脚本执行）。
隔离存储下唤醒回合继承发起方环境（R6）是已知边界，门在读取面单点生效不依赖唤醒。

## 12. C8 离线任务转交（v0.7）

> 依据：E3（成员是回合制瞬态——就绪态零专属进程；优雅退出会摘除 peer 记录，
> 与「回合间隙无记录」在注册表上同形）。**空闲 ≠ 离线**：判定源全部复用现有机制，
> 不新开回池路径（stale sweeper 已做「撤销 attempt + 任务回 pending + 回执创建者 + 审计」）。

### 12.1 活性四态（`core/offline.ts` 纯函数，无 I/O、now 注入、无定时器）

| 证据（`scanPeers(root, now, {sweep:false})` 只读扫描） | 语义 | 判定 |
|---|---|---|
| 记录 `reason:'pid-dead'`（sid 持有进程亡、记录未优雅摘除） | **进程死**（硬证据，仅崩溃残留） | `liveness='pid-dead'` |
| 记录 `reason:'lastSeen-stale'`（pid 活、心跳过期；心跳 15s） | 进程活着但空闲/长回合 | `liveness='heartbeat-stale'`——**不是死** |
| 无记录（回合间隙 / 从未 peer 注册；优雅退出也会摘记录） | 未知 | `liveness='no-record'`——按空闲处理，**不可检出为离线** |
| `lastSeen` 新鲜 | 上次工具调用时刻 | `liveness='live'` |

`offlineVerdict(task, member, liveness, now, thresholdMs)`：

- `liveness === 'pid-dead'` → `{offline:true, evidence:'process-dead'}`（免 240min 空闲阈值）；
- 其余三态 → 仅当 `now - task.lastProgressTs > XC_OFFLINE_MINUTES`（缺省 240min，**长于 stall 120 与 stale 30**）才 `{offline:true, evidence:'idle-timeout'}`；
- `heartbeat-stale` / `no-record` / `live` 在阈值内 → `{offline:false, evidence:null}`（**活着但空闲不判离线**）；
- `member.state === 'removed'` → 直接 `{offline:false, evidence:null}`（已停机成员不参与离线判定）。

### 12.2 可达性如实声明

- **优雅退出与空闲在注册表上同形**（pipe.ts 优雅退出摘记录）——「用户主动关闭的会话」检不出离线，
  可检出的进程死只有崩溃残留。故 C8 的 lead 通知实际覆盖「成员崩溃」而非「成员主动离开」；
  主动离开靠 stale 回池 + createdBy 回执既有链路兜底。
- **idle-timeout 分支窄可达**：`updatedAt ≥ lastProgressTs`，满足 240min 空闲的任务必已被 30min stale
  先回收（sweeper 常驻）——idle-timeout 只在「全员静默 ≥240min 后某会话重启触发首轮清扫」时命中，
  是兜底而非常规路径。**升级信号实际由 process-dead 证据产生。**
- 30 < 240 保证 stale 先动，C8 永不抢先、与 stale 无双闸竞态；豁免条件（在途 wake nonce）不动。

### 12.3 增量落点（复用 sweeper，无新闸）

1. sweeper 内对被扫任务算 `offlineVerdict`；`process-dead` 或 idle-timeout 命中的，除 createdBy 回执外
   **额外通知 lead**（邮箱消息 + 同一 wakePlan 机制），消息体带转交建议（lead 用 `xc_dispatch` 重派——
   现有能力组合，不新增工具/动作）；
2. `TaskEdgeOutcome` 增 `offline: OfflineMember[]`（进 `xc_report` 工具 payload 与 `task-offline` 审计事件）；
3. `xc_overview` team 视图挂 `offlineMembers` 块 + 文本行（`offline: <名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)`）；
   阈值被钳制时挂 `offlineThresholdClamped` + WARNING。
4. 并发安全：全部裁决在 `withTeamLock` 内；peer 扫描在锁外只读做。
