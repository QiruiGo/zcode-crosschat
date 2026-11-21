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

**G-12 修正（2026-11-19 16:1x 实证）**：原"0 字节日志=永久静默死亡"判定错误——上午 5 个 0 字节文件事后全部补写（慢写瞬态），0 字节不能作失败判据（须加 ≥5min 等待期）。**真实失败信号=wake-failed 事件（error 截断 "error: {"，子进程写 error JSON 半行即死，OOM 形态），该侦测路径工作正常**。缺口收窄为：①wake-failed 无告警通道（只写 engine.jsonl，lead 不巡检不知情）；②fire-and-forget 下消息停在 delivered:wake（本轮 10 次失败均靠目标会话自身 hook 消费兜底=半失败，但死会话场景仍无解）。仍成立：spawn 前容量闸（并发 13/水位 8.9%/wake-failed 累计 16，死亡螺旋持续，必要性增强）、urgent 告知 lead、死会话直判。

## 第七批输入（2026-11-19 16:2x，主控转交，用户判定「自我修改不顶事」）——G-13~G-16

**软约束失效实证**：主控零下场纪律三违（prompt/memory 规则不在决策强制位）；inbox 4 条关键回报躺着没人消费；双回合并发致重复派单（BD865 连派 t85/t86/t87、BD818/819 派 t88+t89——**日志铁证：15:40:46/15:41:43/15:41:44 三张票 58 秒内打同一成员 dev-code-5**，六一九轮已全部 cancel+叫停，⑥按旧口径白跑 20min 幸未动库）。主控自救（cron 三巡检）仍是 prompt 软纪律——重复恰发生在内存危机高压期，证明高压下行为回归惯性，需工具层硬闸。

**四项机制级请求（优先级从高到低）**：
- **G-13 派单前置查重硬闸**：`xc_dispatch` 内置「同 assignee 同单活任务存在即拒绝或要求 force」——t85-t89 类事故工具层拦死
- **G-14 回合开始强制 hook**：UserPromptSubmit/cron 唤起时若 inbox 未读>0 或任务板有 completed 未接力项，注入**阻塞**提醒——升级为「未 xc_read 消费前回合首条工具调用被前置校验拦下」的强制序（现 hook 只在部分时机触发且不阻塞）
- **G-15 主控工具白名单（可选激进）**：角色=lead/master 时禁用/告警直连 Bash 的 git push/psql/工单 HTTP 写——「零下场」从纪律变技术闸
- **G-16 双主控并发锁**：同会话交互+cron 回合并行时派单类工具加互斥；或 cron 回合检测到交互回合活跃即让位（只巡检不派单）

**与既有缺口关系**：G-13=G-3 工具面延伸且更刚需；G-14 与 G-9 互补（看队友/看邮箱）；G-15 与 G-1 同为会话行为治理（拦自己/拦别人）；G-16 与 G-11 同根（同 sessionId 多回合并发治理）。

---

**G-12 修正 v2（2026-11-19 17:1x）**：0 字节可持续 12min+ 但子进程活着（session-start 跟上）——源码机制：`openSync(logFile,"a")` spawn 时建空文件、stdout/stderr 流式直落，**0 字节=尚未产出输出，与成败无关**。三态模型替代二态：①0→补写=慢启动；②0 持续+session-start=**静默长回合（非失败）**；③有输出后死=wake-failed（侦测有效）。真静默死亡无实例；**真缺口=spawn-ok→delivered=wake 瞬间记录与回合实际开跑之间的长延迟无遥测**（BD865 25min 的机制）。改进 v2：a) wake-child 生命周期写日志（start 头行/exit 尾行）；b) wake-failed→urgent 通知 lead；c) 新增 wake-slow 信号（spawn 后 5min 无 session-start 即告知 lead）；d) 0 字节永远不作失败判据。

