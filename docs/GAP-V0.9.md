# GAP-V0.9：v0.8.1 首日生产实战暴露的五项能力缺口

> 来源：lims2.0 主控会话（工单专项总调度）转交，用户裁定「需要改进」｜整理：独立监督会话（ZCodeProject）｜日期：2026-11-18
> 基准：**v0.8.1 user 级安装，真实生产环境全天实战**（非搭建测试场景）——lims2.0 工作区（`D:\工作\work\xizheng\lims2.0`）十会话团队（1 调度 master + 8 执行成员 + 1 观测），2026-11-18 11:01–18:40 连续 7.5 小时，任务 t1~t29、完成 20 单、承载真实 MR 放行流水线（!7723/!7740/!7748/!7779/!7806/!7807/!7814 等）。
> 实测证据：①lims2.0 `.crosschat/logs/engine.jsonl`（839 行，独立第三方每小时只读监督，快照 `docs/trial-data/2026-11-18-lims2.0-records.jsonl`）②主控台账 `de-workspace/work/ticket-batch-20261112/STATUS.md` 11-18 轮次（五二一/五二二/五四四轮）③`skills/crosschat/SKILL.md` 文档自述。
> 纪律：对齐 GAP-V0.5——每条给证据；本文所有日志事件均可在 engine.jsonl 快照或监督记录中复核。**工具面本身 0 失败**（7.5h 无 error/failed/非送达终态），五项全部是**平台/配置/机制层缺口**，不是功能缺陷。

---

## 结论速览

| # | 缺口 | 一句话 | 证据强度 | 定级（主控） |
|---|---|---|---|---|
| G-1 | 无法向运行中会话插入消息 | 消息只能排队到回合边界，管理者对跑偏的长回合只能干等或整体打断 | 定性（日志全部投递事件均为回合边界机制） | **最高优先** |
| G-2 | 中断原语缺失/降级 | `interrupt:true` 无宿主原语支撑（E1），降级为 urgent+下回合必读，名不副实；宿主 InterruptSession 掐回合留半成品态 | 定性（SKILL.md §3-L8 自认 + STATUS.md L485 教训） | 高 |
| G-3 | 队列无排序/删除 | 排队消息不可删不可调序，仅 urgent 置顶+重发覆盖两原语，实操靠「以本条为准」约定，易错 | 定性（工具面无参数、引擎无事件类型） | 中 |
| G-4 | 无自动唤醒 | `XC_WAKE_ENABLED` 默认 false，任务进邮箱 idle 会话不自启回合，须另一通道「踢一脚」 | **定量**（7.5h 累计 wake-skipped 128 次，100% raw="false"；双通道补丁：未读注入+人工踢） | 高 |
| G-5 | 30min stale-sweep 与长任务现实不匹配 | 30 分钟无 xc_report 即扫，实战 4 例，含正在等待裁决/执行中的；≤25min 手动心跳是负担 | **定量+个案**（4 例逐一定性见 §5，误扫率 2/4） | 高 |

---

## G-1 回合中注入缺失（主控定级最高优先）

**现象**：消息只能排队到回合边界——宿主 SendToSession=queued；crosschat urgent=插到未读最前面但仍等当前回合结束。管理者对跑偏的长回合没有「回合中注入」原语，只能干等或整体打断。

**实测证据**：
- engine.jsonl 全部投递事件均为回合边界机制：`hook-prompt-submit-unread`（UserPromptSubmit 钩子=下一回合注入，7.5h 39 次）、`inbox-check`（成员回合内主动拉取 57 次）；不存在任何「回合中推送」事件类型。
- 实战代价：主控 17:32 对 t25 状态的确认要等 instrument-6 当前回合结束才可见；11-13 期间（STATUS.md L485）纠偏迟到根因即「排队不打断运行回合」。

**改进方向**：回合中注入原语（注入的指令在当前回合下一个工具调用边界被消费）——宿主层能力，插件无法单独解决，建议与 G-2 合并设计。

