# DESIGN-V0.8.md — v0.8.0 设计：交接与压缩防护（A1 检查点 / A2 接手包 / A3 时间线 / A4 状态视图 / A5 命令与文档）

日期：2026-11-15 ｜ 状态：待用户批准（**已按独立复核意见修订一轮**，见文首修订记录）｜ 前置：v0.7.2 已交付（tag 5e5a18f，工具面恰 10，已知问题仅平台限制）
方案依据：`deepseek-crosschat/reports/27-v080方案.md`（已定稿；本设计是它的可实现化，逐条落地 §2 的 A1–A5）

**修订记录（2026-11-15，独立复核后）**：复核判定 4 项必修 + 7 项应修，本版全部落地——
① front-matter 键数统一为 **7**（原「8 键」与所列 7 行自相矛盾，:129/:398）；
② `judgeCapacity` 无 `level` 字段的**真源更正**（`capacity.ts:283-286` 只有 `{red, violated, detail}`；RED/GREEN/UNKNOWN 改由新代码推导并要求三视图共用同一助手，:131/:140/:244/:330）；
③ **新增 §4.1「id 三视角下七要素的冻结语义」表**（原 task 视角六要素未定义，ACCEPT15-2 无可判依据）；
④ **≤3 步测量口径钉死**（真实 invoke 计数而非语义步；claim 只接 pending 的前提；仍 in_progress 他人任务需 takeover/等清扫；基线资产指定 21-v060 拷贝，:236-240）；
⑤ unread 数据源按「自己/花名」两路分别标真源（:229）；
⑥ R8 增量清单补 `offset` 新语义一项并给出退化方案（:463）；
⑦ 计数更正：`server.ts:61-68` 是 8 个 register 调用注册 10 个工具；版本统一为**五处**（§7.3/AC6 一致）；
⑧ 三个工具文件的**字段级 describe** 落点补全（:50/:212/:283/:446-449）；
⑨ 「从未写过检查点 → 该提醒一次」的 adjudication 要求写成 AC1 命名断言（:178/:398）；
⑩ 钩子侧 agentKey 来源点名 `boundNamesForSession`（:186）；
⑪ `stallSuggestion` 引用由 :124 更正为 :120；
⑫ 更正复核前一版的一处误判：`legacy-removal.test.ts:218-220` 的命令断言是**正向存在性循环**，新增命令文件不会令其失败，「扩到 8」是可选加强而非必修（:403/:460）。

## 0. 输入与依据（每条设计决策的出处）

| 输入 | 关键结论 | 本设计对它的消费 |
|---|---|---|
| reports/27-v080方案.md §1 平台事实表 | zcode 3.18.2 **无 PreCompact/PostCompact 钩子**、**无原生 statusline 扩展点**；现有钩子只有 SessionStart / UserPromptSubmit / Stop | §2 缺口声明：不做自动压缩钩子、不做状态栏；压缩防护 = 一键 checkpoint + UserPromptSubmit 提醒；状态栏 = `xc_overview(view:"status")` |
| 同上 §2 A1–A5 | checkpoint→`xc_team` action；handoff→`xc_read` scope；timeline/status→`xc_overview` view；命令 6→8；longtask/crosschat/README/PROTOCOL 同步 | §3–§7 逐条落地；工具面仍恰 10、0 新增 |
| 同上 §4 ACCEPT15（7 条） | 判据含「接手 ≤3 步」「保留 20 份滚动」「提醒可关/30min/负例」「超预算按章截断并标注」「工具面恰 10 + 命令 8 + 版本 0.8.0」 | §8 验收映射表（判据 → 模块/文件落点 → 测试落点） |
| 代码现状（本会话实读） | `TeamShape.action` 8 值（`plugin/src/mcp/tools-team.ts:74`）；`ReadShape.scope` 6 值（`tools-read.ts:71`）；`OverviewShape.view` 3 值（`tools-overview.ts:138`）；钩子单出口 emit（`hooks/prompt-submit.ts:151`）；留档文件格式先例（`core/archive.ts:84-101/:228-250`） | §3/§4/§5/§6 的落点全部挂在现有枚举与现有文件格式先例上，不新开机制 |
| 既有验收资产 | 六场景剧本 `deepseek-crosschat/evidence/21-v060/acceptance/_脚本/six-scenarios.mjs`（场景②已测「接手 ≤3 步」，实测 4 次工具调用）；工具面黑盒 `.../_脚本/probe-surface.mjs` + `tool-surface.md`；49 bug 表 `.../48-bug-total-table.md`；仓内红队重放 `_redteam-replay/` | §8 AC5/AC6 的回归落点；场景②的「≤3 步」口径在 v0.8 收紧为**工具调用数 ≤3**（handoff 一次调用替代 overview+journal 两次） |

产品纪律（用户最高约束，本设计每节自对账）：工具面恰 10（0 新增）；不新增必填配置（新阈值只走代码常量 + 1 个可关 env）；不改任务状态机与既有工具语义；checkpoint 文件不自动发给任何会话；提醒默认开启但可关、阈值 30min、每 agent 30min 最多一次、必须有「不该提醒时不提醒」负例；handoff 超预算按章截断并标注 `truncated`；每项配防回归单测；合法流程不破坏（六场景/lead 移交/archive/relay/C6/C8/C9）。

## 1. 设计决策总览（反臃肿核算）

| 决策 | 结论 | 理由（证据） |
|---|---|---|
| checkpoint 载体 | **`xc_team` 增 action**（不新增工具） | 方案 §1 平台事实表第 4 行；`xc_team` 已是指挥族 action 分发（`tools-team.ts:1389` switch），加一个 case 的增量最小；`note` 入参键已存在（`tools-team.ts:80`，member-add 审计备注），checkpoint 复用同名键 |
| checkpoint 组装位置 | **服务端落盘**（MCP server 内组装+写盘，不依赖模型写文件） | 方案 §2 A1「由 MCP server 服务端直接落盘」；模型写文件已在 C4 被证明不可靠（上下文一压缩就断，longtask SKILL.md:8「没写进 journal 的进展等于没发生」） |
| checkpoint 是否需要团队锁 | **不需要**（读路径无锁 + 只写自己目录） | 读路径无锁是既有纪律（`tools-overview.ts:202` 注释「读路径无锁（§2.7-5）」；`hooks/shared.ts:212-222` unreadSummary 同款纯读）；写目标 `<root>/checkpoints/<me>/` 与 team.json 无交集，不碰状态机——「不改任务状态机」纪律的结构性保证 |
| handoff 载体 | **`xc_read` 增 scope**（不新增工具） | 方案 §1；`xc_read` 已是统一分页读面（`tools-read.ts:384` handleRead switch），加一个 case；且接手流程天然是「读」动作 |
| handoff 预算 | **代码常量 4000 字符**，不进配置 | 方案 §2 A2「默认预算 ≤4000 字符」；纪律「不新增必填配置」；测试用大任务板构造超限，不需要可调旋钮 |
| timeline/status 载体 | **`xc_overview` 增 view**（不新增工具） | 方案 §1；overview 已是观测合一面（`tools-overview.ts:391` handleOverview 路由），timeline/status 与 team/peers/panel 同层 |
| timeline 读取方式 | **尾部窗口读**（新模块自持，不改 `core/jsonl.ts`） | engine.jsonl 无上界（每次工具调用都追加，`core/log.ts:75`）；`readJsonl`（`jsonl.ts:67`）是全文件读；尾部读放新模块 `core/timeline.ts`，只**复用** `parseJsonl`（`jsonl.ts:43`）——公共文件 jsonl.ts 零改动，G1/G3 不受影响 |
| 提醒注入点 | **UserPromptSubmit 钩子**（现有注入通道） | 方案 §1 平台事实表第 3 行；钩子已有未读提醒的完整先例（`prompt-submit.ts:128-148`）与单出口契约（`:151`） |
| 提醒节流状态存哪 | **`checkpoints/<agentKey>/.nudge`**（钩子是独立进程，内存态不可用） | 钩子每回合都是新进程（`plugin/scripts/build.mjs:16-17` 三个独立 entry）；必须落盘才能跨回合节流；放点文件前缀 `.` + 滚动删除只认 `*.md`，两者互不干扰 |
| 工具面 | **恰 10，0 新增** | §9.1 落点全部是既有文件的枚举扩展；`server.ts:61-68` 是 **8 个 `register*` 调用注册出 10 个工具**（identify / tasks 族三工具 / read / relay / overview / team / review + `:76` 的 doctor 另行 `registry.set`），本版这 8 行一行不加、`registry` 集合不变（`legacy-removal.test.ts:60-63` `EXPECTED_TOOLS` 恰 10 继续通过） |

