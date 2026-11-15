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

v0.7.1（故障注-2 修复）：`registry/names.json` 不可解析/形状非法时，读写方抛**带文件绝对路径 + 恢复动作**的显式诊断（与 team.json 损坏文案同族）——`invalid names.json "<path>": <原因> — it is a rebuildable index: delete the file to reset (name bindings re-establish on the next xc_identify / xc_team member-add), or restore it from a backup`。names.json 是**可重建索引**（删文件即重置，会话记录里的 boundName 兼容兜底不受影响），不再裸抛 JSON token 错让运维猜。

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
| `completed` | 终态；必须带 evidence（工作区内普通文件 + 现算 sha256 + 可选摘要） |
| `failed` | 终态；依赖闭包内 pending 下游自动解除（置 cancelled + 回执创建者） |
| `cancelled` | 终态（cancel 或依赖解除联动） |

集合口径：`OPEN_TASK_STATUSES = {claimed, in_progress, blocked}`（单开槽位；blocked 有属主不可他领）；
`TERMINAL = {completed, failed, cancelled}`；`SWEEPABLE = {claimed, in_progress}`——**blocked 不进僵尸清扫**（合法暂停不得被误回收）。
attempt 令牌：claim 时铸造一次性 attemptId，report 不匹配即硬拒；接管/停机经 `revokeAttempt` 回池并回执创建者。
`priority` 只影响呈现与取单建议顺序，**不做抢占**——claim 始终是显式 taskId。

### 4.1 证据门（`xc_report` 的 `evidence`，v0.7.1 边界-7/边界-8）

每条证据 = 工作区内一个**真实普通文件** + 工具现算的 sha256 + 可选一句话摘要。三道硬闸（整单拒绝，真源不动、终态回执不发）：

| 条件 | 错误码 |
|---|---|
| resolve 后路径越出工作区（`../` 穿越、绝对路径、同前缀兄弟目录） | `evidence_path_outside_workspace` |
| 不是普通文件（目录 / 设备文件 / 套接字） | `evidence_not_a_file` |
| 不存在或不可读 | `evidence_file_missing` |

sha256：**可省略**（省略或显式 `null` = 未声明，工具现算后落库，回执随带）；**带了就必须与文件内容一致**（hex 大小写不敏感、首尾空白忽略），否则 `evidence_checksum_mismatch`（payload 带 `claimed`/`computed`）。报告回执 payload 以 `evidenceSha256:[{path,sha256}]` 披露现算值——DEMO §2 的「读回执 → 与文件核对一致」按此完成。
`note`：**可选**，省略按空串入库；控制字符（C0/DEL）入库前一律清洗为空格，长度钳 500 字符。

### 4.2 重复派发幂等键（v0.7.1 规模压-B3）

`xc_dispatch` 的去重键（单一事实源 `dispatchDedupKey`，`mcp/tools-tasks.ts`）：

```
duplicateKey = (to 成员键, 任务票文本) ∧ 该派发信封未被读过(readAt 缺省) ∧ isCurrentMail(team, m)
```

- **不含发送方**：两个会话把同一张票派给同一收方，第二个不再建单，返回既有 `taskId` + `delivered:"duplicate"`。
- **不含 taskId / attempt 快照**：新 taskId 不可预知；发送方当前在途任务的快照只作 `source*` 字段透传，不进键。
- 回执披露 `duplicateKey`（`to=<收方>|ticket=<票面 sha256 前 16 hex>`）与 `originalCreatedBy`（首派方，命中他人派单时据此看出「这一单已经有人派过」）。
- 收方已读走旧票、或票面（标题/内容/验收标准）不同 → 建新单。

### 4.3 派单目标生命周期闸（v0.7.2 C8-B3 修复）