## G-2 中断原语缺失/降级

**现象**：`xc_relay(interrupt:true)` 底层无宿主中断原语（设计文档 E1 项），降级为 urgent+下一回合必读——名不副实。宿主侧 InterruptSession 能掐回合但留半成品态（中途文件/分支中间态），生产写库/部署中段不可用。

**实测证据**：SKILL.md §3-L8 自述「宿主平台无中断原语，退化为下一回合必读，payload 会如实回报」；STATUS.md L485（11-13 纠偏机制升级轮）：「中断留半成品态须先核对再接续，写库/部署中途慎断」已入派单 skill。

**改进方向**：「软中断」——注入中断指令 + 会话在下一个**安全点**（工具调用边界/非写库段）自检消费；与 G-1 是同一原语的两面。

## G-3 队列无排序/删除

**现象**：SendToSession 排队消息主控无法删除或调序（只有用户 UI 能删）；crosschat 仅有 urgent 置顶 + 重发覆盖作废两个原语，无任意排序/撤回。实操靠「以本条为准前条作废」约定，易错。

**实测证据**：工具面 `xc_relay` 无 delete/reorder 参数；engine.jsonl 无对应事件类型；7.5h 内 urgent 置顶使用 9 次（有效但只有一维）；STATUS.md 多轮出现「前令 queued 未消费+新令再 queued」的叠加态（L284/L292/L321）。

**改进方向**：至少提供按 messageId 的**撤回未读消息**原语；排序可后置。

## G-4 无自动唤醒（数据最铁证）

**现象**：`XC_WAKE_ENABLED` 默认 false：任务派进邮箱，idle 会话不自启回合，须另一通道「踢一脚」——主控评价「双通道耦合是补丁不是设计」。

**实测证据（定量）**：
- 7.5h 累计 `wake-skipped` **128 次**，reason 100% 为 `wake-disabled: XC_WAKE_ENABLED 非 "true"（raw="false"）`，场景覆盖 message/dispatch/report/stale-sweep 全部应唤醒时机。
- 实际运行靠双通道补丁：`hook-prompt-submit-unread`（未读注入 39 次）+ 宿主 SendToSession/start_now 人工踢（成员会话「一单一唤醒」重启重绑 24 次）。
- 直接代价见 G-5：无人驱动心跳 → 任务被清扫。

**改进方向**：默认可配自动唤醒（派发即唤醒目标开回合）。引擎 wake 链路已实现（`wake-skipped` 事件本身证明判定逻辑在跑），差的是默认值/开启路径的产品化。

## G-5 30min stale-sweep 与长任务现实不匹配

**现象**：引擎 30 分钟无 xc_report 更新即扫（staleMinutes:30）。实战 4 例被扫，**其中 2 例为误扫**（会话活跃但在等外部裁决/长步骤间）；要求成员 ≤25 分钟手动心跳是纪律负担。

**实测证据（4 例逐一定性）**：

| 任务 | 成员 | 时间线 | 定性 |
|---|---|---|---|
| t1 | form-fix-3 | 11:12 claim → **停报等主控裁令** → 12:35 被扫（STATUS.md L975：「等待裁决期间裸等，聊天 relay 不算任务心跳」） | **误扫**（活跃等待中） |
| t17 | form-fix-3 | 15:58 claim → 16:02 扫；16:16 重领 → 17:06 再扫；主控改派 t23 绕过（L995） | **结构性死循环**（长任务×2） |
| t19 | qc-forms-7 | 16:34 claim → 17:05 扫 → 17:14 第三次 attempt 3 分钟收口 | 边界（重做成本小） |
| t25（反例） | instrument-6 | 长任务，3 次规范 in_progress 心跳，未被扫 | 证明「回合活跃+纪律打卡」可避免——但 t1/t17 证明**靠人的纪律补机制缺口不可靠** |

