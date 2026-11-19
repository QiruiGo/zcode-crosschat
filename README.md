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

1. 打开 <https://github.com/QiruiGo/zcode-crosschat/releases>，下载资产 **`zcode-crosschat-0.9.0-prebuilt-slim.tar.gz`**（约 4–5MB）。**保留原文件名**——随包发布的 `.sha256` 校验和按原名录，改名后校验会失败。
2. （可选）校验完整性：在文件所在目录执行 `sha256sum -c zcode-crosschat-0.9.0-prebuilt-slim.tar.gz.sha256`（PowerShell 可用 `Get-FileHash` 对照 `.sha256` 文件里的值），期望输出 `OK`。
3. 解包（Windows 10+ 自带 tar，PowerShell / Git Bash 均可）：

   ```bash
   tar -xzf zcode-crosschat-0.9.0-prebuilt-slim.tar.gz
   ```

   得到目录 `zcode-crosschat-0.9.0/`（下称「解包目录」，其下应有 `marketplace.json`）。

### 第 2 步：安装

zcode 命令行**不在系统 PATH 里**（它是桌面版内置的入口），要用「可执行文件 + 入口脚本」形态调用。先定位 zcode 安装目录：

- 默认位置 `%LOCALAPPDATA%\Programs\ZCode`；
- 不在默认位置时：打开注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（以及 `HKLM` 同路径与 `HKLM\WOW6432Node` 下同名路径），找 DisplayName 含「ZCode」的项，其 `UninstallString` 里的程序路径（形如 `<某目录>\Uninstall ZCode.exe`）所在目录就是安装目录；
- 入口脚本在 `<安装目录>\resources\<variant>\zcode.cjs`（`<variant>` 常见为 `glm`；不确定就打开 `resources` 目录看哪个子目录下有 `zcode.cjs`）。

**Git Bash**（推荐：定义一次函数，后面命令都很短）：

```bash
ZC() { ELECTRON_RUN_AS_NODE=1 "<安装目录>/ZCode.exe" "<安装目录>/resources/<variant>/zcode.cjs" "$@"; }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.9.0"
# 期望：Added marketplace dev-zcode-crosschat (1 plugins)

ZC plugins install zcode-crosschat@dev-zcode-crosschat
# 期望：Installed plugin zcode-crosschat@dev-zcode-crosschat (0.9.0) [enabled]
```

**PowerShell**：

```powershell
function ZC { $env:ELECTRON_RUN_AS_NODE = "1"; & "<安装目录>\ZCode.exe" "<安装目录>\resources\<variant>\zcode.cjs" @args }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.9.0"
ZC plugins install zcode-crosschat@dev-zcode-crosschat
```

**不想用命令行？** 桌面 UI 路径：打开 zcode 桌面端 → 插件市场 → 添加 → 添加插件市场 → 粘贴解包目录 → 找到 ZCode CrossChat → 安装 → 启用（此路径未做真实点击验证，UI 入口与文案以桌面实际界面为准）。

### 第 3 步：验证装通

```bash
ZC plugins list
```

期望输出包含：

```text
- zcode-crosschat@dev-zcode-crosschat [enabled]
  skills: 1, commands: 1, hooks: 3, mcp: plugin:zcode-crosschat:crosschat
```

判据：**`[enabled]` 且 skills / commands / hooks / mcp 计数非零**。`commands: 1` 与插件实际自带的斜杠命令文件数不一致——属宿主计数行为，非安装异常。

### 没有合适的 Release 资产？从源码安装（开发者路径）

```bash
git clone https://github.com/QiruiGo/zcode-crosschat.git
cd zcode-crosschat/plugin
npm install && npm run build
```

然后回到第 2 步，把「解包目录」换成克隆的仓库根目录。**顺序红线：必须先 `npm install && npm run build` 再添加市场**——安装是纯目录拷贝，源码形态不先构建会得到一个「安装显示正常、实际不可用」的插件（缺构建产物且零报错）。GitHub 直连不畅时的兜底通道（实测更稳）：`curl -L -o zcode-crosschat.tar.gz https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/heads/main`，解包后同样**先构建再添加**。

## 第一次协作：两会话闭环（0 配置）

开两个 zcode 会话，工作区设为**同一个空目录**（协作状态落在这个目录的 `.crosschat/` 下，人可直接阅读；删掉该目录即重置协作状态）。跟着敲：

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

整个闭环**不需要任何配置**；跟着做，约 5 分钟内可以跑通这第一次协作（不含安装时间）。

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

**容量标红与压缩联动（C9，建议级）**：`xc_overview`（`view:"team"`/`"panel"`）与 `xc_doctor` 都会惰性采样容量（无定时器；`capacity/sample.json` 缓存最小间隔 60s，窗口内设备水位仍与 `os.freemem()` 实时交叉复核）。三条预警规则任一命中即标红（`capacity.red`，`violated` 给出明细）：①可用内存 < 15%（`XC_MEM_WARN_WATERMARK`）；②单会话 working set > 800MB（`XC_MEM_SESSION_LIMIT_BYTES`）；③并发 headless 回合数 × 单回合预估 1.5GB > 可用内存（`XC_TURN_ESTIMATE_BYTES`，建议减少并发回合或让成员休眠）。标红时面板附 `compress-advice` 建议行——先按 longtask 技能 §3 的压缩前 checklist 落盘（`/xc-checkpoint` 检查点 + journal「当前进度」与产物路径），**之后**才接受压缩；lead 可 `xc_relay` 要求目标先 `xc_report(status:"in_progress")` 附 journal 路径，看到板面指针即算落盘。平台无宿主压缩钩子接口（zcode 3.18.2 无 PreCompact/PostCompact），插件**只能预警 + 建议 + 提醒，不能拦截或触发压缩**；v0.8 起的压缩防护是两级降级：一键 `/xc-checkpoint` 服务端落盘 + UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）——详见「已知限制」16。

