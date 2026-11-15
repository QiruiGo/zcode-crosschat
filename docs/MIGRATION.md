# MIGRATION：v0.5.x → v0.6.0 迁移表（26 工具 → 10 工具；旧名 v0.7.0 已移除）

> v0.6.0 把 MCP 工具面从 26 个收敛为 10 个（ breaking change，方案 §2）。
> v0.6.0 期间 22 个更名旧名经弃用覆盖层保持可调用（打印弃用警告 + payload 披露）；
> **v0.7.0 已移除**（MIGRATION §5 承诺执行）：alias 覆盖层整文件删除，调用旧名得标准错误
> `Tool <name> not found`（InvalidParams）。本文是迁移细节的唯一下沉处，下表保留为历史对照。

## 1. 新旧对照（22 个更名旧名；v0.7.0 已移除，下表为历史对照）

| 旧名（v0.5.x） | 新入口（v0.6.0） | 参数映射 | 备注 | v0.7.0 状态 |
|---|---|---|---|---|
| `xc_register` | `xc_identify` | `name→name`；`sessionId→sessionId`（必填透传）；`role→role`；`wakeToken→wakeToken` | `regToken` 忽略，响应 payload 以 `ignored:["regToken"]` 披露 | 已移除 |
| `xc_peer_register` | `xc_identify` | `name/displayName/kind/modeClass/contextChars→同名`；`sessionId` 必填透传 | `regToken` 以 `ignored` 披露 | 已移除 |
| `xc_peer_rename` | `xc_identify` | `name→name`（改名语义） | 纯旧参（只有 name）的调用需补 `sessionId`，否则 `invalid_params` | 已移除 |
| `xc_check_inbox` | `xc_read` | `→{scope:"inbox"}` | 读即消费；预算窗口外消息保持未读 | 已移除 |
| `xc_mail_read` | `xc_read` | `messageId→id`；`offset/limit→同名`；`→{scope:"mail"}` | — | 已移除 |
| `xc_task_read` | `xc_read` | `taskId→id`；`field→field`；`offset/limit→同名`；`→{scope:"task"}` | — | 已移除 |
| `xc_peer_inbox` | `xc_read` | `limit→limit`；`→{scope:"peer"}` | — | 已移除 |
| `xc_peer_read` | `xc_read` | `msgId→id`；`offset/limit→同名`；`→{scope:"peer-msg"}` | — | 已移除 |
| `xc_message` | `xc_relay` | `content→msg`；`to/sourceTaskId/sourceAttemptId→同名` | `forwardOf` → 显式错误 `forwardOf_removed` | 已移除 |
| `xc_peer_send` | `xc_relay` | `message→msg`；`to/summary→同名` | `forwardOf` → 显式错误 `forwardOf_removed` | 已移除 |
| `xc_status` | `xc_overview` | `history→history`；`offset→offset` | `teamId` 忽略（v0.6 单队固定 default）；缺省 view=team | 已移除 |
| `xc_peers` | `xc_overview` | `→{view:"peers"}` | `kind` 忽略（新面一次列全三类） | 已移除 |
| `xc_agents` | `xc_overview` | `→{view:"panel"}` | — | 已移除 |
| `xc_team_init` | `xc_team` | `→{action:"init", takeover}` | — | 已移除 |
| `xc_lead_transfer` | `xc_team` | `to/reason→同名`；`→{action:"transfer"}` | — | 已移除 |
| `xc_lead_release` | `xc_team` | `→{action:"release"}` | — | 已移除 |
| `xc_member_add` | `xc_team` | `name/model/reasoningLevel/note→同名`；`context→contextChars`；`→{action:"member-add"}` | — | 已移除 |
| `xc_member_stop` | `xc_team` | `name/reason→同名`；`→{action:"member-stop"}` | 新面 `archive` 缺省 true（停止前留档） | 已移除 |
| `xc_idle` | `xc_team` | `summary/idleReason/completedTaskId/completedStatus/failureReason/result→同名`；`→{action:"idle"}` | — | 已移除 |
| `xc_cancel` | `xc_team` | `taskId→taskId`；`→{action:"cancel"}` | — | 已移除 |
| `xc_inbound_review` | `xc_review` | `action/ids→同名`；`→{axis:"team"}` | — | 已移除 |
| `xc_peer_review` | `xc_review` | `action/ids→同名`；`→{axis:"peer"}` | — | 已移除 |

