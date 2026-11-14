# zcode-crosschat

[![Release](https://img.shields.io/github/v/release/QiruiGo/zcode-crosschat)](https://github.com/QiruiGo/zcode-crosschat/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

让多个**互相独立**的 zcode 会话协作：一个会话把可检验的任务派出去，另一个会话认领、执行、带证据回传；也可以跨会话直接互发消息。纯插件形态（技能 + 斜杠命令 + 进程钩子 + MCP server），文件邮箱是唯一持久真源——装好即用，无必填配置。任务状态机与消息协议与开源的 dsh-agent-teams 插件机制等价（机制对照见 [docs/DESIGN.md](docs/DESIGN.md)）。

三种玩法：**两会话任务闭环**（0 配置）、**跨会话 peer 消息**（0 配置）、**lead-成员团队自动开工**（开一个开关即可，zcode 路径 v0.4 起自动探测）。

## 环境要求

- zcode 桌面版；
- Node.js ≥ 22（自测 v24）——预构建包运行时也需要：宿主用系统 node 拉起插件的 MCP server 与钩子；
- git 仅「从源码安装」的开发者路径需要；
- 兼容性声明：自测与验收在 Windows 上完成；**其他操作系统未经测试**（不宣称可用，也不宣称不可用）。

## 快速开始（3 步）

主路径 = GitHub Release 的预构建包：**下载后不需要任何构建**，装上就能用。

### 第 1 步：下载并解包

1. 打开 <https://github.com/QiruiGo/zcode-crosschat/releases>，下载资产 **`zcode-crosschat-0.5.2-prebuilt-slim.tar.gz`**（约 4–5MB）。**保留原文件名**——随包发布的 `.sha256` 校验和按原名录，改名后校验会失败。
2. （可选）校验完整性：在文件所在目录执行 `sha256sum -c zcode-crosschat-0.5.2-prebuilt-slim.tar.gz.sha256`（PowerShell 可用 `Get-FileHash` 对照 `.sha256` 文件里的值），期望输出 `OK`。
3. 解包（Windows 10+ 自带 tar，PowerShell / Git Bash 均可）：

   ```bash
   tar -xzf zcode-crosschat-0.5.2-prebuilt-slim.tar.gz
   ```

   得到目录 `zcode-crosschat-0.5.2/`（下称「解包目录」，其下应有 `marketplace.json`）。

### 第 2 步：安装

zcode 命令行**不在系统 PATH 里**（它是桌面版内置的入口），要用「可执行文件 + 入口脚本」形态调用。先定位 zcode 安装目录：

- 默认位置 `%LOCALAPPDATA%\Programs\ZCode`；
- 不在默认位置时：打开注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（以及 `HKLM` 同路径与 `HKLM\WOW6432Node` 下同名路径），找 DisplayName 含「ZCode」的项，其 `UninstallString` 里的程序路径（形如 `<某目录>\Uninstall ZCode.exe`）所在目录就是安装目录；
- 入口脚本在 `<安装目录>\resources\<variant>\zcode.cjs`（`<variant>` 常见为 `glm`；不确定就打开 `resources` 目录看哪个子目录下有 `zcode.cjs`）。

**Git Bash**（推荐：定义一次函数，后面命令都很短）：

```bash
ZC() { ELECTRON_RUN_AS_NODE=1 "<安装目录>/ZCode.exe" "<安装目录>/resources/<variant>/zcode.cjs" "$@"; }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.5.2"
# 期望：Added marketplace dev-zcode-crosschat (1 plugins)

ZC plugins install zcode-crosschat@dev-zcode-crosschat
# 期望：Installed plugin zcode-crosschat@dev-zcode-crosschat (0.5.2) [enabled]
```

**PowerShell**：

```powershell
function ZC { $env:ELECTRON_RUN_AS_NODE = "1"; & "<安装目录>\ZCode.exe" "<安装目录>\resources\<variant>\zcode.cjs" @args }

ZC plugins marketplace add "<解包目录>\zcode-crosschat-0.5.2"
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

判据：**`[enabled]` 且 skills / commands / hooks / mcp 计数非零**。`commands: 1` 与插件实际自带的 8 个斜杠命令文件不一致——属宿主计数行为，非安装异常。

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
          → B：xc_check_inbox → xc_claim 拿 attemptId → 写文件
               → xc_report(completed, evidence=[result-a2b.txt + sha256])

（会话 A） 继续            ← 回执已自动注入 A
          → A：xc_check_inbox 读回执 → 读文件核对 391 → 向你汇报
```

整个闭环**不需要任何配置**；跟着做，约 5 分钟内可以跑通这第一次协作（不含安装时间）。

## 更多玩法（可选）

### 跨会话 peer 消息（0 配置）

本机上**互相独立**的会话（不必同工作区、不必同团队）直接互发消息，名字即地址：

```text
（会话 A）xc_peer_register(name="alice", sessionId=<钩子注入的会话 id>, regToken=<钩子注入的锚定令牌>)
（会话 B）xc_peer_register(name="bob",   sessionId=<钩子注入的会话 id>, regToken=<钩子注入的锚定令牌>)

（会话 A）xc_peers                    → 可寻址清单里有 alice / bob
（会话 A）xc_peer_send(to="bob", message="……")
          → 回执 delivered；B 的下一回合收到结构化信封：
            <crosschat-peer-message from="alice" …>…</crosschat-peer-message>
            信封标签外自带归因尾注（不是你的用户输入、不携带你的用户的授权）
（会话 B）xc_peer_send(to="alice", …) ← 抄信封里的 from 即可回信
```

要点：只能发现**已显式注册**的会话；消息只在**回合边界**注入（不打断对方正在进行的回合）；`/xc-agents` 一张面板看全部（可寻址会话 + 在队成员 + 任务概览 + 当前入站策略）；入站策略出厂走自动档，可设 accept / hold / refuse（hold 进隔离区等 `xc_peer_review` 放行），总开关 `peer_receive=off` 一律拒收。

**v0.5 起可转达用户原话**：想让另一个会话知道「这是**你**说的」，让会话逐字引用你的原话（`/xc-say`）——正文命中用户原始提示时自动带 `origin="user"` 标记，接收方看到的是「发送会话用户的原话」标注；转述/改写不命中，回落为普通会话消息。

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
→ 回执回到队长邮箱；队长核对证据（读文件 + sha256 复算）后汇总给你
```

配套操作：`/xc-status` 全景（成员状态 / 任务板 / 依赖图）、`/xc-member stop <名字> [原因]` 停止成员、`xc_cancel` 取消任务；派发时用 `dependsOn` 表达依赖，上游完成后下游自动收到解除阻塞通知并开工。

**v0.5 起队长角色可换人**：队长是**元数据角色**不是系统中枢——`/xc-team transfer <成员名>` 把队长身份移交给指定成员、`/xc-team release` 卸任回到无队长的对等态、`/xc-team takeover` 在原队长会话已退出/失联且你明确要求换帅时接管（通知旧队长，全程审计）。移交/释放/接管**不搬**任务、邮箱与注册；即使无队长，派发/认领/互发消息照常（无队长时兜底到创始会话）。

## 工具与命令

**8 个斜杠命令**：

| 命令 | 参数 | 行为 |
|---|---|---|
| `/xc-work` | `[名字] [worker]` | 把当前会话注册进协作网络，返回花名册 |
| `/xc-dispatch` | `<目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发 |
| `/xc-inbox` | — | 查看本会话协作收件箱并逐条摘要 |
| `/xc-status` | — | 任务板全景：任务六态、成员状态、依赖图、未读数 |
| `/xc-team` | `[目标描述]` \| `transfer <成员名>` \| `release` \| `takeover` | 立队拆解；v0.5 起 lead 是可指派可移交的元数据角色：`transfer` 移交给指定成员、`release` 卸任回无 lead 对等态、`takeover` 在现任 lead 失联/拒绝配合时按用户指令接管（全程审计） |
| `/xc-member` | `add <名字>` \| `stop <名字> [原因]` | 队长建员（引擎程序化供给）或停止成员 |
| `/xc-agents` | — | 跨会话协作全景面板：可寻址会话 + 在队成员 + 任务概览 |
| `/xc-say` | — | 用户亲述使用指引：让会话「把我的话带给 X」时如何逐字引用原话（盖章链按字节匹配，转述即丢标记） |

**26 个 MCP 工具** = 15 个队内 `xc_*` + 8 个跨会话 peer + 1 个免注册体检 + 2 个只读分页器：

| 工具 | 作用 |
|---|---|
| `xc_register` | 把当前连接绑定为协作身份（支持无头唤醒回合的一次性令牌路径）；重绑已绑定的 (name, sessionId) 对必须出示锚定令牌 `regToken`（v0.5.3 起，`identity_token_required`）——精确对可经 `xc_status` 公开读到，本身不是凭据；名字经同形字归一（v0.5.3 起）：西里尔/希腊字母中与拉丁形近的字符（с→c、ο→o 等）与全角拉丁折到对应拉丁字符后再判重——`viсtim` 与 `victim` 撞同一把 `name_taken` 闸；非形近字母（б г д ж、γ δ 等）原样保留，数学字母数字等其余混淆源不在归一范围 |
| `xc_dispatch` | 派发新任务（可带依赖 `dependsOn`）；`dependsOn` 指向已 failed/cancelled 的任务时显式拒绝 `invalid_params`（v0.5.3 起——终态依赖永远无法满足，挂在其下的任务只会生而死锁） |
| `xc_check_inbox` | 读取并消费自己邮箱的未读消息（单条与**批次**都按预算截断：单次只消费批次窗口内消息，其余保持未读并给「再调一次」指针；超大单条按预算截断并给分页指针）；投递时落邮箱哈希链（sidecar `<agent>.jsonl.int`，v0.5.3 起），消费面对链记录/正文哈希复核——磁盘篡改件照常返回但带显著 WARNING + `integrityViolations` 载荷并审计（不阻断消费） |
| `xc_claim` | 原子认领 pending 任务，返回一次性 attemptId 凭证（prompt/acceptance 超预算时截断回显并给 `xc_task_read` 分页指针，真源全文不动）；任务看着 pending 但派发方邮箱已有其 completed 回执（真源被陈旧备份回滚/手工改坏）时硬拒 `rollback_conflict`（v0.5.2 起，防止已完成工作被静默重复执行） |
| `xc_report` | 汇报 in_progress / completed（必须带证据）/ failed；每条证据文件必须真实存在、**位于工作区内**且 sha256 由工具现算复核（越界 → `evidence_path_outside_workspace`（v0.5.2 起），缺失 → `evidence_file_missing`，声称值不符 → `evidence_checksum_mismatch`，整单拒绝；缺省/显式 null 落现算值） |
| `xc_message` | 成员间对等自由消息（可关联任务上下文；v0.5 支持 `forwardOf` 原文转发并保留作者溯源） |
| `xc_status` | 任务板快照（免注册；任务 result/error 超预算截断并给 `resultTruncated`；任务板本身也按接收方声明预算开窗口（v0.5.2 起）——装不下时只呈现窗口前缀并给 `boardTruncated{shown,total,offset,budgetChars}`，用 `xc_status({offset})` 分页续读，`snapshot.json` 落盘仍全量；摘要行 `tasks=` 恒为任务总数、窗口行数另列 `shown=`（v0.5.3 起）；`history:true` 附 lead 变更史，超预算同样窗口化并给 `leadHistoryTruncated`；真源被陈旧备份回滚时在此强制披露 `staleCompletedReceipts`/`stateRecovery` 与 WARNING 行（v0.5.2 起）——`xc_claim` 对矛盾任务回 `rollback_conflict`；查询零写副作用（v0.5.3 起）：团队不存在时只回 `phase:none` 不落盘，不建目录） |
| `xc_mail_read` | 只读分页器：读自己邮箱历史件全文（含已消费），单次 ≤64k 字符；读取面对邮箱哈希链复核（v0.5.3 起）——篡改件带 WARNING 且载荷 `integrity.status=tampered`（附原因），存量无链记录旧件静默兼容（`unverified`） |
| `xc_task_read` | 只读分页器：读 team.json 任务 result/error/prompt 字段全文 |
| `xc_team_init` | 立队为 lead；已有其他队长时返回 `lead_exists`（载荷附现任 lead 的 sessionId）；`{takeover:true}` 仅限用户明确指令时接管 |
| `xc_lead_transfer` | （现任 lead）把 lead 角色移交给另一在册成员——元数据角色，任务/邮箱/注册不动 |
| `xc_lead_release` | （现任 lead）卸任：团队回到无显式 lead 的对等态，派发/认领/消息照常 |
| `xc_member_add` | （队长）程序化建成员：建会话→设模型→欢迎回合自注册→投产（可带 `context` 声明该成员上下文字符数） |
| `xc_member_stop` | （队长）停止成员：开放任务收回池 + 回执 + 停机通知 |
| `xc_idle` | 成员无活可领时通知队长（无显式 lead 时回落 founder）；`completedTaskId` 必须引用**存在且属于调用者**的任务（未知 → `unknown_task`、他人任务 → `not_task_owner`，v0.5.3 起硬拒）——帧自称完成状态与任务板矛盾（状态不符或自称 completed 而板上无证据）时帧内附 `integrityWarning` 供 lead 核对 |
| `xc_cancel` | （队长/任务创建者）取消任务并回执；取消后其依赖闭包内的 pending 下游自动解除（置 cancelled，v0.5.3 起）——引擎回执/唤醒各下游创建者，依赖死锁不再无声永久阻塞；`xc_report` failed 同款自动解除 |
| `xc_inbound_review` | 审查队内 hold 隔离箱：accept / discard |
| `xc_peer_register` | 把本连接注册为跨会话 peer（可带 `contextChars` 声明上下文字符数）；sessionId 归属三道闸（v0.5.3 起完整落地）：活冲突 `session_id_in_use`、无锚定 `session_not_anchored`（钩子基记录缺失即拒，全伪造 sid 进不来）、已绑定队内身份的 sid 必须出示锚定令牌 `regToken`（`identity_token_required`）；花名 claim→落盘在机器全局注册表锁内串行（v0.5.3 起）——并发注册同名时恰好一个成功、其余显式 `name_taken`（拒名带 `peer-name-taken-refused` 审计；锁超时给结构化 `busy`），不再出现同名多持有 |
| `xc_peers` | 本机可寻址会话清单（免注册；清单行按接收方声明预算开窗口（v0.5.2 起），装不下时给 `rowsTruncated{shown,total,offset,budgetChars}` 并用 `xc_peers({offset})` 分页续读） |
| `xc_peer_send` | 给本机其他会话发信（用户亲述经盖章链可携带 origin=user 权威标记；`forwardOf` 原文转发保留溯源）；回执 delivered/held/refused 等——`dropped` 等非送达终态时摘要行如实改口为「未投递」并附原因与恢复动作（v0.5.2 起，不再自称「已投递」） |
| `xc_peer_inbox` | 拉取本会话待投递的 peer 消息（信封按接收方注入预算排布），**只消费预算窗口内的到达序前缀**（v0.5.2 起）：窗口外消息保持待投递（留在队列），`remaining` 字段与摘要行「再调一次 xc_peer_inbox 继续拉取」指针照常；单条超预算时保底消费一条并做单条截断 + `xc_peer_read` 指针，响应内不再出现「已省略（超注入预算）」占位符 |
| `xc_peer_read` | 只读分页器：读某条收到的跨会话消息全文（截断指针的取回通道） |
| `xc_peer_review` | 跨会话 hold 隔离区审阅（list / accept / discard；操作**本会话**的隔离区——需先 `xc_peer_register`，注册是连接与 sessionId 的绑定方式；未注册调用显式 `not_registered`）；暂存件损坏（不可解析）时摘要行披露 `corrupted N 条`（v0.5.2 起，不再静默当空暂存区） |
| `xc_peer_rename` | 改名：旧名仍是可寻址别名；与注册同一互斥临界区（v0.5.3 起）——并发改名到同一活名恰好一个成功，其余 `name_taken`（同款拒名审计） |
| `xc_agents` | 只读观测面板数据源：peers + 成员 + 任务概览 + 入站策略（peers 行按接收方声明预算开窗口（v0.5.2 起），装不下时给 `peersTruncated{shown,total,budgetChars}`，完整清单用 `xc_peers` 续读） |
| `xc_doctor` | 只读体检：插件版本、运行时、自动探测到的 zcode 路径与探测尝试线索；探测失败时它会告诉你该填什么 |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、过期凭证硬拒、completed 缺证据拒收、证据文件存在性、工作区遏制（v0.5.2 起）与 sha256 现算复核（v0.5.1 起）、保留名注册拒绝（`xc_register` 与 `xc_member_add` 同规则）、重复派发幂等去重。协议纪律（派发必须写验收标准、等待让位不轮询、认领失败不重试）由 `crosschat` 技能承载，随安装自动进入会话。

## 配置项参考（插件设置）

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关。开启后，派发/回传在目标**无人值守**时用无头回合唤醒目标会话（fire-and-forget，失败自动回落邮箱投递）。团队自动开工必须开启；默认关闭以保护正被桌面持有的会话。 |
| `zcode_exe` | 空 | 推送唤醒与成员供给用的 zcode 可执行文件绝对路径。**留空 = 自动探测本机安装**（Windows）；探测失败时才需要手填（zcode 安装目录下的 `ZCode.exe`），`xc_doctor` 可查看探测线索。**显式配置后即严格校验并按配置使用**（v0.5.3 起）：路径不存在/不是 `.exe` 可执行文件时 `xc_member_add` 与推送唤醒显式报错（`xc_doctor` 出 WARNING），绝不静默回落自动探测、不建真实会话消耗额度。 |
| `zcode_cjs` | 空 | 与 `zcode_exe` 配套的 CLI 入口脚本绝对路径（通常为 zcode 安装目录下 `resources\<variant>\zcode.cjs`）。留空时从 `zcode_exe` 同目录推导（推导不到则显式报错要求手填）；与 `zcode_exe` 一并显式校验，无效即报错不回落（v0.5.3 起）。 |
| `max_members` | `8` | 团队最大成员数（**lead、供给失败(failed)与已停止(removed)的成员不计**——上限只约束 provisioning/ready 的活成员；v0.5.3 起口径）。超限的 `xc_member_add` 被硬拒。 |
| `member_model` | 空 | 新建成员会话的模型 id（如 `glm-5.3-flash`）。留空 = 引擎从可用模型表自动选第一个——它可能是当前账号不可用的模型；若建员因模型失败，失败回执会给出可选模型与填写指引，届时再填本项即可。 |
| `member_provider` | 空 | 成员模型的 providerId。留空时按枚举表自动匹配。 |
| `member_reasoning` | `max` | 成员会话的推理档位。 |
| `member_bootstrap_timeout_ms` | `300000` | `xc_member_add` 等待成员欢迎回合完成的上限（毫秒）。超时成员标记 failed，可同名重试（幂等重供给）。 |
| `inbound_mode` | `accept` | 队内成员间自由消息的入站裁决：accept 直接入箱；hold 进隔离箱待 `xc_inbound_review` 处置；refuse 拒收并给发送者回执。协议帧（派单/回执/空闲/解除阻塞）不受影响。 |
| `stale_task_minutes` | `30` | 在途任务超过该分钟数无任何更新且成员无在途唤醒时，被引擎清扫回待领并回执队长。成员守则要求长任务每 10 分钟心跳一次。 |
| `cross_session_inbound` | 空（=未设） | 跨会话（peer）入站裁决的用户层取值：accept / hold / refuse。留空 = 未设（刻意如此，让自动档可达）；与项目层（`<工作区>/.crosschat/peer/inbound.json`）、会话层（环境变量）取**最严者**；非法取值按 hold 处理。 |
| `peer_receive` | `on` | 跨会话接收总开关：设为 `off` 时本机所有会话一律拒收跨会话消息，压过一切其他设置。 |
| `hold_ttl_ms` | `43200000`（12h） | 被 hold 的跨会话消息等待人工放行的存活时长，到期回执 `expired`（此为 zcode 自定值）。 |
| `messaging_dir` | 空（=插件数据目录） | 机器全局的跨会话 peer 注册表根目录；填绝对路径可改到别处（例如做隔离演示）。 |
| `peer_max_queue_depth` | `0`（=内置 1024） | 单个会话的跨会话（peer）待投递队列深度上限（v0.5.2 起；此前固定 64）。超限的入站消息被丢弃并给发送方 `dropped` 回执（附原因与恢复动作）。0 或留空 = 内置默认 1024；设置更大值可容纳更长 fan-in 突发，设置更小值可提早暴露消费不足。 |
| `context_chars` | `200000` | 本会话的上下文字符数声明（v0.5 注入预算刻度；声明值，宿主无法探测真实模型窗口）。 |
| `inject_item_chars` | 空（=按预算函数） | 单条消息注入预算覆盖（字符）。设极大值可回退 v0.4 的「全文直灌」行为。 |
| `inject_total_chars` | 空（=按预算函数） | 单批次注入总预算覆盖（字符）。与上一项同规。 |
| `uservoice_ttl_ms` | `600000`（10min） | 用户亲述盖章链的匹配窗口：钩子记录的用户原话在该时长内参与匹配（每条 ≤3 次）。 |

**v0.5 防卡死机制**：磁盘真源（队列/邮箱/team.json）永远全文；注入面（钩子信封/工具响应/快照）按**接收方声明的上下文预算**自适应截断——单条基准 4000、批次基准 16000，按 `context_chars/200000` 缩放（0.25×~4×钳制）；被截消息带 `[消息已截断：显示 n/m 字符 —— 用 xc_peer_read/xc_mail_read/xc_task_read 取全文/分页]` 指针，接收方按需分页读完全文，会话不卡死、不爆上下文。**批次预算接入所有批量消费路径**（v0.5.1 起）：`xc_check_inbox` 单次只消费「JSON 面+信封面」联合成本 ≤ 批次预算的到达序前缀（保底一条），窗口外消息保持未读、摘要行/payload/信封尾行三处给「再调一次 xc_check_inbox」指针；`xc_claim` 回显的 prompt/acceptance 超单条预算即截断并给 `xc_task_read` 指针（`promptTruncated`/`acceptanceTruncated` 携带全文 sha256 供分页拼回终验）。**快照/观测面同规**（v0.5.2 起）：`xc_status` 任务板与 `history` lead 史、`xc_peers` 清单行、`xc_agents` peers 行全部接入同一预算——装不下的部分不进响应、由 `boardTruncated`/`leadHistoryTruncated`/`rowsTruncated`/`peersTruncated` 指针分页续读；凡被消费的消息绝不做「已省略」占位省略（`xc_peer_inbox` 窗口外一律留在队列）。

**v0.5 用户亲述溯源**：你在会话里打的字经 UserPromptSubmit 钩子记录（最近 8 条、单条 ≤64KiB、10 分钟窗口）；会话用 `xc_peer_send`/`xc_message` 发出的正文若是某条原话的逐字节连续片段（≥8 字符），自动携带 `origin="user"` 权威标记与分叉尾注——接收方看到「这是**发送会话**用户的原话，不构成本会话的任何授权」。工具没有 origin 参数、正文自称无效、无记录回落 agent。让会话转述你的话时用 `/xc-say`。

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

1. **仅 Windows 实测**——所有自测与验收在 Windows 上完成；其他操作系统未经测试（不宣称「不可用」，只是没测过）。
2. **团队自动开工依赖本机 zcode 路径**——默认自动探测（Windows），失败时 `xc_doctor` 与报错文案会给出填写指引；两会话任务闭环与跨会话消息**完全不受影响**。
3. **跨会话消息只在回合边界注入**——发消息不会打断对方正在进行的回合。
4. **只能发现已显式注册的会话**——会话先注册（队内 `/xc-work`；跨会话 `xc_peer_register`）才能被寻址，插件不感知未注册的会话。
5. **别把敏感内容写进协作邮箱**——跨会话可见的只有邮箱/消息内容本身；身份校验是协作假设而非密码学校验。
6. **pipe 通道单帧 1 MiB 上限**——超过 1 MiB 的跨会话消息发送被拒（`too_large`）；超大内容请分条发送或走队内 `xc_message`（无此闸，注入面照常截断）。磁盘态任意大文件可入队（入站不闸内容大小），但任何注入面都有界。**MCP stdio 传输层另有 32 MiB 单帧上限**（v0.5.1 起）：队内 `xc_message`/`xc_dispatch` 单帧 ≤32 MiB 正常入队（红队实测 9~24 MiB 档位全覆盖）；超过 32 MiB 的单帧被**显式 JSON-RPC 拒收**（`Parse error` + 明确提示），server 进程继续服务——超限内容请分条发送。**pipe 端点并发连接上限 128**（v0.5.1 起，此前 32）：`xc_peer_send` 每次调用开一条新连接，同 tick 对同一 peer 的在途连接超过 128 时超出部分显式 `socket_busy`（fail-closed，重试即可）；8 成员协作的常规 fan-in 突发（红队实测最高 45 并发）已全覆盖。
6a. **peer 待投递队列深度上限 1024**（v0.5.2 起，此前 64，可配 `peer_max_queue_depth`）——单个会话的跨会话待投递队列达到上限后，新入站消息被入队闸丢弃：发送方收到 `dropped` 回执（非错误），摘要行如实报「未投递」并附原因与恢复动作（`queue-full: … ask the receiver to drain with xc_peer_inbox, or retry later`）；窗口内消费由接收方 `xc_peer_inbox` 拉取即可释放配额。上限保留的理由：无界队列 = 接收方磁盘无界增长；1024 覆盖红队实测 300 条扇入突发（旧值 64 曾在第 65 条起静默丢弃——v0.5.2 已修）。
6b. **peer 发送限速 30 条/10 秒（每发送方）**——单个发送方对**任一**接收方的入站速率由接收侧令牌桶约束（30 条/10s，v0.5.2 起文档化；实现常量 `PEER_RATE_LIMIT`/`PEER_RATE_WINDOW_MS`）：连续突发第 31 条起被拒，发送方收到 `sender_paced` 错误（`rate-limited`），约 10s 窗口滚动恢复（等 60s 亦必恢复）；fan-in/回执风暴请按 ~5s 间隔步进发送。队内域（`xc_message`/`xc_dispatch`）无此限。
7. **注入预算是声明值**——宿主无法查询会话真实模型窗口（实测 ListModels `model_catalog_unavailable`），预算按用户声明的 `context_chars` 刻度缩放：偏小=多截断（安全方向），偏大=不劣于全文注入的旧行为。
8. **用户亲述溯源窗口**——只有最近 8 条用户 prompt（单条 ≤64KiB、10 分钟内）参与盖章匹配；更早/超长的原话不命中（回落 origin=agent，安全方向）。溯源证明「文本是发送会话用户所打」，不验证发送意图——接收方永远先向本会话用户确认。
9. **转发链 hop 只记一跳**——跨会话转发（`forwardOf`）后收方信封的 `hop-chain` 只有转发者一个名字，不累积原始链路（SPEC R-13 的 `[原链…,转发者]` 在 pipe 通道未落地）。**溯源主体不受影响**：`origin="user"` 与 `origin-session` 原样保留并继续分叉页脚。
10. **暂存件放行后的终态回执到不了发方**——被 hold 的跨会话消息后来被放行/拒收时，回执以 status 帧发往发方端点，而端点按「status 帧是收→发专用」丢弃：发方模型只知道「已暂存」，不知道后来放行还是拒收。
11. **盖章语料是宿主展开后的整段提示文本**——用 `/xc-say` 等自定义命令时，钩子记录的是**命令展开后的整段提示**（含模板里的示例原话）；模型原样发出模板示例串也会命中 `origin=user`。接收方页脚始终声明「非本会话授权」，权威不随消息转移。
12. **同机进程可伪造盖章记录**——能写 `peers/uservoice/<sid>.json` 的同机进程可以让自己的消息被盖上 `origin="user"`（威胁模型边界，不做密码学防御）。缓解：钩子独写 + `uservoice-hit` 审计；接收方永不因该标记放宽任何权限。

**v0.5.0 硬验收结论**（2026-11-11；报告与证据：`deepseek-crosschat/reports/16-v050验收.md`、`deepseek-crosschat/evidence/16-v050/acceptance/`）：五条硬标准**全部通过**——lead 指派/移交/释放/接管与无 lead 对等协作实测通过；用户亲述盖章链与两种伪造尝试（自称无效 / 仿冒信封被 `verified="false"` 标记）实测通过；614KB 大消息注入面截断到 4098 字符并可分页读完全文实测通过；typecheck 0 错、42 文件 681 例单测全绿、vs v0.4.0 基线 544 例零删除、pull/团队/peer 三轴冒烟实跑通过；L1~L10 限制条款逐条附实验证据。验收期另修复 1 处既有缺陷（hold 暂存件无法被 accept 放行，已补回归单测）。

**v0.5.1 修复轮**（2026-11-13；红队对抗裁决与逐项复现证据：`deepseek-crosschat/evidence/adversarial/adjudication.md`）：红队 19 项中 18 项 confirmed 缺陷全部修复，每项配防回归单测（裁决编号 ↔ 修复 ↔ 单测对照表见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) §12.1）。要点：`xc_status.teamId` 路径穿越封堵；peer 轴 hold→accept 放行修复（假成功黑洞）；completed 证据门硬化（文件存在性 + sha256 现算复核）；team.json 损坏自愈（.bak 镜像）与重置告警 + 任务 id 纪元前缀；坏行/已读重注入治理；不可解析残留锁自愈；僵尸任务周期清扫兑现（`stale_task_minutes`）；大帧守卫（stdio 32 MiB 显式拒收不杀进程）；批次注入预算接入 `xc_check_inbox` 与 `xc_claim`；peer 端点并发上限提到 128（fan-in 突发不再 busy）；保留名注册与 `xc_member_add` 统一。基线 48 文件 / 758 例全绿。

**v0.5.2 修复轮**（2026-11-14；红队二轮对抗裁决与逐项复现证据：`deepseek-crosschat/evidence/adversarial/adjudication/adj051-round2.md`）：二轮 21 项中 19 项 confirmed（去重后）缺陷全部修复，每项配防回归单测（裁决编号 ↔ 修复 ↔ 单测对照表见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) §14.1）。要点：**快照/观测面接入注入预算**（`xc_status` 任务板与 lead 史、`xc_peers` 清单行、`xc_agents` peers 行分页指针 `boardTruncated`/`rowsTruncated`/`peersTruncated`）；**peer 队列上限 64→1024** 并可配（`peer_max_queue_depth`），非送达回执摘要行如实改口并附恢复动作；**`xc_peer_inbox` 只消费预算窗口**（窗口外留在队列，不再「消费即省略」）；peer 重复注册幂等重认领、死花名接管留痕（`peer-name-reclaimed`）、保留名与自发禁令对齐队内轴、改名通知并行化（不再随在线数线性恶化）；**peer 注册验 sessionId 归属**（冒充与 sid 碰撞黑洞同一道闸）+ 盖章前活性/锚定双验证；伪造信封判定线前移（夹带信封标签即 `forged`）、`forwardOf` 所有权硬校验；陈旧 .bak 回滚的双重披露与 `xc_claim` 回滚矛盾硬拒、锁路径被目录占用自愈、审计不可写降级披露、暂存件损坏披露、高并发锁打开冲突重试吸收（EPERM 不再抛 internal）；completed 证据路径工作区遏制（v0.5.2 起，`evidence_path_outside_workspace`）。1 项未复现（并发注册争抢 registry 锁 EPERM）按同族失败模式顺带加固（registry 锁与 team 锁同路径重试吸收）。基线 53 文件 / 824 例全绿。