### 跨会话工具转办（C6/C7，v0.7）：先查放置，再考虑转办

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
| `xc_relay(to, msg, {urgent, interrupt, summary, sourceTaskId, sourceAttemptId, withdrawMessageIds})` | 发消息 + 用户介入传导合一；`urgent` 插到所有未读之前并尽力唤醒；`interrupt` 发结构化软中断 INTERRUPT 信封（urgent 置顶不变；收方下一回合安全点消费并回确认，payload 如实回报）；`withdrawMessageIds`（仅队内轴）撤回自己发给该目标且仍未读的消息（整单语义，含已读件整单拒绝并逐条报状态）；非送达回执（dropped/held/…）在 payload `detail` 里附原因与恢复动作 |
| `xc_overview({view, history, offset, limit})` | 全景观测：任务板（team）/ peer 清单（peers）/ 面板（panel：成员+任务+容量+停滞+入站策略）/ 时间线（timeline：engine.jsonl 尾部事件，`limit` 缺省 20、上限 100）/ 紧凑状态（status：任务七态计数+stalled+容量色+离线成员+checkpoint 年龄+未读，一眼瞭望） |
| `xc_team(action, …)` | 指挥族：init / transfer / release / member-add / member-stop / idle / cancel / unblock / **checkpoint**（服务端落盘一份交接检查点；`note`=写进检查点第 7 章的一句话） |
| `xc_review({action, axis, ids})` | 入站审阅（队内/跨会话两轴隔离区；`action` 增 approve/deny、`axis` 增 approval 用于转办审批，仅现任 lead 可批） |
| `xc_doctor` | 只读体检：插件版本、运行时、zcode 路径探测线索、容量采样（水位/标红规则；免注册） |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、过期凭证硬拒、completed 缺证据拒收、证据必须是工作区内真实存在的**普通文件**且 sha256 与工具现算值一致、保留名注册拒绝、花名严格文法（全角/同形/路径符等会被静默归一到碰撞键的写法一律拒绝）、派单仅限受领人认领（not_assignee）、重复派发幂等去重。协议纪律（派发必须写验收标准、等待让位不轮询、认领失败不重试）由 `crosschat` 技能承载，随安装自动进入会话。

**证据门**（`xc_report` 的 `evidence`）：每条 = 工作区内一个真实普通文件 + 工具现算的 sha256 + 可选一句话摘要（`note`）。三道硬闸：路径越出工作区 → `evidence_path_outside_workspace`；不是普通文件（目录/设备文件）→ `evidence_not_a_file`；不存在/不可读 → `evidence_file_missing`。`sha256` 可省略（由工具现算后落库，回执随带）；**带了就必须与文件内容一致**（hex 大小写不敏感），否则整单拒绝 `evidence_checksum_mismatch`。`note` 可省略（按空串入库），控制字符入库前清洗为空格、长度钳 500 字符。

**重复派发幂等**（`xc_dispatch`）：去重键 = `(收方成员键, 任务票文本)` ∧ 该派发信封**未被读过** ∧ 仍是现行信封——**不含发送方**。同一张票、同一个收方、还没被读走，就算重复派发：不建新单，返回既有 `taskId` 与 `delivered:"duplicate"`，并在 payload 披露 `duplicateKey`（`to=<收方>|ticket=<票面 sha256 前 16 hex>`）与 `originalCreatedBy`（首派方，可能是别人）。收方已读旧票、或票面（标题/内容/验收标准）不同 → 建新单。键的完整定义见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §4。

**派单目标生命周期闸**（`xc_dispatch`，v0.7.2 C8-B3）：`to` 指向已停机（`xc_team member-stop`，state=removed）成员时**显式拒绝** `member_removed`——不建单、不投递（否则任务永久搁浅：他人 `not_assignee`、停机成员无法认领、pending 不在僵尸清扫域、创建者无回执），文案指引改派活成员或 lead 的 `xc_team member-add` 幂等重供给，审计落 `dispatch-refused`。详见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §4.3。

## 配置项参考（插件设置）

完整 env 表（含仅代码读取的演练变量 `XC_STALL_MINUTES` / `XC_MEM_*`）见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §9。常用项：

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

**防卡死机制**：磁盘真源（队列/邮箱/team.json）永远全文；注入面按**接收方声明的上下文预算**自适应截断（单条基准 4000、批次基准 16000 字符，按 `context_chars/200000` 缩放），被截消息带 `xc_read` 分页指针，会话不卡死、不爆上下文。公式与全部配置项见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §8–§9。

队内协作状态都在工作区 `.crosschat/` 下；peer 轴状态在机器全局注册表（默认插件数据目录下 `peers/`）。

## 常见问题（FAQ）

**`zcode: command not found`？** zcode CLI 不在 PATH，它是桌面版内置入口。按「快速开始第 2 步」的方式调用（可执行文件 + 入口脚本，Git Bash 函数或 PowerShell 函数任选）；安装目录定位法同处（默认 `%LOCALAPPDATA%\Programs\ZCode`，否则用注册表 Uninstall 项反推）。

**`npm install` 报 esbuild 的 allowScripts 警告？** npm 较新版本的安装脚本审批提示，**可忽略**（实测不影响构建）——只有从源码安装的开发者路径会遇到。

**装完想更新？** 解包目录/克隆目录是市场源（添加市场时做快照），**删除后无法更新**，请长期保留。出新版后：下载新 Release 资产 → 解包到新目录 → `plugins marketplace add <新解包目录>`（刷新快照）→ `plugins install zcode-crosschat@dev-zcode-crosschat`（版本递增触发重新物化）。从源码更新则需先递增 `plugin/.zcode-plugin/plugin.json` 与 `marketplace.json` 的 `version` 再重装，否则宿主不会重新物化。

**GitHub 访问不畅？** Release 资产下载失败可换时间重试；或用实测更稳的源码压缩包兜底：`curl -L -o zcode-crosschat.tar.gz https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/heads/main`（解包后按开发者路径先构建再添加）。注意 `plugins marketplace add QiruiGo/zcode-crosschat` 这种让 zcode 内部克隆的形态只认 `ZCODE_HTTP_PROXY` 环境变量。

