# zcode-crosschat

让多个**互相独立**的 zcode 会话互相派发任务、执行并回传结果——对齐 Claude Code 生态的「跨对话交流执行任务」能力。

它是一个纯 zcode 声明式插件（skills + commands + hooks + mcpServers 四组件）：

- **MCP server 常驻进程**承担工具面与投递引擎，暴露 13 个 `xc_*` 工具；
- **文件邮箱是唯一持久真源**（`<工作区>/.crosschat/`），与宿主完全解耦；
- **进程钩子**做会话身份锚定、活跃刷新与收件箱拉取注入；
- **`zcode --resume` 无头单发**做跨进程推送唤醒（可选，默认关闭）。

任务状态机（六态 + attempt 令牌）与消息格式机制等价移植自 opencode/DeepSeek 生态的 dsh-agent-teams 插件，全部用 zcode 原生扩展点重新实现。

**v0.2.0 新增 lead-成员团队协作**（设计见 `docs/DESIGN-V0.2.md`，目标为闭合 v0.1.0 相对 CC Agent Teams 的核心差距 G1-G6；实现、单元测试与端到端硬验收均已落地——五条硬验收标准（自动开工/动态成员/lead 协调/回归/GAP 闭合）于 2026-11-09 全部通过，验收报告：`deepseek-crosschat/reports/10-v020验收.md`，演示步骤与证据摘录：`docs/DEMO.md`）：

- **三种身份**：`lead`（`xc_team_init` 或首个建员动作隐式成为 lead；拆解目标→建员→派发→核收回执→汇总）＋ **engine 成员**（lead 调 `xc_member_add`，引擎经 app-server 协议程序化建会话→设模型→欢迎回合自注册，**零人工开窗口**）＋ **peer**（v0.1.0 自注册形态原样保留）；
- **自动开工无守护进程**：成员唤醒 prompt 内嵌守则 v2（回合内多单循环、完成即领下一单、心跳、无活 `xc_idle` 通知 lead）；确定性边沿在工具层实现——终态报告自动解除依赖阻塞（unblock-notice→唤醒下游）、僵尸任务清扫（30 分钟无心跳回池）、投产边沿（供给期间积压的派发在成员就绪后立即唤醒投产）；
- **V9 修复**：推送唤醒改经「立即退出的 node 跳板」（`dist/mcp/wake-helper.mjs`）孤儿化，派发方 CLI/app-server 退出不再连带清杀唤醒子进程——机制经可行性实验 E3b 端到端实测（FEASIBILITY-V0.2 §2.1），产品化链路有真实 spawn 单测覆盖，产品级复现已于验收完成（Phase B：CLI 派发方退出后成员全自动完成，`10-v020验收.md` §4）；WMI 逃逸为预设计备选（见已知限制）；
- **观测与安全**：`xc_status` 结构化全景（成员状态/lead/任务 DAG/未读/引擎信息，snapshot.json 同步刷新）、`xc_cancel`/`xc_member_stop` 控制工具；帧类型白名单（未知帧一律拒收+审计）、入站策略 accept/hold/refuse（hold 消息进独立 `.held.jsonl` 不注入）、引擎签发一次性 wakeToken + 预绑名双重背书。

v0.1.0 的对等 pull 协作（两会话邮箱闭环）**原样保留且不受以上增量影响**：会话形态上，engine 成员与 lead 的唤醒回合均为属主缺席的无头会话，跨会话可见的仍然只有邮箱内容。

## 工作原理

1. **身份**：SessionStart / UserPromptSubmit 钩子把当前会话 id 写入注册表并注入上下文；每条 MCP 连接通过 `xc_register` 绑定一个花名，之后所有工具自动取当前连接的身份，无需（也不允许）传调用者参数。
2. **派发**：`xc_dispatch` 把一个可检验任务（标题 + 内容 + 验收标准）投进目标会话的邮箱（`inbox/<名字>.jsonl`），返回 `{taskId, delivered}`。
3. **投递**：`delivered=mailbox` 表示消息已落盘、对方下一回合会被钩子自动注入未读提示；`delivered=wake` 表示已额外用 `zcode --resume` 无头唤醒目标会话（仅属主缺席会话，默认关闭）；`duplicate` 表示同文消息已在效期内，不重复投递。
4. **执行**：目标会话 `xc_claim` 原子认领任务并拿到一次性 `attemptId` 凭证，执行后 `xc_report` 汇报；报告 `completed` 必须携带结果摘要与至少一条证据（文件路径 + sha256）。
5. **回传**：回执落回派发方邮箱，派发方核对证据与验收标准后向用户汇报。
6. **兜底**：所有状态变更走「进程内锁 + 跨进程 lockfile + 读侧严格校验 + 原子写」，多会话并发写同一状态根不会撕裂数据；损坏的邮箱行会被跳过并记入审计，不阻塞其余消息。