**G-12 修正 v3 / 机制 B（2026-11-19 17:5x，用户质疑逼出）**：「没有沉睡也没派过去」指正成立——17:03 唤醒实际成功（3 秒 session-start、36 秒已读），但后续派单"没过去"。**机制 B=limbo 态**：wake 路径 spawn 成功瞬间即盖 deliveredAt（fire-and-forget），子进程在成员回合消费内容前死亡（内存红线 OOM/ZCode 重启杀无头子进程）→ 消息已盖章投递、从未被读、**且因不再是 unread 而永不被未读注入钩子呈现**。生产实例（邮箱文件级实锤）：15:32:26→dev-code-5「重踢：BD869」/form-fix-3「救火重踢：BD865」从未被读（wm 8.9-10% 期）；17:04:58→form-mods-4「放行令」从未被读（重启杀进程后该会话三次重注册消息仍未浮现）；16:24:43→yf2208-finish 从未被读；另 8 条成员→master 回执同机制 limbo。~~主控消息标题自带"重踢/救火重踢"=已体感并用重发绕过~~ **（此句已撤回）**：经用户指正+STATUS.md 六一四轮「机制落地（用户怒后）」实证——主控对 limbo **无感知**，重踢是响应用户提醒而非自发现；**4/4 limbo 消息收方事后零动作**（dev-code-5/form-fix-3 从未执行重踢内容、form-mods-4 的动作源于另一条已读消息、yf2208-finish 全黑）——「始终没有真的生效」经引擎数据完全证实。改进 v3（v0.9.1 重点）：①delivered 盖章与消费确认分离——child 退出回写 consumedAt，超时未回写自动降级 unread（重新可注入/可 pull）；②limbo/wake-failed 均 urgent 告知 lead；③与 v0.9.0 已知限制 20 同科。

## 第八批输入（2026-11-19 16:3x，主控根因分析四条，监督侧仲裁）

**仲裁1（wake 失败）——方向对，三处修正**：①"wake-failed 零记录"不实——15:39 起已 23 条，逐条关联 nonce→wakeLog 全部有输出（14–251KB），**侦测对"写输出后死"有效**；真正无侦测的"完全静默 spawn"至今未获实证（所有 0 字节样本事后全部补写=慢启动瞬态）。②"引擎自动重试"未见证据——重试波=主控重发消息的新 spawn，本身是内存放大器。③认同告警缺口：wake-failed 只写 engine.jsonl、lead 无通道（BD865 延误根因是"不巡检"非"无记录"）。
**仲裁2（信任域）——认同**：被拦的 xingtai/instrument-6 恰是最老会话+4 个 appserver 进程在场，"按实例/会话树而非项目"自洽；属**宿主层**（SendToSession 是 host 工具），转平台侧。
**仲裁3（MCP 放大器）——认同且催生 G-17**：主控实测每回合≈1GB（主进程 290MB+7-9 plugin host×85-100MB）——**修正 G-12 原文"1.5GB 预估 4-5 倍于实测"：373MB 是采样器主进程单点值不含进程树，预估值与含树成本同量级，RED 判定本身正确，脱节只在只警不拦**。**G-17（新）：无头回合 MCP 子集加载**（只挂 crosschat+ticket，plugin host 7-9→2，每回合省 ~600MB）+ RED 时 dispatch 排队拒绝（G-12-b 强化）+ 回合结束回收 plugin host；CreateSession 新会话同问题纳入。
**仲裁4（双主控并发）——与 G-13/G-16 重合，认同。**

---

## 给升级会话的指引（v0.9.0 输入）

1. **原始数据**：`docs/trial-data/2026-11-18-lims2.0-records.jsonl`（监督快照持续更新，字段说明见 `docs/TRIAL-DATA-2026-11-18-lims2.0.md`）；复现环境为 lims2.0 工作区 `.crosschat/`（生产数据，未随仓库提交）。
2. **对照阅读**：G-1/G-2 属宿主能力（zcode 平台），需评估「插件可做到什么程度」（如软中断=注入+安全点自检，纯插件可实现）；G-4/G-5/G-7 是插件引擎配置/机制，可直接进 v0.9.0；G-3 优先撤回原语；G-6 建议文件级配置持久位（`.crosschat/config.json` 或 `~/.zcode/cli/config.json` 挂载）；G-8 需宿主 SendToSession 改进或插件侧 peer 注册表联动重绑。
3. **正交数据**：全天工具面 0 失败、dispatch→claim→report 全链路 47 任务无丢失——**核心机制不需要动**，v0.9.0 应聚焦本清单而非重构。