**模块数口径**（= 实现对账单元 = §9.1 的 G1/G2/G3）：**3 个模块**（与方案 §5 实施分组一致，可三组并行）。

## 2. 平台事实与缺口声明（本设计最重要的如实收窄）

1. **无 PreCompact/PostCompact 钩子**（3.18.2；方案 §1 引 OSS `docs/hooks-implementation-analysis.md` §8.2 的 P1 缺口）→ 插件**不能**在压缩发生前自动写检查点、也**不能**拦截压缩。v0.8 的压缩防护是**两级降级方案**：① 一键 `xc_team({action:"checkpoint"})` / `/xc-checkpoint`（服务端落盘，一条命令办完）；② UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）。**文档不得宣称「自动压缩检查点」**（ACCEPT15-1 逐字检查项）。
2. **无原生 statusline 扩展点**（方案 §1）→ 不做状态栏；`xc_overview({view:"status"})` 紧凑文本视图是替代物，不是 UI。
3. **唤醒回合可继承发起方环境**（v0.7 R6 已知边界，DESIGN-V0.7.md §10.3）不在本版范围；checkpoint 只写调用方自己的工作区状态根，不跨工作区。
4. 既有 C9 压缩联动（`capacity.ts:340` `COMPRESS_ADVICE_LINE`）是**建议级非拦截级**，本版沿用同一口径，并在 status 视图标红时复用同一建议行——不新增第二套压缩话术。

## 3. A1 检查点（checkpoint）

### 3.1 API 与权限

```
xc_team({ action: "checkpoint", note?: "<一句话>" })
```

- 落点：`plugin/src/mcp/tools-team.ts` —— `TeamShape.action` 枚举加 `"checkpoint"`（现 `:74` 8 值 → 9 值）；`TeamActionArgs` action 联合加成员（现 `:1259`）；`handleTeam` switch 加 case（现 `:1389-1429`，放在 `unblock` 之后）；**两处 describe 都必须同步**：工具级描述补一行（现 `:1449`）+ **字段级** `note` 的 describe 现写「action=member-add：备注（仅审计）」（现 `:80`），必须改为覆盖两个 action（如「action=member-add：备注（仅审计）；action=checkpoint：写进检查点第 7 章的一句话」）——不改会造成模型可见面与枚举不一致。
- 入参：只复用既有键 `note`（`tools-team.ts:80`，`.optional()`，无需新键、无必填项）。未用字段忽略（既有口径，`tools-team.ts:1257` 注释）。
- 权限：`identityStore.require(connectionKey)`（未注册连接拒，与所有成员动作一致）；**不设 lead 闸**——每个成员只能写自己的 `<root>/checkpoints/<自己>/` 目录，没有越权面。
- 前置：team.json 不存在 → `no_team`（与 `tools-read.ts:346` 同族错误）；成员不在花名册 → 仍可写，「身份」章如实记 `state: (not on roster)`（不阻断，检查点的价值是落盘）。
- 副作用面：**只写 `<root>/checkpoints/<me>/`**。不写 team.json、不进邮箱、不唤醒、不碰锁、不改任务状态机。

### 3.2 磁盘路径与滚动策略

```
<workspace>/.crosschat/
└── checkpoints/
    ├── <agentKey>/
    │   ├── 2026-11-15T18-00-00-000Z.md   ← 检查点（stamp = ISO8601，"："与 "." 折成 "-"，Windows 合法且字典序=时间序）
    │   └── .nudge                         ← 提醒节流标记（内容 = 上次提醒的 ISO 时间；滚动删除不碰它）
```

- 路径构建器落在 `plugin/src/core/paths.ts`（新增 4 个，紧邻 `:107-133` 既有状态根级构建器）：`checkpointsDir(root)` / `checkpointDir(root, agentKey)` / `checkpointFile(root, agentKey, stamp)` / `checkpointNudgeFile(root, agentKey)`。
- **路径安全**：`<agentKey>` 一律先过 `sanitizeKey` 再过断言级复核（`archive.ts:75-81` `safeSegment` 的同款防御纵深，在新模块 `core/checkpoint.ts` 内自带一份，**不修改 archive.ts**）；调用方（tools-team）只许经 paths 构建器取路径，禁止自行 `join`。
- **滚动**：每 agent 保留最近 **20** 份（`CHECKPOINT_KEEP_MAX = 20`，代码常量，无 env）。策略 = 列出该目录 `*.md`、按文件名升序（= 时间升序）、删除最旧的 `len-20` 个。`.nudge` 与非 `.md` 文件不在删除域。archive 目录（`<root>/archive/<name>/`）完全不受影响（方案 §2 A1 明示）。
- 滚动删除失败（文件被占用/权限）→ **不阻断已成功的写入**：审计 `checkpoint-prune-failed`，payload 附 `pruned: 0` 与 `pruneError`（写盘成功这一事实不被删除失败抹掉）。

### 3.3 文件格式（冻结：front-matter + 7 章字段）

单文件、UTF-8、以 `\n` 结尾（`archive.ts:247` 同款原子写纪律）。

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
- agent: alice | role: member | state: ready | lead: alice | team: default
- sessionId: sess_6b9 (短 8 位) | lastSeen: 2026-11-15T17:58:00Z（2min 前）

## 2. 我的进行中任务（claimed / in_progress / blocked）
| taskId | 状态 | 标题 | attempt | 最后进展 |
| t-a1 | in_progress | 落盘脚本改造 | 2 | 2026-11-15T17:40:00Z（20min 前） |
| t-b2 | blocked | 等审批文件 | 1 | 2026-11-15T16:00:00Z（阻塞原因：等用户落 approvals/） |
（无进行中任务）

## 3. 待领池（前 10，priority → createdAt）
| taskId | 优先级 | 标题 | 依赖 |
| t-c3 | high | 补单测 | - |
| t-d4 | normal | 文档同步 | t-c3! |
（依赖列：`-`=无依赖；尾缀 `!`=依赖未终态；池共 M 个时末行记「（待领池共 M 个，列前 10）」）

## 4. 最近 journal（每任务末 5 行 + 路径）
### t-a1（.crosschat/tasks/t-a1/journal.md）
- 2026-11-15 17:40 | 完成骨架 | D:\ws\out\a.txt
- 2026-11-15 17:12 | 定字段 | —
（无 journal：.crosschat/tasks/t-b2/journal.md 不存在）

## 5. 未读摘要（urgent 优先，最多 5 条）
- [urgent] bob | 记得先落盘再压缩（msg_1a2b）
- carol | 文档我看完了（msg_3c4d）
（另有 N 条未读，xc_read({scope:"inbox"}) 消费）
（无未读）

## 6. 建议下一步
- t-a1：in_progress 超 120min 无进展 → relay 催办 / cancel / 重派（转交）
- t-b2：blocked → 处理阻塞原因（xc_team unblock）或 cancel
- t-d4：依赖 t-c3 未终态 → 等待项（dependsOn 未满足）
- 容量 RED → 先按 longtask checklist 落盘再接受压缩
- 无在途任务且有待领 → 可认领 t-c3（注意单在途任务规则：认领前先 xc_report 收尾当前任务）