`xc_dispatch` 的 `to` 除会籍存在性（`not_a_member`）外，还过一道**生命周期**闸：目标成员 `state === 'removed'`（`xc_team member-stop` 已留档 + 回池其开放任务）→ 显式拒绝 `member_removed`（**不建单、不投递**），payload/文案指引两条恢复动作（改派活成员 / lead 的 `xc_team member-add` 幂等重供给），并落 engine.jsonl `dispatch-refused` 审计。理由：removed 成员的 pending 派单会永久搁浅——他人 claim 得 `not_assignee`、停机成员自身无法认领、pending 不在 `SWEEPABLE` 清扫域、创建者无任何回执（红队 c8b3 实测）。`provisioning`/`failed`/`ready` 目标不受本闸影响（fail-closed 只针对已停机）。

## 5. 停滞检测（C5）与容量水位（C3）

- 停滞：`lastProgress` 超 `XC_STALL_MINUTES`（缺省 120 分钟）的任务在 `xc_overview` 标 `stalled` 并附建议（催/转交/取消）。
- 容量采样（无定时器，仅在 `xc_overview`/`xc_doctor` 调用时惰性采样，缓存 `capacity/sample.json`，最小间隔 `XC_MEM_SAMPLE_MIN_MS` 缺省 60s）：
  设备水位 `os.totalmem/freemem` + ZCode 进程树 working set（CIM 采样）。窗口期内回缓存，但缓存样本的**设备水位字段与 `os.freemem()` 实时交叉复核**（一次系统调用）——缓存只省进程树（CIM）采样成本，不为伪造/陈新缓存制造最长一个窗口（缺省 60s）的虚假读数（v0.7.2 修复）。