---

## 第九批输入（2026-11-19 深夜~11-20 晨，cron-27/28 监督发现）——G-18/G-19 + 协作轴冻结事故

> v0.9.1（b2fbd06）已落地 limbo ack / 派单查重闸 / 容量闸（对应 G-12v3/G-13/G-12-b）——以下两项为 v0.9.1 之后生产续测新发现。

**事故全貌**：11-19 17:54:09 末次协作事件后，lims2.0 十会话团队协作轴完全冻结，至 11-20 09:54 已 **16 小时**零 dispatch/claim/report/message/wake；引擎进程本身存活（晨间 5 次 hook-session-start、2 次 probe、2 次 snapshot 均正常落盘）——是协作/唤醒双轴停摆，非引擎死亡。

**G-18 wake 开关静默翻转（G-6 的恶化形态，源码实锤）**：
- **事实**：snapshot.engine.wakeEnabled 于 11-19 17:54:09→18:53:59 之间翻转为 false，此后 16h 无任何唤醒尝试、无重开痕迹；引擎零事件记录该变化。
- **源码定位（0.8.1）**：缓存 plugin.json 第 28 行 `"XC_WAKE_ENABLED": "${user_config.wake_enabled}"`——**注入的是生效值不是 default**；用户 11-18 23:05 改的 default=true 至今完好（文件 mtime 11-18 21:54，未回滚）。wake.ts:499 每次 attemptWake 现读 `req.env["XC_WAKE_ENABLED"]`；snapshot.ts:144 `wakeEnabledFromEnv` 严格等于字符串 "true" 才为开（"TRUE"/缺省均关）。
- **结论**：翻转发生在**生效值层**（应用侧插件设置存储内的值被改为非 "true"，或插件重载于一个生效值为 false 的上下文），缓存文件无辜；生效值无落盘可查（G-6 全盘搜索零命中）、无变更事件、无回滚手段——**运维上完全不可观测**。
- **附**：17:27-38 / 17:44-54 两个 inflight-nonce 15min 黑域（累计 87 次 nonce 跳过中 76 次砸 master）约 17:59:15 已自然过期——当前唯一阻塞因素就是全局开关本身，具备"一键恢复"条件但无人操作。
- **改进方向**：①生效值落盘（`.crosschat/config.json`，v0.9.0 已有雏形）+ 变更写 engine.jsonl 事件；②wake-disabled 持续超 T 分钟主动告知 lead（现在只有提示词软提醒）；③提供 config 查询/修改工具让 lead 可查可改开关状态。

**G-19 wake 成功≠消息被消费（provider 限流致死无侦测，cron-27 定量）**：
- **事实**：163 次成功 wake 中 **44 次（27%）**子进程死于 provider 限流（wake 日志内 litellm RateLimitError / GLM-5.3 池，43 次集中在 11-19 15-16 点内存危机时段），但引擎只记 wake/wake-child 成功事件、**wake-failed 零记录**——wake-failed 指标严重低估真实失败率；仅 70.6%（115/163）唤醒轮有有效响应。
- **与 G-12 的分工**：G-12 系列解决"spawn 前容量闸 / 0 字节判据 / limbo 盖戳"；G-19 解决"spawn 成功后子进程快速死亡"——证据就在引擎自己的 `logs/wake-*.json` 里，但引擎从不回读。v0.9.1 的 limbo ack（consumedAt 回写+超时降级 unread）可覆盖本条的后果侧，但**致死原因回读与指标拆分仍缺**。
- **叠加后果**：E100 POC 6 条收尾情报（qc-forms-7 17:44-54 → master）claimed 未投递卡死 16h19m；master 三态消费零变化；inbox-check 断档 16h（末次 11-19 17:45:10）；容量采样器同步停摆（末样 17:58:42）——疑似均依赖唤醒/协作循环驱动。
- **改进方向**：①wake 子进程退出必写 exit 行（G-12 v2-a 同款）+ 引擎回读 wake 日志识别 RateLimitError 类死亡 → wake-failed/degraded 事件 + urgent 告知 lead；②provider 限流死亡自动重投邮箱（mailbox 兜底本就存在，缺触发）；③wake 成功率指标拆成 spawn-ok / child-alive / consumed 三级。

