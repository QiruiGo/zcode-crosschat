# zcode-crosschat

[![Release](https://img.shields.io/github/v/release/QiruiGo/zcode-crosschat)](https://github.com/QiruiGo/zcode-crosschat/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

让多个**互相独立**的 zcode 会话协同完成**大型长期任务**（跨天、换会话、人不在是常态）：一个会话把可检验的任务派出去，另一个会话认领、执行、带证据回传；也可以跨会话直接互发消息、插队介入。纯插件形态（技能 + 斜杠命令 + 进程钩子 + MCP server），文件邮箱是唯一持久真源——装好即用，无必填配置。任务状态机与消息协议与开源的 dsh-agent-teams 插件机制等价（机制对照见 [docs/DESIGN.md](docs/DESIGN.md)）。

三种玩法：**两会话任务闭环**（0 配置）、**跨会话 peer 消息**（0 配置）、**lead-成员团队自动开工**（引擎成员免开关，交互会话可选开启；zcode 路径自动探测）。长期任务协作约定（任务日志 / 交接 / 压缩前检查点与留档）由内置 `longtask` 技能承载。

## 环境要求

- zcode 桌面版；
- Node.js ≥ 22（自测 v24）——预构建包运行时也需要：宿主用系统 node 拉起插件的 MCP server 与钩子；
- git 仅「从源码安装」的开发者路径需要；
- 兼容性声明：自测与验收在 Windows 上完成；**其他操作系统未经测试**（不宣称可用，也不宣称不可用）。

## 快速开始（3 步）

主路径 = GitHub Release 的预构建包：**下载后不需要任何构建**，装上就能用。

### 第 1 步：下载并解包

1. 打开 <https://github.com/QiruiGo/zcode-crosschat/releases>，下载资产 **`zcode-crosschat-0.9.2-prebuilt-slim.tar.gz`**（约 1.7MB；v0.9.4 起生产包已裁掉 node_modules 与测试文件）。**保留原文件名**——随包发布的 `.sha256` 校验和按原名录，改名后校验会失败。
2. （可选）校验完整性：在文件所在目录执行 `sha256sum -c zcode-crosschat-0.9.2-prebuilt-slim.tar.gz.sha256`（PowerShell 可用 `Get-FileHash` 对照 `.sha256` 文件里的值），期望输出 `OK`。
3. 解包（Windows 10+ 自带 tar，PowerShell / Git Bash 均可）：

   ```bash
   tar -xzf zcode-crosschat-0.9.2-prebuilt-slim.tar.gz
   ```

   得到目录 `zcode-crosschat-0.9.2/`（下称「解包目录」，其下应有 `marketplace.json`）。

### 第 2 步：安装

zcode 命令行**不在系统 PATH 里**（它是桌面版内置的入口），要用「可执行文件 + 入口脚本」形态调用。先定位 zcode 安装目录：

- 默认位置 `%LOCALAPPDATA%\Programs\ZCode`；
- 不在默认位置时：打开注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（以及 `HKLM` 同路径与 `HKLM\WOW6432Node` 下同名路径），找 DisplayName 含「ZCode」的项，其 `UninstallString` 里的程序路径（形如 `<某目录>\Uninstall ZCode.exe`）所在目录就是安装目录；
- 入口脚本在 `<安装目录>\resources\<variant>\zcode.cjs`（`<variant>` 常见为 `glm`；不确定就打开 `resources` 目录看哪个子目录下有 `zcode.cjs`）。

**Git Bash**（推荐：定义一次函数，后面命令都很短）：

```bash
ZC() { ELECTRON_RUN_AS_NODE=1 "<安装目录>/ZCode.exe" "<安装目录>/resources/<variant>/zcode.cjs" "$@"; }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.9.2"
# 期望：Added marketplace dev-zcode-crosschat (1 plugins)

ZC plugins install zcode-crosschat@dev-zcode-crosschat
# 期望：Installed plugin zcode-crosschat@dev-zcode-crosschat (0.9.2) [enabled]
```

**PowerShell**：

```powershell
function ZC { $env:ELECTRON_RUN_AS_NODE = "1"; & "<安装目录>\ZCode.exe" "<安装目录>\resources\<variant>\zcode.cjs" @args }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.9.2"
ZC plugins install zcode-crosschat@dev-zcode-crosschat
```

**不想用命令行？** 桌面 UI 路径：打开 zcode 桌面端 → 插件市场 → 添加 → 添加插件市场 → 粘贴解包目录 → 找到 ZCode CrossChat → 安装 → 启用（此路径未做真实点击验证，UI 入口与文案以桌面实际界面为准）。

**生效口径（安装/更新后何时跑上新码）**：marketplace 安装源刷新后，**新起的插件进程即加载新码**（钩子与 MCP server 随每个新会话、每个新无头回合各自启动）；桌面重载只是用户侧确认动作，不是生效前提。实测依据（2026-11-21 断联日）：未经桌面重载，运行中的插件进程已吐出新版独有事件 `watchdog-wake`（本机 0.9.1 安装源码全目录无此事件名、0.9.2 的 watchdog.ts 有；已按 tag 树复核）

### 第 3 步：验证装通

```bash
ZC plugins list
```

期望输出包含（`commands: 1` 与插件实际自带的斜杠命令文件数不一致——属宿主计数行为，非安装异常）：

```text
- zcode-crosschat@dev-zcode-crosschat [enabled]
  skills: 1, commands: 1, hooks: 3, mcp: plugin:zcode-crosschat:crosschat
```

判据：**`[enabled]` 且 skills / commands / hooks / mcp 计数非零**。

**没有合适的 Release 资产？从源码安装（开发者路径）**：git clone → `npm install && npm run build` → **先构建再添加**（顺序红线），GitHub 直连不畅的兜底通道与完整步骤见 [docs/RELEASING.md](docs/RELEASING.md) §7。

## 第一次协作：两会话闭环（0 配置）

开两个 zcode 会话，工作区设为**同一个空目录**（协作状态落在这个目录的 `.crosschat/` 下，人可直接阅读；删掉该目录即重置协作状态）。跟着敲（整个闭环**不需要任何配置**，约 5 分钟内可以跑通，不含安装时间）：

```text
（会话 A） /xc-work a
          → 注册进协作网络，返回花名册
（会话 B） /xc-work b

（会话 A） /xc-dispatch b 计算 17*23，把结果只写数字到 result-a2b.txt
          → 回报 taskId 与投递状态

（会话 B） 继续            ← 随便说一句；B 的下一回合自动注入「有 1 条未读协作消息」
          → B：xc_read({scope:"inbox"}) → xc_claim 拿 attemptId → 写文件
               → xc_report(completed, evidence=[{path:"result-a2b.txt", sha256:<自算>, note:"结果 391"}])
                 sha256 可省略（省略时由工具对文件现算）；带了就必须和文件内容一致，否则整单拒绝

（会话 A） 继续            ← 回执已自动注入 A
          → A：xc_read({scope:"inbox"}) 读回执（回执里带 evidence 的 sha256，工具现算值）
               → 读文件、用同一算法复算比对（DEMO §3.3 同款）→ 核对 391 → 向你汇报
```

## 更多玩法（可选）

### 跨会话 peer 消息（0 配置）

本机上**互相独立**的会话（不必同工作区、不必同团队）直接互发消息，名字即地址：

```text
（会话 A）xc_identify(name="alice", sessionId=<钩子注入的会话 id>)
（会话 B）xc_identify(name="bob",   sessionId=<钩子注入的会话 id>)

（会话 A）xc_overview({view:"peers"})   → 可寻址清单里有 alice / bob
（会话 A）xc_relay(to="bob", msg="……")
          → 回执 delivered；B 的下一回合收到结构化信封：
            <crosschat-peer-message from="alice" …>…</crosschat-peer-message>
            信封标签外自带归因尾注（不是你的用户输入、不携带你的用户的授权）
（会话 B）xc_read({scope:"peer"})      ← 拉取待投递消息；回信抄信封里的 from
```

要点：只能发现**已显式注册**的会话；消息只在**回合边界**注入（不打断对方正在进行的回合，插队介入见 `xc_relay` 的 urgent）；`/xc-status`（全景视图）一张面板看全部（可寻址会话 + 在队成员 + 任务概览 + 容量/停滞 + 当前入站策略）；入站策略出厂走自动档，可设 accept / hold / refuse（hold 进隔离区等 `xc_review` 放行），总开关 `peer_receive=off` 一律拒收。

**寻址与 `[ref]`**（v0.7.1 边界-9）：peers 清单一次给出三类行——`self`（本会话）、`session`（其他跨会话 peer）、`member`（在队成员，队内花名册的只读投影）。**只有跨会话行（self/session）在名字不够用时带 `[ref]`**（= 该会话 sessionId 末 8 位），它就是可寻址的消歧后缀：`to="名字 [ref]"` 精确命中（照抄清单里那一串即可）。`member` 行不带 `[ref]`——它不是跨会话地址，队内寻址用裸名或 `名字 [team]` 后缀；两轴同名时 `to="名字"` 会报 `ambiguous_target` 并列出两个候选，用 `名字 [ref]`（peer 轴）或 `名字 [team]`（队内轴）二选一。

**可转达用户原话**：想让另一个会话知道「这是**你**说的」，让会话逐字引用你的原话（`/xc-say`）——正文命中用户原始提示时自动带 `origin="user"` 标记，接收方看到的是「发送会话用户的原话」标注；转述/改写不命中，回落为普通会话消息。

### lead-成员团队自动开工（引擎成员免开关；交互会话可选开启）

一个会话当队长：拆任务、程序化建成员（零人工开窗口）、收回执。**v0.9 起唤醒分层（G-4/G-7）**：引擎程序化建的成员**免开关自动唤醒**——派单即开回合，不再需要先开 `wake_enabled`（旧口径「团队自动开工必须开 wake_enabled」自 v0.9 废止）；交互式会话（你正开着窗口用的）默认**不**被自动唤醒，维持防打扰。想让某个工作区的交互会话也参与自动开工时，在该工作区 `.crosschat/config.json` 里一行开启（文件优先级高于插件设置，钩子每回合重读、改文件即生效）。插件设置里可确认的常规项：

- `zcode_exe` / `zcode_cjs`：**通常留空即可**——插件自动探测本机 zcode 安装（自动探测仅在 Windows 上实现）；探测失败时运行 `xc_doctor`（或看报错文案），会告诉你填什么、去哪里找；
- `member_model`：留空 = 自动选第一个可用模型——它可能是当前账号不可用的模型；若建员因模型失败，失败回执会给出可选模型与填写指引，届时再填本项即可。

然后在一个会话里：

```text
/xc-team 把 1 到 10 的平方拆成三份给三个新成员算，结果分别写 result-m1.txt / result-m2.txt / result-m3.txt
→ 队长立队 → 引擎程序化建 3 个成员（自动注册）→ 派发 3 单
→ 成员被自动唤醒（无人值守回合）：注册 → 认领 → 执行 → 带证据汇报 → 没活自动领下一单
→ 回执回到队长邮箱；队长核对证据（读文件）后汇总给你
```

配套操作：`/xc-status` 看板（成员状态 / 任务板 / 依赖图 / 停滞标红）、`/xc-team stop <名字> [原因]` 停止成员（默认先留档）、`xc_team({action:"cancel", taskId})` 取消任务；派发时用 `dependsOn` 表达依赖、`priority` 表达优先级（只影响取单顺序，不抢占），上游完成后下游自动收到解除阻塞通知并开工。长任务暂停用 `xc_report(status:"blocked")`（原因必填），解除用 `xc_team({action:"unblock"})`。换会话接手用 `/xc-handoff`（30 秒接手包，≤3 次工具调用进入状态），压缩或交接前先 `/xc-checkpoint` 落检查点。

### 长期任务：任务日志与交接（longtask）

内置 `longtask` 技能给出三行约定：任务日志写在 `.crosschat/tasks/<任务 id>/journal.md`（每进展一行摘要 + 产物指针）；新会话接手走 `/xc-handoff`（= `xc_read({scope:"handoff"})`，`id` 可收窄到任务 id 或花名）**一次拿全七要素**（身份 / 我的任务 / 待领池 / 未读摘要 / 容量水位 / 最近检查点 / 建议下一步），再按 `suggestions` 直接 claim/续作——**≤3 次工具调用进入状态**（`xc_identify` → handoff → claim/续作；全文仍按 `xc_read({scope:"journal"})` 读档 + `xc_read({scope:"task"})` 读任务原文分页取，超 4000 字符的接手包按章截断并在末行披露指针）；压缩前先 `/xc-checkpoint`（= `xc_team({action:"checkpoint"})`，服务端直接落盘 `.crosschat/checkpoints/<你>/<ISO>.md`，每 agent 保留最近 20 份）落检查点、再落 journal。成员停机（`/xc-team stop`，`archive` 缺省 true）会把 journal 与元数据写到 `.crosschat/archive/<名字>/`，恢复 = 新会话 identify + 读档——停机花名的重启用有两条可达路径：lead 的 `xc_team({action:"member-add"})` 幂等重供给（removed 成员的唯一重启用入口，之后新会话 identify 绑回该名），或直接用新花名 identify 接手；两条路都靠读档续上下文（留档 journal 的「交接注意」节按 v0.7.2 起写明这两条路径——同名 identify 在 removed 门处被显式拒绝，不再给出走不通的指令）。

**容量标红与压缩联动（C9，建议级）**：`xc_overview`（`view:"team"`/`"panel"`）与 `xc_doctor` 都会惰性采样容量（无定时器；`capacity/sample.json` 缓存最小间隔 60s，窗口内设备水位仍与 `os.freemem()` 实时交叉复核）。三条预警规则任一命中即标红（`capacity.red`，`violated` 给出明细）：①可用内存 < 15%（`XC_MEM_WARN_WATERMARK`）；②单会话 working set > 800MB（`XC_MEM_SESSION_LIMIT_BYTES`）；③并发 headless 回合数 × 单回合预估 1.5GB > 可用内存（`XC_TURN_ESTIMATE_BYTES`，建议减少并发回合或让成员休眠）。标红时面板附 `compress-advice` 建议行——先按 longtask 技能 §3 的压缩前 checklist 落盘（`/xc-checkpoint` 检查点 + journal「当前进度」与产物路径），**之后**才接受压缩；lead 可 `xc_relay` 要求目标先 `xc_report(status:"in_progress")` 附 journal 路径，看到板面指针即算落盘。平台无宿主压缩钩子接口（zcode 3.18.2 无 PreCompact/PostCompact），插件**只能预警 + 建议 + 提醒，不能拦截或触发压缩**；v0.8 起的压缩防护是两级降级：一键 `/xc-checkpoint` 服务端落盘 + UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）——详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md) 第 16 条。**v0.9.1 起容量预警不再只停在展示面**：`attemptWake` 在 spawn 无头回合前读同一份 verdict（水位低于硬底 ∨ 单回合预估 > 可用内存）→ 不 spawn、`deliver=mailbox` + payload `wake-deferred{reason:"capacity-red"}` + 冷却重试（`XC_MEM_WAKE_COOLDOWN_MS` 缺省 120s，`XC_MEM_WAKE_GATE=off` 可关闸）——消息照常落邮箱、pull 兜底不丢，详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md) 第 22 条。