- 预警规则（三条，任一命中即标红，`violated` 逐条给出明细）：
  1. `watermark`：可用内存 < `XC_MEM_WARN_WATERMARK`（缺省 0.15）；
  2. `session-limit`：headless 回合树单进程 working set > `XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）；
  3. `turn-concurrency`：并发 headless 回合数 × `XC_TURN_ESTIMATE_BYTES`（单回合瞬时占用预估，缺省 1.5GB）> 当前可用内存（建议减少并发回合或让成员休眠）。
  CIM 不可用时降级为只报 os 水位 + `degraded:"cim-unavailable"`，进程类规则（2/3）无数据不评、不虚报。
- 压缩联动（C9，**建议级非拦截级**）：verdict 标红时 `formatCapacityLines` 追加固定 `compress-advice` 建议行——先按 longtask checklist 落 journal（`.crosschat/tasks/<taskId>/journal.md`）再接受压缩；lead 可 `xc_relay` 要求目标先 `xc_report(status:"in_progress")` 附 journal 路径。平台无宿主压缩钩子接口，插件**不能拦截或触发压缩**，只做「预警 + 建议 + 落盘副本」最小闭环；team/panel 两视图都经 `capacityMount`，改一处两处生效。

### 5.1 建员 provisioning 超时（v0.7.1，故障注-1 修复）

超时判据**落盘**：`member-add` Phase 1 写 provisioning 记录时一并写 `provisionDeadlineAt = provisionedAt + XC_MEMBER_BOOTSTRAP_TIMEOUT_MS + 60s 宽限`（`core/teamstate.ts` 的 `provisionStaleAfterMs` 为单一事实源，与 §6.4 幂等重供给的停滞口径同值）。超时不再只存在于 lead MCP server 进程的内存里——server 中途死亡时成员不再永久卡 provisioning（旧形态：无回执、无审计、还占成员名额）。

清扫（两入口，都置 `state=failed` + error 并落审计 `member-provision-timeout`）：
- **工具面**：任一 `xc_team({action:"member-add"})` 的 Phase 1（团队锁内）清扫全部过期记录；同名重试随后干净接管（§6.4），成功载荷披露 `recovered:"provision-timeout"`。
- **钩子面**：任一存活会话的 UserPromptSubmit 回合（`hooks/shared.ts` 的 `sweepStaleProvisioning`，团队锁 2s 预算内 best-effort，锁忙跳过下回合再扫）。

存量记录（无 `provisionDeadlineAt` 字段）按 `provisionedAt/joinedAt + 同一口径`现算兜底；钩子进程无 userConfig env，用内置默认 300s + 60s 宽限（保守方向）。

## 6. 跨会话投递回执六态

`xc_relay` 对 peer 轴的投递回执（`PeerReceipt`）：`delivered | held | denied | refused | dropped | expired`。
非送达终态（dropped/expired/refused/denied）在摘要行如实改口为「未投递」并附原因与恢复动作——不自称「已投递」。
`held` 件进隔离区待 `xc_review({axis:"peer"})` 放行；`expired` 为 hold 超 `XC_HOLD_TTL_MS`（缺省 12h）到期。

**detail 透出（v0.7.1 规模压-B1）**：接收方在管道 `status` 帧里回的 `detail`（入队闸丢弃原因 + 恢复动作，`admissionDropDetail`）由 `xc_relay` 原样透进 payload `detail` 与摘要行（`未投递原因与恢复动作：…`），并写入 `peer-sent` / `relay-peer` 审计。四种丢弃原因的恢复动作：

| reason | 恢复动作 |
|---|---|
| `queue-full` | 收方待投递队列已达上限（`XC_PEER_MAX_QUEUE_DEPTH`，缺省 1024）——让收方 `xc_read({scope:"peer"})` 排空，或稍后重试 |
| `rate-limited` | 每发送方 30 条/10s 限速——放慢发送（约 5s 一条）后重试 |
| `duplicate` | 该 msgId 已在去重窗口内被接收——无需重试 |
| `loop-depth` | 转发链深度超限——不要继续转发这一条 |

读取面错误（v0.7.1，故障注-3 修复）：`xc_read({scope:"peer-msg"})` 查找落空时先分辨「从没收到」与「存储损坏」——`messages/<msgId>.json` 存在但不可解析/缺 text → 显式 `message_corrupt`（附文件路径 + 恢复动作：删/修该文件清障、重发得新 msgId；消息未消费时 queue/inbox/held 兜底仍可读回原文），不再把存储损坏误述成 `unknown msgId`（恢复路径阻断）。peer 审计落 `peer-msg-read-corrupt`。

坏行披露（v0.7.1，故障注-4 修复）：`xc_read({scope:"peer"})` 排空时跳过的队列坏行（不可解析/形状非法）随响应披露 `malformedLines` 计数（摘要行同步提示），与队内 inbox 的 `malformedLines`、held 审阅面的 `corrupted` 三方口径一致；peer 审计落 `peer-queue-malformed`。无坏行时不带该键（响应形状不变）。

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
| `XC_MAX_MEMBERS` | `max_members` | `8` | 活成员上限（lead/failed/removed 不计）。触顶报 `team_at_member_cap`，payload 分报 `activeMembers`（当前活成员数）与 `activeAfterAdd`（本次写入后） |
| `XC_MEMBER_MODEL` | `member_model` | 空 | 成员模型 id；空=引擎枚举表选第一个 |
| `XC_MEMBER_PROVIDER` | `member_provider` | 空 | 成员模型 providerId |
| `XC_MEMBER_REASONING` | `member_reasoning` | `max` | 成员推理档位 |
| `XC_MEMBER_BOOTSTRAP_TIMEOUT_MS` | `member_bootstrap_timeout_ms` | `300000` | 建员等待欢迎回合上限（ms）；超时判据随 provisioning 记录落盘（`provisionDeadlineAt`=本值+60s 宽限），lead server 中途死亡也由后续 member-add/钩子清扫为 failed——见 §5.1 |
| `XC_INBOUND_MODE` | `inbound_mode` | `accept` | 队内自由消息入站裁决：accept/hold/refuse（协议帧不受影响） |
| `XC_STALE_TASK_MINUTES` | `stale_task_minutes` | `30` | 僵尸任务清扫阈值（分钟；blocked 不在清扫域）。**`0`/负数/非数字一律回落缺省 30**（v0.7.1 边界-10 显式化）：既不是「立即清扫」（那会让所有在途任务瞬间回池），也不是「关闭清扫」（sweeper 照常按 30min 跑）——与 `XC_PEER_MAX_QUEUE_DEPTH` 的「0=内置值」同口径 |
| `XC_CROSSCHAT_INBOUND` | `cross_session_inbound` | 空 | peer 入站用户层：accept/hold/refuse；与项目层/会话层取最严，三显式层都未设走 mode-parity 自动档，非法值按 hold |
| `XC_PEER_RECEIVE` | `peer_receive` | `on` | peer 接收 kill-switch；`off` 一律拒收 |
| `XC_HOLD_TTL_MS` | `hold_ttl_ms` | `43200000`（12h） | hold 件存活时长，到期回执 `expired` |
| `XC_MESSAGING_DIR` | `messaging_dir` | 空 | peer 注册表根目录覆盖（绝对路径） |
| `XC_PEER_MAX_QUEUE_DEPTH` | `peer_max_queue_depth` | `0`（=1024） | 单会话 peer 待投递队列深度上限；超限投递被丢弃并回执 `dropped`（payload `detail` 带原因与恢复动作，见 §6） |
| `XC_CONTEXT_CHARS` | `context_chars` | `0`（=200000） | 注入预算刻度（声明值） |
| `XC_INJECT_ITEM_CHARS` | `inject_item_chars` | 空 | 单条预算覆盖（0/非法=自动） |
| `XC_INJECT_TOTAL_CHARS` | `inject_total_chars` | 空 | 批次预算覆盖（0/非法=自动） |
| `XC_USERVOICE_TTL_MS` | `uservoice_ttl_ms` | `600000`（10min） | 盖章链匹配窗口；每条原话 ≤3 次 |

仅代码读取、无用户设置项的演练 env：`XC_STALL_MINUTES`（停滞阈值，缺省 120）、`XC_MEM_WARN_WATERMARK`（缺省 0.15）、`XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）、`XC_TURN_ESTIMATE_BYTES`（并发 headless 回合单回合瞬时占用预估，缺省 1.5GB=1610612736 字节；>0 合法，非法/未设回落缺省——见 §5 预警规则 3）、`XC_MEM_SAMPLE_MIN_MS`（缺省 60000）、`XC_TOOL_REQUEST_TTL_MS`（v0.7 C6 转办请求缺省有效期，缺省 3600000=1h，硬上限 86400000=24h）、`XC_OFFLINE_MINUTES`（v0.7 C8 离线判定空闲阈值，缺省 240min；低于 `XC_STALE_TASK_MINUTES` 时按 stale 钳制并附 WARNING；v0.7.2 起 0/负数/非数字同样**不静默**——回落内置缺省 240min 并附 WARNING + payload `offlineThresholdFallback:true`，见 §12）。均为高级 env，不进插件设置面。