## 7. note
模型传入的一句话；缺省记「（未提供）」
```

**冻结字段规则**（实现必须逐字遵守，验收据此走查）：

| 面 | 规则 |
|---|---|
| front-matter | **7 个键固定且每行必现**（`agent`/`team`/`lead`/`createdAt`/`taskCounts`/`unread`/`capacity`——键数与示例行数一致，走查时逐行点数）；`taskCounts` 恒含 `claimed`/`in_progress`/`blocked` 三个键（0 也写，键集合稳定可 grep）；值内含换行/`---` 的，入库前折成单行（防 front-matter 被注入撑破） |
| `lead` | 无 lead 时写 `(none)`（不写 null，保持标量） |
| `capacity` | **推导链如实写明**（`capacity.ts:283-286` 实测 `CapacityVerdict` 只有 `{red, violated, detail}`，**没有 `level` 字段**）：新代码自行把 `verdict.red === true` 映射为 `level: RED`、`false` 映射为 `GREEN`；`watermarkPct` = `watermark*100` 保留 1 位；`freeGb` 保留 2 位。**采样失败**（`capacityMount` 的 catch 分支返回 null，`tools-overview.ts:78-83`）→ 由新代码把 null 映射为 `capacity: {watermarkPct: n/a, freeGb: n/a, level: UNKNOWN}`，写盘继续 |
| 章标题 | `## 1. 身份` … `## 7. note` 七章、顺序固定、编号固定（与方案 §2 A1 的七章一致） |
| 「我的进行中任务」 | 口径 = `OPEN_TASK_STATUSES`（`types.ts:48` = claimed/in_progress/blocked）∧ `assignee === me`；`最后进展` = `lastProgressTs`（`stall.ts:46`，v0.7.2 起的落盘镜像字段）转 ISO + 相对分钟；blocked 追加阻塞原因（`blockedReason`） |
| 「待领池」 | `status === "pending"`，按 `sortTasksForBoard`（priority → createdAt，`teamstate.ts`，tools-overview.ts:35 引用）取前 10 |
| 「最近 journal」 | 每任务取 `.crosschat/tasks/<taskId>/journal.md`（`archive.ts:99` `taskJournalPath`）**末 5 个非空行**；最多覆盖 10 个任务（超出记「（另有 N 个任务 journal 未列入）」）；文件缺失记「（无 journal：<path> 不存在）」——**不得静默跳过** |
| 「未读摘要」 | `readUnreadMailbox` + `urgentFirst`（C1 读取序）取前 5；每条只记 `[urgent?] <from> | <正文首行截断 80 字符>（<msgId 短 8 位>`）——**只抄索引不搬原文**（与留档 `ARCHIVE_PREVIEW_MAX_CHARS` 同纪律，`archive.ts:40`）；超出记「（另有 N 条未读…）」 |
| 「建议下一步」 | 由 `stallSuggestion`（`stall.ts:120`）+ 依赖未满足项 + 单在途任务规则提示 + 容量 RED 建议行拼装；无项时记「（暂无：按 journal 指针继续）」 |
| 「note」 | 上限 **500 字符**（与证据 note 的长度钳同口径，README.md:209）；控制字符折空格；缺省「（未提供）」 |

**与方案字面的差异（如实记录，不改方案意图）**：方案 front-matter 草案写 `capacity: {available: 23.5, level: GREEN}`，本设计冻结为 `{watermarkPct, freeGb, level}`——`available` 在「百分比 / 字节数」上有歧义，而采样量本身就是 `watermark`（分数）与 `freeBytes`（`capacity.ts:262-279`），按真源字段命名可防实现方各写一半。**另注**：`level` 不是采样/判定函数的产物（`capacity.ts:283-286` 的 `CapacityVerdict` 只有 `{red, violated, detail}`），由 checkpoint/handoff/status 三处新代码按同一规则推导（red→RED、false→GREEN、挂载 null→UNKNOWN）——三处必须共用同一个推导助手（放 `core/checkpoint.ts`，handoff/status 都 import 它），**不得各写一遍**（否则三视图会出现 GREEN/UNKNOWN 口径分裂）。

### 3.4 返回面（文本 + JSON 双层）

- 文本一行：`Checkpoint written: <path> (<bytes> bytes, <openTasks> open task(s), <unread> unread, capacity <level>).`
- payload：`{ path, createdAt, tasks, unread, capacity, bytes, pruned? }`（方案 §2 A1 的返回集；`tasks` = 我的开放任务 `[{taskId, status}]`，`capacity` = `{watermarkPct, freeGb, level}` 或 `null`，`pruned` = 本次滚动删除份数，`pruneError` = 删除失败原因）。

### 3.5 提醒（无 PreCompact 的替代；UserPromptSubmit 注入点）

**注入点**：`plugin/src/hooks/prompt-submit.ts`——在既有未读提醒块（`:128-148`）之后、单出口 `emitAdditionalContext`（`:151`）之前，追加一支独立 `try/catch`（照 `:116-118` peer 块的失败只审计不阻断范式）。提醒行进 `blocks[]`，因此 **stdout 契约不变**：仍是一行 JSON、仍只有一个 `additionalContext` 键（`prompt-submit.test.ts:112` 的回归断言继续成立）。

**判据（纯函数，便于负例单测）**——`core/checkpoint.ts`：

```ts
export type NudgeReason =
  | "disabled"              // XC_CHECKPOINT_NUDGE=0
  | "no-active-task"        // 无活跃任务 → 不该提醒
  | "within-threshold"      // 距上次 checkpoint ≤30min → 不该提醒
  | "rate-limited"          // 距上次提醒 ≤30min → 不该提醒
  | "emit";                 // 该提醒

export function checkpointNudgeDecision(input: {
  env: NodeJS.ProcessEnv;
  openTaskCount: number;         // 我的 OPEN_TASK_STATUSES 任务数
  lastCheckpointAt: number | null; // 该 agent 目录内最新 *.md 的 mtime（无则 null）
  lastNudgeAt: number | null;      // .nudge 内容解析值（无则 null）
  now: number;
}): { nudge: boolean; reason: NudgeReason; ageMin?: number };
```

判定顺序（先命中先返回，保证负例可逐条单测）：

1. `env.XC_CHECKPOINT_NUDGE === "0"` → `disabled`；
2. `openTaskCount === 0` → `no-active-task`（**负例**：没活干的成员不被提醒）；
3. `lastCheckpointAt !== null && now - lastCheckpointAt <= 30min` → `within-threshold`（**负例**：刚写过不重复提醒）；
4. `lastNudgeAt !== null && now - lastNudgeAt <= 30min` → `rate-limited`（**负例**：30min 内最多一次）；
5. 其余 → `emit`。`lastCheckpointAt === null`（从未写过）按 age=∞ 处理 = 该提醒一次（由第 4 条把噪声钳在每 30min 一次）——选择理由：功能目的就是「压缩前盘上已有一份」；从不落盘的成员更该被提醒一次。

> **adjudication 必须写成命名断言**（复核意见）：硬标准字面是「有活跃任务**且距上次 >30min**」，「从未写过」在字面上没有「距上次」。本设计裁决为「该提醒一次」；若不在单测里显式编码，验收员可能按「无上次→不该提醒」判红。故 `core/checkpoint.test.ts` 必须含一条**命名用例**：`lastCheckpointAt=null ∧ openTaskCount>0 ∧ lastNudgeAt=null → reason==="emit"`，以及配套的 `lastCheckpointAt=null ∧ lastNudgeAt=now → reason==="rate-limited"`（证明它仍受 30min 节流，不会每回合刷）。

**常量与开关**：`CHECKPOINT_NUDGE_MINUTES = 30`（提醒阈值与节流窗同值，代码常量）；`XC_CHECKPOINT_NUDGE=0` 关闭（仅此一个 env，不进插件设置面、不是必填项）。阈值不做 env 化——方案只要求「30min 可关」，多一个旋钮就多一份走查面。

**注入文案**（一行）：`[zcode-crosschat] 建议先 /xc-checkpoint（距上次检查点 <ageMin>min）——长期任务随时可能被压缩，先落盘再继续；不需要可设 XC_CHECKPOINT_NUDGE=0。`（`lastCheckpointAt === null` 时 `<ageMin>` 渲染为 `从未`，文案相应改为「尚未落过检查点」。）

**节流标记写盘**：判为 `emit` 时先把 `now` 写进 `.nudge`（原子写，best-effort）再注入；标记写失败仍注入（提醒比记账重要），只审计 `checkpoint-nudge-marker-failed`。审计事件：`hook-checkpoint-nudge`（带 `sessionId/agentKey/ageMin/reason`），负例不记事件（避免每回合刷审计）。

