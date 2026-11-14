# PROTOCOL：zcode-crosschat 协议细则（v0.6.0）

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

不带 `type` 的自由文本（或非对象 JSON）按 `chat` 处理——这是 v0.1.0 起的兼容形态。
消息内容永不授予权限："permission rules are never accepted from messages"。

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

仅代码读取、无用户设置项的演练 env：`XC_STALL_MINUTES`（停滞阈值，缺省 120）、`XC_MEM_WARN_WATERMARK`（缺省 0.15）、`XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）、`XC_MEM_SAMPLE_MIN_MS`（缺省 60000）。

## 10. 身份与安全底线（v0.6 口径）

- 注册 = `xc_identify(name, sessionId)`：两轴合一（队内 + peer）。`sessionId` 取钩子注入值，不要编造。
- regToken 硬闸已砍（个人/内部场景无恶意进程模型）：sid 存在性 + 活性软校验；**同名冲突显式拒**（`name_taken`）保留。
- 成员崩溃后接管：无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；
  `xc_identify({takeover:true})` 立即换绑并回池其未完任务（受在途唤醒活信号闸保护：15min 内有在途回合 → `takeover_inflight` 拒绝）。
- 证据门（v0.6）：evidence = 文件 + 摘要；文件必须真实存在且位于工作区内（`evidence_path_outside_workspace` / `evidence_file_missing` 硬拒）；**sha256 复核已砍**（旧参忽略并披露）。
- 底线三不：不崩（大帧守卫/截断有界）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚 = 连接 extra 的 connectionKey，别名路径透传不变）。
