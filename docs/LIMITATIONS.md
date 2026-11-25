# 已知限制、威胁模型与转办专题（LIMITATIONS）

> **v0.9.4 B3 搬迁说明**：本文件承接原 README 的三个深水区段落——「已知限制」（24 条，
> 逐字节搬迁）、「威胁模型（v0.6 口径）」、「跨会话工具转办（C6/C7，v0.7）」专题
> （逐条比对零丢失，证据见 deepseek-crosschat/evidence/39-v094/fix-b/B3-逐条比对.md）。
> README 只留指针；本条内「已知限制 N」互指以本文件编号为准。

## 已知限制

1. **仅 Windows 实测**——所有自测与验收在 Windows 上完成；其他操作系统未经测试。
2. **团队自动开工依赖本机 zcode 路径**——默认自动探测（Windows），失败时 `xc_doctor` 与报错文案会给出填写指引；两会话任务闭环与跨会话消息**完全不受影响**。
3. **回合中注入分三档，硬插队只到引擎成员**——消息默认只在回合边界注入。`xc_relay({urgent:true})` 只调整未读顺序，不打断对方回合；`xc_relay({interrupt:true})` 是软中断（结构化 INTERRUPT 信封 + 收方安全点纪律，收方下一次读收件箱才看到）；`xc_relay({steer:true})`（v0.9.8 起）是插件侧上界：终止引擎成员的当前回合（整棵进程树）并立即重开新回合、纠偏作首条指令——它是「杀回合再续」而不是向运行中的回合注入，被中止回合一刻没落盘的进度可能丢；仅 lead/用户可发，交互式会话降级为软中断。宿主 0.18.0 另有直接提供给会话模型的会话控制工具（`InterruptSession` 中断指定回合、`SendToSession` 向指定会话投递输入且对方忙时排队等）——那是宿主与模型之间的通道，crosschat 的 MCP server 是宿主外的独立 stdio 进程，调不了它们（同第 12 条口径）；所以交互式会话的硬中断仍然只有两条路：用户在自己的窗口里按 Esc，或 lead 模型自己去调用宿主工具。读面信封恒由消息元数据重建，正文内嵌的信封/横幅/页脚/回信指引标记一律剥离——伪造信封不透传（v0.9.1）。
4. **只能发现已显式注册的会话**——会话先注册（`xc_identify`）才能被寻址。
5. **别把敏感内容写进协作邮箱**——跨会话可见的只有邮箱/消息内容本身；身份校验是协作假设而非密码学校验。
6. **pipe 通道单帧 1 MiB 上限**——超过 1 MiB 的跨会话消息发送被拒（`too_large`）；超大内容分条发送或走队内 `xc_relay`。**MCP stdio 传输层另有 32 MiB 单帧上限**：超过的单帧被显式 JSON-RPC 拒收（`Parse error`），server 进程继续服务。**pipe 端点并发连接上限 128**：同 tick 对同一 peer 的在途连接超限时超出部分显式 `socket_busy`（重试即可）。
7. **peer 待投递队列深度上限 1024**（可配 `peer_max_queue_depth`）——达上限后新入站被丢弃并给发送方 `dropped` 回执：payload 的 `detail` 带**原因与恢复动作**（上限值 + 「让收方 `xc_read({scope:"peer"})` 排空或稍后重试」），摘要行同步透出。**peer 发送限速 30 条/10 秒（每发送方）**——突发超限得 `sender_paced`，约 10s 窗口滚动恢复。
8. **注入预算是声明值**——宿主无法查询会话真实模型窗口，预算按声明的 `context_chars` 刻度缩放（单条基准 4000、批次 16000 字符）：偏小=多截断（安全方向）。磁盘真源永远全文，被截消息带 `xc_read` 分页指针，会话不卡死、不爆上下文。
9. **用户亲述溯源窗口**——只有最近 8 条用户 prompt（单条 ≤64KiB、10 分钟内）参与盖章匹配；溯源证明「文本是发送会话用户所打」，不验证发送意图——接收方永远先向本会话用户确认。
10. **暂存件放行后的终态回执到不了发方**——被 hold 的消息后来被放行/拒收时，发方只知道「已暂存」。
11. **盖章语料是宿主展开后的整段提示文本**——用自定义命令时钩子记录的是命令展开后的整段提示；模型原样发出模板示例串也会命中 `origin="user"`。接收方页脚始终声明「非本会话授权」。
12. **转办审批门防流程缺失，不防恶意伪造**（v0.7 C6/C7）——审批门结构性拒绝未审批/过期/畸形/工具不符/自批的 `tool_request`（两个读取面都遮蔽、不进模型注入面），但同机进程仍可直接伪造审批文件——与 v0.5 uservoice「同机进程可伪造盖章记录」同一边界（个人/内部场景「不崩/不丢/不串号」底线由 JSONL 追加真源 + 团队锁 + 帧白名单 + 台账/审计双轨承担）。另外：批准后的**执行**仍是 A 会话的模型回合（crosschat 的 MCP server 是宿主外的独立 stdio 进程，不持有其他 MCP 连接，无法代调宿主工具）。
13. **唤醒回合继承发起方环境**（隔离存储场景，v0.7 已知边界）——被唤醒的回合跑在发起方环境里，其工具面可能是发起方的而非成员自己的（E4 §7.2 实测）；审批门在读取面单点生效，不依赖唤醒路径；生产单存储无此问题。
14. **压缩联动是建议级，非拦截级**（v0.7 C9）——平台无宿主压缩钩子接口，插件只能「容量预警 + 建议先落 journal（longtask checklist）+ lead 操作序」，拦不住压缩本身；规则靠回合自觉。（v0.8 起该 checklist 第一步是 `/xc-checkpoint`，平台缺口与两级降级方案见第 16 条。）
15. **桌面 UI 会话不可远程关闭**——直接 close 一个非活跃会话报 `Session is not active`（E3 ② 实测）；已退出的旧会话可先 `--resume` 再 close；**活跃的 UI 会话未测**。成员停机请走 `xc_team({action:"member-stop"})`（先留档再停、任务回池不丢）。宿主 0.18.0 起，会话里的模型可以直接调用宿主的 `SetSessionArchived`（归档或恢复，不中断执行）与 `ListSessions`，但那是宿主给会话模型的工具，插件进程同样够不到——**插件对宿主侧归档态零感知（G-21，v0.9.3 如实声明）**：宿主没有「会话已归档」事件可订阅，归档后 hooks 自述、引擎证言、邮箱写入、peer 记录四路全停——活性四判据合判如实落「判据来源为空（unknown）」而**不冒充活跃**（`xc_overview` 成员行 `liveness.livenessSources` 可见依据），任务回池仍靠 stale 清扫与 C8 离线转交兜底；平台反馈建议（`member-archived` 事件 / 归档态投递告警）见 [docs/PROTOCOL.md](PROTOCOL.md) §15.6，本版不自造实现。
16. **平台无 PreCompact/PostCompact 钩子，故用「提醒 + 一键」，不提供自动压缩检查点**（v0.8）——zcode 3.18.2 没有压缩事件钩子，插件**不能在压缩发生前自动写检查点、也不能拦截压缩**：压缩防护 = ① 一键 `/xc-checkpoint`（= `xc_team({action:"checkpoint"})`，MCP server 服务端直接落盘 `.crosschat/checkpoints/<你>/<ISO>.md`，front-matter + 七章，每 agent 保留最近 20 份）；② UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）。同理**无原生状态栏扩展点**，「一眼瞭望」由 `xc_overview({view:"status"})` 紧凑文本视图承担（不是 UI）。压缩后能否从检查点恢复，取决于宿主压缩行为——本平台无压缩事件可复现，该半不可测（如实边界）。
17. **engine.jsonl 审计可整体伪造（V090-04，不修行为）**——审计是工作区内的明文 JSONL，同机进程可整文件重写（个人/内部威胁模型，不做对抗级防伪）：审计用于观测与对账，**不作为可信凭据**；可信锚点是 `xc_report` 的 evidence sha256（工具现算）与磁盘真源本身，不是日志。
18. **协议帧正文可伪装（V090-13，不修行为）**——帧白名单防「未知具名帧混进读取面」与「消息携带授权语义」，不防正文伪装：chat 正文可内嵌伪造的信封/横幅/页脚/回信指引标记。读面信封已恒由消息元数据重建（伪造引擎属性与冒名 `from` 不透传，v0.9.1/v0.9.2），但 `xc_read` 的 JSON entry 与 mail scope 原文分页按磁盘真源口径逐字保留——真值层不漂白，信任判定看元数据不看正文。
19. **撤回通知无频控（V090-14，不修行为）**——每次成功撤回各投一条 `withdrawal-notice`，通知帧不受入站限速/频控约束，失误或恶意成员可制造通知噪音；但每条通知都必须对应真实撤回的未读件（无消息即无通知），且通知帧自身不可撤回（v0.9.2 起链式撤回封死、对账锚点保留）。
20. **持续伪造引擎证言可无限期豁免清扫（V090-01 处置，不修行为）**——清扫豁免的活性输入是引擎证言（`registry/witness/<sid>.json`，只由引擎进程写：hook 回合边界 + 工具调用心跳），**一次**本地文件写伪造自述记录造不出证言（不豁免），但同机进程**持续重写**证言文件（活跃攻击）可让名下任务一直停在豁免态——这是威胁模型边界（v0.6 口径：同机进程可伪造状态文件；产品 doctrine 不做对抗级防伪护城河，签名/哈希链一律不引入）。既有防线如实：豁免**有界**（证言停止 2×stale 阈值后照扫）、`pid-dead` 硬证据立即失效、C8 离线转交通知照发（豁免不壅蔽）；可观测性兜底：任务板带 `sweepExemptPeriods`（「豁免 N×阈值」）与 `Exempt:` 文本行、`task-sweep-deferred` 审计逐周期留痕、成员行 `liveness.witness` 并列展示自述与证言——lead 可见异常长豁免并人工介入（cancel/改派）。
21. **投递盖章 ≠ 消费确认，中间有 limbo 静默区（v0.9.1 G-12v3，机制 B 收口）**——spawn 成功瞬间盖 `deliveredAt`（fire-and-forget），子进程可能在成员回合**消费内容前**死亡（内存红线 OOM / 宿主重启杀无头子进程）→ 消息已盖章、从未被读、且因不再是 unread 而永不被未读注入钩子呈现（生产 4 实例收方零动作）。现补口：spawn 即写 wake-child 生命周期头行、退出写尾行；成员真实消费（hook 注入 / `xc_read` / `xc_claim`）回写 `consumedAt`；盖章后 `XC_LIMBO_TIMEOUT_MS`（缺省 10min）无消费确认 → 自动打回可重新投递态（重新可注入/可 pull）+ `message-limbo` 事件 + urgent 告知 lead；spawn 后 5min 无 session-start → `wake-slow` 告知。**0 字节日志永不出现也永不作失败判据**（慢写瞬态可 12min+，只有「≥5min 且无 session-start」才判慢）。
22. **容量闸挡唤醒不拦投递，且只到 spawn 前（v0.9.1 G-12-b；v0.9.2 收口五条 mustFix）**——水位低于硬底或单回合预估 > 可用内存时 `attemptWake` 不 spawn、直接 `deliver=mailbox` + `wake-deferred{reason:"capacity-red"}` + 冷却（`XC_MEM_WAKE_COOLDOWN_MS` 缺省 120s、**上钳 1h**，非法值回落缺省并在 detail 明示；`XC_MEM_WAKE_GATE=off` 关闸，事件带 `gateEnv` 原值）。消息照常落邮箱、收方自己的回合随时可读（pull 兜底不丢）；闸**不**取消任务、不撤回消息、不拦压缩（同第 14/16 条的平台边界）。派单面的「RED 期排队拒绝」需在派单工具面接线，本版只在 wake 层给出 deferral 块与冷却窗、派单回执经 `note` 透出原因与重试窗口。容量采样意外时闸 fail-open（不因观测故障永久挡唤醒）并落 `wake-capacity-probe-failed` 事件；**CIM 进程采样不可用**（采样成功但拿不到进程树）时进程类规则（session-limit/turn-concurrency）不评、面板显示 `n/a`，且放行路径也落 `wake-capacity-degraded` 事件——不静默、不声称已评。v0.9.2 起冷却记录按 `teamId+收方+紧急度` 分域（一个成员的 RED 不再把全队唤醒含紧急 relay 一并静默转 mailbox），窗内命中在 detail 明示「沿用旧判据（未重采样、快照时刻可对账）」；进程归类只认唤醒子标记（`XC_WAKE_CHILD=1` env 标记 + 命令行可见的唤醒回执前缀），README 文档化的用户 CLI 不再被误判成无头回合而误触 session-limit。
23. **文件引用是引用不是内容，且 peer 管道帧不带它（v0.9.1 G-10）**——`xc_relay({refs})` 只传工作区内真实普通文件的 path+sha256（+可选 mime/note；复用 evidence 三道硬闸与 sha256 现算），接收面渲染「用 Read 打开该路径」提示：**不内联内容、不做 base64**（消息通道是纯文本 JSON，内联会撑爆帧闸与注入预算）。因此引用**不随消息历史永存**——文件被移动/删除后引用即失效（sha256 仍可对账「曾经存在过这个版本」）。peer 轴另有载体边界：管道 MsgFrame 白名单冻结，refs 只随**文件退化**队列项抵达，`via=pipe` 时 payload `refsCarried:false` 如实说明（urgent 同款纪律）。G-17（无头回合 MCP 子集加载 = 宿主层能力）只出可行性结论与平台反馈建议，本版不自造实现，见 PROTOCOL §15.4。