**钩子侧读取助手与 agentKey 来源**：`core/checkpoint.ts` 提供 `checkpointNudgeState(stateRoot, agentKey, env, now)`（读 team.json 数我的开放任务 + 列最新 `*.md` 的 mtime + 读 `.nudge`），钩子只做「取数 → 判据 → 拼一行」，全部读路径无锁（与 `hooks/shared.ts:222` unreadSummary 同纪律——纯读、不判定新鲜度、不丢弃，`shared.ts:212-216` 注释明定「freshness adjudication/discarding stays the property of the MCP tool」）。**agentKey 从哪来（复核意见补钉）**：沿用未读提醒的现成机制——钩子先 `boundNamesForSession(ctx.stateRoot, ctx.sessionId)`（`hooks/shared.ts:188`；`prompt-submit.ts:122-131` 正是这么拿 `names[0]` 的），取 `names[0]` 作为 agentKey；取不到（未注册会话）→ 不提醒（与未读提醒同一条门：没花名就没有「我的任务/我的检查点目录」可言）。**不新造解析机制**（不读 peer 基记录、不猜 names.json 结构）。

### 3.6 失败路径与审计

| 失败 | 行为 |
|---|---|
| team.json 不存在 | `no_team`（与 `tools-read.ts:346` 同族） |
| 目录/文件创建或写失败 | `checkpoint_write_failed`，payload 带 `path` + 首因错误；**不返回成功**（不得假装落盘） |
| journal 读取失败（单任务） | 该任务记「（journal 读取失败：<path>）」，不影响其他章 |
| 未读读取失败 | 第 5 章记「（未读读取失败）」并在 payload `warnings[]` 披露 |
| 容量采样失败 | 新代码把 `capacityMount` 的 null（`tools-overview.ts:78-83` catch 分支）映射为 `capacity: {…, level: UNKNOWN}`，写盘继续 |
| 滚动删除失败 | 审计 `checkpoint-prune-failed`，`pruned: 0` + `pruneError`，写盘事实保持成功 |
| 钩子侧任何异常 | `auditHookFailure(ctx.stateRoot, 'prompt-submit-checkpoint-nudge', error)`，会话永不因钩子失败（`hooks/shared.ts:140-152`） |

审计事件（`core/log.ts:75`）：`checkpoint`（`{teamId, agentKey, path, bytes, openTasks, unread, pruned}`）；`checkpoint-write-failed`；`checkpoint-prune-failed`；`hook-checkpoint-nudge`。

## 4. A2 接手包（handoff packet）

### 4.1 API 与 id 过滤

```
xc_read({ scope: "handoff" })                              // 我自己的接手包
xc_read({ scope: "handoff", id: "<taskId>" })              // 单任务视角
xc_read({ scope: "handoff", id: "<花名>" })                 // 某成员的活儿视角
```

- 落点：`plugin/src/mcp/tools-read.ts`——`ReadShape.scope` 枚举加 `"handoff"`（现 `:71` 6 值 → 7 值）；`ReadArgs.scope` 联合加成员（现 `:80`）；`handleRead` 加 case（现 `:386-408`，放在 `journal` 之后）；**两处 describe 都必须同步**：工具级描述补一行（现 `:528`）+ **字段级** `id` 的 describe 现列 4 个 scope（现 `:73`「mail/peer-msg=消息 id；task=任务 id；journal=任务 id 或 "archive:<成员名>"」），必须补 handoff 的两种合法取值（taskId / 花名）——不改会造成模型可见面与枚举不一致。**不新增入参键**（`id` 已存在）。
- 权限：`identityStore.require`（与其余 scope 一致）；team.json 不存在 → `no_team`（`tools-read.ts:346` 同族）。
- `id` 解析（顺序固定，命中即止）：
  1. `id` ∈ `team.tasks[].id` → `filter: {kind:"task", id}`；
  2. `sanitizeKey(id)` ∈ `team.members[].key` → `filter: {kind:"member", id}`；
  3. 都不是 → `invalidParamsError`，文案给合法形态 + 至多 10 个现存 taskId / 花名候选（可行动错误，不让人猜）。
- 花名查 checkpoint 目录时过 `sanitizeKey` + 断言复核（§3.2）；清洗后与原文不同 → 该成员的 `checkpoint` 记 `null` 并在 `warnings[]` 说明（不猜路径）。

**`id` 三视角下七要素的冻结语义**（复核意见：此前只定义「tasks 被过滤」，其余六要素在 task 视角下未定，会造成两种语义不同的包；下表逐格钉死，ACCEPT15-2「id 过滤正确」据此判定）：

| 要素 | `id` 缺省（self） | `id=<taskId>` | `id=<花名>` |
|---|---|---|---|
| `identity` | 调用方自己 | **调用方自己**（不变；受领人信息在 `tasks[].assignee`） | 调用方自己（被看成员在 `tasks[].assignee`） |
| `tasks` | 我的开放任务 | **仅该任务一条**（不限 assignee、不限状态——终态任务也出，供复盘） | **该成员的开放任务**（`OPEN_TASK_STATUSES` ∧ assignee=该名） |
| `pool` | pending 前 10 | 同 self（不变：接手决策需要备选池） | 同 self（不变） |
| `unread` | **我的箱**：`readUnreadMailbox(me)` + `urgentFirst` 前 5 | **我的箱里该任务的件**：`readUnreadMailbox(me)` ∧ `m.taskId === id` 前 5；0 条时记「（我的箱里没有该任务的未读）」 | **该成员的计数**：`readMailbox(<name>)` + `countUnread` 得 `{count, urgentCount, top: []}`（`unreadWithheld: "subjects"`，见 §4.4） |
| `capacity` | 机器级采样 | 同 self（容量是团队级事实，不随视角变） | 同 self |
| `checkpoint` | **我的目录**最新一份 | **该任务受领人的目录**最新一份（受领人 = `tasks[0].assignee`；无受领人或无检查点 → `null`） | **该成员的目录**最新一份 |
| `suggestions` | 全局（我的任务 + 池 + 容量） | **仅该任务**（停滞/阻塞/依赖未满足/单在途规则提示；不含认领池建议） | **该成员名下的任务**逐条给建议；该成员无开放任务时记「（该成员无开放任务）」 |

文本面对应加一行 `视角：self | task <id> | member <name>`，payload 带 `filter: {kind, id}`——视角必须在输出里自明，不允许调用方猜。

### 4.2 七要素与双层输出

**payload 七个键（冻结，与方案 §2 A2 逐条对应）**：

| 键 | 形状 | 数据源 |
|---|---|---|
| `identity` | `{agentKey, teamId, leadKey, role, memberState, isLead}` | `readTeam` + 成员记录（`teamstate.ts`）；`isLead` = `key === leadKeyOf(team)`（tools-overview.ts:289 同款） |
| `tasks` | `[{taskId, title, status, attempt, assignee, lastProgressTs, blockedReason?}]` | 我的（或 id 过滤后的）`OPEN_TASK_STATUSES` 任务；`lastProgressTs` 取 `stall.ts:46` |
| `pool` | `[{taskId, title, priority, dependsOn, unmetDependsOn}]` | `pending` ∧ `sortTasksForBoard` 序前 10；`unmetDependsOn` = 未终态依赖（`tools-tasks.ts:470-476` 的判据复用：依赖不满足认领会被拒，接手包必须先说清） |
| `unread` | `{count, urgentCount, top: [{msgId, from, subject}]}` | **分视角**（下表钉死）：self / task 视角 = `readUnreadMailbox(me)` + `urgentFirst`（前者前 5，后者按 `m.taskId === id` 过滤后前 5）；member 视角 = `readMailbox(<name>)` + `countUnread`（`tools-read.ts:98`）只出 `{count, urgentCount, top: []}`。`subject` = 正文首行截 80 字符；**`tool_request` 帧的 subject 一律遮蔽**（见 §4.4） |
| `capacity` | `{watermarkPct, freeGb, level, sampledAt} \| null` | `sampleCapacity` + `judgeCapacity`（`capacity.ts:262-297`）；**`level` 由新代码推导**（verdict 无该字段，`capacity.ts:283-286`）：`verdict.red` → RED/GREEN，挂载 null → UNKNOWN；整体失败 = `null` + `warnings[]`，不假装 GREEN |
| `checkpoint` | `{path, createdAt, ageMin, bytes} \| null` | 该 agent 目录最新 `*.md` 的 stat（`core/checkpoint.ts` 的 `latestCheckpoint`）；无 = `null` |
| `suggestions` | `string[]`（≤5） | `stallSuggestion`（stalled/blocked-long）+ 依赖未满足等待项 + 单在途任务规则提示 + 认领建议 + 容量 RED 建议行（`capacity.ts:340` 同款文案，不造第二套） |

