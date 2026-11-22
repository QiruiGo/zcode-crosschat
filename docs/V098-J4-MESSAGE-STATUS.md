# v0.9.8 J4：一行消息状态（messageId → 状态）口径

> 定稿：2026-11-22 · 属主：组 M（消息可见性）· 唯一实现：`plugin/src/core/mailbox.ts`（状态阶梯）
> 与 `plugin/src/mcp/tools-read.ts`（读取面与权限）；本文档是**写死的口径声明**。
>
> v0.9.9 修订（V098-03）：`refused` 判据从「解析消息正文」改为「引擎凭据对账」——
> 帧形状降为必要不充分条件，正文里嵌 `delivery-refused` JSON 不再伪造状态；收方
> carve-out 随之只对 genuine 回执生效（§二/§三/§四/§五.3）。

## 一、读取面

```
xc_read({ scope: "mail", id: "<messageId>", statusOnly: true })
```

- **不加工具、不加必填配置**：`statusOnly` 是 `xc_read` 的可选布尔参数（不变式 1：工具面恰 10）。
- 返回**一行**人可读状态 + JSON 负载（`messageId/status/from/to/ts/location/stamps/milestones`）。
- **只返回状态与印章，不返回正文**（权限模型：不开放读别人邮箱内容）。

## 二、状态阶梯（写死，按优先级取第一个命中的）

| 状态 | 判据（邮箱真源） | 语义 |
|---|---|---|
| `queued` | 在主邮箱 ∧ 无 `deliveredAt`（含只盖了投递租约 `deliveryClaimedAt` 的形态） | 排队等投递 |
| `delivered` | `deliveredAt` ∧ 无 `consumedAt` ∧ 无 `readAt` | 已进对方邮箱，对方尚未知悉 |
| `injected` | `consumedAt` ∧ 无 `readAt` | 已进对方回合提示（钩子回合注入 / 唤醒全文 / 认领 / 历史分页） |
| `read` | `readAt` 在场 | 对方调了读取面 `xc_read({scope:"inbox"})` |
| `consumed` | 保留态：现行 `acknowledgeMailbox` 把 `readAt`/`consumedAt` **同时**盖章，故读取面消费恒报 `read`；`consumed` 只在 `readAt` 缺席而确认到齐时单独出现（与 `injected` 同条件，按「读面优先」归并） | 确认消费 |
| `held` | 该行在收方隔离区 `inbox/<key>.held.jsonl` | 入站策略 hold，未经 `xc_review` 放行 |
| `refused` | **引擎凭据确认**的回执帧：帧形状（`delivery-refused`）∧ engine.jsonl 里有对应 `inbound-refused` 审计事件（同 teamId ∧ 同 messageId） | 入站策略 refuse 的凭据（v0.9.9 V098-03 起只认引擎回执，正文不可伪造） |
| `discarded` | `discardedAt` 在场 | 陈旧 / 审批门拒 / 已作废 |
| `unknown` | 本队任何邮箱（主箱 + 隔离区）都找不到该 id | **不是 8 态之一**——拒绝对未知 id 猜态 |

`payload.stamps` 给全量印章真值（`deliveredAt/consumedAt/readAt/discardedAt/deliveryClaimedAt`），
`payload.milestones` 给四个布尔（`delivered/injected/read/consumed`）——一行状态之外的
信息不丢失，也不靠正文。

## 三、权限（写死）

1. **发送方本人**（`message.from === 调用者`）——查自己发出去的消息；
2. **lead**（`agentKey === leadKeyOf(team)`）——可查本队全部；
3. `delivery-refused` 回执帧的**收方本人**——那条回执本就写在调用者自己的邮箱里
   （`message.to === 调用者`），不构成「读别人邮箱」；否则 `refused` 永不可达
   （refuse 分支从不创建原消息，只回写一条回执，guards.ts:146-169）。

v0.9.9（V098-03）起，第 3 条 carve-out 只对**引擎凭据确认的 refused 回执**生效：
`refused` 态本身要求 engine.jsonl 里有对应的 `inbound-refused` 事件（core/mailbox.ts
`refusalReceiptEvidence`）——正文里嵌 `delivery-refused` JSON 不再伪造状态，
收方因此也查不了普通消息（普通消息的 status 恒不等于 refused）。

越界 → 结构化错误 `permission_denied`：错误文案**不点名发送方、不给邮箱位置、不含正文**。
「id 是否存在」本身可由 `unknown` / `permission_denied` 两种回法分辨——这是「按 id 查状态」
的固有性质（`unknown` 必须能给发送方自己用），如实声明、不假装隐藏。
收方本人查「别人发来的」同样被拒（口径 = 发送方或 lead，收方不在此列）。

## 四、与 mailbox 真值的一致性

- 判据只读邮箱行上的印章与隔离区位置，**不推断、不缓存、不改写**（查询本身零副作用：
  `readAt`/`consumedAt` 不动）。
- 唯一一处邮箱行之外的输入是 `refused` 的**引擎凭据**（engine.jsonl 的
  `inbound-refused` 事件，尾部 2 MiB 窗口内按 messageId 对账，只读不写）——
  消息正文永不做判据（回执帧与「正文恰为同一段 JSON 的普通消息」在邮箱行上字节级
  不可区分，只解析正文等于让任一成员伪造权威状态面，v0.9.8 adv-2 F1）。
- 定位要跨邮箱（发送方查的消息躺在**收方**邮箱里）：遍历本队全部邮箱键
  （`core/mailbox.ts listMailboxKeys`，主箱 `<key>.jsonl` 与隔离区 `<key>.held.jsonl` 并集）。
- 新鲜度裁决（`isCurrentMail`）**不**参与本查询：它是状态事实而非投递资格；
  陈旧件照实报它的印章态（`discarded` 由 readCurrentMailboxLocked 落盘后自然可见）。

## 五、已知限制（如实声明）

1. `read` 与 `consumed` 在现行写入面下不可分离（`acknowledgeMailbox` 原子盖两章）——
   要真正分离需要一个独立印章字段，那要动 `core/types.ts`（非组 M 文件域），本轮不做。
2. `refused` 只能凭**回执帧的 id** 查到（原消息在 refuse 分支从未被创建，没有 id 可查）；
   发送方在 `xc_relay` 的 `inbound_refused` 错误里拿到的就是 `receiptMessageId`。
3. `refused` 的引擎凭据只对账 engine.jsonl 的**尾部 2 MiB 窗口**——回执事件早于窗口
   起点时（极长历史的回执） genuine 也报不到 refused（按印章态报 queued）；状态查询
   通常紧随 `inbound_refused` 错误，超长历史请以 engine.jsonl 的 `inbound-refused`
   事件为权威。同机可写 engine.jsonl 是既定边界（PROTOCOL §10/§11.5：不做签名/哈希链）——
   本判据把「伪造 refused」从「发一条消息」提到「改审计日志」。
4. 跨会话（peer 轴）消息有自己的回执状态机（`core/peerpolicy.ts` 的
   `held/denied/expired/delivered/refused/dropped`），不在本口径内。