**改进方向（主控建议，数据支撑）**：任务 in_progress 且会话活跃（回合运行中）时**暂停倒计时**；或心跳由宿主回合活动自动代理（会话在跑=活着，无须手动打卡）。误扫的本质：sweep 只看任务时间线，看不见会话活性。

---

## 第二批输入（2026-11-18 晚，主控同步，用户令）——G-4 现场处置 + 三项新增

**G-4 现场处置（用户批准）**：直接改缓存插件 `plugin.json` 的 `userConfig.wake_enabled.default` false→true。监督验证：✅ 修改已落盘；❌ **尚未生效**（改后引擎仍持续输出 wake-skipped raw="false"——userConfig 在插件加载时注入进程环境，需插件重载/桌面重启；生效判据=事件 note 不再含 wake-disabled）。此处置的风险即 G-6。

| # | 新缺口 | 一句话 | 证据 |
|---|---|---|---|
| G-6 | userConfig 无文件级配置持久位 | userConfig 值无任何可发现落盘 JSON（APPDATA 全域+~/.zcode 全域搜索零命中），只能 UI 或改缓存（**插件更新即冲掉**） | 全盘搜索零命中 + 本次改缓存处置本身 |
| G-7 | wake 默认 false 对协作场景是首要摩擦源 | 主控被迫全程 OpenSession+SendToSession 手动踢，绑定频繁掉线（proto.sessionNotFound 需重绑重发），用户多次质问「对话怎么又死了」 | 主控全天实操台账；监督累计 wake-skipped 223+ |
| G-8 | SendToSession 对已注册 peer 不自动重绑 | sessionNotFound 高频，全靠主控先 OpenSession 再重发，回合制下极易漏 | 主控台账（11-12 L182 即有 sessionNotFound 失效加速案例） |

**当晚战绩背书（主控口径，监督数据印证）**：任务板 50+ 任务零失败（监督：t1~t47，确认 29 单 completed，0 工具失败）；evidence sha256 审计全通过；stale-sweep 心跳规驯化完成（t44~t46 心跳规范零清扫）；双雷达（发版+工单）并入 release_monitor 自持调度。**核心能力实战可靠，改进点集中在配置与通道层。**

## 第三批输入（2026-11-18 深夜，用户直接提出）——G-9

**G-9 成员会话运转状态不可见（需实时同步）**：主控无法及时知道其他对话是否正在运转。

- **监督侧实证**：`registry/sessions` 的 `lastSeen` 是引擎事件时间戳——成员回合运行中（长时间执行工具不打 xc 事件）lastSeen 停滞但会话其实在跑；反之回合已结束的会话 lastSeen 可能还很新。**「上次见过」≠「正在运转」**，主控只能靠任务心跳（粗颗粒）或 UI 逐个查看。
- **被动发现掉线的代价**：会话死/掉线要等发消息时 sessionNotFound 才发现（与 G-8 同症）；wake 关闭时死会话无人叫也无人知（G-4 叠加）。
- **同根关联**：G-5 误扫的本质也是引擎看不见回合活性——**G-9 的活性真源建好后，G-5 的「回合活跃暂停倒计时」就有数据基础，两项可一揽子解决**。
- **改进方向**：①插件侧（可直接做）：引擎已收到 hook-stop-probe / prompt-submit / session-start 事件流，可聚合出会话状态机（running=回合执行中 / idle=回合结束 / dead=进程消失），在 `xc_overview` 成员行暴露活性字段，状态变化写 engine.jsonl 事件；②宿主侧：executionId/运行态的查询或推送 API（更准但需平台支持）。

---

## 第四批输入（2026-11-19，用户发现）——G-10 图片/二进制传输缺位