## 工具与命令

**8 个斜杠命令**（v0.7.0 起 `/xc-agents`、`/xc-member` 弃用存根已删文件——功能早已并入 `/xc-status` 与 `/xc-team`；v0.8.0 起新增 `/xc-checkpoint`、`/xc-handoff`）：

| 命令 | 行为 |
|---|---|
| `/xc-work [名字] [worker]` | 注册进协作网络（=`xc_identify`），返回花名册 |
| `/xc-dispatch <目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发 |
| `/xc-inbox` | 查看本会话协作收件箱并逐条摘要（=`xc_read({scope:"inbox"})`） |
| `/xc-status [全景]` | 任务板全景：任务七态、成员状态、依赖图、未读数、容量/停滞（=`xc_overview`） |
| `/xc-team [目标描述]` \| `stop <名字>` \| `transfer <成员名>` \| `release` \| `takeover` | 立队拆解；建员/停员；lead 是可指派可移交的元数据角色 |
| `/xc-say` | 用户亲述使用指引：让会话「把我的话带给 X」时如何逐字引用原话（=`xc_relay`） |
| `/xc-checkpoint [一句话备注]` | 写一份交接检查点到 `.crosschat/checkpoints/<你>/`（服务端落盘：身份/我的任务/待领池/journal 摘要/未读/建议下一步/note），压缩或换会话前先用它落盘（=`xc_team({action:"checkpoint"})`） |
| `/xc-handoff [任务id\|花名]` | 读一份 30 秒接手包（七要素 + 建议下一步），新会话接手或换人续作时用；可按任务 id 或花名收窄（=`xc_read({scope:"handoff"})`） |

**10 个 MCP 工具**（v0.6.0 起工具面收敛；22 个更名旧名的弃用垫片已按 [docs/MIGRATION.md](docs/MIGRATION.md) §5 承诺于 v0.7.0 移除——调用旧名得标准错误 `Tool <name> not found`）：

| 工具 | 作用 |
|---|---|
| `xc_identify(name, sessionId, …)` | 注册/重绑/改名/接管（队内 + 跨会话两轴合一；`sessionId` 取钩子注入值；`takeover:true` 显式接管崩溃成员；peer 轴附 `kind`/`modeClass`/`contextChars`） |
| `xc_dispatch(to, title, prompt, {acceptance, dependsOn, priority})` | 派发可检验任务；`priority`（high/normal/low）只影响取单顺序；同一张票重复派发幂等（见下） |
| `xc_claim(taskId)` | 原子认领 pending 任务，返回一次性 attemptId 凭证 |
| `xc_report(taskId, attemptId, status, {result, error, evidence})` | 回报 in_progress / completed（证据=工作区内普通文件 + 现算 sha256 + 可选摘要）/ failed / blocked（原因必填） |
| `xc_read(scope, {id, field, offset, limit})` | 统一分页读：inbox / mail / task / peer / peer-msg / journal / **handoff**（30 秒接手包，七要素 + 建议下一步；`id`=任务 id 或花名收窄） |
| `xc_relay(to, msg, {urgent, interrupt, summary, sourceTaskId, sourceAttemptId, withdrawMessageIds, refs})` | 发消息 + 用户介入传导合一；`urgent` 插到所有未读之前并尽力唤醒；`interrupt` 发结构化软中断 INTERRUPT 信封（urgent 置顶不变；收方下一回合安全点消费并回确认，payload 如实回报）；`withdrawMessageIds`（仅队内轴）撤回自己发给该目标且仍未读的消息（整单语义，含已读件整单拒绝并逐条报状态）；`refs`（可选）随消息带工作区内真实文件的 path+sha256（+可选 mime/note），接收面渲染「用 Read 打开该路径」提示——传引用不传内容，不内联、不 base64；非送达回执（dropped/held/…）在 payload `detail` 里附原因与恢复动作 |
| `xc_overview({view, history, offset, limit})` | 全景观测：任务板（team）/ peer 清单（peers）/ 面板（panel：成员+任务+容量+停滞+入站策略）/ 时间线（timeline：engine.jsonl 尾部事件，`limit` 缺省 20、上限 100）/ 紧凑状态（status：任务七态计数+stalled+容量色+离线成员+checkpoint 年龄+未读，一眼瞭望）；capacity 块附唤醒闸状态（阻塞条件/下次重判/本窗 wake-deferred 计数） |
| `xc_team(action, …)` | 指挥族：init / transfer / release / member-add / member-stop / idle / cancel / unblock / **checkpoint**（服务端落盘一份交接检查点；`note`=写进检查点第 7 章的一句话） |
| `xc_review({action, axis, ids})` | 入站审阅（队内/跨会话两轴隔离区；`action` 增 approve/deny、`axis` 增 approval 用于转办审批，仅现任 lead 可批） |
| `xc_doctor` | 只读体检：插件版本、运行时、zcode 路径探测线索、容量采样（水位/标红规则；免注册） |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、过期凭证硬拒、completed 缺证据拒收、证据必须是工作区内真实存在的**普通文件**且 sha256 与工具现算值一致、保留名注册拒绝、花名严格文法（全角/同形/路径符等会被静默归一到碰撞键的写法一律拒绝）、派单仅限受领人认领（not_assignee）、重复派发幂等去重。协议纪律（派发必须写验收标准、等待让位不轮询、认领失败不重试）由 `crosschat` 技能承载，随安装自动进入会话。

**证据门**（`xc_report` 的 `evidence`）：每条 = 工作区内一个真实普通文件 + 工具现算的 sha256 + 可选一句话摘要（`note`）。三道硬闸：路径越出工作区 → `evidence_path_outside_workspace`；不是普通文件（目录/设备文件）→ `evidence_not_a_file`；不存在/不可读 → `evidence_file_missing`。`sha256` 可省略（由工具现算后落库，回执随带）；**带了就必须与文件内容一致**（hex 大小写不敏感），否则整单拒绝 `evidence_checksum_mismatch`。`note` 可省略（按空串入库），控制字符入库前清洗为空格、长度钳 500 字符。

**重复派发幂等**（`xc_dispatch`）：去重键 = `(收方成员键, 任务票文本)` ∧ 该派发信封**未被读过** ∧ 仍是现行信封——**不含发送方**。同一张票、同一个收方、还没被读走，就算重复派发：不建新单，返回既有 `taskId` 与 `delivered:"duplicate"`，并在 payload 披露 `duplicateKey`（`to=<收方>|ticket=<票面 sha256 前 16 hex>`）与 `originalCreatedBy`（首派方，可能是别人）。收方已读旧票、或票面（标题/内容/验收标准）不同 → 建新单。键的完整定义见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §4。

**派单目标生命周期闸**（`xc_dispatch`，v0.7.2 C8-B3）：`to` 指向已停机（`xc_team member-stop`，state=removed）成员时**显式拒绝** `member_removed`——不建单、不投递（否则任务永久搁浅：他人 `not_assignee`、停机成员无法认领、pending 不在僵尸清扫域、创建者无回执），文案指引改派活成员或 lead 的 `xc_team member-add` 幂等重供给，审计落 `dispatch-refused`。详见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §4.3。

## 配置项参考（插件设置）

完整 env 表（含仅代码读取的演练变量 `XC_STALL_MINUTES` / `XC_MEM_*`）见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §9。队内协作状态都在工作区 `.crosschat/` 下（peer 轴状态在机器全局注册表，默认插件数据目录下 `peers/`）。常用项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关（**交互会话**口径）。v0.9 起分层：引擎供给成员免开关自动唤醒；交互式会话维持默认关闭防打扰，需要时在工作区 `.crosschat/config.json` 一行开启（文件优先级高于本项，改文件即生效）。开启后派发/回传在目标无人值守时用无头回合唤醒（失败回落邮箱投递） |
| `zcode_exe` / `zcode_cjs` | 空 | 留空 = 自动探测本机安装；显式配置后严格校验，无效即报错不静默回落 |
| `max_members` | `8` | 活成员上限（lead、failed、removed 不计）。触顶时报错 `team_at_member_cap`，payload 分报 `activeMembers`（当前活成员数）与 `activeAfterAdd`（本次写入后的数目） |
| `member_model` / `member_provider` / `member_reasoning` | 空 / 空 / `max` | 新建成员会话的模型与推理档位 |
| `member_bootstrap_timeout_ms` | `300000` | 建员等待欢迎回合上限（毫秒）。超时判据随 provisioning 记录落盘（deadline=本值+60s 宽限）：lead 的 MCP server 中途死亡也不会让成员永久卡 provisioning——后续 `xc_team member-add` 调用或任一存活会话的回合钩子把过期记录清扫为 failed（审计 `member-provision-timeout`、名额释放、同名重试干净接管） |
| `inbound_mode` | `accept` | 队内自由消息入站裁决：accept / hold / refuse（协议帧不受影响） |
| `stale_task_minutes` | `30` | 在途任务超时无更新且无在途唤醒 → 清扫回待领并回执（blocked 不在清扫域）。**`0`/负数/非数字 = 回落缺省 30min**（不是立即清扫、也不是关闭清扫；想调小窗口就设正值，如 `1`） |
| `cross_session_inbound` | 空 | 跨会话入站用户层：accept / hold / refuse；与项目层/会话层取最严 |
| `peer_receive` | `on` | 跨会话接收总开关：`off` 一律拒收 |
| `hold_ttl_ms` | `43200000`（12h） | hold 件等待放行的存活时长，到期回执 `expired` |
| `messaging_dir` | 空 | 机器全局 peer 注册表根目录（留空=插件数据目录下 `peers/`） |
| `context_chars` | `200000` | 注入预算刻度（声明值；按 0.25×~4× 缩放单条/批次预算，防卡死） |

## 已知限制与威胁模型

24 条已知限制（平台缺口、威胁模型边界与「不修行为」的如实声明）与 v0.6 口径威胁模型已搬家至 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)（v0.9.4 B3：README 正文 ≤220 行预算，内容零丢失、逐条可比对）。

## 版本记录

逐版摘要（v0.5.x 起，含各版不变式声明）见 [CHANGELOG.md](CHANGELOG.md)——v0.9.4 起新版本条目只进 CHANGELOG，README 不再内联版本历史。

License: [MIT](./LICENSE)