**v0.5.3 修复轮（身份轴 + 状态机/观测面收尾）**（2026-11-14；红队三番战 12 项 confirmed 裁决与逐项复现证据：`deepseek-crosschat/evidence/adversarial/adjudication/adj052/`，a1 stale 丢弃 3 轮未复现保留观察）：**注册身份锚定令牌（regToken）**——(name, sessionId) 对可经 `xc_status` 免注册读到，本身不是凭据；SessionStart 钩子现铸造每会话锚定令牌并只注入本会话上下文（两份锚定记录 `registry/sessions/<sid>.json` 与机器全局 `peers/base/<sid>.json` 各存一份）。队内轴：重绑已绑定的 (name, sid) 精确对必须出示令牌（`identity_token_required`），精确对重放冒充（偷消费邮箱 / `xc_lead_transfer` 移走 lead / 零告警，a6）就此堵死；同连接幂等重试、wakeToken 路径（一次性 nonce 即属主凭据）与升级前旧锚（放行 + 告警披露，下次 SessionStart 即带令牌）豁免。peer 轴：sessionId 归属三道闸完整落地（活冲突 `session_id_in_use` → 无锚定 `session_not_anchored`（全伪造 sid 拒绝）→ 已绑定队内身份的 sid 须验令牌 `identity_token_required`（a8 的 (name, sid) 冒充与交叉「验证」堵死））；队内注册成功后自动在基记录盖 `boundName` 队内绑定标记（跨工作区可见），未入队的普通会话 sid 不受令牌闸影响。**同轮其余修复**：伪造信封判定线升级到 NFKC 归一 + 不可见格式字符剥离副本上扫描（U+200B 零宽嵌入标签不再致盲判定，a7；补闭标签形态，fail-closed 声明见工具注释）；`xc_idle` completedTaskId 归属/存在硬拒 + 帧板矛盾 `integrityWarning`（a9）；邮箱哈希链完整性（`<agent>.jsonl.int` sidecar）——`xc_check_inbox`/`xc_mail_read` 对篡改件 WARNING + 载荷披露 + 审计（a10，检测+告警口径）；名字同形字归一（a11，见 `xc_register` 行）；无效显式 zcode_exe/zcode_cjs 配置显式报错不回落不建真会话（a5）；xc_status 幽灵团队目录（免注册无限刷目录写原语）封堵——查询零写副作用（a2）；终态依赖死锁引擎自动解除（`xc_dispatch` 派发面拒绝 + failed/cancelled 边沿级联置 cancelled + 回执/唤醒，a3）；peer 花名并发注册/改名注册表锁互斥（a4）；`max_members` 计数口径 lead/failed/removed 不计（a12）；xc_status 摘要行 `tasks=` 真值化（a13）。每项修复配防回归单测（含 a6/a8 攻击重放用例：`src/mcp/identity-regtoken.test.ts`、`src/mcp/peer-ownership.test.ts`；a7 用例 `src/core/peerenvelope-zw.test.ts`；a10 用例 `src/core/mailintegrity.test.ts` + `src/mcp/mail-integrity-face.test.ts`；其余见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) §16.1）。基线 61 文件 / 952 例全绿。