## 10. 身份与安全底线（v0.6 口径）

- 注册 = `xc_identify(name, sessionId)`：两轴合一（队内 + peer）。`sessionId` 取钩子注入值，不要编造。
- regToken 硬闸已砍（个人/内部场景无恶意进程模型）：sid 存在性 + 活性软校验；**同名冲突显式拒**（`name_taken`）保留。
- 成员崩溃后接管：无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；
  `xc_identify({takeover:true})` 立即换绑并回池其未完任务（受在途唤醒活信号闸保护：15min 内有在途回合 → `takeover_inflight` 拒绝）。
- 证据门（v0.7.1 边界-7/边界-8）：evidence = 工作区内**普通文件** + 现算 sha256 + 可选摘要；三道路径/形态门（`evidence_path_outside_workspace` / `evidence_not_a_file` / `evidence_file_missing`）+ sha256 复核（`evidence_checksum_mismatch`）；调用方声明的 sha256 必须与工具现算值一致，缺省则由工具现算后落库并随回执披露（详见 §4.1）。
- peers 视图寻址（v0.7.1 边界-9）：`[ref]`（= sessionId 末 8 位）只在**跨会话可寻址行**（self/session）上渲染，且照抄即可作地址（`to="名字 [ref]"`）；`member` 行是队内花名册的只读投影，**不渲染 `[ref]`**，队内寻址用裸名或 `名字 [team]` 后缀。
- **两轴操作的原子性**（v0.7.1 边界-4/边界-6）：`xc_identify` 的注册与改名都是「队内轴 + peer 轴」一次调用办两件事，任一轴失败都不留半边状态——
  - 注册：peer 轴失败（`name_taken` / `session_not_anchored` / 锁忙等）→ **队内轴回滚**（names.json 绑定、team.json 成员行、连接绑定全部撤销；本次新建的队伍连 team.json 一起撤），错误信封 `peer_axis_failed` 带 `teamAxis:{registered:false, rolledBack:true}`。调用方可以把错误当「无副作用」直接重试（精确对重绑幂等）。回滚自身失败时如实写 `registered:true, rolledBack:false` + `rollbackError`。
  - 改名：队内轴被「板面不干净」守卫阻止（名下任务引用/邮箱非空）→ **两轴都不改**，显式 `team_rename_blocked`（payload `renamed:{peer:false,team:false}`）；peer 轴改名失败（`name_taken`）→ 队内轴改名回滚到原键，同样不给「队内新名 + peer 旧名」的半个改名。