24. **容量闸三旋钮走 config.json `capacity` 段，闸状态与持续态上观测面（v0.9.3 B1–B4）**——`.crosschat/config.json` 收 `{wake_enabled, capacity:{warn_watermark, turn_estimate_bytes, wake_gate}}`（优先级 file > env > 内置默认，每次现读=改文件即生效；段与键全部可选，畸形逐层披露不静默；未知键静默忽略）。`xc_overview`（team/status/panel 同源）的 capacity 块附 `wakeGate`：阻塞条件名、下次重判时刻、本窗 wake-deferred 计数；GREEN 不显示阻塞。持续态告警：wake-deferred 窗内累积 ≥`XC_DEFERRED_ALERT_N`（缺省 5）、wake 生效值连续 false ≥`XC_WAKE_OFF_ALERT_MS`（缺省 30min）且有 pending 消息 → urgent lead（每窗/各一次）；生效值变更落 `config-effective-changed{key,from,to,source}`（对拍基线 `capacity/config-state.json`，防刷屏）。边界（如实声明）：现读比对发生在唤醒闸被咨询时（总开关关闭时那段时间的配置变更不产生事件）；config.json 段在唤醒闸与 overview 三视图生效，`xc_doctor`/journal/checkpoint 的容量展示仍走 env 口径（未设该段时各面行为与本版之前完全一致）；告警状态文件读-改-写不加显式锁，同机多 server 最坏罕见重复一条（engine.jsonl 仍是权威）。
25. **成员推理档位：进程级 env 不生效，不支持时有界降级（v0.9.6 R2）**——`member_reasoning` 由插件设置（userConfig）经 manifest 注入 MCP server 进程（`XC_MEMBER_REASONING`），**进程级环境变量会被该注入覆盖，单独设进程级 env 不生效**（与 [docs/PROTOCOL.md](PROTOCOL.md) §9「由 manifest 从用户设置注入」口径一致）。provider/模型不支持所配档位时按 **high → medium → 省略** 的有界顺序降级重试，落审计 `member-reasoning-fallback{from,to}`，member-add 回执如实披露实际生效档位；**显式非法档位显式报错，不静默降级**；降级只发生在「档位不被支持」时，正常供给不降级（档位与去重语义见第 26 条的边界族）。
26. **孤儿唤醒票回收与在途去重口径（v0.9.6 R1）**——供给失败的 attempt 签发的未消费唤醒票会被显式回收（`revoked{reason:"provision-failed"}`）；在途去重只认「有活体证据」的在途票（lifecycle 有 start 且子进程活，或票据未过短窗）——孤儿票不再压制后续派单（此前失败尝试留票会把其后 15 分钟内的 dispatch 全部压成只落邮箱）；**正常在途票仍照常去重，该口径不放宽**。成员状态门控（provisioning/failed/removed）先于 inflight 去重：failed/removed 成员的 dispatch 显式拒绝/改派，不再被误标 `inflight-nonce`。同机手置/伪造票据与状态文件仍属威胁模型边界（同第 17/20 条族，不做签名/哈希链）；强杀导致的 wake-child 生命周期账缺 `exit` 尾行属信号边界（「start 头行无 exit 尾行 = 尝试可能仍在途」判据不变，本版如实声明不修）。
27. **桌面界面对后台回合的高亮属于宿主，插件只做到观测面与回合开始提示（v0.10.0 R4 产品侧后半段未做）**——插件侧落地的是机器可读面：`xc_overview`（team/panel/status 三视图同形）成员行 `headlessTurn` 标识（判据**只看引擎事件**：该 sid 晚于最近一次 `session-idle` 有 `wake` 且不晚于该 `session-running`；注册表自述 running 但无 wake 不标记——宁漏不误报）+ UserPromptSubmit 回合开始一行提示「后台回合进行中：<名字列表>」（只列其他成员）。桌面 UI 的高亮/心跳属宿主能力（同第 15/16 条：宿主不给的接口插件变不出来），本版不自造实现。
28. **看门狗判亡连续两个扫描周期才确认，真正掉线的检出晚一个周期（v0.10.0 R3 二次确认的代价）**——判 `member-dead` 前要过四道校验（在途唤醒 / 在途任务 / 更新的 pid / 跨周期二次确认）：首次判死只记 suspect（台账仍 alive、落 `suspect-dead` 审计），**连续第二个扫描周期**仍判死才认领并回池。代价：真正掉线（无在途任务、无在途唤醒、pid 亡）的检出比单周期晚一个扫描周期（`XC_WATCHDOG_MS` 缺省 60s，最坏约两个轮询间隔）；换来的是 R3 当日 21 次误判（在途/刚唤醒的成员被判亡 → 误回池、误撤回派单回执）归零。**pid 被回收复用不会让已判亡成员复活（第 7 轮，真实加测 R3 §6.1）**：判死候选 / 告警收件人过滤 / 重新武装（台账 dead→alive）第 7 轮起共用 `memberLivenessView` 的 `state==='dead'`（活性 pid-dead ∨ 注册表记录自述 dead 且无 live/heartbeat-stale 活证据）；重新武装需要**正向复活证据**——记录不再自述 dead（该会话自己的钩子写过 running/idle）或有 live/heartbeat-stale 证据。记录仍自述 dead 时，即使存储的 pid 被系统回收给别的进程（`alive(storedPid)` 为真令 pid 证据支整支失效、活性退成 no-record）也按死人处理：不重新武装、不进告警收件人名单、不被唤醒——否则出现「僵尸回路」（死成员被重新拉活 → 被 watchdog-wake 拉起一回合 → 再死，member-dead 反复；真实加测实证 m2 于 04:50:33 被重新武装、04:51:35 被拉起）。报告建议的「pid + 进程启动时间双要素」未做（要改 peer 注册记录格式，超出本版范围）；本版止血 = 记录自述 dead 时不许因 pid 复用翻回 + 只有活证据才放行。判亡四道校验与事件口径详见 [docs/PROTOCOL.md](PROTOCOL.md) §16.4。
29. **成员空闲后的补醒照常经过容量闸（v0.10.0 A4）**——被忙闲闸挡下的派单（或落了邮箱的紧急回执）在成员回合一结束后由看门狗补醒，补醒与普通唤醒同权：容量 RED（水位低于硬底 ∨ 单回合预估 > 可用内存）时同样不 spawn、只落邮箱 + `wake-deferred{reason:"capacity-red"}` + 冷却（未读派单 / 未读紧急回执两类共用 120s 窗，`XC_DISPATCH_RESUME_COOLDOWN_MS` 可调，`0`=不冷却）——**紧急不豁免**。内存不足时补醒仍会被挡下，消息照常在邮箱（pull 兜底不丢单），任务回池与真正掉线的判亡不受影响。
30. **协作状态根向上归并的两条实际后果：已生成的子目录根不会自动并回主根，只有 config.json 的工作区不算既存根（v0.10.0 R1/G-27）**——`resolveStateRoot` 改为从起点目录向上 ≤12 层找**既存根**（判据 = 该目录含 `.crosschat` 且其下有 `registry`/`teams`/`logs` 之一）后，有两条用户可感知的后果，本版如实声明、不由插件自动处理：① **升级前已经在子目录里生成的 `.crosschat` 自己就是既存根**——它带 registry/teams/logs 之一，向上查找命中它自己而非主根，所以在这些子目录里启动的会话仍落在旧的子目录根里（身份、邮箱、任务板与主根隔离）；要并回去，须**停掉相关会话**后删除或迁移这些子目录里的 `.crosschat`（删除前确认其中没有要保留的状态；迁移属运维动作，插件不做）。② **工作区的 `.crosschat` 里只有 `config.json`（没有 registry/teams/logs）不算既存根**——该工作区启动时会继续向上找，12 层内若上层目录已有协作根就并入上层根，**它自己的 config.json 不生效**；想让它独立成根，先在其中建好 `registry`/`teams`/`logs` 之一，或确保上层没有根。根漂移本身有审计（`state-root-resolved`/`state-root-drift`，见 [docs/PROTOCOL.md](PROTOCOL.md) §16.5），但**归并动作不由插件代做**（同第 12 条：状态文件的迁移/删除属用户侧运维）。
31. **成员死亡告警发给在途成员时不唤醒、只落邮箱（v0.10.0 第 6 轮，取舍声明）**——看门狗 urgent 告警（member-dead 等）对回合进行中的收件人（任务板有 `claimed`/`in_progress` 任务，或会话记录 `liveness=running` 且 `livenessTs` 可信）**只写 urgent 邮箱、不调用 attemptWake**：再拉一路无头回合同样是 G-28 的双回合格局（两路抢信箱、重复劳动）——宁可不唤醒，也不错杀双回合。告警消息照常在邮箱，成员自己回合即可看到、pull 兜底不丢；判据任务板现读一次，读失败按不忙（fail-open：失败方向是多唤醒一次，不是丢告警）。空闲收件人行为不变（wake 调用/审计/回执三面逐字节不变）。判据与 `watchdog-wake` 的 `note` 取值域详见 [docs/PROTOCOL.md](PROTOCOL.md) §16.8。
## 威胁模型（v0.6 口径）