## 环境要求

- zcode 桌面版（插件通过桌面「插件市场」安装）；
- Node.js 与 npm（构建产物，以及运行 MCP server 与钩子——宿主以 `node` 拉起它们；自测所用版本为 v24）。

## 安装与启用

以下 `<仓库目录>` 指本仓库克隆后的根目录（其下有 `marketplace.json`）。

### 1. 构建插件

```bash
cd <仓库目录>/plugin
npm install
npm run build        # 产出 dist/mcp/server.mjs + dist/hooks/{session-start,prompt-submit,stop}.mjs
```

### 2. 校验清单（可选但推荐）

```bash
zcode plugins validate <仓库目录>/plugin
# 期望输出：Plugin manifest is valid
```

### 3. 通过桌面 UI 安装

CLI 安装子命令的参数未在帮助中文档化，桌面 UI 是权威路径：

1. 打开 zcode 桌面端，进入 **插件市场 → 添加 → 添加插件市场**；
2. 粘贴 `<仓库目录>`（市场根，市场清单 `marketplace.json` 在其下，插件源指向 `./plugin`）；
3. 在 **个人** 市场下找到 **zcode-crosschat**，**安装**并**启用**。

### 4. 验证装通

```bash
zcode plugins list
```

输出应包含 `zcode-crosschat`，且其 skills / commands / hooks / mcp 计数非零（对应本插件的 1 技能、6 命令、3 钩子、1 个 MCP server）。

### 5. 更新

修改源码后：`npm run build` 重新构建 → 同时递增 `plugin/.zcode-plugin/plugin.json` 与 `marketplace.json` 两处 `version` → 在插件市场刷新源 → 插件详情里「更新」。宿主会把插件物化进缓存，不递增版本拿到的仍是旧产物。

## 快速上手：两会话闭环

桌面端开两个 zcode 会话，**工作区设为同一个目录**（状态真源落在该目录的 `.crosschat/` 下；目录任选，本仓库的 `.scratch/` 即为此用途预留，已被 git 忽略）。

```text
（会话 A） /xc-work a
          → a 注册进协作网络，返回花名册
（会话 B） /xc-work b
          → b 注册进协作网络

（会话 A） /xc-dispatch b 计算 17*23，把结果只写数字到 result-a2b.txt
          → A 调 xc_dispatch，回报 taskId 与 delivered 状态

（会话 B） 继续            ← 随便说一句；钩子已把「你有 1 条未读协作消息」注入 B
          → B：xc_check_inbox → xc_claim 拿 attemptId → 写文件
               → xc_report(completed, evidence=[result-a2b.txt + sha256])

（会话 A） 收结果          ← 回执已注入 A 的未读
          → A：xc_check_inbox 读回执 → 自己读文件核对 391 → 向用户汇报
```

以上即 pull（邮箱拉取）路径，**无需任何额外配置**，也是推荐的验收方式。

## 快速上手：lead-成员团队（v0.2 设计能力）

上一节的 pull 闭环不需要任何配置；而「队长拆解建员、成员自动开工」的团队流程依赖推送唤醒与成员供给，需先在插件设置中完成三件事（详见下文配置表）：

- `wake_enabled` 设为 `true`（默认关闭）；
- `zcode_exe` 与 `zcode_cjs` 填写 zcode 可执行文件与配套 CLI 入口脚本的绝对路径（各机器安装位置不同）；
- 建议显式指定 `member_model`（新会话默认模型可能是失效 key）。

然后开**一个** zcode 会话当队长即可——成员会话由引擎程序化创建，无需人工开窗口：

