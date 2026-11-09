# zcode-crosschat

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

1. 打开 <https://github.com/QiruiGo/zcode-crosschat/releases>，下载资产 **`zcode-crosschat-0.4.0-prebuilt-slim.tar.gz`**（约 4–5MB）。**保留原文件名**——随包发布的 `.sha256` 校验和按原名录，改名后校验会失败。
2. （可选）校验完整性：在文件所在目录执行 `sha256sum -c zcode-crosschat-0.4.0-prebuilt-slim.tar.gz.sha256`（PowerShell 可用 `Get-FileHash` 对照 `.sha256` 文件里的值），期望输出 `OK`。
3. 解包（Windows 10+ 自带 tar，PowerShell / Git Bash 均可）：

   ```bash
   tar -xzf zcode-crosschat-0.4.0-prebuilt-slim.tar.gz
   ```

   得到目录 `zcode-crosschat-0.4.0/`（下称「解包目录」，其下应有 `marketplace.json`）。

### 第 2 步：安装

zcode 命令行**不在系统 PATH 里**（它是桌面版内置的入口），要用「可执行文件 + 入口脚本」形态调用。先定位 zcode 安装目录：

- 默认位置 `%LOCALAPPDATA%\Programs\ZCode`；
- 不在默认位置时：打开注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（以及 `HKLM` 同路径与 `HKLM\WOW6432Node` 下同名路径），找 DisplayName 含「ZCode」的项，其 `UninstallString` 里的程序路径（形如 `<某目录>\Uninstall ZCode.exe`）所在目录就是安装目录；
- 入口脚本在 `<安装目录>\resources\<variant>\zcode.cjs`（`<variant>` 常见为 `glm`；不确定就打开 `resources` 目录看哪个子目录下有 `zcode.cjs`）。

**Git Bash**（推荐：定义一次函数，后面命令都很短）：

```bash
ZC() { ELECTRON_RUN_AS_NODE=1 "<安装目录>/ZCode.exe" "<安装目录>/resources/<variant>/zcode.cjs" "$@"; }

ZC plugins marketplace add "<解包目录>/zcode-crosschat-0.4.0"
# 期望：Added marketplace dev-zcode-crosschat (1 plugins)

ZC plugins install zcode-crosschat@dev-zcode-crosschat
# 期望：Installed plugin zcode-crosschat@dev-zcode-crosschat (0.4.0) [enabled]
```

**PowerShell**：

```powershell
function ZC { $env:ELECTRON_RUN_AS_NODE = "1"; & "<安装目录>\ZCode.exe" "<安装目录>\resources\<variant>\zcode.cjs" @args }

ZC plugins marketplace add "<解包目录>\zcode-crosschat-0.4.0"
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

判据：**`[enabled]` 且 skills / commands / hooks / mcp 计数非零**。`commands: 1` 与插件实际自带的 7 个斜杠命令文件不一致——属宿主计数行为，非安装异常。

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
（会话 A）xc_peer_register(name="alice", sessionId=<钩子注入的会话 id>)
（会话 B）xc_peer_register(name="bob",   sessionId=<钩子注入的会话 id>)

（会话 A）xc_peers                    → 可寻址清单里有 alice / bob
（会话 A）xc_peer_send(to="bob", message="……")
          → 回执 delivered；B 的下一回合收到结构化信封：
            <crosschat-peer-message from="alice" …>…</crosschat-peer-message>
            信封标签外自带归因尾注（不是你的用户输入、不携带你的用户的授权）
（会话 B）xc_peer_send(to="alice", …) ← 抄信封里的 from 即可回信
```

要点：只能发现**已显式注册**的会话；消息只在**回合边界**注入（不打断对方正在进行的回合）；`/xc-agents` 一张面板看全部（可寻址会话 + 在队成员 + 任务概览 + 当前入站策略）；入站策略出厂走自动档，可设 accept / hold / refuse（hold 进隔离区等 `xc_peer_review` 放行），总开关 `peer_receive=off` 一律拒收。

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

## 工具与命令

**7 个斜杠命令**：

