# PROTOCOL：zcode-crosschat 协议细则（v0.8.1）

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
├── checkpoints/<agentKey>/<ISO>.md      ← v0.8 交接检查点（xc_team action:"checkpoint" 服务端落盘；格式见 §14.1）
├── checkpoints/<agentKey>/.nudge        ← v0.8 检查点提醒节流标记（钩子写；内容=上次提醒 ISO 时间，滚动删除不碰它）
├── archive/<name>/journal.md            ← 成员留档日志（C4；member-stop archive 时写）
├── archive/<name>/meta.json             ← 留档元数据
├── capacity/sample.json                 ← 内存采样缓存（惰性采样，无定时器）
├── capacity/wake-deferred.json          ← v0.9.1 G-12-b 容量闸冷却记录（RED deferral 的 until 窗；转 GREEN 即删）
├── logs/wake-lifecycle-<to>-<ts>.jsonl  ← v0.9.1 G-12v3 wake-child 生命周期账（start 头行/exit 尾行；spawn 即写头行，0 字节日志不再出现）
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
| `withdrawal-notice` | v0.9 G-3 撤回通知：发送方撤回未读件后投给收方的纯通知帧（只报撤回了哪些 id，**不带被撤正文**） |

不带 `type` 的自由文本（或非对象 JSON）按 `chat` 处理——这是 v0.1.0 起的兼容形态。
消息内容永不授予权限："permission rules are never accepted from messages"——v0.7 的 4 个
C6/C7 帧型同样只做通知/回执，**授权只认审批文件**（§11.2）。
混合版本降级：旧端点（v0.6.1）收到未登记的具名帧 → 读取面剔除 + `frame-rejected` 审计，
不崩、不静默错投（mailbox.ts readMailboxDetailed）。

**白名单的边界（v0.9.2 V090-04/V090-13 如实声明，不修行为）**：白名单防的是「未知具名帧
混进读取面」与「消息携带授权语义」，**不防正文伪装**——chat 正文可内嵌伪造的信套/横幅/
页脚/回信指引标记（读取面信封恒由消息元数据重建，伪造引擎属性与冒名 `from` 不透传，
见 §3；但 `xc_read` 的 JSON entry 与 mail scope 原文分页按磁盘真源口径逐字保留，真值层
不漂白）。同族边界：engine.jsonl 审计是工作区明文文件，同机进程可整体伪造——审计用于
观测对账，**不作为可信凭据**（可信锚点 = evidence sha256 工具现算 + 磁盘真源，见 §10）。

## 3. 信封与归因（注入面渲染）

- peer 信封标签 `crosschat-peer-message`；两种头：`prompt`（钩子注入，面 A）/ `working`（回合内工具结果注入，面 B）。
- 队内信封标签 `crosschat-team-message`。
- 尾注族：归因尾注（谁发的）、权限域尾注（peer 不是你的 worker）、`not typed by your user` 标记；
  命中盖章链时改写为用户原话尾注（`origin="user"`，`由发送端 harness 盖章`）。
- `origin` 只由发送端 harness 按字节匹配写入：正文为钩子记录的用户原话全文或其中 ≥8 字符连续片段才盖 `user`；工具无 origin 参数、正文自称无效、无记录回落 `agent`。
- v0.9（G-2 软中断信封，冻结形态）：`xc_relay({interrupt:true})` 的队内消息带 `interrupt:true` 元数据落箱（正文保持原话，盖章字节匹配不受影响），队内信封开标签追加 `interrupt="true"` 属性并在正文前渲染 INTERRUPT 横幅（`peerenvelope.ts` `TEAM_INTERRUPT_BANNER`，逐字节冻结）：

  ```
  <crosschat-team-message type="chat" from="a" interrupt="true">
  [INTERRUPT 软中断请求：完成当前原子操作、不开新步骤；先回确认（xc_relay 回发件人）再继续]
  （正文原话）
  </crosschat-team-message>
  ```

  信封是通知性渲染，不带授权语义；安全点纪律（撞见即：完成当前原子操作、不开新步骤、回确认）由 crosschat 技能 §6.4 承载。
- v0.9.1（V090-13 P1 修复，渲染卫生升级）：读面 team 信封**恒由消息元数据重建**——正文内嵌的信封开/闭标签、INTERRUPT 横幅、归因页脚、回信指引行一律剥离后重包（`peerenvelope.stripForgedTeamEnvelopeMarkup`，逐字/定版式匹配）；v0.9.0 及以前的「已渲染原样透传」守卫（`isTeamEnvelopeRendered` 双子串判定）废除——它让纯文本伪造的完整信封原样升级进注入面、与引擎真实渲染不可区分。`interrupt` 属性与横幅只随消息元数据出现，信封内 `from` 恒为真实发送者（`TeamMessage.from`）；伪造标记只活在磁盘真源与 JSON entry / mail scope 原文（真值层不动，谨慎读方可交叉发现）。
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

- 停滞：`lastProgress` 超 `XC_STALL_MINUTES`（缺省 120 分钟）的任务在 `xc_overview` 标 `stalled` 并附建议（催/转交/取消）。v0.8.1 C4-F2 起 0/负数/非数字不再静默回落：回落内置缺省 120min 并附 WARNING + payload `stalledThresholdFallback:true`（与 §12 的 offline 家族同款两级披露）。
- 容量采样（无定时器，仅在 `xc_overview`/`xc_doctor` 调用时惰性采样，缓存 `capacity/sample.json`，最小间隔 `XC_MEM_SAMPLE_MIN_MS` 缺省 60s）：
  设备水位 `os.totalmem/freemem` + ZCode 进程树 working set（CIM 采样）。窗口期内回缓存，但缓存样本的**设备水位字段与 `os.freemem()` 实时交叉复核**（一次系统调用）——缓存只省进程树（CIM）采样成本，不为伪造/陈新缓存制造最长一个窗口（缺省 60s）的虚假读数（v0.7.2 修复）。