**文本面**：七章紧凑渲染（`1 身份 … 7 建议下一步`，与 checkpoint 的七章同构便于对照），末行固定披露预算使用情况（未超限时不披露）。

**「≤3 步」口径落地（复核意见：测量前提与计数口径必须钉死，否则按不同理解验收）**：

- 流程：新会话 `xc_identify`（1）→ `xc_read({scope:"handoff"})`（2）→ 按 `suggestions` 直接 `xc_claim` 或续作（3）。
- **计数口径 = 真实 invoke 次数**，不是语义步数。v0.6 sc2 的「实测 4 次工具调用」是**语义步计数**：脚本 `_脚本/six-scenarios.mjs:141-158` 里新会话真实发起了 **5 次** invoke（`xc_identify`、`xc_overview`、`xc_read journal`×2、`xc_claim`），而 `steps.push('journal×2')` 把两次调用并成一个 push，故 `steps.length === 4`（`acceptance/six-scenarios.md:26` 同口径记录）。v0.8 判「工具调用数 ≤3」必须在场景脚本里**按 invoke 计数断言**（每个 `cN.call(...)` 逐一计数，或包一层计数器），不得沿用 `steps.length`。
- **前提（a）：claim 只接 pending**。`tools-tasks.ts:434-437` 对非 pending 任务硬拒 `task_not_pending`（「only pending tasks can be claimed」）。故「identify → handoff → claim」三步只在**目标任务已回 pending** 时走通：sc2 的两个任务在接手前已被 `XC_STALE_TASK_MINUTES=1` 的僵尸清扫收回 pending（`_脚本/six-scenarios.mjs:131-139`）。
- **前提（b）：对仍 `in_progress`/`claimed`/`blocked` 且归属他人的任务，三步走不通**，v0.8 的场景必须显式二选一并写入脚本注释：① 同名 `xc_identify({takeover:true})` 立即换绑并回池其未完任务（`PROTOCOL §10` 接管语义；受 15min 在途唤醒活信号闸保护，可能得 `takeover_inflight`），再 handoff → claim；② 等 stale 清扫回池后再三步接手。handoff 的 `suggestions` 必须按任务真实状态给对应指引（in_progress 他人的任务 → 提示「需 takeover 或等清扫，claim 会得 task_not_pending」），**不得给出走不通的指令**（v0.7.2 C9-B5 同款教训：插件生成的交接指令必须指向真实可达路径）。
- **基线资产（前提 c）**：AC5 的六场景基线固定用 `deepseek-crosschat/evidence/21-v060/acceptance/_脚本/six-scenarios.mjs` 的**只读拷贝**（仓外 23-v070 / 24-v071 / 26-v072 亦各有一份，均为同族剧本；选定 21-v060 是因它自带 `ws/sc1..sc6` 隔离脚手架与 45 项判定的历史基线，改动面最小、可比性最强）。v0.8 的 sc2 段在其拷贝上**追加** handoff 判定（`S2.handoff-7-elements` / `S2.handoff-invoke-count<=3` / `S2.handoff-suggestions-reachable`），原 45 项判定一条不删。

### 4.3 4000 字符预算与按章截断（不得静默丢要素）

- 常量：`HANDOFF_BUDGET_CHARS = 4000`（`core/handoff.ts`）。
- 组装顺序：先按**基础帽**渲染七章（tasks ≤5、pool ≤10、unread.top ≤5、suggestions ≤5、subject 80 字符）；基础帽本身生效时在文本内披露（「（另有 N 条未读…）」「（待领池共 M 个，列前 10）」）。
- 超限处理 = **固定降级序列**（`core/handoff.ts` 纯函数，逐步重算，命中即停）：
  1. `pool` 整章降为一行「（待领池按 4000 字符预算略去：xc_overview 看板）」；
  2. `unread` 降为「未读 N 条（urgent M）」计数行；
  3. `tasks` 只留第 1 条 + 「（另有 N 条我的任务略去）」；
  4. `suggestions` 只留第 1 条；
  5. 仍超限 → 整体文本按预算硬截，末行标注。
- 每级降级都要**留名**：payload `truncated: {budgetChars, shownChars, droppedSections: string[], cappedItems: Record<string,{shown,total}>}`；文本末行 `[已按 4000 字符预算截断：略去/缩减 <名称…>；全文用 xc_read(scope:"inbox") / xc_overview / xc_read(scope:"task") 取]`。**静默丢弃 = 验收失败**（ACCEPT15-2）。
- 降级序的设计理由：`identity`/`tasks`/`suggestions` 是「接手」最小集，最后才动；`pool`/`unread` 只是上下文，先让位。

### 4.4 审批门一致性与授权口径

- **`tool_request` 帧不得在接手包露出原文**：未过门的转办请求帧的 subject 渲染为 `[tool_request 审批门控帧]`（实现冻结值，`core/checkpoint.ts` `checkpointUnreadRef`；与 R6 行同口径——handoff 与 checkpoint 第 5 章共用同一遮蔽）。理由：v0.7 的门是「读取面结构性拒绝」（`tools-read.ts:176-186` inbox 门 / `:302-336` mail 门，DESIGN-V0.7 §2.7），观测面包漏原文等于给门开侧门。
- **`id=<花名>` 时未读只给计数**（`top: []`，payload `unreadWithheld: "subjects"`）：团队观测面本来就只公开各成员未读**计数**（`tools-overview.ts:207` `snapshot.unread[m.key]`），主题/发件人不跨成员披露。给自己的包（`id` 缺省）才给 top 5。
- 无额外授权闸：板面任务、未读计数、checkpoint 路径+年龄对所有在册成员可见（与 overview 同口径）；checkpoint **文件内容不自动发给任何会话**（方案 §6 风险 1 的内部威胁模型口径），README 提示按项目权限管理该目录。

## 5. A3 时间线视图

```
xc_overview({ view: "timeline", limit?: 20, offset?: 0 })
```

- 落点：`plugin/src/mcp/tools-overview.ts`——`OverviewShape.view` 枚举加 `"timeline"` / `"status"`（现 `:138` 3 值 → 5 值）+ 新增 `limit`（`z.number().int().min(1).optional()`，**复用既有 `offset`**，不新增第三个分页键）；`OverviewArgs` 联合扩展（现 `:143`）；`handleOverview` 路由加两支（现 `:391-403`）；**两处 describe 都必须同步**：工具级描述补一行（现 `:511`）+ **字段级** `view` 的 describe 现列 3 个 view（现 `:139`「缺省 team：…；peers：…；panel：…」），必须补 timeline/status 两个取值及各自的 offset/limit 语义——不改会造成模型可见面与枚举不一致。
- 免注册（overview 豁免纪律，`tools-overview.ts:160`）；**不写 snapshot.json**（team 视图的落盘保持在 `:234-236` 原路径，timeline/status 是纯派生视图，不新增写面）。
- 读取：`core/timeline.ts` 自持**尾部窗口读**——`stat` 得文件大小；> `TAIL_READ_MAX_BYTES`（256 KiB）时只读末段，否则全读；按 `\n` 切行后**丢弃窗口首行**（可能被截断的半行）；解析复用 `core/jsonl.ts:43` `parseJsonl`（坏行跳过）；`jsonl.ts` 零改动。
- 归一化字段（冻结）：`{ts, event, family, actor, taskId, summary}`。方案列的 ts/event/actor/taskId/summary 全在；**增量一个 `family`**（方案 §2 A3 自述「事件族」九类，没有字段承载就无法过滤与紧凑呈现，如实记录该增量）。
- 事件族映射（冻结表，实现照抄；不在表内 → `other`）：

| family | event 名 |
|---|---|
| `dispatch` | `dispatch`、`dispatch-refused` |
| `claim` | `claim` |
| `report` | `report` |
| `sweep` | `task-swept`、`revoked-stale` |
| `offline` | `task-offline` |
| `approval` | `tool-approval-request`、`tool-approval`、`tool-expired` |
| `tool` | `tool-request`、`tool-executed`、`tool-result-rejected` |
| `lead` | `lead-set`、`lead-transfer`、`lead-release` |
| `member` | `member-added`、`member-add-started`、`member-add-failed`、`member-stopped`、`member-archive-written`、`member-archive-failed`、`member-provision-timeout`、`member-takeover` |
| `other` | 其余全部（含 `status`/`inject-budget`/`inbox-check` 等高频噪声事件） |