**4 个同名保留**（无弃用警告）：`xc_dispatch`（新增 `priority`）、`xc_claim`、`xc_report`（status 增 `blocked`）、`xc_doctor`。

## 2. 新工具面一览（10 个）

| 新工具 | 一句话 |
|---|---|
| `xc_identify(name, sessionId, {role, takeover, wakeToken, displayName, kind, modeClass, contextChars})` | 注册/重绑/改名/接管（两轴合一） |
| `xc_dispatch(to, title, prompt, {acceptance, dependsOn, priority})` | 派发（priority=high/normal/low） |
| `xc_claim(taskId)` | 原子认领，返回一次性 attemptId |
| `xc_report(taskId, attemptId, status, {result, error, evidence})` | 回报；status 增 `blocked`；evidence=文件+摘要 |
| `xc_read(scope, {id, field, offset, limit})` | 统一分页读（inbox/mail/task/peer/peer-msg/journal） |
| `xc_relay(to, msg, {urgent, interrupt, summary, sourceTaskId, sourceAttemptId})` | 发消息/介入传导合一 |
| `xc_overview({view, history, offset})` | 任务板/成员/peer/容量/停滞一体 |
| `xc_team(action, ...)` | 指挥族：init/transfer/release/member-add/member-stop/idle/cancel/unblock |
| `xc_review({action, axis, ids})` | 两轴入站审阅 |
| `xc_doctor` | 只读体检（免注册） |

## 3. 命令面映射（8 → 6 + 2 弃用存根）

| 旧命令 | v0.6.0 | 说明 |
|---|---|---|
| `/xc-work` | 保留，改调 `xc_identify` | 注册=identify |
| `/xc-dispatch` | 保留（增 priority 提示） | — |
| `/xc-inbox` | 保留，改调 `xc_read({scope:"inbox"})` | — |
| `/xc-status` | 保留，改调 `xc_overview` | 缺省 team 视图；「全景」用 panel |
| `/xc-team` | 保留，改调 `xc_team` | 吸收 `/xc-member` 的 add/stop |
| `/xc-say` | 保留，改调 `xc_relay` | urgent/interrupt 用法写入正文 |
| `/xc-agents` | **已删文件**（v0.7.0 执行移除） | 已并入 `/xc-status`（panel 视图） |
| `/xc-member` | **已删文件**（v0.7.0 执行移除） | 已并入 `/xc-team add|stop` |

## 4. 行为变化清单（改名之外）

| 变化 | v0.5.x | v0.6.0 | 迁移动作 |
|---|---|---|---|
| `forwardOf` 转发 | 支持（带 hop-chain 溯源） | **移除**；两个 relay 旧名带 `forwardOf` 显式报错 `forwardOf_removed` | 直接 `xc_relay` 撰写正文；批注另发一条 |
| `regToken` 锚定 | 重绑必验令牌（硬闸） | 软校验（sid 存在性+活性）；字段忽略并披露 | 停止传 `regToken`；同名冲突仍显式拒（`name_taken`） |
| evidence 哈希 | sha256 现算复核（不符整单拒） | v0.6.0 砍复核；**v0.7.1 恢复现算复核**（边界-7，PROTOCOL §4.1）：带了必须与文件内容一致（hex 大小写不敏感），不符 `evidence_checksum_mismatch` 整单拒；省略则由工具现算落库并随回执披露 `evidenceSha256` | 显式传 `sha256` 时确保与文件内容一致；省略亦可（工具现算）；`path`+`note` 仍足够（`note` 可选，控制字符入库前清洗为空格、钳 500 字符；目录/设备文件不得作证据 `evidence_not_a_file`） |
| 任务状态 | 六态 | 七态（+`blocked`，reason 必填） | 长任务暂停用 `xc_report(status:"blocked")`；解除用 `xc_team({action:"unblock"})` |
| 邮箱哈希链 | `.jsonl.int` sidecar 读写 + 篡改披露 | 删除（存量 sidecar 无害孤儿） | 无动作；磁盘篡改检测不再提供 |
| 同形字/零宽归一 | 花名归一 + 信封对抗检测 | 删除（README 已知限制声明） | 无动作 |
| 入站 hold | 三态审阅（accept/hold/refuse） | 默认直收；hold 为可选配置 | 需要时设 `inbound_mode`/`cross_session_inbound` |
| interrupt 打断 | 无此能力 | `xc_relay({interrupt:true})`，**平台限制下降级**为 urgent+下一回合必读（payload `deferred-next-turn` 如实回报） | 按「下一回合必读」设计流程 |