**冻结期其他实况（供升级会话参考）**：
- t63（E243 平台 docx 补 1/3/9.5mm 三列）无主 24.12h，任务板 92 项零 in_progress；sweep 累计 9 例不增（冻结期无新扫）
- master 未退休未换绑，checkpoint 仍仅 11-19 10:14 那 1 个（全团队最后 checkpoint 事件为 form-mods-4 13:45:55）
- 晨间 2 个无名新会话（sess_9df96df8 / sess_70e97813）零 register 不可寻址；form-mods-4 09:49:07 hook 层已见 master 消息未读提示仍不消费（行为性失聪延续）
- uservoice 累计 41 未动；lims2.0 侧插件仍 0.8.1（v0.9.0/v0.9.1 未装）；engine maxMembers=8 而团队 13 人（超配 5 人）
- **unread 口径自我修正（cron-27）**：游标=ts>maxReadAt 且无 readAt，**不盲**——此前"instrument 全盲"判断作废；master 真未读=6（E100 POC 6 条；16fdc0d3 已被 11-19 17:44:15 唤醒轮暗消费，不计）


---

## 第十批输入（2026-11-20 11 时段，桌面重启后多会话调度故障，总调度 sess_70e97813 通报+监督取证）——G-20

> 背景：v0.9.1 已于本日装上（本地缓存+清单+marketplace 源，sha256 校验通过），用户 ~11:0x 重启桌面后新引擎上线——`session-running`/`wake-deferred` 等新事件类型首现，G-9 活性状态机确认在跑。

**事故链**：重启→所有排队 SendToSession 指令被清空→crosschat takeover 干净完成（member-takeover：sess_0a772889→sess_70e97813，revokedTasks:[]）→但 wake 被 v0.9.1 新容量闸全拦（wake-deferred ×7）→重启后 5 次派单（t93~t97）**全部 delivered:mailbox**→仅 3 次 claim 靠交互回合完成→内存跌至 4.2%→③ 在停止令（urgent relay 未读）到达前合入 !8432（外审否决件，控制令时效第三次实锤）→CreateSession「Project is unavailable」+ReadSession「App control failed」→④ 三次踢达（2 queued+1 accepted）40min 后才拉起一个 2.9s 回合（model-io 11:51:44 实证）。

**G-20 容量闸阈值无 file 层配置位（v0.9.1 容量闸的配置面缺口）**：
- **事实**：`.crosschat/config.json` 只收 `wake_enabled` 一个键（config.ts 源码确认"键只收 wake_enabled，未知键静默忽略"）；容量阈值 `XC_MEM_WARN_WATERMARK`（默认 0.15）/`XC_TURN_ESTIMATE_BYTES`（默认 1.5GB）/逃生口 `XC_MEM_WAKE_GATE=off` 全是**进程启动级 env**——运行中改不了、重启后不持久（G-6 同款病，容量参数是新增暴露面）。
- **今天后果**：水位 4.2%（0.66GB/总 15.84GB）下双条件独立成立（水位<15% 且 1.5GB>可用 1.31GB），wake 全拦；运维方既不能调闸（env 启动级）也不能用 config.json 调（schema 不含），只能关闲置会话等水位自愈——而水位在跌（7.7%→8.3%→4.2%），不会自愈。
- **口径澄清（旧账仲裁）**：1.5GB vs 实测 350MB 的"4 倍失真"不成立——350MB 是主进程单点值（采样器 headlessTurnMaxRssBytes），含树实测 ~1GB（290MB 主+7-9 plugin host×85-100MB），对 1.5GB 是 **1.5 倍余量**；且水位线条件独立成立，**校准预估并不能开闸**。
- **改进方向**：①config.json 增加 capacity 段（warn_watermark/turn_estimate_bytes/wake_gate），file>env>default 同款分层；②闸状态在 xc_overview/snapshot 暴露当前水位+预估+阻塞原因+下次重判时刻（今天全靠翻 engine.jsonl 的 wake-deferred 事件才看到）；③wake-deferred 累积超 T 分钟→urgent 告知 lead（今天静默累积 7 条无任何告警通道）；④水位恢复自动恢复已有（120s 冷却重判），保留。