（event 名全集来自本会话对 `plugin/src` 的 grep：`grep -rn 'event: "' plugin/src --include=*.ts | grep -v .test.ts`。）

- `actor` 取值序：`agentKey ?? by ?? createdBy ?? assignee ?? to ?? null`；`taskId` = `taskId ?? null`；`summary` = 每族一个**确定性模板**（如 dispatch → `dispatch → <assignee/to> by <createdBy>`；claim → `claim by <assignee> (attempt N)`；report → `report <status> by <agentKey>`；lead-transfer → `lead → <to>`；member-stopped → `member stopped <name>`），缺字段时退化到事件名本身——**永不为空串**。
- `limit`：缺省 20、上限 100；`limit > 100` 钳到 100 并披露 `limitClamped: {requested, applied}`。`offset` 语义 = **自最新往回跳过 N 条**（与板面「自头部偏移」不同，工具描述里写明，防误用）。
- 预算：`receiverInjectBudget`（`budget.ts:45`）+ `batchWindowCount`（`budget.ts:199`）对 `JSON.stringify(entry).length` 开窗；超限给 `truncated: {shown, total, budgetChars}` + 续读指针 `xc_overview({view:"timeline", offset:<shown+offset>})`。
- 尾部窗口不足（窗口内事件数 < `limit+offset`）且文件确被窗口截断 → 披露 `tailWindowBytes` + `olderEventsOmitted: true`（不假装看全了历史）。

## 6. A4 状态视图（替代状态栏）

```
xc_overview({ view: "status" })
```

- 落点：同 §5 的 `tools-overview.ts`（同一次枚举扩展；新函数 `statusView` 与 `timelineView` 并列，互不重叠）；免注册、不写 snapshot。
- 单块紧凑文本（**行序冻结**）：

```
team: default | lead: alice | members: 3 (offline 1)
tasks: pending 2 / claimed 1 / in_progress 2 / blocked 1 / completed 3 / failed 0 / cancelled 0 | stalled 1
capacity: GREEN | 水位 23.5% 可用 | 并发回合 2 | sampledAt 2026-11-15T18:00:00Z
checkpoint: alice=12min前, bob=3h前, carol=(none)
unread: alice=3, bob=0, carol=1
```

- 字段口径与**真实状态一致**（ACCEPT15-4 的可检验面）：
  - 任务计数：按 `team.tasks[].status` 全量计数（七态一个不漏；`stalled` = `stalledTasks` 计数，`stall.ts:67`，阈值含钳制披露 `stalledThresholdClamped`）；
  - `offline`：`offlineMembersMount`（`tools-overview.ts:123-135`）成员数；阈值钳制/非法回落照旧附 WARNING（复用现有两条 WARNING 文案，不新造）；
  - `capacity`：`capacityMount`（`tools-overview.ts:75-103`）——**挂载返回 null 时新代码写 `UNKNOWN`，不写 GREEN**（不谎报水位；`capacity.ts:283-286` 的 verdict 无 `level` 字段，RED/GREEN 由新代码按 `verdict.red` 推导）；RED 时附 `COMPRESS_ADVICE_LINE`（`capacity.ts:340`，C9 原句复用）；
  - `checkpoint`：对 `me`（已注册时）与所有有检查点的成员列「年龄 min 前」，无检查点记 `(none)`；年龄 = `now - 最新 *.md mtime`；
  - `unread`：对每个成员 `readMailbox` + `countUnreadFor`（`tools-overview.ts:380-382`，与板面同口径——观测面必须自洽）。
- 预算：同样 `receiverInjectBudget` + 固定降级序（`unread` 行 → `checkpoint` 行 → `offline`/`stalled` 明细行 → `capacity` 明细行），每级留名披露 `truncated`。
- **复用点明示**（防实现方重写一遍）：容量 = capacityMount；离线 = offlineMembersMount；停滞 = stalledTasks/stallSuggestion；未读 = countUnreadFor；checkpoint 年龄 = core/checkpoint.ts 的 latestCheckpoint。**C9 的采样/判定、C8 的活性判定、C5 的停滞判定全部原样复用，零重复实现**。

## 7. A5 命令、skill 与文档

### 7.1 命令（6 → 8）

新增两个文件，其余 6 个命令不动（`plugin/commands/` 现有 6 个：xc-work / xc-dispatch / xc-inbox / xc-status / xc-team / xc-say）。

`plugin/commands/xc-checkpoint.md`（模板冻结）：

```md
---
description: 写一份交接检查点到 .crosschat/checkpoints/<你>/（身份/我的任务/待领池/journal 摘要/未读/建议下一步/note），压缩或换会话前先用它落盘。
argument-hint: "[一句话备注]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

1. 调用 `xc_team({action:"checkpoint"[, note:"<上面的一句话备注>"]})`——由服务端直接落盘，不要自己写文件。
2. 把返回的 `path`、`bytes`、开放任务数、未读数原样回报用户；写失败时如实说明错误码（如 `checkpoint_write_failed`）与恢复动作，不得声称已落盘。
3. 若返回 `capacity.level = RED`，提醒用户：先按 longtask 压缩前 checklist 落 journal，再接受压缩。
```

`plugin/commands/xc-handoff.md`（模板冻结）：

```md
---
description: 读一份 30 秒接手包（身份/我的任务/待领池/未读/容量/最近检查点/建议下一步），新会话接手或换人续作时用；可按任务 id 或花名收窄。
argument-hint: "[任务id|花名]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

1. 已注册则直接调用 `xc_read({scope:"handoff"[ , id:"<任务id或花名>" ]})`；未注册先 `xc_identify`（接手三步：identify → handoff → claim/续作）。
2. 把七要素渲染给用户：我的任务（状态/attempt/最后进展/阻塞原因）、待领池前 10、未读摘要、容量水位、最近检查点路径与年龄、建议下一步。
3. 按 `suggestions` 行动：可认领的先 `xc_claim`（注意单在途任务规则）；blocked 的走 `xc_team unblock` 或 cancel；依赖未满足的记为等待项。
4. 若响应带 `truncated`，如实说明哪些章节被预算裁掉，并指引用 `xc_read({scope:"inbox"})` / `xc_overview` / `xc_read({scope:"task"})` 取全文——不得当作「没有这些内容」。
```

### 7.2 skill 改动面

- `plugin/skills/longtask/SKILL.md`
  - §2「交接」（现 `:30-37`）：第 2 步改为 **`xc_read({scope:"handoff"})` 一次拿全七要素**（原「读 archive journal + 读 task prompt」两步压成一步；全文仍按 journal/task scope 分页取）；一句话模板改为：**接手 \<名\>：identify → /xc-handoff（xc_read handoff）→ 按建议下一步 claim/续作。**（≤3 步口径写死）
  - §3「压缩前 checklist」（现 `:39-46`）：改为三步序——① `/xc-checkpoint`（服务端落盘）② journal「当前进度」写全 + 产物路径落行 ③ **之后**才接受压缩；保留容量标红触发说明，并补一句「平台无压缩钩子，插件只能提醒+一键，拦不住压缩本身」。
- `plugin/skills/crosschat/SKILL.md`：§2 工具一览（现 `:26-40`）补 `xc_read scope:"handoff"`、`xc_team action:"checkpoint"`、`xc_overview view:"timeline"/"status"` 三行；新增一小节「交接与压缩防护」：说明无 PreCompact 故用「提醒 + 一键」，提醒可关（`XC_CHECKPOINT_NUDGE=0`）、30min 阈值、每 30min 最多一次。

### 7.3 文档改动面