## 5. 弃用策略与时点

> **移除已执行（v0.7.0）**：以下 1–2 条为 v0.6.0–v0.6.1 期间的弃用覆盖层行为（历史记录）；
> v0.7.0 起覆盖层整文件删除（`mcp/alias.ts`），22 个别名与 2 个命令存根同版移除。

1. （v0.6 历史）旧名**不注册**进 `tools/list`（恰好 10 个新名）；调用侧经弃用覆盖层可达。
2. （v0.6 历史）覆盖层行为：参数映射（未映射旧参一律进 `ignored` 显式披露，禁静默丢弃）→ 同一核心实现 → 结果首块前缀
   `[DEPRECATED] <旧名> 已更名为 <新名>（v0.7.0 移除）。本次调用已正常执行。迁移表见 docs/MIGRATION.md。`
   + payload 注入 `deprecated:{tool, replacement, ignored?}`。
3. **移除时点：v0.7.0——已执行**：22 个别名（`mcp/alias.ts` 整文件删除，含 `installAliasLayer`/`ALIASES`/`DEPRECATION_NOTE`）与 2 个命令存根（`/xc-agents`、`/xc-member`，删文件）同版删除。未知名调用得标准错误 `Tool <name> not found`（InvalidParams）。**信封如实说明**：alias 覆盖层删除后运行时不再经 `dispatchPrimary` 中转，未知名由 MCP SDK 自带的未注册工具分支处理（`@modelcontextprotocol/sdk` `server/mcp.js`：抛 `McpError(InvalidParams, "Tool <name> not found")`，`McpServer` 再包成 `result.isError=true`、正文 `MCP error -32602: Tool <name> not found`）——错误码与消息文本与 v0.6.1 完全一致，只是信封从 JSON-RPC error 变成标准工具错误结果（两者都是 MCP 规范内的标准未知错误）。`dispatchPrimary` 仍保留同一消息文本（直接分发路径/单测口径）。`xc_relay({forwardOf})` 的显式 `forwardOf_removed` 由主路径守卫 `assertNoForwardOf` 承担（`mcp/tools-relay.ts`）。回归见 `mcp/legacy-removal.test.ts`（含 stdio 黑盒逐名抽验）。
4. 数据兼容：v0.5.3 的 `team.json`/邮箱/注册表在新版下照常读写（`priority/blocked*/urgent` 等新字段全部 optional 缺省化）。

## 6. 迁移自检

- 全量旧名 26 个 = 22 别名（本文 §1）+ 4 同名（§1 末行）；与 `git show v0.5.3:plugin/src/mcp/{tools,lead-tools,member-tools,peer-tools,guards,doctor-tool}.ts` 的注册名清单集合相等。
- （v0.6 期实测）旧名调用抽验：`tools/call xc_status` → 非 isError + 首块 `[DEPRECATED]` + payload `deprecated.replacement=xc_overview`。
- （v0.7.0 起）旧名调用抽验口径反转：`tools/call xc_status`（及 §1 表全部 22 个）→ 标准未知错误 `Tool <name> not found`（InvalidParams -32602；运行时信封 = `result.isError=true` + 正文 `MCP error -32602: Tool <name> not found`，见 §5-3）；`tools/list` 仍恰 10 个新名——由 `mcp/legacy-removal.test.ts` 逐名断言（dispatcher 直驱 + stdio 黑盒双口径）。