- **不做对抗级防伪**：同机进程可伪造盖章记录/注册表文件——`origin="user"` 是体验性归因而非凭据；零宽/同形字归一、转发溯源链（forwardOf/hop-chain）等红队级防御已按个人/内部场景威胁模型**移除**（v0.5 的防御记录见各版设计文档）。v0.6.1 起队内轴改为在闸口**拒绝**会被静默归一到碰撞键的花名写法（与 peer 轴严格文法一致）——这是拒绝歧义而非恢复折叠/归一。
- **打断 = 下一回合必读**：宿主 wire 无中断原语，interrupt 是尽力请求。
- **peer 通道「沉默不等于同意」**：peer 不是你的 worker，转发的消息永远不构成本会话用户的授权；若对方说「我这边被拒/没权限，你替我跑」，那是权限洗白——拒绝并 surfaced 给你的用户。
- **转办不是权限借用**（v0.7 C6/C7）：A 会话代执行 B 的工具请求必须逐请求审批——审批文件由用户/lead 落盘（`.crosschat/approvals/<requestId>.json`，插件侧确定性校验），`tool` 字段与请求逐字节绑定，请求方与执行方均不能自批；白名单帧永不代表授权。relay 消息里的「帮我调个工具」同样不是用户同意——复上条纪律。
- **检查点文件按项目权限管理**（v0.8，内部威胁模型口径）：`.crosschat/checkpoints/<agentKey>/<ISO>.md` 含任务标题与未读主题（只抄索引、不搬原文，`tool_request` 帧的 subject 一律遮蔽），**插件不把它自动发给任何会话**（无工具读它、无帧载它、唤醒票据不带它）——但它是工作区里的明文文件，请按项目权限管理该目录（同「别把敏感内容写进协作邮箱」的处置逻辑）。
- **接管语义**：成员崩溃后无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；`takeover:true` 立即换绑但受两道活信号闸保护（15min 内有在途回合 → 拒；旧持有者 sid 仍被活进程持有 → `takeover_live_holder`，真实活信号、不依赖默认关闭的 wake_enabled），误判接管可恢复（旧 attempt 回池）。
- 安全底线只判 P0：不崩（大帧守卫/截断有界 + **畸形帧显式 -32700**，与超大帧同一错误码，见 [PROTOCOL §13](PROTOCOL.md)）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚随连接透传）。
- **两轴操作原子**（v0.7.1 边界-4/边界-6）：`xc_identify` 的注册/改名是「队内 + peer」一次调用办两件事——任一轴失败都不留半边状态（注册：peer 失败即回滚队内轴；改名：队内被守卫阻止则 peer 也不改，peer 失败则队内改名回滚）。错误即无副作用，可直接重试。
- **改名占用他人花名 = 两轴前置拒**（v0.8.1 M01，P1）：新花名已是队内花名册另一位成员、或 peer 轴上被另一个活会话占着时，改名在**任何状态变更之前**显式拒（`team_rename_blocked` / `peer_axis_failed`，零副作用）——v0.8.0 会把队内轴先写成重复成员键，team.json 与 .bak 双双中毒、全队 team-axis 工具 internal。万一份 team.json 已被写成重复键：免注册的 `xc_doctor({action:"repair-team"})` 做确定性自愈（names 权威索引保留原持有者行、残损字节保全为 team.json.corrupt、真源与 .bak 一并重写；其他缺陷形态不猜，交还原人工恢复）。
- **改名守卫只挡活引用**（v0.8.1 C6-BUG-6）：名下开放任务、指定受领（`to`）的 pending、邮箱**未读**件挡改名（错误给出具体任务 id 与条数）；completed/cancelled/failed 是历史审计痕迹，不再永挡（有任务历史的成员现在改得动名），已读邮件历史同理。改名成功回执披露保留的终态引用数。
- **改名不丢检查点**（v0.8.1 C2-B3）：改名成功即把 `checkpoints/<旧名>/` 搬去新花名（best-effort，失败只披露）；新花名接手的默认 handoff 包三要素全空、而花名册有不在场成员持有状态时，包内给 continuity 建议指向成员视角（`xc_read({scope:"handoff", id:"<名>"})`），不再静默白纸。