## 已知限制

1. **仅 Windows 实测**——所有自测与验收在 Windows 上完成；其他操作系统未经测试。
2. **团队自动开工依赖本机 zcode 路径**——默认自动探测（Windows），失败时 `xc_doctor` 与报错文案会给出填写指引；两会话任务闭环与跨会话消息**完全不受影响**。
3. **回合中注入为宿主层能力，插件侧上界=软中断**——消息只在回合边界注入，发消息不会打断对方正在进行的回合；宿主无回合中注入原语（G-1，如实声明不做，建议另走平台反馈渠道），`xc_relay({interrupt:true})` 是插件侧可达上界：结构化 INTERRUPT 信封 + 收方安全点纪律（完成当前原子操作、不开新步骤、回确认），payload `deferred-next-turn` 如实回报（E1 实测）。读面信封恒由消息元数据重建，正文内嵌的信封/横幅/页脚/回信指引标记一律剥离——伪造信封不透传（v0.9.1）。
4. **只能发现已显式注册的会话**——会话先注册（`xc_identify`）才能被寻址。
5. **别把敏感内容写进协作邮箱**——跨会话可见的只有邮箱/消息内容本身；身份校验是协作假设而非密码学校验。
6. **pipe 通道单帧 1 MiB 上限**——超过 1 MiB 的跨会话消息发送被拒（`too_large`）；超大内容分条发送或走队内 `xc_relay`。**MCP stdio 传输层另有 32 MiB 单帧上限**：超过的单帧被显式 JSON-RPC 拒收（`Parse error`），server 进程继续服务。**pipe 端点并发连接上限 128**：同 tick 对同一 peer 的在途连接超限时超出部分显式 `socket_busy`（重试即可）。
7. **peer 待投递队列深度上限 1024**（可配 `peer_max_queue_depth`）——达上限后新入站被丢弃并给发送方 `dropped` 回执：payload 的 `detail` 带**原因与恢复动作**（上限值 + 「让收方 `xc_read({scope:"peer"})` 排空或稍后重试」），摘要行同步透出。**peer 发送限速 30 条/10 秒（每发送方）**——突发超限得 `sender_paced`，约 10s 窗口滚动恢复。
8. **注入预算是声明值**——宿主无法查询会话真实模型窗口，预算按声明的 `context_chars` 刻度缩放：偏小=多截断（安全方向）。
9. **用户亲述溯源窗口**——只有最近 8 条用户 prompt（单条 ≤64KiB、10 分钟内）参与盖章匹配；溯源证明「文本是发送会话用户所打」，不验证发送意图——接收方永远先向本会话用户确认。
10. **暂存件放行后的终态回执到不了发方**——被 hold 的消息后来被放行/拒收时，发方只知道「已暂存」。
11. **盖章语料是宿主展开后的整段提示文本**——用自定义命令时钩子记录的是命令展开后的整段提示；模型原样发出模板示例串也会命中 `origin="user"`。接收方页脚始终声明「非本会话授权」。
12. **转办审批门防流程缺失，不防恶意伪造**（v0.7 C6/C7）——审批门结构性拒绝未审批/过期/畸形/工具不符/自批的 `tool_request`（两个读取面都遮蔽、不进模型注入面），但同机进程仍可直接伪造审批文件——与 v0.5 uservoice「同机进程可伪造盖章记录」同一边界（个人/内部场景「不崩/不丢/不串号」底线由 JSONL 追加真源 + 团队锁 + 帧白名单 + 台账/审计双轨承担）。另外：批准后的**执行**仍是 A 会话的模型回合（crosschat 的 MCP server 是宿主外的独立 stdio 进程，不持有其他 MCP 连接，无法代调宿主工具）。
13. **唤醒回合继承发起方环境**（隔离存储场景，v0.7 已知边界）——被唤醒的回合跑在发起方环境里，其工具面可能是发起方的而非成员自己的（E4 §7.2 实测）；审批门在读取面单点生效，不依赖唤醒路径；生产单存储无此问题。
14. **压缩联动是建议级，非拦截级**（v0.7 C9）——平台无宿主压缩钩子接口，插件只能「容量预警 + 建议先落 journal（longtask checklist）+ lead 操作序」，拦不住压缩本身；规则靠回合自觉。（v0.8 起该 checklist 第一步是 `/xc-checkpoint`，平台缺口与两级降级方案见第 16 条。）
15. **桌面 UI 会话不可远程关闭**——直接 close 一个非活跃会话报 `Session is not active`（E3 ② 实测）；已退出的旧会话可先 `--resume` 再 close；**活跃的 UI 会话未测**。成员停机请走 `xc_team({action:"member-stop"})`（先留档再停、任务回池不丢）。
16. **平台无 PreCompact/PostCompact 钩子，故用「提醒 + 一键」，不提供自动压缩检查点**（v0.8）——zcode 3.18.2 没有压缩事件钩子，插件**不能在压缩发生前自动写检查点、也不能拦截压缩**：压缩防护 = ① 一键 `/xc-checkpoint`（= `xc_team({action:"checkpoint"})`，MCP server 服务端直接落盘 `.crosschat/checkpoints/<你>/<ISO>.md`，front-matter + 七章，每 agent 保留最近 20 份）；② UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）。同理**无原生状态栏扩展点**，「一眼瞭望」由 `xc_overview({view:"status"})` 紧凑文本视图承担（不是 UI）。压缩后能否从检查点恢复，取决于宿主压缩行为——本平台无压缩事件可复现，该半不可测（如实边界）。
17. **engine.jsonl 审计可整体伪造（V090-04，不修行为）**——审计是工作区内的明文 JSONL，同机进程可整文件重写（个人/内部威胁模型，不做对抗级防伪）：审计用于观测与对账，**不作为可信凭据**；可信锚点是 `xc_report` 的 evidence sha256（工具现算）与磁盘真源本身，不是日志。
18. **协议帧正文可伪装（V090-13，不修行为）**——帧白名单防「未知具名帧混进读取面」与「消息携带授权语义」，不防正文伪装：chat 正文可内嵌伪造的信封/横幅/页脚/回信指引标记。读面信封已恒由消息元数据重建（伪造引擎属性与冒名 `from` 不透传，v0.9.1/v0.9.2），但 `xc_read` 的 JSON entry 与 mail scope 原文分页按磁盘真源口径逐字保留——真值层不漂白，信任判定看元数据不看正文。
19. **撤回通知无频控（V090-14，不修行为）**——每次成功撤回各投一条 `withdrawal-notice`，通知帧不受入站限速/频控约束，失误或恶意成员可制造通知噪音；但每条通知都必须对应真实撤回的未读件（无消息即无通知），且通知帧自身不可撤回（v0.9.2 起链式撤回封死、对账锚点保留）。
20. **持续伪造引擎证言可无限期豁免清扫（V090-01 处置，不修行为）**——清扫豁免的活性输入是引擎证言（`registry/witness/<sid>.json`，只由引擎进程写：hook 回合边界 + 工具调用心跳），**一次**本地文件写伪造自述记录造不出证言（不豁免），但同机进程**持续重写**证言文件（活跃攻击）可让名下任务一直停在豁免态——这是威胁模型边界（v0.6 口径：同机进程可伪造状态文件；产品 doctrine 不做对抗级防伪护城河，签名/哈希链一律不引入）。既有防线如实：豁免**有界**（证言停止 2×stale 阈值后照扫）、`pid-dead` 硬证据立即失效、C8 离线转交通知照发（豁免不壅蔽）；可观测性兜底：任务板带 `sweepExemptPeriods`（「豁免 N×阈值」）与 `Exempt:` 文本行、`task-sweep-deferred` 审计逐周期留痕、成员行 `liveness.witness` 并列展示自述与证言——lead 可见异常长豁免并人工介入（cancel/改派）。