**宿主层疑点（转平台侧素材，非插件可解）**：
- CreateSession「Project is unavailable」与 ReadSession「App control failed」疑同根=**appserver 项目/会话路由表重启后未恢复**（ListProjects 读静态配置所以正常→路由表与配置两个源，重启后分歧）；⑧ 的 11:46 静默→11:47 续上符合 appserver 中途回收重建；34 个 ZCode.exe 命令行无 appserver 字样（appserver 大概率是 13 个 node 之一）。
- SendToSession queued/accepted 对 idle 会话不触发回合（G-1 同根）：④ 实证（model-io 11:51:44 一条 2.9s 回合）；③ 跑过一轮（11:41 合并 !8432）但 model-io 无文件=记录丢失疑点，待查。
- 恢复序列（监督侧建议）：UI 手动踢是唯一确认可用路径但延迟大（④ 40min）；内存抬过 15% 后 wake 自动恢复（120s 重判，无需人工）；确认聋掉的会话 xc_identify 重绑或重建成员。


---

## 第十批勘误（2026-11-20 12:3x，用户令「不能完全基于主控的判断走，需先审核现状有自己的判断」——监督侧对总调度 11 时段通报逐条取证的结论）

**审核方法**：引擎日志（事件时序）+ 邮箱文件（deliveredAt/readAt/consumedAt 三态）+ git 实迹（提交者身份+时间戳）+ rollout model-io。7 条 headline claims 分级：**2 条被推翻、1 条关键前提无证据支持且 git 反向、2 条证实、2 条无法验证**。

| 主控叙述 | 审核结论 | 证据 |
|---|---|---|
| ④重启后零模型调用 | **推翻** | model-io-sess_c5fa1521.jsonl 有 1 条：11:51:44、2.9s、glm-5.3（主控查得早） |
| ③仅一轮（11:41 止，即误合 !8432 那轮） | **推翻** | form-fix-3 11:57:38 又报 t94 in_progress，并非 11:41 后静默 |
| ③在停止令到达前合入 !8432 | **无证据支持，git 反向** | 内容提交"母版加浓度兜底公式+升版 v2.1.1"作者=**吕其睿（人类）**：MR 分支 10:52:58 + deploy-dev 侧 12:00:54；**deploy-dev 在 11:41 前后零合并**（最早 12:07 liute）；11:33-11:52 全网提交全人类身份，无任何会话身份提交/合并 |
| takeover 干净 | **证实** | member-takeover 事件 revokedTasks:[] |
| 停止令（urgent relay 未读） | **证实且更严重** | 11:37:59 急令 + 11:41:53 返工令均为 **claimed 未投递**（deliveryClaimedAt 有/deliveredAt 无/readAt 无）= 根本没投送，不是"到迟" |
| 重启清空排队指令 | 无法验证 | 无引擎可见性（宿主侧队列） |
| CreateSession/ReadSession 病灶 | 无法验证 | 宿主层，维持"疑 appserver 路由表"假设 |

**对 G-20 及整改方向的影响**：主控"控制指令时效第三次实锤"叙事建立在未证实的"先合后停"前提上，应降级；今天真正证实的机制是 **claimed 未投递态急令永久丢失**（与 11-19 E100 POC 6 条同态；v0.9.1 容量闸拦 wake 后"wake 子进程认领即死"成为新触发路径——G-19 的又一实例）。整改应从"控制令时效纪律"转向：①claimed 未投递消息的补投/重发机制（t94/t96 两条仍卡在 form-fix-3 邮箱）；②v0.9.1 的 consumedAt ack 不覆盖 claimed 态，需明确该态的超时降级规则；③对会话自述（in_progress 回报声称"已合入"类）需 git 对账后才可入台账。

**流程教训（已入监督纪律）**：被监督会话的事实性叙述须先对 ground-truth 取证再采纳，分级标注（已证实/未证实/已推翻），整改建议只建立在已证实前提上。