---

## 专题：跨会话工具转办（C6/C7，v0.7）：先查放置，再考虑转办


成员报「我这边没有某个 MCP 工具」时，**默认是放置问题不是转办问题**——按下面矩阵先处置，只有最后一类才需要转办：

| 缺失成因 | 配置层可解？ | 处置 |
|---|---|---|
| ① user / 项目级都没配 | 可 | 放进 `~/.zcode/cli/config.json` 的 `mcp.servers`（user 级）→ 所有会话直接可用 |
| ② 只在项目级配了、没批 trust | 可 | 桌面 UI `/mcp` 批准一次（批准持久化在用户侧，无头/成员会话随即可用） |
| ③ user 级已有同名 server | 可 | 用户级恒赢——改名，或把实现上移到 user 级 |
| ④ 宿主注入（如 `web_reader`）、官方 HTTP 插件 MCP（trusted origin registry） | **不可** | 只能让有该工具的会话代跑（转办）；或为缺工具的会话重建一个 user 级 stdio 等价 server |

> 如实说明：crosschat 的 MCP server 是宿主之外的独立 stdio 进程，看不到宿主其他 MCP server 的清单，插件内**无法程序化诊断「B 缺什么」**——所以这条矩阵是文档/skill 层建议，不是自动诊断。

**转办怎么走**（不新增工具，全走现有面）：B 用 `xc_relay` 发一帧 `{"type":"tool_request", requestId, tool, args, reason, approval:{required:true}, maxResultChars}` 给有该工具的 A；插件侧建台账（`toolrequests/<requestId>.json`）并**强制只投邮箱、不唤醒**（唤醒 prompt 会把请求全文带进 A 的上下文）。A 在 `xc_read({scope:"inbox"})` 或 `xc_read({scope:"mail"})` 读它时，两个读取面都过同一道审批门：**没有有效审批文件时看不到请求正文**（只出遮蔽占位），门同时回投 B 一帧 `refused` 并通知 lead 待批。授权只认审批文件 `.crosschat/approvals/<requestId>.json`（用户/lead 落盘，或 lead 调 `xc_review({action:"approve", axis:"approval", id})` 由插件代写同格式）——`tool` 字段与请求逐字节绑定，请求方与执行方都不能自批（大小写/折叠变体等同拒绝，按成员键归一化判定），批准窗不超出请求窗。**写者胜**：门每次读箱都重读磁盘审批文件——用户先读到请求（门首拒、lead 收到待批通知）之后再落合法批准文件，下一次读取即放行，台账从 refused/denied 迁回 approved；两条轨（用户落盘 ≡ `xc_review` 代写）完全等价。A 跑完真实工具后用 `xc_relay` 回投 `{"type":"tool_result", requestId, status, result, ts}`（`status:"refused"` 的辞谢同样落终态，一请求一结果），B 以邮箱原文 + requestId + ts 自判新旧。

**边界**：审批门防的是流程缺失与误操作（无审批/过期/畸形/工具不符/自批一律结构性拒绝），**不防同机进程直接伪造审批文件**；批准后的**执行仍是 A 的模型回合**——crosschat 的 MCP server 不持有宿主的其他 MCP 连接，无法代调宿主工具（详见「已知限制」12）。