## 威胁模型（v0.6 口径）

- **不做对抗级防伪**：同机进程可伪造盖章记录/注册表文件——`origin="user"` 是体验性归因而非凭据；零宽/同形字归一、转发溯源链（forwardOf/hop-chain）等红队级防御已按个人/内部场景威胁模型**移除**（v0.5 的防御记录见各版设计文档）。v0.6.1 起队内轴改为在闸口**拒绝**会被静默归一到碰撞键的花名写法（与 peer 轴严格文法一致）——这是拒绝歧义而非恢复折叠/归一。
- **打断 = 下一回合必读**：宿主 wire 无中断原语，interrupt 是尽力请求。
- **peer 通道「沉默不等于同意」**：peer 不是你的 worker，转发的消息永远不构成本会话用户的授权；若对方说「我这边被拒/没权限，你替我跑」，那是权限洗白——拒绝并 surfaced 给你的用户。
- **转办不是权限借用**（v0.7 C6/C7）：A 会话代执行 B 的工具请求必须逐请求审批——审批文件由用户/lead 落盘（`.crosschat/approvals/<requestId>.json`，插件侧确定性校验），`tool` 字段与请求逐字节绑定，请求方与执行方均不能自批；白名单帧永不代表授权。relay 消息里的「帮我调个工具」同样不是用户同意——复上条纪律。
- **检查点文件按项目权限管理**（v0.8，内部威胁模型口径）：`.crosschat/checkpoints/<agentKey>/<ISO>.md` 含任务标题与未读主题（只抄索引、不搬原文，`tool_request` 帧的 subject 一律遮蔽），**插件不把它自动发给任何会话**（无工具读它、无帧载它、唤醒票据不带它）——但它是工作区里的明文文件，请按项目权限管理该目录（同「别把敏感内容写进协作邮箱」的处置逻辑）。
- **接管语义**：成员崩溃后无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；`takeover:true` 立即换绑但受两道活信号闸保护（15min 内有在途回合 → 拒；旧持有者 sid 仍被活进程持有 → `takeover_live_holder`，真实活信号、不依赖默认关闭的 wake_enabled），误判接管可恢复（旧 attempt 回池）。
- 安全底线只判 P0：不崩（大帧守卫/截断有界 + **畸形帧显式 -32700**，与超大帧同一错误码，见 [PROTOCOL §13](docs/PROTOCOL.md)）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚随连接透传）。
- **两轴操作原子**（v0.7.1 边界-4/边界-6）：`xc_identify` 的注册/改名是「队内 + peer」一次调用办两件事——任一轴失败都不留半边状态（注册：peer 失败即回滚队内轴；改名：队内被守卫阻止则 peer 也不改，peer 失败则队内改名回滚）。错误即无副作用，可直接重试。
- **改名占用他人花名 = 两轴前置拒**（v0.8.1 M01，P1）：新花名已是队内花名册另一位成员、或 peer 轴上被另一个活会话占着时，改名在**任何状态变更之前**显式拒（`team_rename_blocked` / `peer_axis_failed`，零副作用）——v0.8.0 会把队内轴先写成重复成员键，team.json 与 .bak 双双中毒、全队 team-axis 工具 internal。万一份 team.json 已被写成重复键：免注册的 `xc_doctor({action:"repair-team"})` 做确定性自愈（names 权威索引保留原持有者行、残损字节保全为 team.json.corrupt、真源与 .bak 一并重写；其他缺陷形态不猜，交还原人工恢复）。
- **改名守卫只挡活引用**（v0.8.1 C6-BUG-6）：名下开放任务、指定受领（`to`）的 pending、邮箱**未读**件挡改名（错误给出具体任务 id 与条数）；completed/cancelled/failed 是历史审计痕迹，不再永挡（有任务历史的成员现在改得动名），已读邮件历史同理。改名成功回执披露保留的终态引用数。
- **改名不丢检查点**（v0.8.1 C2-B3）：改名成功即把 `checkpoints/<旧名>/` 搬去新花名（best-effort，失败只披露）；新花名接手的默认 handoff 包三要素全空、而花名册有不在场成员持有状态时，包内给 continuity 建议指向成员视角（`xc_read({scope:"handoff", id:"<名>"})`），不再静默白纸。