- `README.md`：`:181` 命令表 6→8（加 `/xc-checkpoint`、`/xc-handoff` 两行）；`:192-205` 工具表三行各补新 scope/action/view；**已知限制**（现 `:252` 起）加一条「无 PreCompact/PostCompact 钩子（3.18.2）→ 不提供自动压缩检查点，提供提醒 + 一键 `/xc-checkpoint`」；**威胁模型**（现 `:270` 起）加一句「检查点文件含任务标题/未读主题，落在工作区 `.crosschat/checkpoints/`，**不自动发给任何会话**，按项目权限管理」；`:158` longtask 段补 handoff scope；版本记录加 v0.8.0 条目。
- `docs/PROTOCOL.md`：§1.1 磁盘布局（现 `:13-31`）加 `checkpoints/<agentKey>/<ISO>.md` 与 `.nudge` 两行；§9 env 全表（现 `:201-227`）在「仅代码读取的演练 env」段加 `XC_CHECKPOINT_NUDGE`（0=关闭提醒）；新增一节「## 14. 检查点与接手包（v0.8）」承载：checkpoint 文件格式（front-matter + 七章字段冻结表）、滚动 20、提醒判据五态与阈值/开关、handoff 七要素 + 4000 字符预算降级序列 + id 过滤、timeline 字段与事件族表、status 行序与口径。
- `docs/ACCEPTANCE.md`：验收环节回填 v0.8.0 小节（本设计不预写结论）。
- 版本**五处**（统一口径，AC6 同）：`plugin/package.json:3`、`plugin/.zcode-plugin/plugin.json:3`、`plugin/src/mcp/server.ts:38`（`SERVER_VERSION`）、`marketplace.json:8`、README 安装段与版本记录（`:23-58`、`:280` 起）。

## 8. 验收映射（ACCEPT15）

判据来源 = 方案 §4 的 7 条（下称 AC1–AC7）。每条 → 模块/文件落点 → 测试落点。

| # | 判据（方案 §4） | 模块/文件落点 | 测试落点 |
|---|---|---|---|
| AC1 | **checkpoint**：写盘成功且含全部要素；保留 20 份滚动；`/xc-checkpoint` 可用；提醒仅在「有活跃任务且 >30min」时出现、可关、每 30min 最多一次；文档不宣称自动压缩钩子 | G1：`core/checkpoint.ts`、`core/paths.ts`、`mcp/tools-team.ts`、`hooks/prompt-submit.ts`、`commands/xc-checkpoint.md` | `core/checkpoint.test.ts`（stamp 格式与 Windows 合法性、front-matter **7 键恒现且逐行点数**、七章标题/顺序/字段、滚动 prune 纯函数 21→20 且 `.nudge` 不删、`checkpointNudgeDecision` 五态矩阵含 3 条负例 + §3.5 的「从未写过 → emit / 写过但 30min 内提醒过 → rate-limited」两条命名 adjudication 用例）；`mcp/tools-team-checkpoint.test.ts`（临时 stateRoot 端到端：文件存在 + 七章在场 + payload 六键 + 21 份后恰 20 + `checkpoint_write_failed` 路径 + 无 team→`no_team`）；`hooks/prompt-submit.test.ts` 增补（nudge 行进单次 emit 且仍是一行一键；无活跃任务/within-threshold/rate-limited/disabled 四种负例各不注入）；文档静态走查（README/PROTOCOL/longtask 无「自动压缩钩子」字样，且有「无 PreCompact，故用提醒+一键」原句） |
| AC2 | **handoff**：新会话接手工具调用数 ≤3；包内 7 要素；超预算有截断标注；id 过滤正确 | G2：`core/handoff.ts`、`mcp/tools-read.ts`、`commands/xc-handoff.md`、`skills/longtask` | `core/handoff.test.ts`（七键齐全；4000 超限走降级序列且 `truncated.droppedSections` 留名、无静默丢；**id 三视角七要素逐格对照 §4.1 冻结表** + 花名未读只给计数 + `tool_request` subject 遮蔽 + task 视角 checkpoint 取受领人目录）；`mcp/tools-read-handoff.test.ts`（scope 路由、未注册拒、`no_team`、payload/text 双层、非法 id 给候选）；场景②复跑（`_脚本/six-scenarios.mjs` sc2 段拷贝，口径见 §4.2「≤3 步」）：**按真实 invoke 计数**断言 identify → handoff → claim = 3 次（不得沿用 `steps.length`），并新增 `S2.handoff-7-elements`、`S2.handoff-suggestions-reachable`（对 in_progress 他人的任务给出 takeover/等清扫指引，不出走不通的指令） |
| AC3 | **timeline**：事件顺序正确、limit/预算生效、截断披露 | G2：`core/timeline.ts`、`mcp/tools-overview.ts` | `core/timeline.test.ts`（家族映射表逐行、actor/summary 取值序、尾部窗口丢半行、limit 钳 100 + `limitClamped`、坏行跳过）；`mcp/tools-overview-views.test.ts`（时序 newest-first、offset 续读指针、`truncated` 披露） |
| AC4 | **status**：容量红/绿、任务计数、stalled、离线成员、checkpoint 年龄与未读数和真实状态一致 | G2：`mcp/tools-overview.ts`（statusView 复用 capacityMount/offlineMembersMount/stalledTasks/countUnreadFor/latestCheckpoint） | `mcp/tools-overview-views.test.ts`（构造 RED/GREEN/UNKNOWN 三种容量样本各一行；七态计数与构造的 team 逐项相等；stalled 数 = stalledTasks；offline 数 = offlineMembers；checkpoint 年龄按 mtime 断言；unread 数与 mailbox 实况相等） |
| AC5 | **回归**：全量单测绿（含新增）；49 bug 全量重放无新增红；红队 P0/P1 原用例仍拒；六场景核心（sc1/sc2/sc4/sc6）通过 | 三组共同（零删除既有用例，仅增补） | `npx vitest run`（基线：本会话实测 `find plugin/src -name "*.test.ts" \| wc -l` = 83 个测试文件，全绿后方可合）；49 bug 重放 `deepseek-crosschat/evidence/21-v060/acceptance/48-bug-total-table.md` + 仓内 `_redteam-replay/`；红队 P0/P1 原用例（`_redteam-replay/adj052/cases/*.mjs`）仍拒；六场景 `_脚本/six-scenarios.mjs` sc1/sc2/sc4/sc6 |
| AC6 | **工具面**：黑盒 `tools/list` 恰 10；命令 8 个；版本 0.8.0；旧名仍 -32602 | G3：`server.ts`（版本）、`commands/`、五处版本号 | `legacy-removal.test.ts:296` 既有「tools/list 精确集合 = 恰 10」（`EXPECTED_TOOLS` 在 `:60-63`）继续通过（本版不加工具，集合不变）；命令文件断言（`:218-220`）扩到 8——**更正复核前的误判**：该断言是 6 个命令的**正向存在性循环**，新增两个命令文件**不会**让它失败，故「不改也能过」；扩到 8 是**可选的加强**（把「命令面恰 8」变成硬断言），不是必修。`mcp/tools-team-checkpoint.test.ts` 内断言未知 action 走 zod 拒（`action:"checkpoint"` 之外的拼写错值得标准 Input validation error）；版本**五处** + README 静态走查；黑盒 stdio `tools/list`（口径同 `_脚本/probe-surface.mjs`） |
| AC7 | **交付**：commit → tag v0.8.0 → prebuilt+SHA256 → Release → 安装位 0.8.0；验收报告 `reports/28-v080验收.md` 专职落盘 | G3 + 交付工程（`scripts/pack-release.mjs`） | 交付清单走查（tag 指向含本设计全部落点的 commit；资产 `zcode-crosschat-0.8.0-prebuilt-slim.tar.gz` + `.sha256`；安装位 `ZC plugins` 显示 0.8.0）；报告由验收环节落盘，本设计不代写 |

## 9. 模块划分（互不重叠；文件级落点）

### 9.1 目录树（✚=新增 ✏=改动 ─=删除 ｜=不动）