| 命令 | 参数 | 行为 |
|---|---|---|
| `/xc-work` | `[名字] [worker]` | 把当前会话注册进协作网络，返回花名册 |
| `/xc-dispatch` | `<目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发 |
| `/xc-inbox` | — | 查看本会话协作收件箱并逐条摘要 |
| `/xc-status` | — | 任务板全景：任务六态、成员状态、依赖图、未读数 |
| `/xc-team` | `[目标描述]` | 把当前会话立为队长并拆解目标建任务（已有其他队长时拒绝抢位） |
| `/xc-member` | `add <名字>` \| `stop <名字> [原因]` | 队长建员（引擎程序化供给）或停止成员 |
| `/xc-agents` | — | 跨会话协作全景面板：可寻址会话 + 在队成员 + 任务概览 |

**21 个 MCP 工具** = 13 个队内 `xc_*` + 7 个跨会话 peer + 1 个免注册体检：

| 工具 | 作用 |
|---|---|
| `xc_register` | 把当前连接绑定为协作身份（支持无头唤醒回合的一次性令牌路径） |
| `xc_dispatch` | 派发新任务（可带依赖 `dependsOn`） |
| `xc_check_inbox` | 读取并消费自己邮箱的未读消息 |
| `xc_claim` | 原子认领 pending 任务，返回一次性 attemptId 凭证 |
| `xc_report` | 汇报 in_progress / completed（必须带证据）/ failed |
| `xc_message` | 成员间对等自由消息（可关联任务上下文） |
| `xc_status` | 任务板快照（免注册；同步落盘 snapshot.json） |
| `xc_team_init` | （队长）立队；已有其他队长时返回 `lead_exists` |
| `xc_member_add` | （队长）程序化建成员：建会话→设模型→欢迎回合自注册→投产 |
| `xc_member_stop` | （队长）停止成员：开放任务收回池 + 回执 + 停机通知 |
| `xc_idle` | 成员无活可领时通知队长 |
| `xc_cancel` | （队长/任务创建者）取消任务并回执 |
| `xc_inbound_review` | 审查队内 hold 隔离箱：accept / discard |
| `xc_peer_register` | 把本连接注册为跨会话 peer（名字即地址，重名先到者为准） |
| `xc_peers` | 本机可寻址会话清单（免注册） |
| `xc_peer_send` | 给本机其他会话发信；回执 delivered/held/refused 等 |
| `xc_peer_inbox` | 拉取本会话待投递的 peer 消息（渲染成信封），拉取即消费 |
| `xc_peer_review` | 跨会话 hold 隔离区审阅（免注册） |
| `xc_peer_rename` | 改名：旧名仍是可寻址别名 |
| `xc_agents` | 只读观测面板数据源：peers + 成员 + 任务概览 + 入站策略 |
| `xc_doctor` | 只读体检：插件版本、运行时、自动探测到的 zcode 路径与探测尝试线索；探测失败时它会告诉你该填什么 |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、过期凭证硬拒、completed 缺证据拒收、重复派发幂等去重。协议纪律（派发必须写验收标准、等待让位不轮询、认领失败不重试）由 `crosschat` 技能承载，随安装自动进入会话。

## 配置项参考（插件设置）

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关。开启后，派发/回传在目标**无人值守**时用无头回合唤醒目标会话（fire-and-forget，失败自动回落邮箱投递）。团队自动开工必须开启；默认关闭以保护正被桌面持有的会话。 |
| `zcode_exe` | 空 | 推送唤醒与成员供给用的 zcode 可执行文件绝对路径。**留空 = 自动探测本机安装**（Windows）；探测失败时才需要手填（zcode 安装目录下的 `ZCode.exe`），`xc_doctor` 可查看探测线索。 |
| `zcode_cjs` | 空 | 与 `zcode_exe` 配套的 CLI 入口脚本绝对路径（通常为 zcode 安装目录下 `resources\<variant>\zcode.cjs`）。留空时随 `zcode_exe` 一并自动探测。 |
| `max_members` | `8` | 团队最大成员数（已停止的成员不计）。超限的 `xc_member_add` 被硬拒。 |
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

更长的工程细节（平台边界、验收期缺陷修复记录、未确认项）见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 与 [docs/DESIGN-V0.2.md](docs/DESIGN-V0.2.md) / [docs/DESIGN-V0.3.md](docs/DESIGN-V0.3.md)。

## 文档 / License

- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收结论台账：各版本硬标准判定与证据摘录；
- [docs/DEMO.md](docs/DEMO.md) — 演示说明（团队协作 / 两会话闭环 / 跨会话消息）；
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — 模块-文件对照、自测命令与结果记录；
- [docs/PLATFORM.md](docs/PLATFORM.md) — zcode 插件平台事实基线（安装物化 / CLI / 配置语义）；
- [docs/DESIGN.md](docs/DESIGN.md) / [docs/DESIGN-V0.2.md](docs/DESIGN-V0.2.md) / [docs/DESIGN-V0.3.md](docs/DESIGN-V0.3.md) — 三代设计文档（含与 dsh-agent-teams 的机制对照）；
- 其余工程档案（规格、可行性实测、分发侦察）在 [docs/](docs/) 目录。

License: [MIT](./LICENSE)