```text
（会话 A） /xc-team 把 1 到 10 的平方拆成三份给三个新成员算，
          结果分别写 result-m1.txt / result-m2.txt / result-m3.txt
          → A 调 xc_team_init 成为队长（已有其他队长时返回 lead_exists，不抢位）
          → 拆解出三份独立任务 → /xc-member add m1、m2、m3
             （引擎经 app-server 程序化建会话→设模型→欢迎回合自注册，零人工开窗口）
          → xc_dispatch 三单 → A 结束回合等待回执（不 busy-poll）

          ← 成员被自动唤醒（属主缺席的无头回合）：注册 → 认领 → 执行
             → xc_report(completed, evidence=[result-m*.txt + sha256])
             → 无活可领时 xc_idle 通知队长；做完一单自动领下一单
          ← 回执落回队长邮箱；引擎从不 resume 属主在场的会话——
             队长窗口开着就回到该窗口说声「继续」，未读由钩子注入；
             队长会话属主缺席（无头/已关闭）则由孤儿化跳板自动唤醒完成核对

（会话 A） 继续            ← 回执已注入 A 的未读
          → A：xc_check_inbox 读回执 → 按 acceptance 独立复核证据（读文件 + sha256 复算）
               → xc_status 确认全部终态 → 向用户汇总
```

同一场内可用的团队操作：

- `/xc-status` — 结构化全景：队长、成员状态（provisioning/ready/failed/removed 与在途任务）、任务板与依赖 DAG、各成员未读数；同一快照同步落盘 `teams/default/snapshot.json`，可随时直接翻看；
- `/xc-member stop <名字> [原因]` — 停止成员：开放任务收回 pending 池、回执队长、shutdown 帧送达其邮箱（在途回合自然收尾）；花名保留，同名重新 `add` 即幂等重供给；
- `xc_cancel <taskId>` — 队长或任务创建者取消 pending/claimed/in_progress 任务并回执；
- 依赖关系用 `xc_dispatch` 的 `dependsOn` 表达：上游完成后下游自动收到解除阻塞通知并开工，无需人工介入；
- `inbound_mode` 设为 `hold` 时成员间自由消息进隔离箱，`xc_inbound_review` 逐条 accept/discard；`stale_task_minutes`（默认 30）内无心跳的在途任务会被清扫回池并回执队长。

成员上限默认 8（`max_members`，removed 不计）。不开启推送唤醒、不填写可执行文件路径时，团队自动开工流程不可用，但两会话 pull 协作不受影响。

## 斜杠命令