- 预警规则（三条，任一命中即标红，`violated` 逐条给出明细）：
  1. `watermark`：可用内存 < `XC_MEM_WARN_WATERMARK`（缺省 0.15；合法域 **(0,1)**——v0.8.1 C4-O1 起越界值（0/负数/≥1/非数字）不静默按缺省判定：回落内置缺省 0.15 并附 WARNING + capacity payload `memWarnWatermarkFallback:true`，与 offline/stall 家族同款两级披露）；
  2. `session-limit`：headless 回合树单进程 working set > `XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）；
  3. `turn-concurrency`：并发 headless 回合数 × `XC_TURN_ESTIMATE_BYTES`（单回合瞬时占用预估，缺省 1.5GB）> 当前可用内存（建议减少并发回合或让成员休眠）。
  CIM 不可用时降级为只报 os 水位 + `degraded:"cim-unavailable"`，进程类规则（2/3）无数据不评、不虚报。
- 压缩联动（C9，**建议级非拦截级**）：verdict 标红时 `formatCapacityLines` 追加固定 `compress-advice` 建议行——先按 longtask checklist 落 journal（`.crosschat/tasks/<taskId>/journal.md`）再接受压缩；lead 可 `xc_relay` 要求目标先 `xc_report(status:"in_progress")` 附 journal 路径。平台无宿主压缩钩子接口，插件**不能拦截或触发压缩**，只做「预警 + 建议 + 落盘副本」最小闭环；team/panel 两视图都经 `capacityMount`，改一处两处生效。
- **spawn 前容量闸（v0.9.1 G-12-b）**：预警不再只停在展示面——`attemptWake` 在 `createWakeNonce` 之前读同一份 verdict（`judgeCapacity` 任一规则命中 ∨ 边际预估 `XC_TURN_ESTIMATE_BYTES` > `freeBytes`），命中即**不 spawn**、`delivered:"mailbox"` + `wake-deferred{reason:"capacity-red"}` + 冷却窗（`XC_MEM_WAKE_COOLDOWN_MS` 缺省 120s；`XC_MEM_WAKE_GATE=off` 关闸），sessionNotFound 自动重试前复检同一道闸。闸只挡唤醒不拦 pull——消息照常落邮箱，收方自己的回合随时可读（§2.5 mailbox 行兜底不变）；判据、冷却记录与冻结键集见 §15.2。

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

## 7. urgent 优先队列与软中断（C1 / v0.9 G-2）

`xc_relay({urgent:true})`：消息在目标一切读取面排所有未读之前（队内邮箱与 peer 队列同一规则），
并尽力推送一次 wake。离线目标由 wake 回合响应并复述 urgent 标记。

**软中断（v0.9 G-2）**：`interrupt:true` 蕴含 urgent（置顶语义不变），并给队内消息写
`interrupt:true` 元数据落箱——正文保持原话（uservoice 盖章字节匹配不受影响），读取面信封按
§3 冻结形态渲染 INTERRUPT 横幅。宿主仍无回合中注入原语（E1 平台事实），不做任何 stop→send
尝试；收方在下一回合 inbox-check 撞见 INTERRUPT 信封后按安全点纪律处理（crosschat 技能
§6.4：完成当前原子操作、不开新步骤、回确认）。payload interrupt 块键集冻结：

```json
{"requested":true,"result":"deferred-next-turn","reason":"<E1 固定文案>","envelope":"team-inbox"}
```

`envelope` 仅在队内轴消息真实落箱（mailbox/wake 路径）时出现；held/duplicate 不带
（未进可读邮箱 / 重复的是既有消息）。`result` 恒为
`deferred-next-turn`——如实口径：打断的不是当前回合，是「下一回合必读 + 安全点自检」。

**peer 轴 interrupt 的如实回报（v0.9.2 V090-12 C 域）**：管道 MsgFrame 白名单冻结（v0.9
不动 wire），peer 收方**看不到任何 INTERRUPT 痕迹**（不渲染信封、不渲染横幅；文件退化件
仅带 urgent 排序）。payload 必须把这件事说清——peer 路径 interrupt 块键集冻结：

```json
{"requested":true,"result":"deferred-next-turn","reason":"<E1 固定文案>","envelope":"none","note":"<peer 轴无痕迹说明>"}
```

**去重键纳入优先级差异（v0.9.2 V090-12 C 域）**：`findDuplicateMail` 命中后，若既有件与
本次发送的 `urgent`/`interrupt` 标记不同，**不判 duplicate**——同文后发 interrupt 必须真达
收方（软中断信封不被 dedup 吞掉）、urgent 重发必须插队（否则 urgent 标记丢在旧件上）；
优先级相同才去重（防误触双发）。实现在 `mcp/tools-relay.ts` 发送路径（不动
`engine/wake.ts` 的键函数）。

**平台缺口如实声明（G-1）**：回合中注入（注入的指令在当前回合下一个工具调用边界被消费）
是宿主层能力，插件无原语、v0.9 不做——软中断信封 + 安全点纪律已是插件侧可达上界；建议另走
平台反馈渠道。

### 7.1 撤回未读消息（v0.9 G-3，仅队内轴）

`xc_relay({to:"<成员名>", withdrawMessageIds:["<messageId>", …]})` 撤回**自己发给该目标且仍未读**
的消息。语义（整单原子）：

- 可撤判据（判定次序 not_found → foreign → notice → read → discarded → unread）：消息在收方邮箱、
  `from === 发送者`、**非 withdrawal-notice 帧**、`readAt` 缺省、`discardedAt` 缺省；逐条状态随
  响应 `items` 披露。
- **通知帧不可撤（v0.9.2 V090-10 P2 修复）**：`withdrawal-notice` 帧是撤回对账的锚点（收方靠它
  知道哪些 id 被撤、原消息已不可见），结构性排除在可撤集外——v0.9.0~v0.9.1 通知帧满足全部撤回
  判据，发送者可链式撤回通知，收方最终只剩内容=上一条通知 id 的孤儿通知、原始被撤 ids 永久不可见，
  §7.1 对账契约被架空。现在撤通知 → `withdraw_rejected`（items 状态 `notice`），锚点保留。
- 全部可撤 → 整行删除（`mailbox.deleteMailboxMessages`，坏行/空行逐字节保留，原子提交）+
  给收方追加一条 `withdrawal-notice` 通知帧（**不带被撤正文**）+ engine 事件 `message-withdrawn`
  + 尽力唤醒（不带 urgent——撤回本身不是插队请求）。
- 任一件不可撤 → `withdraw_rejected` 整单拒绝：一个字节不动，`items` 逐条报状态
  （审计 `message-withdraw-rejected`）。
- 撤回模式与 `msg`/`urgent`/`interrupt`/`summary`/`sourceTaskId`/`sourceAttemptId` 互斥（冲突
  参数显式拒绝 `withdraw_exclusive_params`）；`msg` 仅在撤回模式下可省略；peer 轴显式拒收
  （`withdraw_peer_axis_unsupported`）。
- 如实边界：撤回不追回「已在途唤醒票据里携带的正文」——wake prompt 由票据原样携带正文，
  已在途的唤醒回合可能仍展示被撤正文（收方按 withdrawal-notice 对账）。
- **通知无频控（v0.9.2 V090-14 如实声明，不修行为）**：每次成功撤回各投一条
  `withdrawal-notice`，通知帧不受入站限速/频控约束——失误或恶意成员可制造通知噪音；
  但每条通知都必须对应真实撤回的未读件（无消息即无通知），且通知帧自身不可撤（见上），
  对账锚点不会被噪音消灭。

通知帧、响应与审计的键集冻结（值为占位；契约测试按 `Object.keys` 对拍）：

```json
{"type":"withdrawal-notice","withdrawnMessageIds":["<messageId>"],"withdrawnCount":1,"ts":0}
```

```json
{"withdrawn":["<messageId>"],"withdrawnCount":1,"noticeMessageId":"<messageId>","to":"<成员名>","delivered":"mailbox"}
```

```json
{"error":"withdraw_rejected","to":"<成员名>","items":[{"messageId":"<messageId>","status":"unread"}],"message":"<拒绝原因>"}
```

```json
{"event":"message-withdrawn","teamId":"default","from":"a","to":"b","messageIds":["<messageId>"],"count":1,"noticeMessageId":"<messageId>"}
```

`items[].status` 取值域冻结：`unread`（可撤）/ `read`（已读）/ `not_found`（收方邮箱无此 id，
含已撤）/ `foreign`（不是发送者发的）/ `discarded`（已作废）/ `notice`（withdrawal-notice 帧，
v0.9.2 起结构性不可撤）。成功响应 `delivered` ∈ `wake|mailbox`（尽力唤醒，同普通消息）。

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

仅代码读取、无用户设置项的演练 env：`XC_STALL_MINUTES`（停滞阈值，缺省 120；小于 `XC_STALE_TASK_MINUTES` 时按 stale 钳制并附 WARNING + payload `stalledThresholdClamped`；v0.8.1 起 0/负数/非数字同样**不静默**——回落内置缺省 120min 并附 WARNING + payload `stalledThresholdFallback:true`，见 §5）、`XC_MEM_WARN_WATERMARK`（缺省 0.15；合法域 (0,1)，v0.8.1 起越界值（0/负数/≥1/非数字）不再静默——回落内置缺省并附 WARNING + capacity payload `memWarnWatermarkFallback:true`，见 §5）、`XC_MEM_SESSION_LIMIT_BYTES`（缺省 800MB）、`XC_TURN_ESTIMATE_BYTES`（并发 headless 回合单回合瞬时占用预估，缺省 1.5GB=1610612736 字节；>0 合法，非法/未设回落缺省——见 §5 预警规则 3；v0.9.1 起同时是 spawn 前容量闸的**边际预估**判据，见 §15.2）、`XC_MEM_SAMPLE_MIN_MS`（缺省 60000）、`XC_MEM_WAKE_COOLDOWN_MS`（v0.9.1 G-12-b 容量闸冷却窗，缺省 120000=120s；>=0 合法，0=每次投递都重新判定，非法/未设回落缺省——见 §15.2）、`XC_MEM_WAKE_GATE`（v0.9.1 G-12-b 容量闸开关；`off`=关闸回到「只警不拦」，其余值/未设=开启——见 §15.2）、`XC_LIMBO_TIMEOUT_MS`（v0.9.1 G-12v3 消费确认超时，缺省 600000=10min；盖章后无 `consumedAt` 回写即自动降级回 unread，见 §15.3）、`XC_WAKE_SLOW_MS`（v0.9.1 G-12v3 wake-slow 阈值，缺省 300000=5min；spawn 后无 session-start 即告知 lead，见 §15.3）、`XC_TOOL_REQUEST_TTL_MS`（v0.7 C6 转办请求缺省有效期，缺省 3600000=1h，硬上限 86400000=24h）、`XC_OFFLINE_MINUTES`（v0.7 C8 离线判定空闲阈值，缺省 240min；低于 `XC_STALE_TASK_MINUTES` 时按 stale 钳制并附 WARNING；v0.7.2 起 0/负数/非数字同样**不静默**——回落内置缺省 240min 并附 WARNING + payload `offlineThresholdFallback:true`，见 §12）、`XC_CHECKPOINT_NUDGE`（v0.8 检查点提醒开关；**`0` = 关闭 UserPromptSubmit 的检查点提醒**，其余值/未设 = 默认开启。判据五态与 30min 阈值/节流见 §14.2；阈值本身不做 env 化）、`XC_START_CONFIRM_MS`（v0.9.2 A1 同步启动确认窗口，缺省 5000ms；正整数，0/负/非整数/不可解析 → 回落缺省，回落不静默（回执仍按「已发起但未见启动证据」如实措辞）——见 §15.5）、`XC_WATCHDOG_MS`（v0.9.2 A2 成员看门狗轮询间隔，缺省 60000=60s；0=关（不启动定时器），非数字/负数 → 回落缺省——见 §15.5）。均为高级 env，不进插件设置面。

## 10. 身份与安全底线（v0.6 口径）

- 注册 = `xc_identify(name, sessionId)`：两轴合一（队内 + peer）。`sessionId` 取钩子注入值，不要编造。
- regToken 硬闸已砍（个人/内部场景无恶意进程模型）：sid 存在性 + 活性软校验；**同名冲突显式拒**（`name_taken`）保留。
- 成员崩溃后接管：无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；
  `xc_identify({takeover:true})` 立即换绑并回池其未完任务（受在途唤醒活信号闸保护：15min 内有在途回合 → `takeover_inflight` 拒绝）。
  **错误文案自带接管指引**（v0.8.1 C2-B7）：队内轴 `name_taken` 的 message 明示「若该会话已死，改带 `takeover:true` 重试」——
  「≤3 次工具调用接手」的第 1 步就要这个参数，而注册前 `xc_read({scope:"handoff"})` 得 `not_registered` 读不到包，
  错误文案是唯一在途指引面（活持有者仍被 `takeover_live_holder` 拒）。
- 证据门（v0.7.1 边界-7/边界-8）：evidence = 工作区内**普通文件** + 现算 sha256 + 可选摘要；三道路径/形态门（`evidence_path_outside_workspace` / `evidence_not_a_file` / `evidence_file_missing`）+ sha256 复核（`evidence_checksum_mismatch`）；调用方声明的 sha256 必须与工具现算值一致，缺省则由工具现算后落库并随回执披露（详见 §4.1）。
- peers 视图寻址（v0.7.1 边界-9）：`[ref]`（= sessionId 末 8 位）只在**跨会话可寻址行**（self/session）上渲染，且照抄即可作地址（`to="名字 [ref]"`）；`member` 行是队内花名册的只读投影，**不渲染 `[ref]`**，队内寻址用裸名或 `名字 [team]` 后缀。
- **两轴操作的原子性**（v0.7.1 边界-4/边界-6）：`xc_identify` 的注册与改名都是「队内轴 + peer 轴」一次调用办两件事，任一轴失败都不留半边状态——
  - 注册：peer 轴失败（`name_taken` / `session_not_anchored` / 锁忙等）→ **队内轴回滚**（names.json 绑定、team.json 成员行、连接绑定全部撤销；本次新建的队伍连 team.json 一起撤），错误信封 `peer_axis_failed` 带 `teamAxis:{registered:false, rolledBack:true}`。调用方可以把错误当「无副作用」直接重试（精确对重绑幂等）。回滚自身失败时如实写 `registered:true, rolledBack:false` + `rollbackError`。
  - 改名：队内轴被「板面不干净」守卫阻止（开放任务引用/指定受领的 pending/**未读**件，判据见下）→ **两轴都不改**，显式 `team_rename_blocked`（payload `renamed:{peer:false,team:false}`，挡路明细 `openTaskIds`/`designatedPendingIds`/`mailboxCount`/`terminalTaskRefs`）；peer 轴改名失败（`name_taken`）→ 队内轴改名回滚到原键，同样不给「队内新名 + peer 旧名」的半个改名。
  - **v0.8.1（M01 修复，P1）：改名两轴前置校验**——队内轴花名换绑落地**之前**先问两件事：① 新花名已是队内花名册另一位成员 → `team_rename_blocked`（reason: held by another member on the team roster）；② 新花名在 peer 轴被另一个**活**会话占着（只读扫描，死记录不挡——死名可 reclaim）→ `peer_axis_failed`（`peer.name_taken`，`teamAxis.registered:false`）。两种都在任何状态变更之前拒、零副作用：v0.8.0 及以前二者都会先把队内轴写成重复成员键（team.json 与 .bak 双重复员键双双中毒、全队 team-axis 工具 internal、回滚自己也读不了损坏文件——红队 M01）。
- **v0.8.1（M01 修复）：中毒 team.json 的工具面自愈**——万一份 team.json 已被写成重复成员键（旧版本痕迹/外部损坏），免注册的 `xc_doctor({action:"repair-team"})` 做确定性修复：names.json 权威索引指向的成员行保留、改名残留行丢弃（无权威绑定时兜底保留先到行并披露 `fallbackKeys`），残损字节保全为 `team.json.corrupt`，真源与 .bak 一并重写，审计 `team-state-repaired`；非重复键缺陷不猜不修（`reason:"unrepairable"` + defect，交还原人工恢复路径）。缺省调用（无 action）仍是纯只读体检、一个字节都不写。
- **改名守卫的判据**（v0.8.1 C6-BUG-6 修正）：只挡**非终态**引用——名下开放任务（assignee/createdBy）、指定受领（`to`）的 pending 任务、邮箱**未读**件。completed/cancelled/failed 是历史审计痕迹（assignee/createdBy 永驻），不挡改名（v0.8.0 及以前「做完手上的活再改名」永远做不到：终态记录无工具可移除，有任务历史的成员永远无法改名——红队 lane-b6）；已读邮件历史同理（换名后只是旧箱留痕，没有功能路径再读它）。改名成功回执披露保留的终态引用数 `terminalTaskRefs`。
- **改名连续性**（v0.8.1 C2-B3 修复）：改名成功时检查点目录随花名搬迁（`checkpoints/<旧名>/` → `checkpoints/<新名>/`，含 `.nudge`；best-effort——搬失败只在回执披露旧路径，不阻断改名）——默认 self 接手包的「最近检查点」不再因换名静默变 null。另：self 接手包三要素（任务/未读/检查点）全空、而花名册有**不在场**成员持有这三类状态时，接手包给一条置顶 continuity 建议（指向 `xc_read({scope:"handoff", id:<该成员名>"})` 成员视角）——「新花名 identify 接手」的落地点不再是一张静默白纸。
- **takeover 的失败无副作用**（v0.8.1 C6-BUG-1 修复）：`takeover:true` 的 sessionId 校验（锚定存在性 → `session_not_anchored`；sid 未被别的花名绑定 → `session_already_bound`）前置到**任何状态变更之前**——v0.8.0 及以前先撤销在途 attempt、任务回池、摘 names 绑定才报错，调用方不能把失败当「无副作用」重试（红队 lane-b1-repro）。
- **改名后 names.json 写新绑定**（v0.7.2 CB-01 修复）：队内花名换绑在 registry 锁内「解绑旧键 + **写新键绑定**（`{sessionId, role, registeredAt}`）」一次完成——v0.7.0~v0.7.1 只解绑旧名、新键从不写入，names.json 对该 sid 零绑定，而 SessionStart 钩子的「已注册花名」判定（`hooks/shared.ts boundNamesForSession`）就读 names.json，于是改名成功的会话下一轮钩子注入误报「尚未注册跨会话花名」（红队 capbug1 实测；功能路由不受影响、无冒名窗口，但观测面自相矛盾）。**冲突保护**：新键已被**别的 sid** 绑定（陈旧死绑定）时不覆盖——那属于接管语义（takeover/claim 路径），改名面不越权改别人的索引行；改名被守卫整体阻止时两键都不动。
- **同 sid 冲突的文案**（v0.7.1 并发与-1）：`session_id_in_use` 的 payload 增 `sameSessionId`。冲突对象持有**同一个** sessionId（同一会话被两个活进程重复拉起）时文案说清「两个活进程在争一个会话，停掉重复的那个」，不再误述 "another live session … use your own id"（败者用的正是自己的 id）；**异** sid 才是冒用场景，沿用 v0.5.2 起的原文案。
- 底线三不：不崩（大帧守卫/截断有界 + **畸形帧显式 -32700**，见 §13）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚 = 连接 extra 的 connectionKey，别名路径透传不变）。
- **审计与日志不是可信凭据（v0.9.2 V090-04 如实声明）**：engine.jsonl / peer.jsonl 是工作区（或插件数据目录）内的明文文件，同机进程可整体重写——威胁模型口径（个人/内部协作、不做对抗级防伪）下，审计用于观测与对账，**不作为可信凭据**；可信锚点是 `xc_report` evidence 的 sha256（工具对文件现算，§4.1）与磁盘真源本身。

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
   **额外发转交通知**（邮箱消息 + 同一 wakePlan 机制），消息体带转交建议（用 `xc_dispatch` 重派——
   现有能力组合，不新增工具/动作）。收件人（v0.8.1 C6-BUG-4 修复）：属主**不是** lead → 通知 lead；
   属主**就是** lead 自己（founder 兜底同判）→ 通知崩溃者自己的邮箱无接收意义，改投**其他在册成员**
   （有 sessionId 的可寻址队友——队友才能认领回池的任务），无人可通知时只落审计；
   `task-offline` 审计**恒定落地**（v0.8.0 对「lead 自己离线」整体跳过通知+审计，而「lead 崩溃」
   恰是 C8 最该留信号的场景——红队 lane-b4：presweep status 已检出 pid-dead，sweep 却零 task-offline）；
2. `TaskEdgeOutcome` 增 `offline: OfflineMember[]`（进 `xc_report` 工具 payload 与 `task-offline` 审计事件）；
3. `xc_overview` team 视图挂 `offlineMembers` 块 + 文本行（`offline: <名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)`）；
   阈值被钳制时挂 `offlineThresholdClamped` + WARNING；`XC_OFFLINE_MINUTES` 为 0/负数/非数字（回落内置缺省）时挂
   `offlineThresholdFallback` + WARNING（v0.7.2 C8-B4 修复，不再静默）。
4. 并发安全：全部裁决在 `withTeamLock` 内；peer 扫描在锁外只读做。

### 12.4 会话活性状态机与清扫联动（G-9/G-5，v0.9.0）

**活性真源**（`core/liveness.ts` 纯函数 + `core/registry.ts` 落盘属主）：`lastSeen` 是
「上次见过」，不是「正在运转」——会话状态机三态，其中 `dead` 为派生态不落盘。

**双轨分路（v0.9.1 r3 V090-01，V090-GUIDANCE-R3）**——自述与证言分开，豁免只认证言：

| 轨 | 文件 | 写者 | 用途 |
|---|---|---|---|
| 自述（display-only） | `registry/sessions/<sid>.json` 的 `liveness`/`livenessTs`/`lastEventTs` | 引擎进程（hooks + 工具心跳）**同刻写**，但可被一次本地文件写伪造 | **仅展示**（三视图成员行）；**不得作豁免输入** |
| 引擎证言（exemption input） | `registry/witness/<sid>.json`（paths.ts `witnessFile`） | **只有引擎进程**：hooks 回合边界（`session-running`/`session-idle` 同源）+ `withPeerDrain` 包装层的队内工具调用心跳（30s 节流，dispatch/relay/report/claim 等一切被包装工具） | 清扫豁免（`sweepOwnerGuard`）的**唯一**活性输入 |

证言形状 `{sessionId, kind: "running"|"idle"|"heartbeat", ts}`：`running`/`idle` = hook 三态
迁移（回合起/止），`heartbeat` = 队内工具调用（引擎亲见）。`coerceSessionWitness` 对
**未来值整条拒绝且容差为 0**（v0.9.1 r4 V090-02：证言是引擎写入时刻的 Date.now()，与判定
同机同钟、无时钟漂移场景——r3 误继承自述的 5min 容差使伪造 `ts=now+4min` 的 age 为负、
恒满足 boundMs，单次写的豁免窗被放大到 skew+2×阈值，实测 360s vs 过去值 120s；5min 容差
只适用于自述记录）。纯函数 `sweepOwnerGuard` 同款防御（`witness.ts > now` 即不豁免，兜内联
构造路径）。裁决实证的攻击面（case1r3/case7br3）：成员自有 MCP server 全会话常驻
（15s 端点心跳），使「端点活性证词」（r2 修法）可被攻击者自己的存活 server 满足——故 r3
把豁免输入收敛为引擎证言：一次外部写伪造自述记录**造不出证言**，双文件伪造（连证言一起写）
属活跃攻击（超出「一次本地文件写」的确认缺陷类，且留痕可见）。

**迁移事件**（engine.jsonl 新事件族，family=`liveness`；同态刷新不写事件——每个 prompt
只刷记录不刷日志）。键名刻意用 `prev`/`state`（不用 `from`/`to`——时间线 actor 取值链
占用这两个键，状态字符串会被误当行为方渲染）：

```json
{"ts": 0, "event": "session-running", "sessionId": "sess_6c244439", "prev": "idle", "state": "running", "name": "m3"}
{"ts": 0, "event": "session-idle", "sessionId": "sess_6c244439", "prev": "running", "state": "idle", "name": "m3"}
```

`prev` ∈ {`"running"`, `"idle"`, `null`}（null = 记录此前无活性字段）；`name` = boundName
（未注册省略）。时间线（`xc_overview({view:"timeline"})`）归一化 family=`liveness`，摘要 =
`<event> <name|sessionId>`。

**引擎证言的心跳语义（G-5）**：证言由 registry 触到的各类引擎事件刷新——钩子回合边界
（SessionStart / UserPromptSubmit 标 running、Stop 标 idle）+ MCP 工具调用
（`withPeerDrain` 包装层标 heartbeat，30s 节流；dispatch/relay/report/claim 等一切被包装
的队内工具）。清扫侧口径：属主在 stale 窗口（`XC_STALE_TASK_MINUTES`，与任务 stale 时钟
同宽）内有过引擎事件 = 心跳代理，不再要求手动 `xc_report` 打卡（GAP t1「活跃等待裁决被
误扫」的修复）；他人投给属主的消息（to=member 类事件）**不算**属主心跳——防「反复戳死
会话」把僵尸任务永久挂在清扫域外。自述记录的 `lastEventTs` 与证言同刻写、仅作展示。

**清扫联动**（G-5，复用既有 sweeper，无新闸；`sweepStaleTasksOnce` 无锁预检 + 锁内重算
双层）：

1. 属主**引擎证言** `running`（回合执行中）且证言年龄 ≤ 2×阈值 → **暂停 stale 倒计时**
   （本轮跳过；GAP t17 长任务多轮误扫的修复）；
2. 属主证言年龄 ≤ 阈值（任何引擎事件：工具调用 / 回合边界）→ 心跳代理豁免，不再要求手动
   `xc_report` 打卡（GAP t1「活跃等待裁决被误扫」的修复）；他人投给属主的消息
   （to=member 类事件）**不算**属主心跳——防「反复戳死会话」把僵尸任务永久挂在清扫域外；
3. **无证言 / 证言年龄 > 2×阈值 → 照扫**（V090-GUIDANCE-R3 的有界条款：连续豁免超过
   2×stale 阈值仍无任何引擎事件则照扫，防「回合起了但永远不结束」的永久滞留）；
   `dead`（pid-dead 硬证据）立即失效不等衰减——C8 process-dead 快刀 + 转交通知口径不变；
   真僵尸（idle 且窗口内无事件）照扫（t19 边界与 v0.8 一致）；
4. `blocked` 不在 `SWEEPABLE` 清扫域的旧口径不变；
5. 豁免**必须留痕**（v0.9.1 V090-06）：每任务每超阈周期（epoch = floor(超阈时长/阈值)）
   一行 `task-sweep-deferred`（family=sweep；`{taskId, assignee, reason: "owner-running"|"heartbeat",
   peerLiveness, witnessAgeMin, staleMinutes, epoch, note}`）——预检全豁免跳过与锁内豁免同刻度
   去重（进程内台账），时间线/审计从此能回答「这单为什么一直没被扫」，而非逐 60s 节拍刷日志。
   `witnessAgeMin` = 证言年龄（豁免新鲜度）；`peerLiveness` 仅展示（端点活性非豁免输入）。
   **豁免可观测（v0.9.1 r4 V090-01 处置，V090-GUIDANCE-R4）**：连续豁免的累计期数进
   `xc_overview` 任务板——payload 任务行 `sweepExemptPeriods`（N = floor(超阈时长/阈值)，
   仅被豁免的超阈 SWEEPABLE 任务带）+ `sweepExemptReason`，team 视图文本增
   `Exempt: <taskId>(<reason>, 豁免 N×阈值)` 行（status 视图行序冻结、观测只在 payload）；
   成员行 `liveness.witness` = `{kind, ageMin}|null`（与清扫豁免**同一读取路径**的证言
   快照——「自述 state」与「豁免真实输入」并列，`state=running ∧ witness=null` 即伪造
   签名）。持续重写证言的活跃攻击是威胁模型边界（README 已知限制 20，v0.6 口径：不做
   对抗级防伪），可观测性保证 lead 可见异常长豁免。
6. **offline 通知文案分流**（v0.9.1 r3 V090-02）：转交通知按任务**是否真回池**分流——
   真回池（revokeAttempt 已重置回 pending）沿用旧文案「open task(s) requeued to the pending
   pool」；活性豁免滞留（任务仍在属主名下、未回池）如实写「open task(s) still held by
   "<成员>" under liveness exemption — NOT requeued; cancel via xc_team({action:"cancel"})
   or reassign via xc_dispatch」——旧文案对豁免任务是谎报（lead 按通知去待领池找不到任务）。
   帧载荷 `offline.tasks[]` 逐任务带 `requeued` 布尔（机器可读）；混合属主（部分回池部分
   滞留）写 split 文案并分别计数。
7. 豁免**不壅蔽 C8**（v0.9.1 r2 V090-05）：豁免只暂停**回池**，不遮蔽离线信号——豁免任务
   仍逐节拍算 `offlineVerdict`，命中（process-dead / idle-timeout）即照常 `task-offline`
   审计 + lead 转交通知；通知持久闸 = `task.offlineNoticeAt`（上次通知时刻；`now -
   offlineNoticeAt ≥ XC_OFFLINE_MINUTES` 才再通知——豁免任务不被清扫、会跨节拍持续命中，
   无闸则每 60s 刷一次 lead 邮箱）。字段未来值经 `plausibleLivenessTs` 读盘校验（伪造
   未来值压制通知在读盘即失效）。

**活性字段的信任规则（v0.9.1 r3 V090-01，durable boundary + 引擎证言）**：

- **未来值校验**（自述记录）：产品自写的活性时刻恒为写入时的 `Date.now()`，未来值只可能
  来自外部伪造/损坏。`coerceSessionRecord`（types.ts，读盘入口）对 `livenessTs`/
  `lastEventTs` 施加 `plausibleLivenessTs`：有限正数且 ≤ `now + LIVENESS_TS_FUTURE_SKEW_MS`
  （5min，同机时钟漂移容差），否则**整字段丢弃**（不整文件拒绝）。纯函数同规则防御纵深：
  未来 `lastEventTs` 不给心跳、观测面不钳 0 展示（`lastEventAgeMin=null`）；
- **证言未来值整条拒绝**（registry/witness）：`coerceSessionWitness` 对 `ts > now + 5min`
  或 `kind` 枚举外**整条拒绝**（读回 undefined = 无证言 → 不豁免）——证言是引擎写入时刻，
  无时钟漂移场景；
- **自述 vs 证言不一致审计**（r3）：自述记录声称 `running` 而证言不支持（无证言 / 证言止于
  `idle`）= 伪造签名——清扫面落 `session-record-anomaly`（family=liveness；`{sessionId,
  member, field, detail}`，进程内按状态根×会话×字段去重一次）。自述 running + heartbeat
  证言是引擎正常流（工具调用把记录拉回 running），不算异常；
- **端点活性仅展示（r3）**：`endpointLive`（peer 注册表 live）不再是豁免输入——成员自有
  MCP server 全会话常驻（15s 端点心跳），端点活性可被攻击者自己的存活 server 满足
  （裁决 case1r3/case7br3 实证：伪造自述 + 自有活端点 = 永久 owner-running 豁免）。
  字段保留供 lead 观测「自述 vs 端点」；`pid-dead` 仍是 C8 immediacy 硬开关（在场即豁免
  失效，不等证言衰减）。持续重写证言的活跃攻击超出「一次本地文件写」的确认缺陷类，
  同机进程伪造的完整防线仍在威胁模型边界外（§11.5 uservoice 同款口径）。

**观测口径（三视图统一）**：`xc_overview` 的 team / panel / status 三个视图对每个成员暴露
同形活性视图（单一实现 `memberLivenessView`）：
`{state: "running"|"idle"|"dead", stateAgeMin: number|null, lastEventAgeMin: number|null,
endpointLive: boolean}`（`endpointLive` 仅展示：peer 注册表端点活性，非豁免输入——r3 起
豁免只认引擎证言；`state` 取自述记录，`state=running` 而无对应证言时审计面留痕）。
- team / panel：payload `members[].liveness`（成员行暴露）+ 顶层 `liveness:{running,idle,dead}`
  计数 + 文本行 `liveness: running X / idle Y / dead Z`；
- status：文本行序冻结不加行，活性在 payload 顶层 `liveness:{running,idle,dead,byMember}`
  （`byMember` = 成员行等价物，值形状与 team/panel 的 `members[].liveness` 完全一致）；
- **peer 注册记录的删除一律显式**（v0.9.1 r2 V090-02）：`scanPeers` 缺省只读（死记录进
  `dead` 不删文件），删除仅限显式 `{sweep:true}` 与 claim 路径的定向回收
  （`reclaimDeadRecordsOfName`），**每一笔实际删除写机器全局清扫日志**
  `sessions/.sweeps.jsonl`（`{ts, sweptCount, swept:[{pid, sessionId, reason}]}`，
  core/peerregistry.ts `peerSweepJournalFile`/`appendPeerSweepJournal`——pid-dead 证据被
  谁/何时/按何死因清除，跨工作区可查；文件名不以数字开头，永不进 `/^\d+\.json$/` 扫描集）。
  按名寻址（xc_relay）/观测面/花名占用查询全部只读——崩溃残留不再被自家工具顺手抹掉。
  扫描不可用时降级为记录状态呈现（不猜进程死，观测面永不崩）。

**C4 panel 口径（v0.9.2）：任务计数改七态全量，文本与 payload 同源**：

`view:"panel"` 的 payload `tasks` 与文本 `tasks:` 行都由同一份七态计数渲染——键集恒为
`TASK_STATUSES`（`pending`/`claimed`/`in_progress`/`blocked`/`completed`/`failed`/`cancelled`，
未出现的状态记 0，形状稳定才能跨面对拍），不再有 v0.9.1 及以前的 `{pending, inProgress, done}`
三桶（`completed`/`failed`/`cancelled` 被并成 `done`、`claimed`/`blocked` 无键可落——同一时刻
status 视图给七态、team 板面按七态排序，三个面对不上账）。文本行格式与 status 视图的
`tasks:` 行同构（`tasks: pending 1 / claimed 1 / … / cancelled 1`），**三者数值可对账**：
panel `tasks` ≡ status `taskCounts` ≡ `team.tasks[].status` 真实分布（七态之和 = 任务条数）。
无 team.json 时七态全 0（不缺键）。

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

## 14. 检查点、接手包与观测视图（v0.8）

> **平台事实（本节的由来）**：zcode 3.18.2 **无 PreCompact/PostCompact 钩子、无原生状态栏扩展点**——
> **无 PreCompact，故用「提醒 + 一键」**：不做自动压缩检查点、不能拦截压缩；压缩防护 = 「一键 `/xc-checkpoint` 服务端落盘 + UserPromptSubmit 轻量提醒」。
> 状态栏同理：无原生扩展点，「一眼瞭望」降级为 `xc_overview({view:"status"})` 紧凑文本视图（不是 UI）。
> 全部落在既有 10 工具面内——checkpoint → `xc_team` action；handoff → `xc_read` scope；timeline/status → `xc_overview` view；
> **0 新增工具、0 新增必填配置**（新阈值走代码常量 + 仅 1 个可关 env `XC_CHECKPOINT_NUDGE`）。
> 设计依据 [docs/DESIGN-V0.8.md](DESIGN-V0.8.md)；命令与技能口径见 README「工具与命令」与 `crosschat` / `longtask` 技能。
>
> **跨面 leadKey 口径（v0.8.1 M05，全节适用）**：凡本节（及 `xc_team` 的 lead 闸错误信封）出现 lead 标识，一律取 `leadKeyOf(team)`（`team.leadKey ?? founderKey`——无显式 lead 时 **founder 读作 lead**），不得直读 `team.leadKey ?? null`。覆盖：checkpoint front-matter `lead` 与身份章、handoff payload `identity.leadKey` 与文本章、status 文本行与 payload、team 视图 `members[].isLead` 与 `history:true` payload 的 `leadKey`、以及 `not_lead`/`not_authorized` 信封的 `leadKey`（与同一信封的 message 文案和门闸判据同源）。v0.8.0 只在部分面直读 `team.leadKey`，无显式 lead 时出现「payload `leadKey:null` 而同报文 `isLead:true` / message 展示 founder」的自相矛盾（29 红队 M05）。

### 14.1 检查点（checkpoint）

API：`xc_team({ action: "checkpoint", note?: "<一句话>" })`——只复用既有入参键 `note`（无新键、无必填项）。
权限：`identityStore.require`（未注册连接拒，与所有成员动作一致）；**不设 lead 闸**（每个成员只能写自己的目录，没有越权面）。
前置：team.json 不存在 → `no_team`（与 §4 的读面同族）；成员不在花名册仍可写，「身份」章如实记 `state: (not on roster)`（检查点的价值是落盘，不阻断）。
副作用面：**只写 `<root>/checkpoints/<me>/`**——不写 team.json、不进邮箱、不唤醒、不碰锁、不改任务状态机。

**改名时随花名搬迁**（v0.8.1 C2-B3）：`xc_identify` 改名成功（两轴都落地）后，`checkpoints/<旧名>/` 整目录搬去
`checkpoints/<新名>/`（含 `.nudge` 节流标记；best-effort——搬失败只在改名回执披露旧路径，不阻断改名、不谎报成功）。
改名守卫保证板面干净、邮箱无未读，检查点目录是该成员仅存的每名状态——搬过去，默认 self 接手包的「最近检查点」
七要素才不因换名静默丢失（v0.8.0 及以前旧目录原地成孤儿，不再被任何工具面引用）。

路径：`.crosschat/checkpoints/<agentKey>/<ISO8601>.md`。stamp = ISO8601，`:` 与 `.` 折成 `-`（Windows 合法且字典序 = 时间序）；
`<agentKey>` 一律先过 `sanitizeKey` 再过断言级复核（`core/archive.ts` `safeSegment` 同款防御纵深，新模块内自带一份，不修改 archive.ts）；
调用方只许经路径构建器取路径，禁止自行 join。

**同毫秒并发的占位（v0.8.1 C1-B01 修复）**：「一次调用一份文件」由**排他创建**保证：候选 stamp 先做存在性预检（快路径），
落盘用 `core/atomic.ts` 的 `writeFileExclusive`（同目录 temp + `link`，目标已存在即 EEXIST 让位）——两个同刻并发调用不会
互相静默覆写（v0.8.0 的「stat 预检 → rename 落盘」两步之间有竞态：双方都报成功、同一路径、先发者内容消失；红队同刻探针
6/10 + 11/25 轮稳定复现）。输家按毫秒进位重选（≤ `CHECKPOINT_STAMP_COLLISION_MAX = 1000` 次）；进位轮次记入结果的
`stampCollisions` 并审计 `checkpoint-stamp-collision`；候选位全占满才抛错（`checkpoint_write_failed`），**绝不静默覆写**。
**残留 `.tmp` 清扫（v0.8.1 C1-B02 修复）**：被杀进程会在目录留下 `<ISO>.md.<pid>.<uuid>.tmp`（原子写的 temp；击杀落在
「temp 已写、link 未成」之间；红队 10 次击杀 6 次残留且旧实现永不清扫）。每次写检查点时按**年龄**清扫（`now - mtime > 60s`
才删——在途写是毫秒级生命周期，并发写者的 temp 不会误删）：清掉的份数审计 `checkpoint-tmp-swept`，清扫失败只审计
`checkpoint-tmp-sweep-failed`（不阻断已成功的写入）。`.nudge` 与非 `.tmp` 文件不在清扫域。

**滚动（冻结）**：每 agent 保留最近 **20** 份（`CHECKPOINT_KEEP_MAX = 20`，代码常量，无 env）——列该目录 `*.md`、按文件名升序
（= 时间升序）、删除最旧的 `len-20` 个。`.nudge` 与非 `.md` 文件不在删除域；`archive/<name>/` 完全不受影响。
删除失败**不阻断已成功的写入**：审计 `checkpoint-prune-failed`，payload 附 `pruned: 0` 与 `pruneError`（写盘成功这一事实不被删除失败抹掉）。

**文件格式（冻结：front-matter + 7 章）**——单文件、UTF-8、以 `\n` 结尾（`archive.ts` 同款原子写纪律）：

```md
---
agent: alice
team: default
lead: alice
createdAt: 2026-11-15T18:00:00.000Z
taskCounts: {claimed:2, in_progress:1, blocked:1}
unread: 3
capacity: {watermarkPct: 23.5, freeGb: 7.2, level: GREEN}
---

## 1. 身份
## 2. 我的进行中任务（claimed / in_progress / blocked）
## 3. 待领池（前 10，priority → createdAt）
## 4. 最近 journal（每任务末 5 行 + 路径）
## 5. 未读摘要（urgent 优先，最多 5 条）
## 6. 建议下一步
## 7. note
```

| 面 | 冻结规则 |
|---|---|
| front-matter | **7 个键固定且每行必现**：`agent` / `team` / `lead` / `createdAt` / `taskCounts` / `unread` / `capacity`；`taskCounts` 恒含 `claimed`/`in_progress`/`blocked` 三键（0 也写）；值内含换行或 `---` 的入库前折成单行（防 front-matter 被注入撑破） |
| `lead` | `leadKeyOf(team)`（`team.leadKey ?? founderKey`——无显式 lead 时 **founder 读作 lead**，v0.8.1 M05：与 status/team/handoff 三面同源；仅团队记录异常缺 founder 时才写 `(none)`，不写 null，保持标量） |
| `capacity` | `{watermarkPct, freeGb, level}`；`level` **不是**采样/判定函数的产物（`capacity.ts` 的 `CapacityVerdict` 只有 `{red, violated, detail}`），由新代码推导：`verdict.red === true` → `RED`、`false` → `GREEN`、挂载返回 null → `UNKNOWN`（并写 `watermarkPct: n/a, freeGb: n/a`，写盘继续）；`watermarkPct` = `watermark*100` 保留 1 位、`freeGb` 保留 2 位。checkpoint / handoff / status 三处共用同一推导助手，不得各写一遍 |
| 章标题 | `## 1. 身份` … `## 7. note` 七章、顺序固定、编号固定 |
| 「我的进行中任务」 | `OPEN_TASK_STATUSES`（claimed/in_progress/blocked）∧ `assignee === me`；`最后进展` = `lastProgressTs` 转 ISO + 相对分钟；blocked 追加阻塞原因；无进行中任务记「（无进行中任务）」 |
| 「待领池」 | `status === "pending"`，按 `sortTasksForBoard`（priority → createdAt）取前 10；依赖列 `-`=无依赖、尾缀 `!`=依赖未终态；池共 M 个时末行记「（待领池共 M 个，列前 10）」 |
| 「最近 journal」 | 每任务取 `.crosschat/tasks/<taskId>/journal.md` **末 5 个非空行**；最多覆盖 10 个任务（超出记「（另有 N 个任务 journal 未列入）」）；文件缺失记「（无 journal：<path> 不存在）」——**不得静默跳过**；读取失败记「（journal 读取失败：<path>）」不影响其他章 |
| 「未读摘要」 | `readUnreadMailbox` + `urgentFirst`（C1 读取序）取前 5；每条只记 `[urgent?] <from> | <正文首行截断 80 字符>（<msgId 短 8 位>）`——**只抄索引不搬原文**（与 `ARCHIVE_PREVIEW_MAX_CHARS` 同纪律）；超出记「（另有 N 条未读…）」；读取失败记「（未读读取失败）」并在 payload `warnings[]` 披露 |
| 「身份」章 sessionId | **全量渲染**（v0.9.2 V090-15：v0.9.1 及以前 `slice(0,8)` 在 `sess_`/`sess_dwf-` 前缀下恒等退化、不同成员的检查点显示同一串，与 team.json / `xc_overview` 成员行的全量口径矛盾）；`lastSeen` 仍是 ISO + 相对分钟；msgId 摘要列仍短 8 位（uuid 前缀不撞、无身份寻址职责） |
| 「建议下一步」 | 由 `stallSuggestion` + 依赖未满足项 + 单在途任务规则提示 + 容量 RED 建议行拼装；无项时记「（暂无：按 journal 指针继续）」 |
| 「note」 | 上限 **500 字符**（与 evidence note 的长度钳同口径）；控制字符折空格；缺省「（未提供）」 |

**返回面（文本 + JSON 双层）**：文本一行 `Checkpoint written: <path> (<bytes> bytes, <openTasks> open task(s), <unread> unread, capacity <level>).`；
payload `{ path, createdAt, tasks, unread, capacity, bytes, pruned?, pruneError? }`（`tasks` = 我的开放任务 `[{taskId, status}]`，
`capacity` = `{watermarkPct, freeGb, level}` 或 `null`）。

**失败路径**：目录/文件创建或写失败 → `checkpoint_write_failed`，payload 带 `path` + 首因错误，**不返回成功**（不得假装落盘）。

**审计事件**（`core/log.ts`）：`checkpoint`（`{teamId, agentKey, path, bytes, openTasks, unread, pruned}`）、`checkpoint-write-failed`、`checkpoint-prune-failed`；
v0.8.1 起新增三条披露事件（payload 冻结形状不增不减，披露只走审计）：`checkpoint-stamp-collision`（`{teamId, agentKey, path, stamp, bumped}`——同毫秒并发撞名进位）、
`checkpoint-tmp-swept`（`{teamId, agentKey, removed}`——残留 `.tmp` 清扫掉）、`checkpoint-tmp-sweep-failed`（`{teamId, agentKey, error}`）。

### 14.2 检查点提醒（无 PreCompact 的替代；UserPromptSubmit 注入）

**注入点**：`hooks/prompt-submit.ts`——在既有未读提醒块之后、单出口 `emitAdditionalContext` 之前追加一支独立 `try/catch`
（照 peer 块的「失败只审计不阻断」范式）。提醒行进 `blocks[]`，**stdout 契约不变**：仍是一行 JSON、仍只有一个 `additionalContext` 键。
**零注入块也输出（v0.8.1 C1-B03）**：`blocks[]` 为空时同样 emit 一行 `{"additionalContext":""}`——契约是「恰一行 JSON、恰一个键」的
**恒定形状**（v0.8.0 零块时 stdout 为空串，`JSON.parse` 直接失败，形状随内容有无而变；空串 additionalContext 对宿主即无注入语义）。

**判据（纯函数 `checkpointNudgeDecision`，先命中先返回，保证负例可逐条单测）**：

| 序 | 条件 | `reason` | 提醒？ |
|---|---|---|---|
| 1 | `env.XC_CHECKPOINT_NUDGE === "0"` | `disabled` | 否（开关可关） |
| 2 | `openTaskCount === 0`（我的 `OPEN_TASK_STATUSES` 任务数） | `no-active-task` | 否（负例：没活干的成员不被提醒） |
| 3 | `lastCheckpointAt !== null && now - lastCheckpointAt <= 30min` | `within-threshold` | 否（负例：刚写过不重复提醒） |
| 4 | `lastNudgeAt !== null && now - lastNudgeAt <= 30min` | `rate-limited` | 否（负例：30min 内最多一次） |
| 5 | 其余 | `emit` | 是 |

- 常量：`CHECKPOINT_NUDGE_MINUTES = 30`（提醒阈值与节流窗同值，代码常量，**不做 env 化**——多一个旋钮就多一份走查面）。
- `lastCheckpointAt === null`（从未写过）按 age = ∞ 处理 = **该提醒一次**（由第 4 条把噪声钳在每 30min 一次）：
  功能目的就是「压缩前盘上已有一份」，从不落盘的成员更该被提醒一次。该裁决已写成命名断言（`lastCheckpointAt=null ∧ openTaskCount>0 ∧ lastNudgeAt=null → emit`；
  以及 `lastCheckpointAt=null ∧ lastNudgeAt=now → rate-limited`，证明它仍受 30min 节流）。
- **开关**：`XC_CHECKPOINT_NUDGE=0` 关闭（仅此一个 env，不进插件设置面、不是必填项）。
- **注入文案**（一行）：`[zcode-crosschat] 建议先 /xc-checkpoint（距上次检查点 <ageMin>min）——长期任务随时可能被压缩，先落盘再继续；不需要可设 XC_CHECKPOINT_NUDGE=0。`
  `lastCheckpointAt === null` 时 `<ageMin>` 渲染为 `从未`，文案改为「尚未落过检查点」。
- **节流标记**：判为 `emit` 时先把 `now` 写进 `.nudge`（原子写，best-effort）再注入；标记写失败仍注入（提醒比记账重要），只审计 `checkpoint-nudge-marker-failed`。
- **agentKey 来源**：钩子先 `boundNamesForSession(stateRoot, sessionId)` 取 `names[0]`（与未读提醒同一机制）；取不到（未注册会话）→ 不提醒。
- 读路径全部无锁（纯读，与 `hooks/shared.ts` 的 unreadSummary 同纪律）；负例**不记审计事件**（避免每回合刷审计）。
- 钩子侧任何异常 → `auditHookFailure(stateRoot, 'prompt-submit-checkpoint-nudge', error)`，会话永不因钩子失败。

### 14.3 接手包（handoff packet）

API：`xc_read({ scope: "handoff" })` ｜ `xc_read({ scope: "handoff", id: "<taskId|花名>" })`（**不新增入参键**，复用既有 `id`）。
权限：`identityStore.require`；team.json 不存在 → `no_team`。

**`id` 解析（顺序固定，命中即止）**：① `id` ∈ `team.tasks[].id` → `filter:{kind:"task"}`；
② `sanitizeKey(id)` ∈ `team.members[].key` → `filter:{kind:"member"}`；③ 都不是 → `invalidParamsError`，文案给合法形态 + 至多 10 个现存 taskId / 花名候选。
花名查 checkpoint 目录时过 `sanitizeKey` + 断言复核；清洗后与原文不同 → 该成员 `checkpoint` 记 `null` 并在 `warnings[]` 说明。

**七要素（payload 七个键，冻结）**：

| 键 | 形状 | 数据源 |
|---|---|---|
| `identity` | `{agentKey, teamId, leadKey, role, memberState, isLead}` | `readTeam` + 成员记录；`leadKey` = `leadKeyOf(team)`（`team.leadKey ?? founderKey`——无显式 lead 时 founder 读作 lead，v0.8.1 M05：与 status/team/checkpoint 三面同源，v0.8.0 直读 `team.leadKey ?? null` 会渲染 `lead: (none)` 而 status 展示 founder，自相矛盾）；`memberState` 走 W2 访问器（`m.state ?? "ready"`，DESIGN-V0.2 §6.5）——`xc_identify` 入册的记录本就不落 `state` 字段，v0.8.1 起在册成员恒得其生命周期态（缺省 `ready`），只有**不在册**才 `null`（文本面记 `(not on roster)`；v0.8.0 直取原始字段，对在册成员恒报 not on roster，与 checkpoint 身份章矛盾——29 红队 M02） |
| `tasks` | `[{taskId, title, status, attempt, assignee, lastProgressTs, blockedReason?}]` | 我的（或 id 过滤后的）`OPEN_TASK_STATUSES` 任务 |
| `pool` | `[{taskId, title, priority, dependsOn, unmetDependsOn}]` | `pending` ∧ `sortTasksForBoard` 序前 10；`priority` **恒在**（缺省 `normal` 的旧记录在此归一，v0.8.1 C2-B8——JSON 序列化会丢 value 为 undefined 的键） |
| `unread` | `{count, urgentCount, top:[{msgId, from, subject}]}` | 分视角（见下表）；`subject` = 正文首行截 80 字符 |
| `capacity` | `{watermarkPct, freeGb, level, sampledAt} \| null` | `sampleCapacity` + `judgeCapacity`；`level` 由新代码推导；整体失败 = `null` + `warnings[]` |
| `checkpoint` | `{path, createdAt, ageMin, bytes} \| null` | 该 agent 目录最新 `*.md`；`createdAt` 取 **front-matter `createdAt`**（v0.8.1 C2-B4：外部拷贝/还原会重置 mtime，而 front-matter 是产品自写的事实），缺失/不可解析才回退 mtime；无 = `null` |
| `suggestions` | `string[]`（≤5） | `stallSuggestion` + 依赖未满足等待项 + 单在途任务规则提示 + 认领建议 + 容量 RED 建议行（同款文案，不造第二套） |

**`id` 三视角下七要素的冻结语义**（视角必须在输出里自明：文本面加一行 `视角：self | task <id> | member <name>`，payload 带 `filter:{kind,id}`）：

| 要素 | `id` 缺省（self） | `id=<taskId>` | `id=<花名>` |
|---|---|---|---|
| `identity` | 调用方自己 | 调用方自己（受领人信息在 `tasks[].assignee`） | 调用方自己 |
| `tasks` | 我的开放任务 | 仅该任务一条（不限 assignee、不限状态，终态也出，供复盘） | 该成员的开放任务 |
| `pool` | pending 前 10 | 同 self（接手决策需要备选池） | 同 self |
| `unread` | 我的箱前 5 | 我的箱里该任务的件前 5；0 条时记「（我的箱里没有该任务的未读）」 | 该成员的**计数** `{count, urgentCount, top: []}`，payload 附 `unreadWithheld:"subjects"` |
| `capacity` | 机器级采样 | 同 self（容量是团队级事实） | 同 self |
| `checkpoint` | 我的目录最新一份 | 该任务受领人的目录最新一份（无受领人或无检查点 → `null`） | 该成员的目录最新一份 |
| `suggestions` | 全局（我的任务 + 池 + 容量） | 仅该任务（停滞/阻塞/依赖未满足/单在途规则提示；不含认领池建议） | 该成员名下的任务逐条给建议（含单在途任务规则，v0.8.1 C2-B9：该成员有在途且池有对其可认领项时，以第三人称给「<花名> 需先 xc_report 收尾当前任务（<id>）再认领 <id>」——读者不一定是该成员，不下走不通的祈使句）；无开放任务记「（该成员无开放任务）」 |

**预算与按章截断（不得静默丢要素）**：常量 `HANDOFF_BUDGET_CHARS = 4000`（代码常量，不进配置）。
先按基础帽渲染七章（tasks ≤5、pool ≤10、unread.top ≤5、suggestions ≤5、subject 80 字符），基础帽本身生效时在文本内披露
（「（另有 N 条未读…）」「（待领池共 M 个，列前 10）」）。超限 = **固定降级序列**（逐步重算，命中即停）：

1. `pool` 整章降为一行「（待领池按 4000 字符预算略去：xc_overview 看板）」；
2. `unread` 降为「未读 N 条（urgent M）」计数行；
3. `tasks` 只留第 1 条 + 「（另有 N 条我的任务略去）」；
4. `suggestions` 只留第 1 条；
5. 仍超限 → 整体文本按预算硬截，末行标注。

每级降级都要**留名**：payload `truncated: {budgetChars, shownChars, droppedSections: string[], cappedItems: Record<string,{shown,total}>}`；
文本末行 `[已按 4000 字符预算截断：略去/缩减 <名称…>；全文用 xc_read(scope:"inbox") / xc_overview / xc_read(scope:"task") 取]`。
**静默丢弃 = 验收失败**。降级序理由：`identity`/`tasks`/`suggestions` 是「接手」最小集，最后才动。

**payload 与文本面同帽**（v0.8.1 C2-B5）：`tasks`/`pool`/`unread.top`/`suggestions` 四个数组在 payload 里按**同一降级级**裁切，
`cappedItems.shown` 恒等于对应 payload 数组长度、`total` 为未裁全量；任一章被裁（基础帽或降级）`truncated` 即在场
（v0.8.0 的 cappedItems 描述文本层而 payload 保留全量，只读 JSON 的消费方会误判「没丢」）。JSON 面因此随降级序列同步收缩，
不被 4000 字符预算放行。

**审批门一致性**：`tool_request` 帧不得在接手包露出原文——未过门的转办请求帧 subject 渲染为
`[tool_request 审批门控帧]`（实现冻结值，`core/checkpoint.ts` `checkpointUnreadRef`；观测面包漏原文等于给 §11 的门开侧门）；
checkpoint 第 5 章同样只出索引（同一遮蔽助手）。


**空 self 包的连续性指针**（v0.8.1 C2-B3）：默认 self 接手包三要素（tasks/unread/checkpoint）全空、而花名册里有成员的会话
已不在场（peer 轴只读扫描判定：roster sessionId 与花名均无活记录）却持有这三类状态时，`suggestions` 首位给一条 continuity
建议（`continuity: 你的接手包为空，但花名册有不在场成员持有状态：<名>（N 开放任务/M 未读/有检查点）……先
xc_read({scope:"handoff", id:"<该成员名>"}) 寻回`），payload `warnings[]` 同步落同义一行——「新花名 identify 接手」的落地
点不再是一张静默白纸（数据仍可经成员视角寻址，v0.8.0 是默认面不给指针）。有自有任务/未读/检查点的成员不出该提示；
会话仍在场的持有者不出（它的活它自己干）。
**接手流程口径**：新会话 `xc_identify`（1）→ `xc_read({scope:"handoff"})`（2）→ 按 `suggestions` 直接 `xc_claim` 或续作（3），
**计数 = 真实 invoke 次数**。前提：`xc_claim` 只接 pending（非 pending 得 `task_not_pending`）；对仍归属他人的
in_progress/claimed/blocked 任务须同名 `xc_identify({takeover:true})` 或等 stale 清扫回池——`suggestions` 必须按任务真实状态
给可达指引，**不得给出走不通的指令**。

### 14.4 时间线视图（timeline）

API：`xc_overview({ view: "timeline", limit?: 20, offset?: 0 })`——免注册（overview 豁免纪律）、**不写 snapshot.json**（纯派生视图）。
读取：尾部窗口读——`stat` 得文件大小；> `TAIL_READ_MAX_BYTES`（256 KiB）时只读末段，否则全读；按 `\n` 切行后**丢弃窗口首行**
（可能被截断的半行）；解析复用 `core/jsonl.ts` 的 `parseJsonl`（坏行跳过；`jsonl.ts` 零改动）。

归一化字段（冻结）：`{ts, event, family, actor, taskId, summary}`。
`actor` 取值序（v0.8.1 冻结；29-v080 红队 C3-B1/M03 修复）：`agentKey ?? by ?? createdBy ?? approvedBy ?? from ?? assignee ?? member ?? to ?? null`——
`approvedBy`（tool-approval 的批准者）压 `from`（请求方/发送方/行为方），`from` 压 `to`（接收方），`member`（task-offline 所涉成员）垫在 `assignee` 之后；
v0.8.0 冻结链缺后三键，dispatch/message/tool-approval/tool-executed 等事件的 actor 落到接收方 `to` 或置空（审计核心「谁干的」系统性错配）。
`taskId` 归一（v0.8.1 C3-B5 文档化）：只接受非空字符串原样取之；**非字符串类型（数字/布尔/对象/null/缺省）一律归一为 `null`**（事件本身保留、不丢行）。
`summary` = 每族一个确定性模板，缺字段时退化到事件名本身——**永不为空串**；dispatch 族的「by」位只认显式派单方键
（`createdBy ?? by ?? from`），缺省时省略 by 子句（不渲染 `dispatch → X by X` 的自指句）。

| family | event 名 |
|---|---|
| `dispatch` | `dispatch`、`dispatch-refused` |
| `claim` | `claim` |
| `report` | `report` |
| `sweep` | `task-swept`、`revoked-stale`、`task-sweep-deferred`（v0.9.1 活性豁免留痕，§12.4） |
| `offline` | `task-offline` |
| `approval` | `tool-approval-request`、`tool-approval`、`tool-expired` |
| `tool` | `tool-request`、`tool-executed`、`tool-result-rejected` |
| `lead` | `lead-set`、`lead-transfer`、`lead-release` |
| `member` | `member-added`、`member-add-started`、`member-add-failed`、`member-stopped`、`member-archive-written`、`member-archive-failed`、`member-provision-timeout`、`member-takeover` |
| `liveness` | `session-running`、`session-idle`（v0.9.0 G-9，§12.4）、`session-record-anomaly`（v0.9.1 活性字段异常审计） |
| `other` | 其余全部（含 `status`/`inject-budget`/`inbox-check` 等高频噪声事件） |

`limit` 缺省 20、上限 100；`limit > 100` 钳到 100 并披露 `limitClamped: {requested, applied}`。
**排序**（v0.8.1 C3-B2 修复）：按 `ts` **降序**（稳定排序；同 `ts` 保反向文件序 = 后写者在前）——v0.8.0 按文件行位置反向，
非单调日志（手改/合并/多写者时钟漂移）下「newest-first」承诺与所显示时间戳矛盾；产品自身追加时序下两者等价（真实日志零逆序）。
`offset` 语义 = **自最新往回跳过 N 条**（与板面「自头部偏移」不同，工具描述与字段级 describe 都写明，防误用）。该指针是**位置游标**
（v0.8.1 C3-B7 披露）：日志实时追加时游标相对漂移——续读可能**跳号**（追加量 ≥ 偏移差）或**重叠**，静态日志下才精确；
需要严格不重不漏就加大 `limit` 一次取足。截断尾注文本与本节双面披露该语义。
预算：`receiverInjectBudget` + `batchWindowCount` 对 `JSON.stringify(entry).length` 开窗；刻度优先取**调用方经 `xc_identify` 逐会话声名的
`contextChars`**（§8「逐会话覆盖声明值」；v0.8.1 C3-B8 修复——v0.8.0 的 timeline 只认 env，逐会话声明被忽略），回落 env `XC_CONTEXT_CHARS`/200k。
超限给 `truncated: {shown, total, budgetChars}` + 续读指针 `xc_overview({view:"timeline", offset:<shown+offset>})`。
**跳过披露**（v0.8.1 C3-B3）：窗口内非空行中未能归一化的条数（坏 JSON 行 + 形状不符：非对象/缺 `event`/`ts` 非有限数）计
`skippedEvents`，>0 时随 payload 与文本视图披露——`total` 只计归一化成功事件，两者相加才与窗口内非空行数对账（空行按 `parseJsonl` 纪律不计）。
**尾窗披露**（v0.8.1 C3-B6/M04 修复）：文件确被尾部窗口截断（size > `TAIL_READ_MAX_BYTES`）时，**每一页**都披露
`tailWindowBytes` + `olderEventsOmitted: true`（v0.8.0 只在「窗口内事件 < limit+offset」的远 offset 末页披露，默认首页看不到）——不假装看全历史。
文本视图对日志派生字段做控制字符清洗（C0/C1 折空格，v0.8.1 C3-B4）；JSON payload 保持原值（`JSON.stringify` 正常转义）。

**v0.9.0 新事件族冻结（集成道收口，替换并行期占位段）**：组 A（活性与清扫）的会话活性事件族
`session-running` / `session-idle` → family `liveness`（§12.4 冻结，迁移键 `prev`/`state`）——已并入上方
family 表与 `TIMELINE_FAMILY_BY_EVENT`（core/timeline.ts）。组 B（配置/唤醒/送达）新增事件
`config-malformed` / `wake-retry` / `wake-retry-failed`（`wake-skipped` payload 增 `wakeGateSource` /
`configWarning` 可选键）**不扩 family 表**——与既有 wake 系事件（`wake-child`/`wake-failed`/`wake-skipped`）
同入 `other` 族，actor 取值序沿用上方 v0.8.1 冻结链不改。组 C 本版自有的
`message-withdrawn` / `message-withdraw-rejected`（§7.1）同入 `other` 族，不扩 family 表
（表变更属渲染面；`TIMELINE_FAMILY_BY_EVENT` 之外的事件一律回落 `other`，见 core/timeline.ts `timelineFamilyOf`）。

### 14.5 紧凑状态视图（status；替代状态栏）

API：`xc_overview({ view: "status" })`——免注册、不写 snapshot。单块紧凑文本，**行序冻结**：

```text
team: default | lead: alice | members: 3 (offline 1)
tasks: pending 2 / claimed 1 / in_progress 2 / blocked 1 / completed 3 / failed 0 / cancelled 0 | stalled 1
capacity: GREEN | 水位 23.5% 可用 | 并发回合 2 | sampledAt 2026-11-15T18:00:00Z
checkpoint: alice=12min前, bob=180min前, carol=(none)   # carol 无检查点也列出（记 (none)）；carol 亦可以是调用方本人
unread: alice=3, bob=0, carol=1
```

口径（必须与真实状态一致；**复用而非重写**）：任务计数 = 按 `team.tasks[].status` 全量计数（七态一个不漏）；
`stalled` = `stalledTasks` 计数（阈值钳制/非法回落两级披露：payload `stalledThresholdClamped`/`stalledThresholdFallback` + 文本 WARNING，v0.8.1 C4-F2——`XC_STALL_MINUTES` 的 0/负数/非数字不再静默回落 120min，与 offline 家族拉齐）；`offline` = `offlineMembersMount` 成员数
（阈值钳制/非法回落两级披露：payload `offlineThresholdClamped`/`offlineThresholdFallback` + 文本 WARNING；v0.8.1 C4-F1 前 status 只有 WARNING 无 payload 键，与 team 视图不对称，现已同键）；`capacity` = `capacityMount`——挂载返回 null 时写 `UNKNOWN`
（不写 GREEN，不谎报水位），RED 时附 `COMPRESS_ADVICE_LINE`（C9 原句复用）；`XC_MEM_WARN_WATERMARK` 越界（0/负数/≥1/非数字）时 capacity 块附 `memWarnWatermarkFallback:true` + 文本 WARNING（v0.8.1 C4-O1，不再静默按缺省判定）；`checkpoint` = 对 `me`（已注册时）与**所有花名册成员**列「年龄 min 前」
（**精确分钟**，v0.8.1 C5-BUG-C5-02：v0.8.0 按 min/h/d 阶梯向下取整——26h 渲染成「1d前」，与 handoff 文本/payload 的
精确 `ageMin` 跨面粒度不一致；年龄取数 = `now - front-matter createdAt`，缺失/不可解析回退 mtime，与 handoff 同源，C2-B4），
无检查点记 `(none)`（**不省略**——与 `unread` 行的「对每个成员」平行，谁还没落检查点一眼可见；v0.8.1 C4-F3：v0.8.0 散文写「所有有检查点的成员」而同节示例含 `carol=(none)`，文档自相矛盾，实现与示例口径一致故以散文对齐示例，非改行为）；`unread` = 对每个成员 `readMailbox` + `countUnreadFor`
（与板面同口径——观测面必须自洽）。
预算：`receiverInjectBudget` + 固定降级序（`unread` 行 → `checkpoint` 行 → `offline`/`stalled` 明细行 → `capacity` 明细行），每级留名披露 `truncated`。
v0.9.0（G-9）增量：payload 顶层增 `liveness:{running,idle,dead,byMember}` 块（成员活性，§12.4 口径）——**文本行序冻结不加行**（活性只在 payload；`byMember` 值形状与 team/panel 的 `members[].liveness` 完全一致，三视图同源 `memberLivenessView` 单一实现）。

## 15. v0.9.1 增量：文件引用（G-10）/ spawn 前容量闸（G-12-b）/ 消费确认（G-12v3）

> 本节是 v0.9.1 三组修复中【组 C 传输与容量】的协议下沉处（refs + 容量闸 + G-17 结论），
> 并冻结组 A（消息可靠性）的消费确认契约供跨组对拍。工具面仍**恰 10**、命令 8、
> **0 新增必填配置**（本节所有旋钮都是可选高级 env，见 §9）。

### 15.1 消息文件引用 `refs`（G-10：跨会话传文件 = 传引用，不传内容）

**缺口事实**（2026-11-19 实测）：消息通道是纯文本 JSON（帧硬闸 1 MiB + 注入预算
16k 字符），`[img]` 是工单系统语法、crosschat 注入面不渲染——「消息送达但图不可见」。
合规解法（符合文件真源架构）不是附件区也不是 base64 内联，而是**消息带引用**：

`xc_relay({to, msg, refs:[{path, sha256?, mime?, note?}]})`——队内轴与 peer 轴均可选带。

- **path 必须是工作区内真实普通文件**：复用 `xc_report` evidence 的三道硬闸（同一实现
  `mcp/tools-relay.ts resolveMessageRefs`，锁外现算——sha256 是慢操作，§2.7-4）：
  ① 越出工作区 → `evidence_path_outside_workspace`；② 目录/设备文件 → `evidence_not_a_file`；
  ③ 不存在/不可读 → `evidence_file_missing`。三个错误的 payload 都带 `field:"refs"`
  （标明触发面，与 evidence 门的键集只差这一个键）。
- **sha256 缺省由工具现算**（流式，不整文件读进内存）；声明值与现算值不符 →
  `evidence_checksum_mismatch` 整单拒绝（hex 大小写不敏感、首尾空白忽略）。
- **整单拒绝语义**：任一条不过 → 一个字节都不落箱（调用方可直接重试，无副作用）。
  空数组 `[]` 按「未声明」处理（不落空键）。
- **note** 可选性显式（省略按空串入库；控制字符清洗为空格、长度钳 500 字符，与
  `sanitizeEvidenceNote` 同口径）；**mime** 仅提示（如 `image/png`），不参与任何判定。
- **不做的事**（红线）：不内联文件内容、不做 base64、不新增工具、不新增必填配置、
  不改消息通道的纯文本 JSON 形态。文件真源架构不变——引用指向的文件才是内容真源。

落箱真源：队内轴 `TeamMessage.refs`（`core/types.ts`；`xc_read` 的 JSON entry 经
`{...m}` 展开原样可见）；peer 轴 `PeerQueueItem.refs`（`core/peermsg.ts`）。

**渲染面**（`core/peerenvelope.ts`，信封内、正文后、闭标签前；提示句逐字节冻结）：

```text
[文件引用] 以下是发送方已核验的工作区内真实文件（sha256 可复算核对）——用 Read 打开该路径查看，内容不内联本消息：
- ref: <path> | sha256:<hex> | mime:<类型> | note:<摘要>
```

真引用块只由消息元数据渲染一次；正文内嵌的伪造引用块（提示句逐字 + `- ref: ` 前缀行）
一律先剥离再重包（`stripForgedRefsMarkup`，与 INTERRUPT 横幅/回信指引同一「信任工件
只在引擎渲染面出现一次」纪律，V090-13 同族）。

**payload 回显**（队内轴；键集冻结，值为占位；契约测试按 `Object.keys` 对拍）：

```json
{"messageId":"<messageId>","delivered":"mailbox","refs":[{"path":"<path>","sha256":"<hex>","note":"<摘要>"}]}
```

resolved 引用条目的键序冻结为 `path` / `sha256` / `mime`（仅声明时）/ `note`（恒在，
可空串）；`duplicate` 路径不回显 refs（返回的是既有件，其引用集可能与本次不同——
不虚报「这条带了新引用」）。

**peer 轴载体边界（如实声明，同 urgent 既有纪律）**：管道 `MsgFrame` 白名单冻结
（`transport/frames.ts` 封闭字段集，混合版本端点对未知字段整帧拒收），因此 refs 只随
**文件退化**队列项携带。`via=pipe` 时 payload 带 `refsCarried:false` + 摘要行说明
（「文件引用只在文件退化路径生效……或改走队内轴」），`via=file` 时 `refsCarried:true`：

```json
{"msgId":"<msgId>","to":"<peer 名>","receipt":"delivered","via":"file","axis":"peer","refs":[{"path":"<path>","sha256":"<hex>","note":""}],"refsCarried":true}
```

**去重口径（v0.9.1 V090-12 同族增量）**：`findDuplicateMail` 命中后，若本次显式带了
refs 而既有件的引用集不同（JSON 逐字节比对），**不判 duplicate**——「同一句正文 + 一张
新截图」必须真达收方（否则 payload 报着新 refs、收方看到的旧件无引用）。无 refs 的
普通同文仍按原语义去重。键函数在 `engine/wake.ts`（组 A 文件域），比对在调用侧
`mcp/tools-relay.ts`（不改键函数）。

### 15.2 spawn 前容量闸与 `wake-deferred`（G-12-b：容量只警不拦 = 死亡螺旋）

**缺口事实**：RED 判定本身正确（仲裁 3：单回合预估与含进程树成本同量级，早先「预估高
4-5 倍」的批评被推翻），但 `attemptWake` 不读 capacity verdict——内存枯竭期继续 spawn
无头 `--resume` 子进程 → 更多 OOM（当日 wake-failed 16+、水位 8.9%、并发 13）。

**闸门位置**：`attemptWake` 步骤 3.8，在分层唤醒闸 / 在途 nonce / 成员状态门 /
spawn 配置闸之后、`createWakeNonce` **之前**——前面的门都不触发时才值得采样
（采样有 60s 缓存窗，成本 = 一次文件读 + `os.freemem()`）。与组 A 的边界：**容量闸在
spawn 前，消费确认在 spawn 后**（§15.3），两者互不覆盖。

**判据**（G-12-b 原文「水位<硬底或边际预估>freeBytes」）：
① `judgeCapacity` 任一规则命中（watermark 硬底 / session-limit / turn-concurrency，
degraded 样本只评 watermark——不虚报）；
② **边际预估**：单回合预估 `XC_TURN_ESTIMATE_BYTES` > 当前 `freeBytes`（再起一个无头
回合也放不下）。

**动作**：不 spawn、不写 nonce、不盖租约（跳过路径不留 15min 在途标记，与成员状态门
同纪律）→ `delivered:"mailbox"` + payload `wake-deferred` 块 + engine 事件
`wake-deferred` + 冷却窗。冷却窗内再来的唤醒不重复采样、不 spawn（RED 期的重试风暴
本身是放大器）；窗到期重新采样，转 GREEN 即删本键域的冷却记录、下次唤醒立即通行。

**v0.9.2 增量（34-v091验收 V091-13/14/15/18/19，五条 mustFix 全落本闸）**：

- **C3 冷却键分域**：冷却记录落 `capacity/wake-deferred.json`，形态为
  `{version:2, entries:{"<teamId>|<收方>|<urgent|normal>": {until, sampledAt, scope, …}}}`
  ——键 = teamId + 收方 + 紧急度（`wakeCooldownKeyOf`）。v0.9.1 只按 stateRoot 一个键：
  一个成员的 RED 把全队唤醒（含紧急 relay、含别的 team）在窗内一并静默转 mailbox，且窗内
  连 `judgeCapacity` 都不跑。v0.9.1 的平铺记录（无 `version`/`entries`）**不迁移**，按损坏
  处理 → 重新判定（最坏多采样一次，不把旧格式误读成别域的挡门）；损坏/过期 → 重新判定，
  不因冷却文件坏掉而永久挡唤醒。
- **C3 窗内沿用明示**：窗内命中时 `detail` 追加 `cooldown-reuse` 行，写明「未重采样，
  detail 与水位是 `<ISO 时刻>` 首次判定时刻的快照（按当时 env 阈值与水位判定），不是此刻
  读数」——兑现「跨面可对账」：五个观测面全绿而唤醒决策面称 capacity-red 时，读者能看出
  后者引用的是旧快照（V091-19）。
- **C3 冷却 env 上钳**：`XC_MEM_WAKE_COOLDOWN_MS` ≤ 3600000ms（1h，`WAKE_CAPACITY_COOLDOWN_MS_MAX`）。
  非法值（非数字/负数）→ 回落内置缺省 120000；超上钳 → 按上钳生效；两者都在 deferral
  `detail` 里写一行（`cooldown-clamped:` / `cooldown-env:`），**不静默**（V091-15 实测
  `999999999999` 曾照收 = 277777.78h）。
- **C2 degraded 披露**：CIM 不可用（采样成功但拿不到进程树）时进程类规则不评，且**放行
  路径也落事件** `wake-capacity-degraded`（`{degraded, watermark, freeBytes, detail, note}`；
  每状态根持续降级期间只落一次，采样恢复即除名）。此前「进程类规则未评」的 detail 只在
  判红时随 `wake-deferred` 落盘，GREEN 时被整体丢弃——宿主 CIM 坏了而闸静默放行，运维
  零线索（V091-14）。面板文本同口径：degraded 样本的「常驻树 / 并发回合」显示
  `n/a（CIM 进程采样不可用，未评）`，不显示 0（0 会被读成「此刻没有回合」的断言）。
- **C1 进程归类**：headless-turn 只认**唤醒子标记**（`WAKE_CHILD_COMMAND_MARKER` = 唤醒
  prompt 的冻结回执前缀，随 `--prompt` 进命令行、CIM 可见；env 标记 `XC_WAKE_CHILD=1` 由
  `spawnResume` 注入、只达子进程，CIM 读不到他人 env 故不作采样判据）。原「`zcode.cjs` ∧
  ¬app-server ∧ ¬--surface」形态规则**已删除**——它把 README 文档化的用户 CLI 误归回合树，
  单个 >800MB 的用户 CLI 即判 session-limit 红、合法唤醒被静默转 mailbox（V091-13）。
  无标记的 `--resume` 命令行归 main：宁漏计并发回合，不制造假红。
- 采样意外（os 读数异常等）→ **fail-open** + `wake-capacity-probe-failed` 事件（不因观测
  故障永久挡住协作唤醒）。

**`wake-deferred` payload 块**（键集冻结，值为占位；契约测试按 `Object.keys` 对拍）：

```json
{"reason":"capacity-red","detail":["watermark: 可用内存 8.9% < 预警线 15.0%（XC_MEM_WARN_WATERMARK；可用 2.79GB / 总 31.30GB）"],"watermark":0.089,"freeBytes":2790000000,"cooldownMs":120000,"retryAfterMs":120000,"cooldownActive":false}
```

**engine 事件 `wake-deferred`**（键集冻结，行级 `ts` 除外）：

```json
{"event":"wake-deferred","reason":"capacity-red","scene":"message","teamId":"default","to":"b","watermark":0.089,"freeBytes":2790000000,"detail":["<命中规则明细>"],"cooldownMs":120000,"retryAfterMs":120000,"cooldownActive":false,"wakeGateEnabled":true,"gateEnv":"off","urgent":false}
```

`gateEnv` = `XC_MEM_WAKE_GATE` **原值**（未设/空串 = `null`）——v0.9.2 C5/V091-18 兑现
`wakeCapacityGateEnabledFromEnv` 注释里的承诺：布尔 `wakeGateEnabled` 分不清「我没配」与
「我配错了」，原值可以（示例值 `"off"` 表示运维显式关闸；`"true"`/`"yes"` 等非 `off` 值都
按开启处理并原样落盘）。`urgent` = 本次唤醒是否紧急（冷却键域的第三维；与 `wake` 事件
的 `urgent` 同口径，恒在而非仅 true 时在场——键集冻结要求形状稳定）。

**env**（均可选，缺省即工作；`XC_MEM_WAKE_GATE=off` 关闸回到 v0.9.0「只警不拦」行为）：
`XC_MEM_WAKE_COOLDOWN_MS`（缺省 120000）、`XC_MEM_WAKE_GATE`、判据复用
`XC_MEM_WARN_WATERMARK` / `XC_TURN_ESTIMATE_BYTES`（§9）。

**如实边界**：① 闸只挡**唤醒**（spawn），不拦 pull——消息照常落邮箱，收方自己的回合
随时可读；② 派单面的「RED 期排队拒绝」需在派单工具面接线（`mcp/tools-tasks.ts` 属组 B
文件域），本版只在 wake 层给出 deferral 块 + 冷却窗，派单回执经既有 `note` 字段透出
原因与 `retryAfterMs` 窗口；③ 容量采样本身是设备级读数（`os.freemem` + CIM 进程树），
宿主若限制进程枚举则降级为只评 watermark（既有 degraded 口径）。

### 15.3 消费确认 `consumedAt` 与 limbo（G-12v3 机制 B；组 A 域实现，本节冻结契约）

**缺口事实**：`deliveredAt` 在 spawn 成功瞬间盖（fire-and-forget），子进程在成员回合
**消费内容前**死亡（内存红线 OOM / 宿主重启杀无头子进程）→ 消息已盖投递章、从未被读、
且因不再是 unread 而永不被未读注入钩子呈现。生产 4 实例经收方行为实测**零动作**。

**契约**（实现 = `core/mailbox.ts` / `engine/wake.ts` / `hooks/*`，组 A 文件域）：

- `TeamMessage.consumedAt`：**消费确认**时刻，与 `deliveredAt`（投递盖章）分离。
  回写面 = 成员回合真实消费（hook 未读注入 / `xc_read` / `xc_claim` 读件），幂等
  （已有值不被改写）。
- **limbo 降级**：`deliveredAt` 已盖而 `consumedAt` 超 `XC_LIMBO_TIMEOUT_MS`（缺省
  10min）未回写 → 团队锁内打回可重新投递态（清 `deliveredAt`/`deliveryClaimedAt`，
  `readAt`/`consumedAt` 不动）+ engine 事件 `message-limbo` + urgent 告知 lead。
  锁内复判「消费先到」则跳过（已被读，不是 limbo）；同一消息只降级一次。
- **wake-child 生命周期账**（`logs/wake-lifecycle-<to>-<ts>.jsonl`）：spawn 即写
  `{event:"wake-child-start", nonce, sid, to, scene, teamId, ts}` 头行；观察到子进程
  消失写 `{event:"wake-child-exit", pid, durationMs, exitCode, evidence?}` 尾行
  （孤儿化唤醒子退出码不可观测，如实记 `null`）。**0 字节日志永不出现**（至少有头行），
  且 0 字节依旧**不是**失败判据。
- **wake-slow**：spawn 后 `XC_WAKE_SLOW_MS`（缺省 5min）内目标 sid 无 session-start
  投影 → engine 事件 + urgent 告知 lead（「≥5min 且无 session-start」才判慢，慢写瞬态
  不误判）。
- 事件族键集冻结（行级 `ts` 除外；契约测试按 `Object.keys` 对拍）：

```json
{"event":"message-limbo","teamId":"default","to":"b","from":"a","messageId":"<messageId>","nonce":"<nonce>","sid":"<sid>","scene":"message","stampedAt":0,"downgradedAt":0,"waitedMs":600000,"timeoutMs":600000}
```

```json
{"event":"wake-slow","scene":"message","teamId":"default","to":"b","nonce":"<nonce>","sid":"<sid>","pid":1234,"waitedMs":300000,"thresholdMs":300000}
```

`message-limbo` 的 `taskId` 为可选键（消息绑定了任务时才出现）。

### 15.4 G-17 可行性结论：无头回合 MCP 子集加载（宿主层，本版不实现）

**诉求**（GAP 第八批仲裁 3）：主控实测每回合 ≈1GB（主进程 290MB + 7-9 个 plugin host
×85-100MB）——若只给无头回合挂 crosschat + ticket 两个 MCP server（plugin host 7-9→2），
每回合可省 ~600MB；RED 期这条与容量闸（§15.2）叠加是内存危机最直接的杠杆。

**结论：插件无法控制宿主为无头回合加载哪些 plugin——属宿主层能力，本版只出结论与
平台反馈建议，不自造实现。** 依据（均可复现）：

1. crosschat 的 MCP server 是宿主**之外**的独立 stdio 进程（README「转办怎么走」同款
   事实），看不到宿主为某个会话装配了哪些 MCP server，也没有「配置别的 server 装载集」
   的接口；
2. 唤醒路径只持有 `spawnResume`（`engine/resume-cli.ts`：`--resume <sid>` + prompt +
   `--cwd`），无「会话级 MCP 装配」参数；宿主的 CreateSession/SendToSession 侧才决定
   plugin host 的装载；
3. 插件能做的只有「少唤醒」（§15.2 容量闸）与「让回合自己少干活」（成员守则 v2 的
   不空转轮询），都不是子集加载本身。

**平台反馈建议**（转 zcode 平台侧，不在本插件交付范围）：

1. 无头/`--resume` 回合支持**按会话声明 MCP 子集**（如 `--mcp-subset crosschat,ticket`
   或会话记录里的 `mcpServers` 覆盖），使无人值守回合不为用不到的 server 起 plugin host；
2. 或提供「回合结束回收空闲 plugin host」的宿主策略（与诉求同效，插件零参与）；
3. 宿主暴露**只读**的「本会话已装载 MCP server 清单」，让插件至少能如实诊断
   「这个会话为什么有 9 个 plugin host」（当前只能靠进程树采样旁证，见 §5）。

同族边界（一并记录，本版不修）：G-15 lead 工具白名单（会拦合法操作，需用户拍板延后）；
宿主不允许插件否决工具调用 → G-14 上界只能是醒目重复注入，不得声称能拦截首条工具调用。

### 15.5 v0.9.2 增量：主动告警链（A1 同步启动确认 / A2 成员看门狗）

> 本节是 v0.9.2 组 A「主动告警链 + limbo 校准」的协议下沉处：两个新 env 与 6 个新
> engine 事件的冻结键集（值为占位；契约测试按 `Object.keys` 对拍）。工具面仍**恰 10**、
> 命令 8、**0 新增必填配置**（两个 env 均仅代码读取、可选带缺省，见 §9）。

**缺口事实**（用户核心诉求「消息发出去后，主控不能自以为进程启动了」）：① `delivered:"wake"`
只表示「已发起」，无启动确认；② 无全局看门狗——唯一监视器是每次 spawn 的 15min 有界
监视器，且宿主是派发方进程；③ `notifyLeadUrgent` 只写 lead 邮箱**不唤醒**，lead 空闲时
消息永远躺着。

**A1 同步启动确认**：spawn 后在 `XC_START_CONFIRM_MS`（缺省 5000ms）内观察 wake-child
启动证据（helper 汇报的唤醒子 pid）→ 回执 `startConfirmed:true`；窗口内未见 → `false`
+ 措辞「已发起但未见启动证据」（**仍非送达确认，也非失败**——失败由 `wake-failed` 事件
与邮箱 pull 兜底）。双通道披露：生命周期账 `logs/wake-lifecycle-<to>-<ts>.jsonl` 记
`wake-child-start-confirmed` / `wake-child-start-unconfirmed` 行（与 spawn 前的
`wake-child-start` 头行并排，运维一眼看出「发起了」与「起来了」的差别）；engine.jsonl
记 `wake-start-confirm` 事件供时间线查询（A3 的事故计数**不**消费它，唤醒失败另有
`wake-failed` 事件）。

**engine 事件 `wake-start-confirm`**（键集冻结，行级 `ts` 除外；`pid` 仅确认时在场）：

```json
{"event":"wake-start-confirm","nonce":"<nonce 摘要>","sid":"<sid>","to":"b","scene":"message","teamId":"default","waitedMs":1200,"thresholdMs":5000,"pid":1234,"startConfirmed":true}
```

**A2 成员看门狗（推）**：lead 的 MCP server 内一个轻量常驻定时器
（`XC_WATCHDOG_MS` 缺省 60s，`0`=关；unref，引擎进程退出即停，观测面不拖进程），每节拍扫
成员 pid 活性 / 在途 nonce / limbo 三类判据（全部从落盘真源现算）。**仅状态迁移时发**
（同一成员同一次死亡只发一次，状态真源 `capacity/watchdog-state.json`；跨进程认领锁保证
同一次事故只有一个通告者）；发 = engine 事件 + lead 邮箱 urgent + **尝试唤醒 lead**
（受 §15.2 容量闸约束，冷却/延迟按该节口径）。lead 自己死 → 通知其余在册成员并唤醒
（复用 C6-BUG-4「不通知崩溃者自己的邮箱」口径：已判 pid-dead 的成员一律不收）。
看门狗全部随进程死亡时，由 UserPromptSubmit 的**回合开始事故摘要**（自上次回合
`lastTurnTs`：N 个成员死亡 / M 条 limbo 降级 / K 次唤醒失败）兜底。

**engine 事件 `member-dead`**（键集冻结，行级 `ts` 除外）：

```json
{"event":"member-dead","teamId":"default","member":"b","sessionId":"<sid>","liveness":"pid-dead","evidence":"process-dead","via":"watchdog"}
```

**engine 事件 `wake-orphan-nonce`**（在途 nonce 未消费而唤醒子已退出——该轮唤醒疑似
无声死亡；键集冻结，行级 `ts` 除外）：

```json
{"event":"wake-orphan-nonce","teamId":"default","to":"b","nonce":"<nonce 摘要>","nonceTs":0,"sid":"<sid>","note":"在途 nonce 未消费而唤醒子已退出——该轮唤醒疑似无声死亡（消息仍在邮箱，pull 兜底不丢）"}
```

**engine 事件 `watchdog-wake`**（键集冻结，行级 `ts` 除外；`note` / `wakeDeferred` /
`retryAfterMs` / `detail` 为可选键，仅在有值时在场——后者三个是容量闸 deferral 透出）：

```json
{"event":"watchdog-wake","teamId":"default","to":"b","delivered":"wake"}
```

**engine 事件 `watchdog-notify-skipped`**（无人可通知：lead 死且无其他活成员 / 全员
不可寻址 → 只落审计，不抛、不回退；键集冻结，行级 `ts` 除外）：

```json
{"event":"watchdog-notify-skipped","teamId":"default","reason":"lead-dead-no-other-live-members","incidents":2,"deadThisRound":["lead"]}
```

**engine 事件 `watchdog-sweep-failed`**（定时器回调纪律：永不抛，扫描意外只留痕、下轮
再试；键集冻结，行级 `ts` 除外）：

```json
{"event":"watchdog-sweep-failed","teamId":"default","error":"<error.message>"}
```

**`message-limbo` 双生产者形状**（§15.3 契约的 v0.9.2 修订）：同一事件名有两个生产者，
键集按可选键分辨，读取面不得要求任一生产者独有的键恒在：

1. **per-spawn 监视器**（`engine/wake.ts`，该唤醒轮次自己扫）——落全量键，`nonce` /
   `sid` / `scene` / `stampedAt` / `waitedMs` 在场；
2. **看门狗清扫**（`engine/watchdog.ts`，轮询面补扫）——只落最小键 + `via:"watchdog"`。

两者共用 `core/mailbox.ts` 的候选判据与 watchdog-state 的 `(messageId, 轮次)` 节流台账；
降级在团队锁内且判据自销（`deliveredAt` 被清）⇒ 同一次失效恰一次降级、告警 1:1，不被
重叠扫描放大（A4-c 节流）。

```json
{"event":"message-limbo","teamId":"default","to":"b","from":"a","messageId":"<messageId>","nonce":"<nonce 摘要>","sid":"<sid>","scene":"message","stampedAt":0,"downgradedAt":0,"waitedMs":600000,"timeoutMs":600000}
```

```json
{"event":"message-limbo","teamId":"default","to":"b","from":"a","messageId":"<messageId>","downgradedAt":0,"timeoutMs":600000,"via":"watchdog"}
```

**A4 limbo 校准**（判据交叉校验活性，复用 wake-slow 的 `sessionStartedSince`/lastSeen
投影）：(a) 锁竞争回写失败 → 宽限重试不降级；(b) wake prompt 已内嵌消息全文时记
`injectedConsumed`，不因未调 `xc_read` 而误判；(c) 降级告警按 `(messageId, 轮次)` 节流。

**env**（均可选，缺省即工作；仅代码读取、不进插件设置面，见 §9）：
`XC_START_CONFIRM_MS`（A1 启动确认窗口，缺省 5000ms；0/负/非整数/不可解析回落缺省）、
`XC_WATCHDOG_MS`（A2 轮询间隔，缺省 60000ms；`0`=关，非数字/负数回落缺省）。

**如实边界**：看门狗是**观测与告警**面，不取消任务、不撤回消息、不拦 pull（消息照常落
邮箱，pull 兜底不丢）；同机持续伪造 `consumedAt`/`lastSeen` 仍属威胁模型边界（§10 口径，
不做签名）；A1 的启动确认是**进程起来**的证据，不是**内容被消费**的证据（后者由
`consumedAt`/`readAt` 说话，§15.3）。