- **改名后 names.json 写新绑定**（v0.7.2 CB-01 修复）：队内花名换绑在 registry 锁内「解绑旧键 + **写新键绑定**（`{sessionId, role, registeredAt}`）」一次完成——v0.7.0~v0.7.1 只解绑旧名、新键从不写入，names.json 对该 sid 零绑定，而 SessionStart 钩子的「已注册花名」判定（`hooks/shared.ts boundNamesForSession`）就读 names.json，于是改名成功的会话下一轮钩子注入误报「尚未注册跨会话花名」（红队 capbug1 实测；功能路由不受影响、无冒名窗口，但观测面自相矛盾）。**冲突保护**：新键已被**别的 sid** 绑定（陈旧死绑定）时不覆盖——那属于接管语义（takeover/claim 路径），改名面不越权改别人的索引行；改名被守卫整体阻止时两键都不动。
- **同 sid 冲突的文案**（v0.7.1 并发与-1）：`session_id_in_use` 的 payload 增 `sameSessionId`。冲突对象持有**同一个** sessionId（同一会话被两个活进程重复拉起）时文案说清「两个活进程在争一个会话，停掉重复的那个」，不再误述 "another live session … use your own id"（败者用的正是自己的 id）；**异** sid 才是冒用场景，沿用 v0.5.2 起的原文案。
- 底线三不：不崩（大帧守卫/截断有界 + **畸形帧显式 -32700**，见 §13）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚 = 连接 extra 的 connectionKey，别名路径透传不变）。

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
  `denied`=审批文件显式拒绝；`refused` 亦含执行方回投 `status:"refused"` 的辞谢——一请求一结果，
  辞谢同样是终态；显式批准可从 refused/denied 转入——后者写者胜）。
- **写者胜（v0.7.2 修复 B-01 ≡ C7-B1）**：门在**任意台账状态**下都重读磁盘审批文件
  （`core/toolgate.ts`）。拒绝态（refused/denied）台账 + 合法批准文件 → 门放行并把台账迁回
  approved；文件轨与工具轨（`xc_review` 代写同格式）自此完全等价。两处不重读：请求窗已关闭
  （`now > expiresAt`——安全边界，批准窗不可能同时满足「> now」与「≤ 请求 expiresAt」）与已终态
  executed/error（回投已发生，请求帧照常带头全文）。
- **工具轨审批动作的边界**（v0.7.2 修复 C7-B6/C7-B7）：`xc_review({action:"approve"|"deny", axis:"approval"})`
  对**已终态**（executed/error/expired）台账显式拒绝 `request_already_finalized`——不写审批文件、不发
  `approval_result` 回执、不改台账（旧实现静默放弃台账迁移却照写文件照发回执并回报 ok）；可审批的
  台账态 = pending/approved/refused/denied（后者写者胜）。`xc_review({axis:"approval", action:"list"})`
  的**可批清单**只含「pending ∧ 无审批文件 ∧ 未过 `expiresAt`」的请求；已过 `expiresAt`、尚未被
  sweeper 标记 expired 的 pending **不进清单**（旧实现照列并附 `approveHow`，按建议 approve 只得到
  `approval_window_closed`——观测面误导），另以 `lapsedWindowClosed` 计数 + 说明行披露「批准窗已关，
  需请求方重发」。