---

## 第十一批输入（2026-11-20 17:4x，总调度午后五问清单+监督侧审核，用户令「先审核现状有自己的判断」）——G-21/G-22/G-23

> 审核方法：每条先取证后结论，可验证性分级（✅实据/➖主控记录+部分佐证/❌监督侧不可见）。

**G-21 宿主归档态不可见 + accepted-but-never-ran 假成功**：
- ✅ 部分证实：instrument-6 现以新会话 sess_fa15e8f9 运行（14:41 启动、liveness=running）——归档重建注册链有实迹；form-fix-3 原会话恢复活跃（lastSeen 17:40）。归档时刻（15:45/16:40）宿主侧不可见——crosschat registry 无 archive 字段，插件对宿主归档零感知。
- 插件侧可做：「投递 accepted 后 T 分钟无 session-running/prompt-submit」=假成功检测（G-12 v2-c 同款思路用于宿主投递，今日 3 实例够定阈值）；平台侧：归档态可见性+归档态投递告警+member-archived 事件（需宿主会话状态馈给）。

**G-22 in_progress+idle→needs-continuation 通知**：
- ✅ 形态证实（踢次宿主动作不可数）：④ 早三次踢达 40min 仅一个 2.9s 回合；form-fix-3 今日间隙 1h46m；今日实际踢的主力=桌面 UI+主控直投，引擎中介贡献为零。
- **对主控框架的修正**：「自动续踢」不可行——续踢机制只能是 wake，而 wake 今日被容量闸拦 45 次。可行解=**回合结束通知主控**（v0.9.1 liveness session-idle 已首现+任务板 in_progress；「带 in_progress 转 idle→通知 lead」纯插件侧不依赖 wake）。v0.9.2 优先级高于自动续踢。

**G-23 发版执行器逐件终态（平台侧工单材料）**：
- ➖ V2.0.278 16:57:12 发版成功（#36594）但 data-fix 失败 3 项——「成功」外衣下含没跑成的件，E019 自愈兑现不可验；277 因他人件 e063@1170 整版失败（主控 round679）。
- 建议：坏件跳过+继续方向正确；**监督侧补充=跳过必须带「skipped≠passed」显式登记，执行器输出逐件终态（passed/failed/skipped）**——模糊包是下游对账永远在猜的根因。

**model-io 轮转致活性判据失效（✅证实）**：11:51 时 rollout 3 文件（⑧/c5fa1521/监督会话），17:44 是另外 3 个（sess_37b24341/**主控 51MB**/监督会话）——⑧④文件没了；保留窗口宿主策略不可见。**主控 51MB model-io=今日数十回合独立铁证**。结论：引擎 liveness 不权威（form-fix-3 今日零 hook 事件但活跃）；交接档「IO 增长=唯一可信活性判据」改笔为**四判据合判**：artifacts mtime+registry lastSeen/liveness+引擎事件+邮箱写入。

**日累计被闸拦统计（✅互证）**：主控独立提出与 G-20② 同一诉求；今日 wake-deferred 累计 45（message 23/idle 12/dispatch 5/report 4/sweep 1），全天水位 4.00%~11.71%；16:39 一条纯水位拦截（可用 1.85GB>预估 1.50GB 仅 watermark 拦）=G-20 实锤。建议 v0.9.2 连带做 G-20①（config.json capacity 段）。

---

## 第十二批输入（2026-11-21 上午，「断联日」：哨兵夜窗断联 + 监督执行链中断；附 v0.9.3 上游状态）

> 取证口径同第十一批。本批两条「断联」均已闭环；无新 G 编号（结构性结论入档，不新开缺口）。

### 断联一：哨兵监控 14.5h 断联 + 持锁僵滞（11-20 夜→11-21 晨，已闭环）