## 版本记录（摘要）

- **v0.9.0**（2026-11-19，首日生产实测九缺口修复，三组并行；工具面仍恰 10、命令 8、0 新增必填配置；G-3 撤回/G-2 软中断见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §2/§3/§7 冻结示例——文档即测试契约）。**组 C 消息控制与软中断**：撤回原语（G-3）`xc_relay` 增可选 `withdrawMessageIds`（仅队内轴）——只撤自己发给该目标且**仍未读**的消息（整行删除 + 给收方投 `withdrawal-notice` 通知帧 + engine 事件 + 尽力唤醒），含已读/非本人/不存在件整单拒绝并逐条报状态；软中断（G-2）`interrupt:true` 发结构化 INTERRUPT 信封（消息元数据 + 读取面横幅，urgent 置顶语义不变），收方按安全点纪律消费（完成当前原子操作、不开新步骤、回确认），payload 如实回报；平台缺口如实声明（G-1）——回合中注入为宿主层能力，插件侧上界=软中断（已知限制 3）。**并行组增量**：唤醒分层口径变更（组 B，G-4/G-7/G-6/G-8）——旧口径「团队自动开工必须开 wake_enabled」改为「**引擎成员免开关，交互会话可选开启**」，工作区 `.crosschat/config.json` 一行开启（file > env > 默认，改文件即生效），sessionNotFound 投递自动重绑重试一次；活性与清扫联动（组 A，G-9/G-5）——活性状态机（running/idle/dead）进 `xc_overview` 成员行，任务 in_progress 且属主 running 暂停清扫倒计时、引擎事件即心跳代理。
- **v0.8.1**（2026-11-16，29-v080 能力反向检验 28 项修复；工具面仍恰 10、0 新增工具、0 新增必填配置——`xc_doctor` 多一个可选 `action:"repair-team"` 写面，新旋钮只走既有高级 env 的披露）：
  - **身份重绑与队内真源（P1×1 / P2×3）**：**改名两轴前置拒（M01，P1）**——新花名已是队内花名册另一位成员、或 peer 轴上被另一个活会话占着时，改名在**任何状态变更之前**显式拒（`team_rename_blocked` / `peer_axis_failed`，零副作用）；v0.8.0 会把队内轴先写成重复成员键、team.json 与 .bak 双中毒、全队 team-axis 工具 internal。**中毒 team.json 自愈**——免注册的 `xc_doctor({action:"repair-team"})` 做确定性修复（names 权威索引保留原持有者行、残损字节保全为 `team.json.corrupt`、真源与 .bak 一并重写；其他缺陷形态不猜）。**takeover 失败无副作用（C6-BUG-1）**——`sessionId` 校验（锚定存在性 / 未被别的花名绑定）前置到任何状态变更之前。**改名守卫只挡活引用（C6-BUG-6）**——终态任务引用不再永挡改名，未读（而非全史）才挡邮箱，挡路理由给出具体任务 id。
  - **观测面判据与口径（P2×2 / P3×22）**：**handoff 身份章（M02）**——在册成员恒得生命周期态（缺省 `ready`），不再对在册成员恒报 `(not on roster)`；**lead 渲染跨面同源（M05）**——无显式 leadKey 时 founder 读作 lead，status / handoff / checkpoint / team 视图（含 `history:true` payload 与 `not_lead`/`not_authorized` 错误信封的 `leadKey`）五处同源。**timeline（M03/M04 + C3-B2/B3/B4/B5/B7/B8）**——actor 链补 `approvedBy`/`from`/`member`（派单方/批准者不再落到接收方或置空）、按 `ts` 降序、`skippedEvents` 跳过披露、文本视图控制字符折空格、非字符串 `taskId` 归一 `null`、续读 offset 位置游标语义披露、预算刻度接 identify 的 `contextChars`、尾窗截断**每页**披露 `olderEventsOmitted`。**handoff 截断口径（C2-B5/B8/B9）**——`cappedItems.shown` 恒等于 payload 数组长度、pool 项 `priority` 恒在、checkpoint payload 恰四键（`stamp` 不再漏出）、成员视角也给第三人称单在途任务规则。**年龄取数与粒度（C2-B4 / C5-BUG-C5-02）**——取 front-matter `createdAt`（回退 mtime）、status 文本按精确分钟（26h → `1560min前`，不再 `1d前`）。**阈值披露拉齐（C4-F1/F2/O1）**——`XC_OFFLINE_MINUTES` / `XC_STALL_MINUTES` / `XC_MEM_WARN_WATERMARK` 的钳制 / 非法回落 / 越界在 status 与 team 两视图都给 payload 键 + WARNING。**checkpoint 行列（C4-F3）**——`me`（已注册时）+ 全部花名册成员，无检查点记 `(none)`。**并发与残留（C1-B01/B02）**——同毫秒并发排他创建（一次调用一份文件）、被杀进程残留 `.tmp` 按年龄清扫并披露。**C8 lead 崩溃（C6-BUG-4）**——离线属主即 lead 时转交通知改投其他在册成员，`task-offline` 审计恒定落地。**钩子零块（C1-B03）**——无可注入内容时 stdout 仍是一行 JSON 单键（`additionalContext` 空串）。**3 步接手引导（C2-B7）**——`name_taken` 文案自带 `takeover:true` 指引。