- 失败路径全表（§2.6）：A 不在线→入箱异步等 + sweeper 过期回投；A 不存在→双轴解析未命中
  `target_not_found`（显式 `名字 [team]` 后缀指向非花名册成员则是队内闸的 `not_a_member`，
  两者都 fail-closed；v0.7.2 按实际行为校正本表文案）；
  工具不存在→平台错误原样回投 `status:"error"`；审批缺失/过期/畸形/denied/工具不符/自批→
  门拒 + 对应 reason（`approval missing` / `approval expired` /
  `approval file malformed (unparseable JSON | not a JSON object | invalid fields: <清单> | requestId mismatch)` /
  `approval denied` / `approval tool mismatch` /
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
- **写者胜（v0.7.2）**：拒绝态（denied/refused/expired）复读前也重读磁盘审批文件——持有效
  批准文件即放行并把台账迁回 approved（审计 `tool-decision approved` 附 `revivedFrom`）；
  无文件或文件非法则沿用历史理由继续遮蔽（fail-closed 不变）。自批守卫按成员键归一化
  （`approvedBy:"REQB"` 与 `reqb` 同等拒绝，`core/sanitize.ts` 同一条清洗链）。
- 门只对 `type:"tool_request"` 生效；其他帧/chat 早返回原路径（零影响）。

### 11.4 预算、审计与清理

- args ≤ 64KB；result ≤ 请求 `maxResultChars`（**按有效载荷计**：字符串取自身长度、非字符串取
  序列化长度——v0.7.2 修复 B-03，不再把 JSON 引号算进载荷；A 侧主动截断时在帧内标
  `resultTruncated{shown,total}`，模型改投摘要+文件指针）；协议硬顶 MCP stdio 单帧 32MiB
  （-32700 显式拒收）不改。
- 注入面复用现有预算（item 4000/total 16000 基准，§8）：获批全文超限时截断 + 尾注指针，
  `xc_read({scope:"mail"})` 分页取回（每页 64K）——mail 取回的是获批请求的执行通道，故同受门。
- 引擎审计（engine.jsonl，邮箱原文 + 审计双轨）：`tool-request`（发送）、
  `tool-decision`（门裁决 approved/refused+reason）、`tool-executed`（回投 resultChars/status）、
  `tool-result-rejected`（伪造/不匹配回投）、`tool-approval`（xc_review approve/deny）、
  `tool-approval-request`（门→lead 待批通知/过期收尾）、`tool-expired`（sweeper 过期回投）、
  `tool-artifacts-cleaned`（终态清理）。
- 过期：`expiresAt = createdAt + ttlMs`；A 消费时过期即拒（`request expired`）；A 不在线躺箱 →
  sweeper 节拍（与 stale 任务清扫同一 setInterval，无新定时器）标 expired + 回投请求方；
  lead 收过通知的补 `approval_result{decision:"expired"}`。**多进程幂等（v0.7.2 修复 B-02）**：
  过期迁移在团队锁内完成，且只有真正落盘的那一次进回投列表——同相位竞态的其它进程读到已
  expired 即跳过，不会重复回投/重复审计。
- **lead 收尾可达性（v0.7.2 修复 C7-B5）**：lead 收过待批通知的请求，无论走哪条路径关闭窗口
  都能收到 `approval_result{decision:"expired"}`——①被 sweeper 扫为 expired（pending/approved
  超期，§3.3 原路径）；②停在 refused/denied（门拒后始终无人批准）且窗口已关闭时，由 sweeper
  补发收尾帧（只通知、不改台账，`approvalClosedAt` 记档防重复）。
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

`task.lastProgressTs`（v0.7.2 C8-B2 修复起**落盘字段**，epoch ms）：每个进展点（建单 / 认领 / 状态转移 / blocked / unblock / 引擎回池）由 `teamstate.appendTaskHistory`（全部转移的唯一收口点）随 history 末条同步刷新，与 history 末条 ts 同值（冗余镜像，观测面可直读）。读取口径（`core/stall.ts lastProgressTs`，停滞检测与本判据共用）：history 末条 ts 与落盘字段中**较旧**的一个（二者正常恒等；仅外部改写才会分歧，取较旧者是「宁可提示、不漏报」的保守方向）；history 为空时退回 `createdAt`。v0.7.2 之前的存量记录无该字段 → 按 history 末条推导，自洽记录结果不变。