- **实况比初报大一个量级**：总调度初报「漏捕 282-284」，监督侧读 release-monitor-runs.log 实证=该日志 11-20 18:32:03 后**整段静默至 11-21 09:02:03（暗 14.5h，全程无日志）**，且 09:02 轮处理 30 条积压后**持锁未释放**（09:07/09:12/09:17 连续三轮 WARN「锁被持有，本轮跳过」）——形态是停摆+现存故障，不是漏捕。
- **三源互证判休眠（哨兵无过错）**：引擎 18:40→09:00 零事件 + 哨兵日志静默 + 监督 cron 自身 18:16→09:18 缺跑（用户 hourly 提示流同窗中断）= 机器过夜休眠实锤；持锁进程 pid7252 已死（tasklist 实证），**死时水位 3.7%=内存低压杀进程实证**（与 11-19 23 次 wake-failed/OOM 同族）。
- 处置闭环：删锁 + schtasks 手动触发 → 09:19:45 一轮追平 8 事件（V2.0.281-285 全对），09:22 起全轮正常。
- **结构性结论（入档）**：**休眠窗=所有监控面（引擎/哨兵/监督 cron）的共同盲区**——单监控面加哨不能覆盖，登记表补扫（夜窗补扫 18 行+fixNames 13 件全他域零失败）是唯一跨窗兜底；互补结构验证有效，但兜底不当主路径。**「持锁跳过连续≥2 次」列入例行监测阈值**（哨兵自监测）。
- 插件侧论据：内存低压杀进程=容量闸（G-12）+看门狗（v0.9.2 A2 member-dead）的实证支撑；根治仍是降载（外部应用常驻约 9GB/15.84GB）。

### 断联二：监督执行链中断（step5-executor 供应商切断，主会话接管）

- cron-37 轮执行子代理被 Provider rejected 切断（8 次工具调用后手带回执、未写记录）；主会话接管完成+双源复核——**执行链有 SPOF，中断时例行不能停**。
- **其断联前所报「引擎日志疑似被重写/乱序」被推翻**：awk 全局单调性检测为空（4257 行严格递增）；旧 ts 出现在 tail-60 只因尾部窗口跨越休眠边界（首行 11-20 18:05:36→第 46 行才跳到 11-21 09:06:28），是休眠期事件稀疏的正常形态。教训入监督纪律：**子代理的「异常发现」同样默认待证，乱序/重写类强结论必须全局检测后采信**。
- 检查点回正：两条 special 行 checkpointTs 为手写估计值、**超越实时时钟约 30 分钟**（真实时钟 10:14，估计值写 10:46/10:50）；本轮回正到 cron-36 实测锚点（11-20 18:11:04）——手写时间戳超前同类错误第三次，特别行也必须取真实时钟。

### 运行侧状态修正（非缺口，影响「生效」判定）

- ✅ **v0.9.2 代码已在运行进程现身（未经正式桌面重载）**：引擎 11-21 09:15:26 吐出 watchdog-wake 事件——0.9.1 源码全目录无此事件名、0.9.2 的 watchdog.ts 有；即 marketplace 安装源刷新后，新启动的插件进程已加载 0.9.2。**「安装后生效待桌面重载」的前提修正为：重载只是用户侧确认动作，新进程已在跑新码**。重载三件核验进度：③ gateEnv 已见（09:15 wake-deferred 事件带 gateEnv:null，env 未设）；① startConfirmed 0 次（容量闸全程挡 wake、无 spawn 可验）；② member-dead 0 次（无成员死亡触发）。
- ➖ **上游已发 v0.9.3**（369a1c1a，pushed 2026-11-20 19:59 UTC）：lease expiry redelivery / wake 3-level metrics / capacity config / needs-continuation / bounded audit append——据提交信息推断正对 G-20①（capacity 文件层配置）、G-22（needs-continuation）、G-19 家族（lease expiry redelivery），未核码；本地安装（0.9.2）落后一个版本。
- limbo 沉积新实例（G-19 家族）：11-19 15:58 旧件投递休眠成员 yf2208-finish（无注册会话），被容量闸降级后邮箱内未读，limbo 重试每 10 分钟撞一次闸——正属 v0.9.3 lease-expiry 范畴。
- 内存全日低位：18:05 7.9% → 09:15 10.0% → 10:14 6.6%（free 1.05GB/15.84GB），wake 持续被容量闸挡（本窗 2 次 wake-deferred 均 to master，09:15 带 urgent）。