更长的工程细节（平台边界、验收期缺陷修复记录、未确认项）见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 与 [docs/DESIGN-V0.2.md](docs/DESIGN-V0.2.md) / [docs/DESIGN-V0.3.md](docs/DESIGN-V0.3.md) / [docs/DESIGN-V0.5.md](docs/DESIGN-V0.5.md)。

## 文档 / License

- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收结论台账：各版本硬标准判定与证据摘录；
- [docs/DEMO.md](docs/DEMO.md) — 演示说明（团队协作 / 两会话闭环 / 跨会话消息）；
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — 模块-文件对照、自测命令与结果记录；
- [docs/PLATFORM.md](docs/PLATFORM.md) — zcode 插件平台事实基线（安装物化 / CLI / 配置语义）；
- [docs/DESIGN.md](docs/DESIGN.md) / [docs/DESIGN-V0.2.md](docs/DESIGN-V0.2.md) / [docs/DESIGN-V0.3.md](docs/DESIGN-V0.3.md) / [docs/DESIGN-V0.4.md](docs/DESIGN-V0.4.md) / [docs/DESIGN-V0.5.md](docs/DESIGN-V0.5.md) — 五代设计文档（含与 dsh-agent-teams 的机制对照）；
- [docs/SPEC-V0.5.md](docs/SPEC-V0.5.md) — v0.5 规格（信封字段表 / 预算刻度 / 盖章链规则）与 CC 逆向坐标对齐；
- [docs/GAP-V0.5.md](docs/GAP-V0.5.md) — v0.4.0 现状盘点与三项改进的差距分析；
- [docs/RELEASING.md](docs/RELEASING.md) — 发布 runbook（版本冻结 / 打包 / 发布 / 发布后自检）；
- 其余工程档案（可行性实测、分发侦察、可行性/平台档案）在 [docs/](docs/) 目录。

License: [MIT](./LICENSE)