跨会话传图不可用：消息通道纯文本 JSON（帧硬闸 1 MiB，注入预算 16k 字符+截断），源码零命中 image/base64/attachment。`[img]` 标记是工单系统语法，crosschat 通道注入后不渲染（实测 11-19 11:23 form-fix-3「YF2188 两截图经 [img] 标记已传上」delivered:wake——消息送达但图无法呈现）。当下绕法=传路径（共享目录+对端 Read 读图）/交付物走 evidence(path+sha256)。改进方向：①消息协议支持文件引用字段（path+sha256+mime），接收面提示用 Read 打开；②或附件区（.crosschat/attachments/）+消息带引用 id。

---

## 第五批输入（2026-11-19 午，监督发现并复现）——G-11 uservoice 盖章与 wake 唤醒回合的归属冲突

master 雷达会话（被 cron/wake 反复无头唤醒）4 次用户语音盖章被拒：`uservoice-stamp-refused, reason=session-id-held-elsewhere`（11:20×2、11:24、13:05）。安全机制按设计工作（防冒充），但 wake-child 回合与桌面原会话的 sessionId 归属二义导致被唤醒回合无法盖章——主控传导用户裁决话术的能力受损（uservoice-hit 此前成功 4 次，被拒时点与 wake 全量生效相关）。改进方向：明确 wake 续跑回合的 uservoice 归属规则（继承原会话 voice 归属，或显式 voice 代理授权）。

---

## 第六批输入（2026-11-19 15:2x 内存红线事故，主控转交+监督源码复核）——G-12 wake 失败静默区

**事故**：15:07–15:25 内存红线（watermark 11–15%）下 5 个 0 字节 wake 日志（spawn --resume 起来即死），BD865 延误 25min、t63 stalled 334min。

**源码定性**：①wake 链路**无容量闸**——`attemptWake` 不读 capacity verdict，RED 只是展示面；不存在"预估过保守误拦"，是真实内存枯竭杀死了子进程。②**0 字节日志在失败侦测域外**：`findWakeFailureEvidence` 只认正向证据（isError:true/success:false/error 字段），设计口径"窗口静默=不表态"；而 spawn 成功即 markDelivered（fire-and-forget）、delivered:wake 不留邮箱副本——死会话永不 pull，消息实质丢失直至人工发现。③red3 公式双重计入（freeBytes 已含在跑回合占用再乘 count×1.5GB）；1.5GB 预估系 E3 期实测，与当前机型不符（当日 headlessTurnMaxRssBytes=280MB，主控实测峰值 ~350MB）。

**修复方案**：a) 侦测补口——wake-child 启动即写 start 头行、退出必写 exit 行；「文件存在但 T 秒仍 0 字节/无头行」=确定性失败 → wake-failed + **重投邮箱** + urgent 通知 lead；b) spawn 前容量闸——watermark<硬底或边际预估>freeBytes 时直接 deliver=mailbox + `wake-deferred{reason:"capacity-red"}` + 冷却重试；预估校准用采样器已有的 headlessTurnMaxRssBytes 滚动观测×2–3x（env 已可调）；c) 死会话直判——zcode-locate 查无目标进程即跳过 wake 直接告警。

---

## 给升级会话的指引（v0.9.0 输入）

1. **原始数据**：`docs/trial-data/2026-11-18-lims2.0-records.jsonl`（监督快照持续更新，字段说明见 `docs/TRIAL-DATA-2026-11-18-lims2.0.md`）；复现环境为 lims2.0 工作区 `.crosschat/`（生产数据，未随仓库提交）。
2. **对照阅读**：G-1/G-2 属宿主能力（zcode 平台），需评估「插件可做到什么程度」（如软中断=注入+安全点自检，纯插件可实现）；G-4/G-5/G-7 是插件引擎配置/机制，可直接进 v0.9.0；G-3 优先撤回原语；G-6 建议文件级配置持久位（`.crosschat/config.json` 或 `~/.zcode/cli/config.json` 挂载）；G-8 需宿主 SendToSession 改进或插件侧 peer 注册表联动重绑。
3. **正交数据**：全天工具面 0 失败、dispatch→claim→report 全链路 47 任务无丢失——**核心机制不需要动**，v0.9.0 应聚焦本清单而非重构。