| 命令 | 参数 | 行为 |
|---|---|---|
| `/xc-work` | `[名字] [worker]` | 把当前会话注册进协作网络，返回花名册；带 `worker` 则角色为值班执行 |
| `/xc-dispatch` | `<目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发，回报 taskId 与 delivered 状态 |
| `/xc-inbox` | — | 查看本会话协作收件箱并逐条摘要 |
| `/xc-status` | — | 渲染任务板：任务六态、认领人、attempt 代数、成员未读数（v0.2 起为结构化全景：成员状态/lead/依赖 DAG/引擎信息） |
| `/xc-team` | `[目标描述]` | （v0.2）把当前会话立为 lead 并拆解目标建任务（已存在其他 lead 时拒绝抢位） |
| `/xc-member` | `add <名字>` \| `stop <名字> [原因]` | （v0.2）lead 建员（引擎程序化供给）或停止成员（开放任务收回 pending 池） |

## MCP 工具面（13 个 `xc_*` 工具）

v0.1.0 七工具（行为不变，v0.2 仅在包装层叠加边沿与安全策略）：

| 工具 | 作用 |
|---|---|
| `xc_register` | 把当前连接绑定为协作身份（支持一次性 wakeToken 路径，供无头唤醒的回合重新注册） |
| `xc_dispatch` | 派发新任务（可带依赖 `dependsOn`） |
| `xc_check_inbox` | 读取并消费自己邮箱的未读消息 |
| `xc_claim` | 原子认领 pending 任务，返回 attemptId 能力令牌 |
| `xc_report` | 汇报 in_progress / completed（必须带证据）/ failed |
| `xc_message` | 成员间对等自由消息（可关联任务上下文，过期关联自动作废） |
| `xc_status` | 任务板快照（免注册；每次调用落盘 snapshot.json） |

v0.2 新增六工具：

| 工具 | 作用 |
|---|---|
| `xc_team_init` | （lead）立队并登记 leadKey；已有其他 lead 时返回 `lead_exists` |
| `xc_member_add` | （lead）引擎程序化建成员：app-server 建会话→设模型→欢迎回合自注册→投产；受 `max_members` 上限；failed/removed 同名重调 = 幂等重供给 |
| `xc_member_stop` | （lead）停止成员：开放任务收回 pending 池 + 回执 lead + shutdown 帧 + 尽力唤醒收尾；花名不释放 |
| `xc_idle` | 成员无活可领时通知 lead（回执唤醒；provisioning/failed 成员只入箱不唤醒） |
| `xc_cancel` | （lead/任务创建者）取消 pending/claimed/in_progress 任务并回执 |
| `xc_inbound_review` | 审查入站 hold 队列：accept（转主邮箱）/ discard |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、stale attempt 硬拒、completed 缺证据拒收、重复派发幂等去重、跨进程锁冲突返回结构化 `{"error":"busy"}`。协议纪律（派发必须写验收标准、等待让位不 busy-poll、claim 失败不重试、stale 立即停手）由 `crosschat` 技能承载，随命令自动进入会话。

## 配置项（插件设置）

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关。开启后，派发/回传在目标**属主缺席**时用 `zcode --resume` 无头唤醒目标会话（v0.2 起经孤儿化跳板，派发方退出不影响唤醒；fire-and-forget，失败自动回落邮箱投递）。zcode 配置展开为任何非 `"true"` 的值都按关闭处理。**团队自动开工演示必须开启**。 |
| `zcode_exe` | 空 | 推送唤醒与**成员供给**用的 zcode 可执行文件绝对路径（随机器安装位置不同，需自行填写；留空则两者不可用，投递回落邮箱）。 |
| `zcode_cjs` | 空 | 与 `zcode_exe` 配套的 CLI 入口脚本绝对路径（同上）。 |
| `max_members` | `8` | （v0.2）团队最大成员数（removed 不计）。超限的 `xc_member_add` 被硬拒（`team_at_member_cap`）。对照 dsh-agent-teams maxMembers 默认 8。 |
| `member_model` | 空 | （v0.2）新建成员会话的模型 id（如 `glm-5.3-flash`）。留空时引擎从 app-server 枚举的可用模型表选第一个。新会话默认模型可能是失效 key，建议显式指定（FEASIBILITY P1/E4）。 |
| `member_provider` | 空 | （v0.2）成员模型的 providerId（如 `opencode`）。留空时按枚举表自动匹配。 |
| `member_reasoning` | `max` | （v0.2）成员会话的 reasoningLevel。 |
| `member_bootstrap_timeout_ms` | `300000` | （v0.2）`xc_member_add` 等待成员欢迎回合完成的上限（毫秒）。超时成员标记 failed，可同名重试（幂等重供给）。 |
| `inbound_mode` | `accept` | （v0.2）成员间自由消息（chat 帧）的入站裁决：accept 直接入箱；hold 进 `.held.jsonl` 待 `xc_inbound_review` 处置（钩子不注入、唤醒不携带）；refuse 拒收并给发送者回执。协议帧（派单/回执/空闲/解除阻塞）不受影响。 |
| `stale_task_minutes` | `30` | （v0.2）claimed/in_progress 任务超过该分钟数无更新且成员无在途唤醒时，被引擎清扫回 pending 并向 lead 发 failed 回执。成员守则要求长任务每 10 分钟心跳一次。 |

交互会话之间的协作只走邮箱拉取，无需开启推送唤醒；两个桌面会话都开着时也不应开启（引擎从不 resume 正被持有/属主在场的会话——v0.2 的成员与 lead 唤醒回合均为属主缺席形态，设计上就不依赖活属主 resume，V5 维持未验证且未被依赖）。

## 数据与观测

一切状态都在工作区的 `.crosschat/` 下，人可直接阅读：

| 位置 | 内容 |
|---|---|
| `teams/default/team.json` | 任务真源：六态状态机（pending / claimed / in_progress / completed / failed / cancelled）、attempt 代数、history 时间线、成员花名册 |
| `teams/default/inbox/*.jsonl` | 每个成员的邮箱，每条消息含投递/已读/作废全生命周期字段 |
| `teams/default/inbox/<名>.held.jsonl` | （v0.2）入站策略 hold 的隔离箱（不注入、不唤醒，`xc_inbound_review` 处置） |
| `teams/default/policy.json` | （v0.2）入站策略（accept/hold/refuse）持久化 |
| `teams/default/snapshot.json` | `xc_status` 与引擎边沿/回合收尾刷新的快照（v0.2 起含成员状态/lead/DAG 全景） |
| `registry/sessions/*.json`、`registry/names.json` | 会话身份锚定文件与花名绑定 |
| `logs/engine.jsonl` | 审计日志：每次状态转移、投递、唤醒一行（who / what / when / attemptId） |
| `logs/wake-*.json` | 每次无头唤醒的完整返回 |

## 能力清单与验证方式

以下能力均已实现并带有自动化验证：

- **7 个 MCP 工具全链路**（注册 → 派发 → 认领 → 报告 → 回执 → 快照）：stdio 冒测 11 项全过，含未注册拒绝、免注册观测、wakeToken 注册、自动建队等（记录见 `docs/IMPLEMENTATION.md` §3.3）；
- **3 个进程钩子**（SessionStart 身份锚定、UserPromptSubmit 未读注入与活跃刷新、Stop 回合探针）：真实进程冒测通过，含损坏 JSONL 行跳过容错（`docs/IMPLEMENTATION.md` §3.4）；
- **六态任务状态机 + attempt 令牌 + 证据链**（completed 必须 result + 至少 1 条 evidence，工具侧现算 sha256）：单元测试覆盖非法转移、stale、缺证据、重复派发等拒绝路径；
- **跨进程并发安全**：进程内 promise 链 + 跨进程 O_EXCL lockfile（含持锁者死亡后的陈旧锁强夺），锁竞争用例使用真实双进程；
- **推送唤醒引擎**（默认关闭）：delivered 三态决策、在途去重、失败自动降级邮箱、唤醒 prompt 组装（≤4000 字符），均有单测；v0.2 起经 wake-helper 孤儿化跳板（helper 失败/超时走降级，消息不丢）；
- **v0.2 动态成员供给**（app-server 协议客户端 + 供给四步 + 幂等重供给探针）：协议按 FEASIBILITY-V0.2 P1/P2/P4 实测事实产品化（模型枚举取 create 结果内联表、回合完成判定过滤无文本 timeline 事件、send 后 ≤3s 落库硬杀不丢）；成员上限/lead 判定/重供给分流为纯函数并有单测；
- **磁盘真源容错**：原子写（临时文件 + rename + 失败重试）、JSONL 半行跳过、读侧严格校验。

其中 lead-成员协作、动态成员、自动开工的能力已通过端到端硬验收：`docs/DESIGN-V0.2.md` §8 的五场景演示于 2026-11-09 执行，五条硬标准全部通过（报告：`deepseek-crosschat/reports/10-v020验收.md`；演示摘录：`docs/DEMO.md`）。验收中发现并修复 1 处供给回调注册缺陷（provision.ts 未应答 `session/requestRuntimePreferences`，真实运行暴露——294 例单测未覆盖该缺陷，修复后全量复测），如实声明于报告 §2.3/§9。

验证基线：`npm run typecheck` 零错误；`npm test`（vitest）全绿——v0.1.0 基线 167 例全数保留（`docs/IMPLEMENTATION.md` §3 记录）+ v0.2 新增模块用例，当前全量 24 文件 / 294 例；`zcode plugins validate` 通过。复现方式即上述三条命令。

## 已知限制

- **平台**：自测在 Windows 上完成；其他操作系统未经测试（原子写与锁已做防御性处理，但无实测背书）。
- **推送唤醒与成员供给的适用面**：需要用户在插件设置里填写 zcode 可执行文件与 CLI 入口路径（各机器安装位置不同）。唤醒只对属主缺席的会话发起；v0.1.0 的 V9（派发方 CLI 退出连带清杀唤醒子进程）已实现「helper 孤儿化」修复——机制经可行性实验 E3b 端到端实测（派发方 CLI 退出后孤儿化唤醒子进程仍全自动完成任务，FEASIBILITY-V0.2 §2.1），产品级复现已于验收完成（Phase B，`10-v020验收.md` §4）；残余竞态（派发方在跳板拉起子进程前的毫秒级窗口被杀）未量化，兜底=邮箱真源（消息留箱、下次唤醒/拉取补做）。**WMI 逃逸（路径 B）为预设计备选**：E3c2 已验证可行，但 WMI 子进程继承 WmiPrvSE 的 SYSTEM 环境、须落盘/回读用户 env（P3），v0.2 未进代码，触发条件=未来某机器上 helper 路径验证失败。
- **成员供给的平台事实与边界**（FEASIBILITY-V0.2 P1-P5，2026-11-09 实测于 zcode CLI 0.17.1）：模型枚举主路径=app-server `session/create` 结果内联 `settings.model.available[].ref`（`state.updated` 事件流不可依赖，P1）；回合完成判定必须过滤无文本 parts 的 timeline 事件消息（P2）；`session/send` accept 后 ≤3s 会话落库、硬杀 app-server 不丢（P4），供给完成即 kill keeper 是安全的；CLI 退出的清杀沿活父链传播、孤儿链杀不到（P5）。验收后验证点状态（`10-v020验收.md` §9）：V20（MCP 回合内同步供给 ≤300s 不超时）与 V13（模型枚举）已闭合；仍开放——`session/create` 安全面（toolAllowlist/toolDenylist）未实测，V15（max_members 真实环境硬拒）由单测覆盖（team_at_member_cap），「先派发后建员」（E-e）与依赖任务链（E-b unblock）的端到端构造未做、均不作已验证宣称（机制在单测与代码路径中，见 `docs/DESIGN-V0.2.md` §13 的验证点与缓解形态）。
- **形态差异（非裁剪，均有等效物）**：zcode 无 steer 注入 API → 唤醒粒度=新回合（v0.1.0 起实测记录）；无 UI 注入点 → 进度可视=磁盘真源 + snapshot.json + `xc_status` 全景（PLATFORM §2.1）；CC 的「队友权限提示冒泡到 lead」无宿主通道 → 审批在成员各自会话内照常弹出（engine 成员为无头回合，权限语义由创建时 mode 决定，`yolo` 仅为演示配置，生产建议受限 mode + 宿主权限面约束）。
- **身份校验是协作假设而非密码学校验**：peer 身份由钩子落盘文件、一次性 wakeToken 与新鲜度告警三重交叉支撑，模型理论上可以谎报会话 id；engine 成员身份=引擎预绑名 + 一次性 nonce 双重背书（他者抢注得 `name_taken`）。消息面另有帧类型白名单与入站策略兜底。不要把敏感内容写进邮箱——跨会话可见的只有邮箱内容。
- **v0.3.0 backlog（明确去向，非静默裁剪）**：跨会话消息传输层（UDS/命名管道）、plan/permission 等剩余协议帧、质量门族完整移植、成员 worktree 隔离、agent view 交互面板等——完整清单与去向理由见 `docs/DESIGN-V0.2.md` §12。
- **CLI 安装**：`zcode plugins install` 的参数未文档化，安装请走桌面 UI。

## 仓库结构

```
├── marketplace.json            # 市场清单（仓根即市场根）
├── plugin/                     # 插件根
│   ├── .zcode-plugin/plugin.json   # 插件清单（组件声明 + userConfig）
│   ├── skills/crosschat/       # 协作协议技能（纪律与工具表；v0.2 含 lead 协议/成员守则/安全章）
│   ├── commands/               # 6 个斜杠命令（v0.2 新增 /xc-team、/xc-member）
│   ├── hooks/hooks.json        # 3 个进程钩子声明
│   ├── src/core/               # 磁盘真源与协议（状态机/邮箱/锁/原子写/任务图/快照/入站策略）
│   ├── src/engine/             # 推送唤醒引擎（wake-helper 孤儿化跳板）+ 成员供给（app-server keeper）
│   ├── src/mcp/                # MCP server 与 13 工具（七基础 + 边沿/守卫/成员/lead/安全包装层）
│   ├── src/hooks/              # 3 个钩子实现
│   ├── scripts/build.mjs       # esbuild 构建（5 入口 → dist/，含 wake-helper）
│   └── dist/                   # 构建产物（安装前必须在场；不入 git）
├── demo/                       # 自动化演示辅助脚本（会话引导；见 docs/DESIGN.md §6.4）
└── docs/                       # 设计 / 平台事实基线 / 实现与自测记录
```

`dist/` 不入库：克隆后请先执行上文「安装与启用」的构建步骤。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 完整设计：通道设计、状态机、并发控制、与 dsh-agent-teams 的机制对照、验证方案；
- [docs/DESIGN-V0.2.md](docs/DESIGN-V0.2.md) — v0.2 增量设计：lead-成员协作、自动开工边沿、动态成员供给、观测/安全面、硬验收演示方案与 v0.3 backlog；
- [docs/FEASIBILITY-V0.2.md](docs/FEASIBILITY-V0.2.md) — v0.2 两条修复路径与动态成员链的可行性实测（E1-E4、P1-P5）；
- [docs/PLATFORM.md](docs/PLATFORM.md) — zcode 插件/钩子/MCP/CLI 的平台事实基线；
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — 模块-文件对照、自测命令与结果记录、已知限制明细。

## License

[MIT](./LICENSE)