### 12.2 可达性如实声明

- **优雅退出与空闲在注册表上同形**（pipe.ts 优雅退出摘记录）——「用户主动关闭的会话」检不出离线，
  可检出的进程死只有崩溃残留。故 C8 的 lead 通知实际覆盖「成员崩溃」而非「成员主动离开」；
  主动离开靠 stale 回池 + createdBy 回执既有链路兜底。
- **崩溃残留的保留与回收（v0.7.2 F-02/C8-B1 修复）**：`pid-dead` 注册记录是进程死判据的唯一硬证据，
  因此**注册/改名路径（xc_identify）的 peer 扫描一律只读**（`scanPeers(..., {sweep:false})`）——此前默认
  惰性清扫会把**全部**死记录一并删掉，而 README 快速开始的第一动作就是 identify：「成员崩溃 →
  无人值守 → 任意会话重启后第一动作 identify」必然抹掉残留，紧接的首轮 stale 清扫只能看到
  `no-record`，task-offline 审计 / lead 转交通知 / overview offlineMembers 三样静默丢失（红队 c8b1
  实测：对照组四件套齐全、故障组全失）。死记录的回收改走**定向 GC**：认领（或改到）某花名时，只删
  该花名的死前任（其身份已被 `peer-name-reclaimed` 审计 + 新记录 `reclaimedFrom` 消费完毕），
  其余会话的崩溃残留保留给队内 sweeper 的离线判据消费（`sweepStaleTasksOnce` 的只读扫描）。
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
   阈值被钳制时挂 `offlineThresholdClamped` + WARNING；`XC_OFFLINE_MINUTES` 为 0/负数/非数字（回落内置缺省）时挂
   `offlineThresholdFallback` + WARNING（v0.7.2 C8-B4 修复，不再静默）。
4. 并发安全：全部裁决在 `withTeamLock` 内；peer 扫描在锁外只读做。

## 13. MCP stdio 传输层帧级拒收（v0.7.1 边界-5）

协议消息仍走 MCP SDK 的 stdio 传输；产品只在其上覆写**帧边界**行为（`GuardedStdioTransport`），
协议处理与 stdout 写路径原样沿用 SDK。帧级失败一律「显式 JSON-RPC 错误响应 + 传输不关 + 后续帧继续服务」：

| 帧形态 | 判据 | 回执 |
|---|---|---|
| 单帧 ≤ 32MiB 且可解析 | 正常路径 | 正常进协议层 |
| 单帧 > 32MiB（`MCP_MAX_FRAME_BYTES`） | ReadBuffer 溢出 | `-32700`，`id:null`（帧读不全，规范要求 id 为 null），message 说明上限值 |
| 行读全但读不懂（裸控制字节入 JSON 字符串 / 裸 `NaN` / 坏 JSON / 帧型不符 schema） | `readMessage()` 抛错 | `-32700`，**尽力取回请求 id**（坏行的 id 段通常完好；取不到才 `null`），message 说明「帧无法解析为 JSON-RPC 消息」 |
| 半行（尚无 `\n` 行界） | 缓冲里没有完整行 | **无回执**（帧还在途，不能把在途帧误判为坏帧）；行界补全后按合并结果处理 |

- 两类失败用**同一个错误码**（-32700，JSON-RPC 2.0 Parse error）：客户端对「读不动的大帧」与「读不懂的坏帧」
  看到同一种显式失败，不再一个静默丢弃一个有回执（v0.7.0 及以前坏帧 0 字节回执，只能靠超时发现）。
- 协议层（`onmessage`）抛错不归传输层：SDK Protocol 自己会给请求回错误帧，传输层不再重复回一条。
- server 进程**永不**因任何帧级失败退出（v0.5.1 CONC-2 纪律不变）。