- **v0.8.0**（2026-11-15，交接与压缩防护；工具面仍恰 10、0 新增工具、0 新增必填配置——新阈值只走代码常量 + 1 个可关 env `XC_CHECKPOINT_NUDGE`）：
  - **A1 检查点**：`xc_team({action:"checkpoint", note?})` 由 MCP server **服务端直接落盘** `.crosschat/checkpoints/<agentKey>/<ISO>.md`（front-matter 7 键 + 七章：身份 / 我的进行中任务 / 待领池前 10 / 最近 journal 末 5 行 / 未读摘要前 5 / 建议下一步 / note），每 agent 保留最近 20 份（`.nudge` 节流标记不在滚动域，archive 目录不受影响）；只写自己的目录，不碰 team.json、不进邮箱、不唤醒、不改任务状态机。同毫秒并发由**排他创建**保证「一次调用一份文件」（撞名进位审计 `checkpoint-stamp-collision`，v0.8.1 C1-B01）；被杀进程残留的 `.tmp` 在每次写入时按年龄清扫（审计 `checkpoint-tmp-swept`，v0.8.1 C1-B02）。配套 `/xc-checkpoint` 命令；UserPromptSubmit 轻量提醒（有活跃任务且距上次检查点 >30min 时提示一次，每 30min 最多一次，`XC_CHECKPOINT_NUDGE=0` 可关）——**平台无 PreCompact/PostCompact 钩子，故不做自动压缩检查点**（见「已知限制」16）。
  - **A2 接手包**：`xc_read({scope:"handoff"[, id:"<taskId|花名>"]})` 一次给全七要素（身份 / 我的任务 / 待领池 / 未读摘要 / 容量水位 / 最近检查点 / 建议下一步），文本 + JSON 双层；默认 ≤4000 字符，超限按固定降级序列（pool → unread → tasks → suggestions）按章截断并披露 `truncated`，不静默丢要素；新会话接手 = `xc_identify` → `/xc-handoff` → claim/续作，**工具调用数 ≤3**。`tool_request` 帧的 subject 在观测面一律遮蔽（不给审批门开侧门）；`id=<花名>` 时未读只给计数。
  - **A3 时间线**：`xc_overview({view:"timeline", limit?})` 读 engine.jsonl **尾部窗口**（256 KiB，窗口首行可能被截断故丢弃），归一化 `ts/event/family/actor/taskId/summary`（dispatch/claim/report/sweep/offline/approval/tool/lead/member 九族），**按 ts 降序**（同 ts 后写者在前），缺省 20 条、上限 100（超限钳制并披露 `limitClamped`），预算超限给 `truncated` + 续读指针（offset = 位置游标，实时追加下可能跳号/重叠，语义已披露）；`actor` 取值序 `agentKey>by>createdBy>approvedBy>from>assignee>member>to`（v0.8.1 补 approvedBy/from/member——派单方/批准者不再落到接收方）；非字符串 `taskId` 归一为 `null`（规则冻结）；窗口内未能归一化的行计 `skippedEvents` 披露（不静默丢）；文件被尾窗截断时**每页**披露 `tailWindowBytes` / `olderEventsOmitted`，不假装看全历史；预算刻度优先取调用方 identify 时声名的 `contextChars`（逐会话覆盖，回落 env）；文本视图控制字符折空格（JSON 面保持原值）。
  - **A4 状态视图**：`xc_overview({view:"status"})` 单块紧凑文本（任务七态计数、stalled、容量色+水位、离线成员、各成员 checkpoint 年龄、未读数），复用 C9 容量采样 / C8 活性判定 / C5 停滞判定 / 未读计数，与板面同口径——**平台无原生状态栏扩展点，这是替代物不是 UI**。`XC_STALL_MINUTES` / `XC_OFFLINE_MINUTES` / `XC_MEM_WARN_WATERMARK` 的钳制 / 非法回落 / 越界一律**两级披露**（payload 键 + WARNING，v0.8.1 C4-F1/F2/O1 与 team 视图拉齐）；checkpoint 行列 `me`（已注册时）+ 全部花名册成员（无检查点记 `(none)`，v0.8.1 C4-F3 与 unread 行「对每个成员」平行）；钩子零注入块时 stdout 仍是一行 JSON 单键（`additionalContext` 空串，v0.8.1 C1-B03）。
  - **A5 命令与文档**：命令面 6 → 8（新增 `/xc-checkpoint`、`/xc-handoff`）；`longtask` 技能接手模板改为「identify → /xc-handoff → 按建议下一步 claim/续作」、压缩前 checklist 三步序（① `/xc-checkpoint` ② journal「当前进度」写全 + 产物路径落行 ③ **之后**才接受压缩）；`crosschat` 技能工具表补 handoff/checkpoint/timeline/status 四行并新增「交接与压缩防护」小节；README/PROTOCOL 新增检查点文件格式（front-matter + 七章字段冻结表）、滚动 20、提醒判据五态与阈值/开关、handoff 七要素与 4000 字符预算降级序列 + id 过滤、timeline 字段与事件族、status 行序与口径，并逐字声明「无 PreCompact，故用提醒+一键」。设计 [docs/DESIGN-V0.8.md](docs/DESIGN-V0.8.md)。