```
plugin/src/
  core/
    checkpoint.ts   ✚ G1：stamp/front-matter/七章聚合纯函数 + 落盘 + 滚动 prune + latestCheckpoint
                         + checkpointNudgeDecision/checkpointNudgeState（提醒判据五态）
    handoff.ts      ✚ G2：七要素组装 + 4000 字符降级序列 + id 过滤纯函数（now/数据注入，无 I/O）
    timeline.ts     ✚ G2：engine.jsonl 尾部窗口读 + 事件族归一化（ts/event/family/actor/taskId/summary）
    paths.ts        ✏ G1：checkpointsDir/checkpointDir/checkpointFile/checkpointNudgeFile（:109 旁）
    budget.ts stall.ts capacity.ts offline.ts archive.ts jsonl.ts log.ts teamstate.ts types.ts ｜ 不动（只读复用）
  hooks/
    prompt-submit.ts ✏ G1：提醒一支（:128-148 之后、:151 单出口之前；读路径无锁；失败只审计）
    shared.ts session-start.ts stop.ts ｜ 不动
  mcp/
    tools-team.ts    ✏ G1：action 枚举 + 载荷 + switch case + **工具级描述与 note 字段级 describe**（:74/:1259/:1428 旁/:1449/:80）
    tools-read.ts    ✏ G2：scope 枚举 + 载荷 + case + **工具级描述与 id 字段级 describe**（:71/:80/:407 旁/:528/:73）
    tools-overview.ts✏ G2：view 枚举 + limit + 路由 + statusView/timelineView + **工具级描述与 view 字段级 describe**（:138/:143/:399 旁/:511/:139）
    server.ts        ✏ G3：SERVER_VERSION 0.8.0（:38）
    其余 mcp/*.ts     ｜ 不动
  transport/ engine/ ｜ 不动
plugin/
  commands/xc-checkpoint.md ✚ G3    commands/xc-handoff.md ✚ G3    其余 6 个命令 ｜ 不动
  skills/longtask/SKILL.md  ✏ G3（§2 :30-37；§3 :39-46）
  skills/crosschat/SKILL.md ✏ G3（§2 :26-40 + 新增「交接与压缩防护」小节）
  .zcode-plugin/plugin.json ✏ G3（版本 0.8.0；**不新增 userConfig 项**）
  package.json ✏ G3（版本）   ｜ 其余不动
docs/
  DESIGN-V0.8.md ✚（本文件）
  PROTOCOL.md ✏ G3（§1.1 布局、§9 env、新 §14）
  README.md ✏ G3（命令表/工具表/已知限制/威胁模型/版本记录/longtask 段）
  ACCEPTANCE.md ✏ 验收环节回填（非本设计预写）
```

### 9.2 共享文件唯一交界（并行不撞车）

- `core/paths.ts`：**只 G1 改**（4 个 checkpoint 构建器）；G2 的 handoff/timeline/status 只**调用**它们（checkpoint 路径与 latestCheckpoint 由 `core/checkpoint.ts` 出，G2 不自行 join）。
- `core/jsonl.ts`：**零改动**——G2 的 timeline 只 import `parseJsonl`（`:43`）。
- `mcp/tools-overview.ts`：G2 独有（enum/路由/两个新视图函数一次落完）；G1 不碰（提醒在钩子侧，不过 MCP）。
- `mcp/tools-read.ts` / `mcp/tools-team.ts`：分别只属 G2 / G1，无交叉。
- `hooks/prompt-submit.ts`：只 G1 改（一支提醒 hunk）；G2/G3 不碰钩子。
- **describe 双面同步**（复核意见）：三个工具文件各改两处 describe（工具级 + 被复用入参的字段级）——`tools-team.ts:1449` 与 `:80`（note）、`tools-read.ts:528` 与 `:73`（id）、`tools-overview.ts:511` 与 `:139`（view）。只改工具级会造成模型可见面与枚举漂移；`legacy-removal.test.ts:72-83` 的模型可见面扫描器覆盖这三个文件（虽只查 22 个旧名不会误伤，走查面仍是缺口）。
- 测试文件：G1 新增 `core/checkpoint.test.ts` + `mcp/tools-team-checkpoint.test.ts` 并**增补** `hooks/prompt-submit.test.ts`；G2 新增 `core/handoff.test.ts` + `core/timeline.test.ts` + `mcp/tools-read-handoff.test.ts` + `mcp/tools-overview-views.test.ts`；G3 **增补** `mcp/legacy-removal.test.ts` 的命令断言（`:218-220`，可选加强）。三个组没有共同测试文件，可并行。
- 文档：README/PROTOCOL 只属 G3（G1/G2 的实现注释不写文档口号，避免双写漂移）。

## 10. 风险与如实声明的边界

| # | 风险 | 落位与对策 |
|---|---|---|
| R1 | **检查点泄露敏感信息**（方案 §6-1，内部威胁模型） | 文件落在工作区 `.crosschat/checkpoints/`，内容含任务标题与未读主题；**插件不把它发给任何会话**（无工具读它、无帧载它、唤醒票据不带它）；README 威胁模型明示按项目权限管理该目录；未读只抄索引不搬原文（§3.3） |
| R2 | **提醒噪声**（方案 §6-2） | 阈值 30min + 每 agent 30min 最多一次 + `XC_CHECKPOINT_NUDGE=0` 可关 + 无活跃任务不提醒 + 刚写过不提醒；AC1 的负例单测覆盖四条「不该提醒」；钩子侧任何异常只审计不阻断 |
| R3 | **handoff 预算**（方案 §6-3） | 4000 字符常量 + 固定降级序列 + 每级留名披露 `truncated`；AC2 用大任务板场景断言「无静默丢」；`id` 过滤让单任务视角天然更短 |
| R4 | **平台缺口误宣称**（方案 §6-4） | §2 四条声明 + README 已知限制逐字写明「无 PreCompact/PostCompact → 不做自动压缩钩子，用提醒+一键」；AC1 文档走查逐字检查；skill 的压缩 checklist 三步序不含「自动」字样 |
| R5 | **回归伤人**（方案 §6-5） | 零删除既有用例；三组文件无交集（§9.2）；既有断言里只有 `legacy-removal.test.ts:296` 的「tools/list 恰 10」是**必须仍绿**的硬断言，`:218-220` 的命令存在性循环是**正向断言、不会被新增文件打破**（扩到 8 属可选加强，§8 AC6 已更正）；`EXPECTED_TOOLS`（`:60-63`）本版不动 |
| R6 | **观测面给审批门开侧门** | handoff 的未读主题对 `tool_request` 帧一律遮蔽（§4.4）；checkpoint 第 5 章同样只出索引（`tool_request` 帧只记 `[urgent?] <from> | [tool_request 审批门控帧]`），不进原文 |
| R7 | **engine.jsonl 无上界导致 timeline 读全文件** | 尾部窗口读（256 KiB）+ 窗口不足时披露 `tailWindowBytes`/`olderEventsOmitted`（§5），不假装看全历史 |
| R8 | **与方案/API 面的字面差异被当作走样** | 五处增量 + 两处裁决，逐条记录理由供复核：① front-matter `capacity` 命名（`available` → `watermarkPct/freeGb`，`capacity.ts:262-279` 真源字段，§3.3）；② timeline 增 `family` 字段（方案 §2 A3 自述「事件族」九类，无字段承载，§5）；③ note 500 字符帽（§3.3）；④ `id=<花名>` 未读只给计数（观测面口径，§4.4）；⑤ **timeline 复用 `OverviewShape.offset` 并赋予新语义**——方案 A3 的 API 面（27-v080方案.md:79）只有 `limit`，没有 `offset`；本设计复用既有键但语义与板面不同（timeline = 自最新往回跳过，板面 = 自头部偏移）。同键两语义虽承诺写进工具描述与字段级 describe（§5），仍是 API 气味，**需规划方确认可接受**；若不可接受则退化为「timeline 只用 limit、不接收 offset」（代价是超 100 条后无续读指针，用 `truncated` 披露代替）。两处裁决：⑥ 从未写过检查点按「该提醒一次」（§3.5，已要求写成命名断言）；⑦ `capacity.level` 的 RED/GREEN/UNKNOWN 由新代码推导（`capacity.ts:283-286` 无该字段，§3.3） |
| R9 | **未验证项（不硬凑）** | ① 桌面/交互会话作为接手方未测（全部无头回合，与 v0.7 同边界）；② 跨工作区/跨机检查点不做（方案 §3 非目标）；③ 真压缩事件无法在本平台复现（无钩子）——「压缩后能从检查点恢复」只能验到「检查点含接手所需全部要素」这一半，另一半（宿主编压缩行为）不可测，如实写入验收报告；④ 提醒在真实长任务里的噪声基线需验收期用大任务板场景观察，不在单测里伪造结论 |
