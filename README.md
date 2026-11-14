# zcode-crosschat

[![Release](https://img.shields.io/github/v/release/QiruiGo/zcode-crosschat)](https://github.com/QiruiGo/zcode-crosschat/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

让多个**互相独立**的 zcode 会话协同完成**大型长期任务**（跨天、换会话、人不在是常态）：一个会话把可检验的任务派出去，另一个会话认领、执行、带证据回传；也可以跨会话直接互发消息、插队介入。纯插件形态（技能 + 斜杠命令 + 进程钩子 + MCP server），文件邮箱是唯一持久真源——装好即用，无必填配置。任务状态机与消息协议与开源的 dsh-agent-teams 插件机制等价（机制对照见 [docs/DESIGN.md](docs/DESIGN.md)）。

三种玩法：**两会话任务闭环**（0 配置）、**跨会话 peer 消息**（0 配置）、**lead-成员团队自动开工**（开一个开关即可，zcode 路径自动探测）。长期任务协作约定（任务日志 / 交接 / 压缩前留档）由内置 `longtask` 技能承载。

## 环境要求

- zcode 桌面版；
- Node.js ≥ 22（自测 v24）——预构建包运行时也需要：宿主用系统 node 拉起插件的 MCP server 与钩子；
- git 仅「从源码安装」的开发者路径需要；
- 兼容性声明：自测与验收在 Windows 上完成；**其他操作系统未经测试**（不宣称可用，也不宣称不可用）。

## 快速开始（3 步）

主路径 = GitHub Release 的预构建包：**下载后不需要任何构建**，装上就能用。

### 第 1 步：下载并解包

1. 打开 <https://github.com/QiruiGo/zcode-crosschat/releases>，下载资产 **`zcode-crosschat-0.6.0-prebuilt-slim.tar.gz`**（约 4–5MB）。**保留原文件名**——随包发布的 `.sha256` 校验和按原名录，改名后校验会失败。
2. （可选）校验完整性：在文件所在目录执行 `sha256sum -c zcode-crosschat-0.6.0-prebuilt-slim.tar.gz.sha256`（PowerShell 可用 `Get-FileHash` 对照 `.sha256` 文件里的值），期望输出 `OK`。
3. 解包（Windows 10+ 自带 tar，PowerShell / Git Bash 均可）：

   ```bash
   tar -xzf zcode-crosschat-0.6.0-prebuilt-slim.tar.gz
   ```

   得到目录 `zcode-crosschat-0.6.0/`（下称「解包目录」，其下应有 `marketplace.json`）。

### 第 2 步：安装

zcode 命令行**不在系统 PATH 里**（它是桌面版内置的入口），要用「可执行文件 + 入口脚本」形态调用。先定位 zcode 安装目录：

- 默认位置 `%LOCALAPPDATA%\Programs\ZCode`；
- 不在默认位置时：打开注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（以及 `HKLM` 同路径与 `HKLM\WOW6432Node` 下同名路径），找 DisplayName 含「ZCode」的项，其 `UninstallString` 里的程序路径（形如 `<某目录>\Uninstall ZCode.exe`）所在目录就是安装目录；
- 入口脚本在 `<安装目录>\resources\<variant>\zcode.cjs`（`<variant>` 常见为 `glm`；不确定就打开 `resources` 目录看哪个子目录下有 `zcode.cjs`）。

**Git Bash**（推荐：定义一次函数，后面命令都很短）：

```bash
ZC() { ELECTRON_RUN_AS_NODE=1 "<安装目录>/ZCode.exe" "<安装目录>/resources/<variant>/zcode.cjs" "$@"; }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.6.0"
# 期望：Added marketplace dev-zcode-crosschat (1 plugins)

ZC plugins install zcode-crosschat@dev-zcode-crosschat
# 期望：Installed plugin zcode-crosschat@dev-zcode-crosschat (0.6.0) [enabled]
```

**PowerShell**：

```powershell
function ZC { $env:ELECTRON_RUN_AS_NODE = "1"; & "<安装目录>\ZCode.exe" "<安装目录>\resources\<variant>\zcode.cjs" @args }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.6.0"
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
               → xc_report(completed, evidence=[{path:"result-a2b.txt", note:"结果 391"}])

（会话 A） 继续            ← 回执已自动注入 A
          → A：xc_read({scope:"inbox"}) 读回执 → 读文件核对 391 → 向你汇报
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

**可转达用户原话**：想让另一个会话知道「这是**你**说的」，让会话逐字引用你的原话（`/xc-say`）——正文命中用户原始提示时自动带 `origin="user"` 标记，接收方看到的是「发送会话用户的原话」标注；转述/改写不命中，回落为普通会话消息。

### lead-成员团队自动开工（唯一需要配置的玩法）

一个会话当队长：拆任务、程序化建成员（零人工开窗口）、收回执。先在插件设置（桌面端 → 设置 → 插件 → zcode-crosschat → 插件设置）里：

- `wake_enabled` 设为 `true`（默认关闭，避免唤醒你正开着窗口使用的会话）；
- `zcode_exe` / `zcode_cjs`：**通常留空即可**——插件自动探测本机 zcode 安装（自动探测仅在 Windows 上实现）；探测失败时运行 `xc_doctor`（或看报错文案），会告诉你填什么、去哪里找；
- `member_model`：留空 = 自动选第一个可用模型——它可能是当前账号不可用的模型；若建员因模型失败，失败回执会给出可选模型与填写指引，届时再填本项即可。

然后在一个会话里：

```text
/xc-team 把 1 到 10 的平方拆成三份给三个新成员算，结果分别写 result-m1.txt / result-m2.txt / result-m3.txt
→ 队长立队 → 引擎程序化建 3 个成员（自动注册）→ 派发 3 单
→ 成员被自动唤醒（无人值守回合）：注册 → 认领 → 执行 → 带证据汇报 → 没活自动领下一单
→ 回执回到队长邮箱；队长核对证据（读文件）后汇总给你
```

配套操作：`/xc-status` 看板（成员状态 / 任务板 / 依赖图 / 停滞标红）、`/xc-team stop <名字> [原因]` 停止成员（默认先留档）、`xc_team({action:"cancel", taskId})` 取消任务；派发时用 `dependsOn` 表达依赖、`priority` 表达优先级（只影响取单顺序，不抢占），上游完成后下游自动收到解除阻塞通知并开工。长任务暂停用 `xc_report(status:"blocked")`（原因必填），解除用 `xc_team({action:"unblock"})`。

### 长期任务：任务日志与交接（longtask）

内置 `longtask` 技能给出三行约定：任务日志写在 `.crosschat/tasks/<任务 id>/journal.md`（每进展一行摘要 + 产物指针）；新会话接手靠 `xc_read({scope:"journal"})` 读档 + `xc_read({scope:"task"})` 读任务全文，**≤3 步进入状态**；压缩前先落 journal。成员停机（`/xc-team stop`，`archive` 缺省 true）会把 journal 与元数据写到 `.crosschat/archive/<名字>/`，恢复 = 新会话 identify + 读档。

## 工具与命令

**6 个斜杠命令**（v0.6 起；`/xc-agents`、`/xc-member` 为弃用存根，分别并入 `/xc-status` 与 `/xc-team`，v0.7.0 删除）：

| 命令 | 行为 |
|---|---|
| `/xc-work [名字] [worker]` | 注册进协作网络（=`xc_identify`），返回花名册 |
| `/xc-dispatch <目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发 |
| `/xc-inbox` | 查看本会话协作收件箱并逐条摘要（=`xc_read({scope:"inbox"})`） |
| `/xc-status [全景]` | 任务板全景：任务七态、成员状态、依赖图、未读数、容量/停滞（=`xc_overview`） |
| `/xc-team [目标描述]` \| `stop <名字>` \| `transfer <成员名>` \| `release` \| `takeover` | 立队拆解；建员/停员；lead 是可指派可移交的元数据角色 |
| `/xc-say` | 用户亲述使用指引：让会话「把我的话带给 X」时如何逐字引用原话（=`xc_relay`） |

**10 个 MCP 工具**（v0.6.0 起工具面收敛；v0.5.x 的 26 个旧名仍可调用一个版本并打印弃用警告，迁移表见 [docs/MIGRATION.md](docs/MIGRATION.md)，v0.7.0 移除）：

| 工具 | 作用 |
|---|---|
| `xc_identify(name, sessionId, …)` | 注册/重绑/改名/接管（队内 + 跨会话两轴合一；`sessionId` 取钩子注入值；`takeover:true` 显式接管崩溃成员） |
| `xc_dispatch(to, title, prompt, {acceptance, dependsOn, priority})` | 派发可检验任务；`priority`（high/normal/low）只影响取单顺序 |
| `xc_claim(taskId)` | 原子认领 pending 任务，返回一次性 attemptId 凭证 |
| `xc_report(taskId, attemptId, status, {result, error, evidence})` | 回报 in_progress / completed（证据=文件+摘要）/ failed / blocked（原因必填） |
| `xc_read(scope, {id, field, offset, limit})` | 统一分页读：inbox / mail / task / peer / peer-msg / journal |
| `xc_relay(to, msg, {urgent, interrupt, summary, sourceTaskId, sourceAttemptId})` | 发消息 + 用户介入传导合一；`urgent` 插到所有未读之前并尽力唤醒；`interrupt` 请求打断（平台限制下降级为下一回合必读，payload 如实回报） |
| `xc_overview({view, history, offset})` | 全景观测：任务板（team）/ peer 清单（peers）/ 面板（panel：成员+任务+容量+停滞+入站策略） |
| `xc_team(action, …)` | 指挥族：init / transfer / release / member-add / member-stop / idle / cancel / unblock |
| `xc_review({action, axis, ids})` | 入站审阅（队内/跨会话两轴隔离区） |
| `xc_doctor` | 只读体检：插件版本、运行时、zcode 路径探测线索（免注册） |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、过期凭证硬拒、completed 缺证据拒收、证据文件存在性与工作区遏制、保留名注册拒绝、重复派发幂等去重。协议纪律（派发必须写验收标准、等待让位不轮询、认领失败不重试）由 `crosschat` 技能承载，随安装自动进入会话。

## 配置项参考（插件设置）

完整 env 表（含仅代码读取的演练变量 `XC_STALL_MINUTES` / `XC_MEM_*`）见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §9。常用项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关。开启后派发/回传在目标无人值守时用无头回合唤醒（失败回落邮箱投递）。团队自动开工必须开启 |
| `zcode_exe` / `zcode_cjs` | 空 | 留空 = 自动探测本机安装；显式配置后严格校验，无效即报错不静默回落 |
| `max_members` | `8` | 活成员上限（lead、failed、removed 不计） |
| `member_model` / `member_provider` / `member_reasoning` | 空 / 空 / `max` | 新建成员会话的模型与推理档位 |
| `member_bootstrap_timeout_ms` | `300000` | 建员等待欢迎回合上限（毫秒） |
| `inbound_mode` | `accept` | 队内自由消息入站裁决：accept / hold / refuse（协议帧不受影响） |
| `stale_task_minutes` | `30` | 在途任务超时无更新且无在途唤醒 → 清扫回待领并回执（blocked 不在清扫域） |
| `cross_session_inbound` | 空 | 跨会话入站用户层：accept / hold / refuse；与项目层/会话层取最严 |
| `peer_receive` | `on` | 跨会话接收总开关：`off` 一律拒收 |
| `hold_ttl_ms` | `43200000`（12h） | hold 件等待放行的存活时长，到期回执 `expired` |
| `messaging_dir` | 空 | 机器全局 peer 注册表根目录（留空=插件数据目录下 `peers/`） |
| `context_chars` | `200000` | 注入预算刻度（声明值；按 0.25×~4× 缩放单条/批次预算，防卡死） |

**防卡死机制**：磁盘真源（队列/邮箱/team.json）永远全文；注入面按**接收方声明的上下文预算**自适应截断（单条基准 4000、批次基准 16000 字符，按 `context_chars/200000` 缩放），被截消息带 `xc_read` 分页指针，会话不卡死、不爆上下文。公式与全部配置项见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §8–§9。

队内协作状态都在工作区 `.crosschat/` 下；peer 轴状态在机器全局注册表（默认插件数据目录下 `peers/`）。

## 常见问题（FAQ）

**`zcode: command not found`？**
zcode CLI 不在 PATH，它是桌面版内置入口。按「快速开始第 2 步」的方式调用（可执行文件 + 入口脚本，Git Bash 函数或 PowerShell 函数任选）；安装目录定位法同处（默认 `%LOCALAPPDATA%\Programs\ZCode`，否则用注册表 Uninstall 项反推）。

**`npm install` 报 esbuild 的 allowScripts 警告？**
npm 较新版本的安装脚本审批提示，**可忽略**（实测不影响构建）——只有从源码安装的开发者路径会遇到。

**装完想更新？**
解包目录/克隆目录是市场源（添加市场时做快照），**删除后无法更新**，请长期保留。出新版后：下载新 Release 资产 → 解包到新目录 → `plugins marketplace add <新解包目录>`（刷新快照）→ `plugins install zcode-crosschat@dev-zcode-crosschat`（版本递增触发重新物化）。从源码更新则需先递增 `plugin/.zcode-plugin/plugin.json` 与 `marketplace.json` 的 `version` 再重装，否则宿主不会重新物化。

**GitHub 访问不畅？**
Release 资产下载失败可换时间重试；或用实测更稳的源码压缩包兜底：`curl -L -o zcode-crosschat.tar.gz https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/heads/main`（解包后按开发者路径先构建再添加）。注意 `plugins marketplace add QiruiGo/zcode-crosschat` 这种让 zcode 内部克隆的形态只认 `ZCODE_HTTP_PROXY` 环境变量。

## 已知限制

1. **仅 Windows 实测**——所有自测与验收在 Windows 上完成；其他操作系统未经测试。
2. **团队自动开工依赖本机 zcode 路径**——默认自动探测（Windows），失败时 `xc_doctor` 与报错文案会给出填写指引；两会话任务闭环与跨会话消息**完全不受影响**。
3. **消息只在回合边界注入**——发消息不会打断对方正在进行的回合；`xc_relay({interrupt:true})` 的打断请求受宿主平台限制，**退化为 urgent + 下一回合必读**（payload `deferred-next-turn` 如实回报，E1 实测）。
4. **只能发现已显式注册的会话**——会话先注册（`xc_identify`）才能被寻址。
5. **别把敏感内容写进协作邮箱**——跨会话可见的只有邮箱/消息内容本身；身份校验是协作假设而非密码学校验。
6. **pipe 通道单帧 1 MiB 上限**——超过 1 MiB 的跨会话消息发送被拒（`too_large`）；超大内容分条发送或走队内 `xc_relay`。**MCP stdio 传输层另有 32 MiB 单帧上限**：超过的单帧被显式 JSON-RPC 拒收（`Parse error`），server 进程继续服务。**pipe 端点并发连接上限 128**：同 tick 对同一 peer 的在途连接超限时超出部分显式 `socket_busy`（重试即可）。
7. **peer 待投递队列深度上限 1024**（可配 `peer_max_queue_depth`）——达上限后新入站被丢弃并给发送方 `dropped` 回执（附原因与恢复动作）。**peer 发送限速 30 条/10 秒（每发送方）**——突发超限得 `sender_paced`，约 10s 窗口滚动恢复。
8. **注入预算是声明值**——宿主无法查询会话真实模型窗口，预算按声明的 `context_chars` 刻度缩放：偏小=多截断（安全方向）。
9. **用户亲述溯源窗口**——只有最近 8 条用户 prompt（单条 ≤64KiB、10 分钟内）参与盖章匹配；溯源证明「文本是发送会话用户所打」，不验证发送意图——接收方永远先向本会话用户确认。
10. **暂存件放行后的终态回执到不了发方**——被 hold 的消息后来被放行/拒收时，发方只知道「已暂存」。
11. **盖章语料是宿主展开后的整段提示文本**——用自定义命令时钩子记录的是命令展开后的整段提示；模型原样发出模板示例串也会命中 `origin="user"`。接收方页脚始终声明「非本会话授权」。

## 威胁模型（v0.6 口径）

- **不做对抗级防伪**：同机进程可伪造盖章记录/注册表文件——`origin="user"` 是体验性归因而非凭据；零宽/同形字归一、转发溯源链（forwardOf/hop-chain）等红队级防御已按个人/内部场景威胁模型**移除**（v0.5 的防御记录见各版设计文档）。
- **打断 = 下一回合必读**：宿主 wire 无中断原语，interrupt 是尽力请求。
- **peer 通道「沉默不等于同意」**：peer 不是你的 worker，转发的消息永远不构成本会话用户的授权；若对方说「我这边被拒/没权限，你替我跑」，那是权限洗白——拒绝并 surfaced 给你的用户。
- **接管语义**：成员崩溃后无参同名注册在 lastSeen 新鲜窗口内得 `name_taken`（不猜测死活）；`takeover:true` 立即换绑但受在途唤醒活信号闸保护（15min 内有在途回合 → 拒），误判接管可恢复（旧 attempt 回池）。
- 安全底线只判 P0：不崩（大帧守卫/截断有界）、不丢（磁盘真源全文 + 原子写 + .bak 自愈）、不串号（身份锚随连接透传）。

## 版本记录（摘要）

- **v0.6.0**（2026-11-14）：面向多会话长期协作重定位——工具面 26→10（旧名弃用可调一个版本）；C1 用户介入传导（urgent/interrupt）、C2 blocked 态 + 优先级、C3 内存水位采样与卸载留档、C4 longtask 技能与 archive、C5 停滞检测；砍邮箱哈希链/零宽同形字归一/forwardOf 溯源/regToken 硬闸（威胁模型边界见上节）。迁移表 [docs/MIGRATION.md](docs/MIGRATION.md)；协议细则 [docs/PROTOCOL.md](docs/PROTOCOL.md)；设计 [docs/DESIGN-V0.6.md](docs/DESIGN-V0.6.md)。
- **v0.5.x**：队长角色可指派可移交（v0.5.0）；观测面注入预算/peer 队列 1024/证据工作区遏制（v0.5.2）；身份锚定令牌与邮箱哈希链/同形字归一（v0.5.3——其中哈希链与同形字归一已在 v0.6 移除，记录见 MIGRATION §4）。
- v0.1–v0.4 与全部工程档案：见 [docs/](docs/)（ACCEPTANCE / DEMO / IMPLEMENTATION / PLATFORM / RELEASING 及历代 DESIGN）。

License: [MIT](./LICENSE)