- **v0.7.2**（2026-11-15，能力反向检验 21 项 P2/P3 清理；三组修复合并记入本条）：
  - **审批门与转办轨组（10 项）**：**写者胜落地（F-01）**——审批门在**任意台账状态**下都重读磁盘审批文件：拒绝态（refused/denied）台账 + 合法批准文件 → 门放行并把台账迁回 approved（审计附 `revivedFrom`），文件轨（用户/lead 落盘）与工具轨（`xc_review` 代写同格式）自此完全等价；两处不重读：请求窗已关闭（安全边界，批准窗不可能同时满足「> now」与「≤ 请求 expiresAt」）与已终态 executed/error（回投已发生，请求帧照常带头全文）；执行方辞谢终态（refused + `resultMessageId`）亦不被审批文件复活（一请求一结果）。**多进程过期竞态（B-02）**——过期迁移改走带状态闸的 `transitionToolRequest`（团队锁内），只有真正落盘的那一次进回投列表，同相位竞态不再重复回投/重复审计。**result 限额按有效载荷计（B-03）**——字符串取自身长度（不再把 JSON 引号算进载荷，「正好等于限值」不再被拒），非字符串仍取序列化长度。**执行方辞谢落终态（B-04）**——`tool_result{status:"refused"}` 记台账 refused：一请求一结果，之后不再接受第二次回投、不被 TTL 清扫改写。**失败表文案校正（B-05）**——PROTOCOL §11.2 按实际行为分列：显式 `名字 [team]` 后缀指向非花名册成员 = 队内闸 `not_a_member`；裸名双轴都未命中 = `target_not_found`（两者都 fail-closed，仅代码不同）。**自批守卫按成员键归一化（C7-B2）**——`approvedBy` 写大小写/折叠变体（`"REQB"` vs `reqb`）不再绕过 self-approval refused。**畸形审批诊断分流（C7-B3）**——`unparseable JSON` / `not a JSON object` / `invalid fields:<清单>` / `requestId mismatch` 四态各得其真因（9 变体不再一律误报）。**lead 收尾可达（C7-B5）**——停在 refused/denied 且窗口已关闭的请求，sweeper 补发 `approval_result{decision:"expired"}`（`approvalClosedAt` 记档防重复）。**终态台账拒审批（C7-B6）**——对 executed/error/expired 台账 approve/deny 显式拒绝 `request_already_finalized`（不写审批文件、不发回执、不改台账）。**待批清单剔除窗关请求（C7-B7）**——已过 `expiresAt` 的 pending 不进可批清单（另报 `lapsedWindowClosed` 计数 + 说明行），不再把「批准窗已关」呈现为可批。
  - **离线与身份组（6 项）**：**崩溃残留保留（F-02/C8-B1）**——`xc_identify` 注册/改名路径的 peer 扫描改**只读**（`sweep:false`）+ 死记录**定向 GC**（只回收本次认领花名的死前任）：`pid-dead` 残留是 C8 离线判据唯一的进程死硬证据，「成员崩溃 → 无人值守 → 重启后第一动作 identify」不再抹掉它——task-offline 审计 / lead 转交通知 / overview offlineMembers 在「重启后查看」流程不再静默丢失。**idle-timeout 判据落盘（C8-B2）**——任务记录新增 `lastProgressTs` 字段（`appendTaskHistory` 唯一收口点随 history 末条刷新），读取口径 = history 末条与落盘字段中**较旧**的一个（外部改写/时间加速时保守方向）；idle-timeout 分支自此可达，且不把活进程/空闲误判为离线（live/heartbeat-stale 仍判 `offline:false`）。**派单目标生命周期闸（C8-B3）**——`to` 指向 removed 成员显式拒绝 `member_removed`（不建单、不投递；否则任务永久搁浅），文案指引改派活成员或 lead `member-add` 幂等重供给，审计落 `dispatch-refused`。**离线阈值非法值披露（C8-B4）**——`XC_OFFLINE_MINUTES=0`/负数/非数字不再静默回落：回落内置缺省 240min 并附 WARNING + payload `offlineThresholdFallback:true`（与 clamped 披露并存）。**C8 lead 崩溃也留信号（v0.8.1 C6-BUG-4）**——离线属主即 lead 自己（founder 兜底同判）时，转交通知改投**其他在册成员**（通知崩溃者自己的邮箱无接收意义，队友才能认领回池的任务），`task-offline` 审计恒定落地（v0.8.0 对该身份整体跳过通知+审计，红队 lane-b4：presweep status 已检出 pid-dead、sweep 却零 task-offline）。**停机恢复路径文档化（C9-B5）**——留档 journal「交接注意」与 README longtask 节按**真实可达**路径书写：member-add 幂等重启用（removed 成员唯一入口）或新花名接手 → 读档续作；同名 identify 在 removed 门处被显式拒绝，不再给出走不通的指令。**改名写 names.json 新绑定（CB-01）**——队内花名换绑后新键写入 names.json（旧键删除）：SessionStart 钩子不再误报「尚未注册跨会话花名」；新键已被别的 sid 占用（陈旧死绑定）时不覆盖别人的索引行。
  - **C9 呈现与文档组**：任务板 ID 列加宽到 `<8hex>-t<N>` 全形（超宽保尾截断）——同一波派发的任务不再在文本面全同形，journal 路径 / `xc_read({scope:"journal"})` / `xc_claim` 依赖的 taskId 在板面上可定位（C9-B2）；RESULT/ERROR 列取消固定 24 字符截断，「看到板面指针即算落盘」在文本渲染面成立（行宽由注入预算窗口统一兜底，JSON 面本就全量不回归——C9-B1）；容量缓存窗口内与 `os.freemem()` 实时交叉复核设备水位——伪造/陈新缓存不再能制造最长 60s 的虚假读数（缓存仍只省 CIM 进程树采样成本——C9-B3）；第三条标红规则 `turn-concurrency`（并发 headless 回合 × `XC_TURN_ESTIMATE_BYTES` 单回合预估 > 可用内存）补登 README/PROTOCOL §5 与 §9 env 表（C9-B4）；`xc_doctor` 按 PROTOCOL §5 参与容量惰性采样并展示（与 `xc_overview` 同一 `sample.json` 缓存/窗口/判定，采样意外只丢该观测块——C9-B6）。
  - 工具面仍恰 10，0 新增工具、0 新增必填配置（`XC_TURN_ESTIMATE_BYTES` 为 v0.7 起即存在的仅代码读取高级 env，本次仅补公共文档登记）。
- **v0.7.1**（2026-11-15，红队四番战 P2/P3 清理；15 项分三组并行修复，本条合并各组条目）：
  - **证据与观测组**：evidence 的 sha256 恢复现算复核（v0.6 砍复核后回执恒 null、DEMO 核对流程落空——边界-7 P3；`evidence_checksum_mismatch` 硬拒，缺省由工具现算并随回执披露 `evidenceSha256`）；证据闸收紧（目录/设备文件不得作证据 `evidence_not_a_file`；`note` 可选性显式=省略按空串入库，控制字符清洗为空格、钳 500 字符——边界-8 P3）；peers 视图 `[ref]` 只在跨会话可寻址行（self/session）渲染且照抄即可作地址，`member` 行不再渲染不可寻址的 `[ref]`（边界-9 P3）；peer 入队闸 `dropped` 回执把「原因 + 恢复动作」透进 `xc_relay` payload `detail` 与摘要行（规模压-B1 P3）；成员上限报文自洽（`activeMembers`=当前活成员、另报 `activeAfterAdd`=本次写入后——规模压-B2 P3）；重复派发去重键明确定义为 `(收方, 任务票) ∧ 未读 ∧ 现行`、**不含发送方**，回执披露 `duplicateKey`/`originalCreatedBy`（规模压-B3 P3）。
  - **故障注入组**：provisioning 超时判据落盘 + 清扫（`provisionDeadlineAt`；lead server 中途死亡不再让成员永久卡 provisioning——后续 member-add/回合钩子清扫为 failed + 审计 `member-provision-timeout` + 同名重试干净接管，故障注-1 P2）；names.json 损坏报错带文件路径与恢复指引（可重建索引：删文件即重置，故障注-2 P2）；peer 消息 store 损坏返回显式 `message_corrupt`（带路径+恢复动作，不再误报 unknown msgId；未消费消息 queue 兜底仍可读，故障注-3 P2）；`xc_read({scope:"peer"})` 披露队列坏行计数 `malformedLines`（与 inbox/held 口径一致，故障注-4 P3）。
  - **协议与状态组**：`xc_identify` 两轴操作原子化——注册时 peer 轴失败即**回滚队内轴**（names.json 绑定 / roster 成员行 / 连接绑定全撤，错误信封 `teamAxis:{registered:false, rolledBack:true}`，调用方可当无副作用直接重试；回滚自身失败也如实披露，边界-4 P3）；改名两轴原子——队内轴被「板面不干净」守卫阻止时 **peer 轴也不改**（显式 `team_rename_blocked`，不再留「队内旧名 + peer 新名」双身份；peer 轴改名失败则队内轴改名回滚到原键，边界-6 P3）；畸形 JSON 帧（裸控制字节 / `NaN` / 坏 JSON / 帧型不符）与超大帧同样回 **-32700**（尽力取回请求 id，传输不关、后续帧继续服务，不再 0 字节静默丢弃，边界-5 P3）；`session_id_in_use` 同 sid 冲突文案分流（payload 增 `sameSessionId`，不再把「同一会话被两个活进程重复拉起」误述成 another live session，并发与-1 P3）；`XC_STALE_TASK_MINUTES=0` 语义显式化 = 回落缺省 30min（既非立即清扫也非关闭清扫，与 `XC_PEER_MAX_QUEUE_DEPTH` 的「0=内置值」同口径，边界-10 P3）。
  - 工具面仍恰 10，0 新增工具、0 新增必填配置。
- **v0.7.0**（2026-11-15）：C6 转办授权 / C7 审批最小集 / C8 离线任务转交 / C9 压缩联动 + 旧名移除——转办与审批走 `xc_relay` 帧与 `xc_review` 扩展（工具面仍恰 10，0 新增）；未审批 `tool_request` 在两个读取面结构性遮蔽；审批文件为用户/lead 落盘的授权锚点；离线判定复用 peer 活性/心跳与 stale sweeper（240min 阈值 env 可配，不把空闲当离线）；容量标红附 `compress-advice` 建议行（longtask checklist + lead 操作序，建议级非拦截级）；**22 个旧名弃用垫片与 `/xc-agents`、`/xc-member` 命令存根按 MIGRATION §5 承诺移除**（breaking：调用旧名得 `Tool <name> not found`）。设计 [docs/DESIGN-V0.7.md](docs/DESIGN-V0.7.md)；迁移表 [docs/MIGRATION.md](docs/MIGRATION.md)。
- **v0.6.1**（2026-11-14）：红队四番战 P0/P1 安全修复（对齐 peer 轴既有语义，工具面仍 10）——队内轴注册/改名/接管补 sessionId 归属与活性硬闸（`session_id_in_use`，堵零凭据用他人公开 sid 冒名串号，P0 安全对-1）；花名严格文法 + 保留名两轴合一（全角/同形/路径符/控制符等碰撞写法与 `system/user/main/team-lead` 一律拒绝，P1 安全对-2 + P2 安全对-5/边界-2）；`xc_claim` 仅限派单受领人认领（`not_assignee`，与 `xc_report` 同闸，P1 安全对-3）；`takeover:true` 对活成员拒（`takeover_live_holder`，P1 安全对-4）；lead/founder 改名 key 随动（不再悬空锁死 transfer/release/init，P1 边界-1）。未恢复 v0.6 砍掉的归一/哈希链/regToken 对抗面。
- **v0.6.0**（2026-11-14）：面向多会话长期协作重定位——工具面 26→10（旧名弃用可调一个版本）；C1 用户介入传导（urgent/interrupt）、C2 blocked 态 + 优先级、C3 内存水位采样与卸载留档、C4 longtask 技能与 archive、C5 停滞检测；砍邮箱哈希链/零宽同形字归一/forwardOf 溯源/regToken 硬闸（威胁模型边界见上节）。迁移表 [docs/MIGRATION.md](docs/MIGRATION.md)；协议细则 [docs/PROTOCOL.md](docs/PROTOCOL.md)；设计 [docs/DESIGN-V0.6.md](docs/DESIGN-V0.6.md)。
- **v0.5.x**：队长角色可指派可移交（v0.5.0）；观测面注入预算/peer 队列 1024/证据工作区遏制（v0.5.2）；身份锚定令牌与邮箱哈希链/同形字归一（v0.5.3——其中哈希链与同形字归一已在 v0.6 移除，记录见 MIGRATION §4）。
- v0.1–v0.4 与全部工程档案：见 [docs/](docs/)（ACCEPTANCE / DEMO / IMPLEMENTATION / PLATFORM / RELEASING 及历代 DESIGN）。

License: [MIT](./LICENSE)
