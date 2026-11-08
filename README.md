# zcode-crosschat

让多个**互相独立**的 zcode 会话互相派发任务、执行并回传结果——对齐 Claude Code 生态的「跨对话交流执行任务」能力。

它是一个纯 zcode 声明式插件（skills + commands + hooks + mcpServers 四组件）：

- **MCP server 常驻进程**承担工具面与投递引擎，暴露 7 个 `xc_*` 工具；
- **文件邮箱是唯一持久真源**（`<工作区>/.crosschat/`），与宿主完全解耦；
- **进程钩子**做会话身份锚定、活跃刷新与收件箱拉取注入；
- **`zcode --resume` 无头单发**做跨进程推送唤醒（可选，默认关闭）。

任务状态机（六态 + attempt 令牌）与消息格式机制等价移植自 opencode/DeepSeek 生态的 dsh-agent-teams 插件，全部用 zcode 原生扩展点重新实现。会话形态为「全独立对等会话」：没有队长-队员控制关系，每个会话各自拥有完整工具权限，跨会话可见的只有对方主动写入邮箱的内容。

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

输出应包含 `zcode-crosschat`，且其 skills / commands / hooks / mcp 计数非零（对应本插件的 1 技能、4 命令、3 钩子、1 个 MCP server）。

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

## 斜杠命令

| 命令 | 参数 | 行为 |
|---|---|---|
| `/xc-work` | `[名字] [worker]` | 把当前会话注册进协作网络，返回花名册；带 `worker` 则角色为值班执行 |
| `/xc-dispatch` | `<目标名> <任务描述>` | 把描述整理成可检验任务（标题/内容/验收标准）并派发，回报 taskId 与 delivered 状态 |
| `/xc-inbox` | — | 查看本会话协作收件箱并逐条摘要 |
| `/xc-status` | — | 渲染任务板：任务六态、认领人、attempt 代数、成员未读数 |

## MCP 工具面（7 个 `xc_*` 工具）

| 工具 | 作用 |
|---|---|
| `xc_register` | 把当前连接绑定为协作身份（支持一次性 wakeToken 路径，供无头唤醒的回合重新注册） |
| `xc_dispatch` | 派发新任务（可带依赖 `dependsOn`） |
| `xc_check_inbox` | 读取并消费自己邮箱的未读消息 |
| `xc_claim` | 原子认领 pending 任务，返回 attemptId 能力令牌 |
| `xc_report` | 汇报 in_progress / completed（必须带证据）/ failed |
| `xc_message` | 成员间对等自由消息（可关联任务上下文，过期关联自动作废） |
| `xc_status` | 任务板快照（免注册；每次调用落盘 snapshot.json） |

所有工具做硬校验而非仅靠提示词纪律：未注册连接拒绝、目标必须在册、任务状态机非法转移拒绝、stale attempt 硬拒、completed 缺证据拒收、重复派发幂等去重、跨进程锁冲突返回结构化 `{"error":"busy"}`。协议纪律（派发必须写验收标准、等待让位不 busy-poll、claim 失败不重试、stale 立即停手）由 `crosschat` 技能承载，随命令自动进入会话。

## 配置项（插件设置）

| 配置 | 默认 | 说明 |
|---|---|---|
| `wake_enabled` | `false` | 推送唤醒总开关。开启后，派发/回传在目标**属主缺席**时用 `zcode --resume` 无头唤醒目标会话（fire-and-forget，唤醒失败自动回落邮箱投递）。zcode 配置展开为任何非 `"true"` 的值都按关闭处理。 |
| `zcode_exe` | 空 | 推送唤醒用的 zcode 可执行文件绝对路径（随机器安装位置不同，需自行填写；仅在启用推送唤醒时使用，留空则推送唤醒不可用、投递回落邮箱）。 |
| `zcode_cjs` | 空 | 与 `zcode_exe` 配套的 CLI 入口脚本绝对路径（同上）。 |

交互会话之间的协作只走邮箱拉取，无需开启推送唤醒；两个桌面会话都开着时也不应开启（不会去 resume 正被桌面持有的会话）。

## 数据与观测

一切状态都在工作区的 `.crosschat/` 下，人可直接阅读：

| 位置 | 内容 |
|---|---|
| `teams/default/team.json` | 任务真源：六态状态机（pending / claimed / in_progress / completed / failed / cancelled）、attempt 代数、history 时间线、成员花名册 |
| `teams/default/inbox/*.jsonl` | 每个成员的邮箱，每条消息含投递/已读/作废全生命周期字段 |
| `teams/default/snapshot.json` | `xc_status` 每次调用刷新的快照 |
| `registry/sessions/*.json`、`registry/names.json` | 会话身份锚定文件与花名绑定 |
| `logs/engine.jsonl` | 审计日志：每次状态转移、投递、唤醒一行（who / what / when / attemptId） |
| `logs/wake-*.json` | 每次无头唤醒的完整返回 |

## 能力清单与验证方式

以下能力均已实现并带有自动化验证：

- **7 个 MCP 工具全链路**（注册 → 派发 → 认领 → 报告 → 回执 → 快照）：stdio 冒测 11 项全过，含未注册拒绝、免注册观测、wakeToken 注册、自动建队等（记录见 `docs/IMPLEMENTATION.md` §3.3）；
- **3 个进程钩子**（SessionStart 身份锚定、UserPromptSubmit 未读注入与活跃刷新、Stop 回合探针）：真实进程冒测通过，含损坏 JSONL 行跳过容错（`docs/IMPLEMENTATION.md` §3.4）；
- **六态任务状态机 + attempt 令牌 + 证据链**（completed 必须 result + 至少 1 条 evidence，工具侧现算 sha256）：单元测试覆盖非法转移、stale、缺证据、重复派发等拒绝路径；
- **跨进程并发安全**：进程内 promise 链 + 跨进程 O_EXCL lockfile（含持锁者死亡后的陈旧锁强夺），锁竞争用例使用真实双进程；
- **推送唤醒引擎**（默认关闭）：delivered 三态决策、在途去重、失败自动降级邮箱、唤醒 prompt 组装（≤4000 字符），均有单测；
- **磁盘真源容错**：原子写（临时文件 + rename + 失败重试）、JSONL 半行跳过、读侧严格校验。

验证基线：`npm run typecheck` 零错误；`npm test`（vitest）17 个文件 / 168 例全绿；`zcode plugins validate` 通过。复现方式即上述三条命令。

## 已知限制

- **平台**：自测在 Windows 上完成；其他操作系统未经测试（原子写与锁已做防御性处理，但无实测背书）。
- **推送唤醒的适用面**：仅对属主缺席的会话生效；且需要用户在插件设置里填写本机 zcode 可执行文件与 CLI 入口路径（各机器不同）。无头回合内插件 MCP 可用性等平台细节仍列在设计文档 §9 的验证清单中——自动化闭环（`docs/DESIGN.md` §6.4）的编排与证据核对脚本不在本仓库，`demo/` 目录目前提供会话引导脚本（`bootstrap-sessions.mjs`，创建会话/设模型/完成注册）；交互式 pull 闭环不受影响。
- **身份校验是协作假设而非密码学校验**：身份由钩子落盘文件、一次性 wakeToken 与新鲜度告警三重交叉支撑，模型理论上可以谎报会话 id。不要把敏感内容写进邮箱——跨会话可见的只有邮箱内容。
- **Stop 钩子当前是纯探针**：不执行任何回合收尾动作（为后续续跑能力预留的观测点）。
- **v1 范围裁剪**：不含 Web 审批面板、计划评审、质量门族、队长-队员调度（对等会话形态下由对话内确认与邮箱协议等效承担）。
- **CLI 安装**：`zcode plugins install` 的参数未文档化，安装请走桌面 UI。

## 仓库结构

```
├── marketplace.json            # 市场清单（仓根即市场根）
├── plugin/                     # 插件根
│   ├── .zcode-plugin/plugin.json   # 插件清单（组件声明 + userConfig）
│   ├── skills/crosschat/       # 协作协议技能（纪律与工具表）
│   ├── commands/               # 4 个斜杠命令
│   ├── hooks/hooks.json        # 3 个进程钩子声明
│   ├── src/core/               # 磁盘真源与协议（状态机/邮箱/锁/原子写）
│   ├── src/engine/             # 推送唤醒引擎
│   ├── src/mcp/                # MCP server 与 7 工具
│   ├── src/hooks/              # 3 个钩子实现
│   ├── scripts/build.mjs       # esbuild 构建（4 入口 → dist/）
│   └── dist/                   # 构建产物（安装前必须在场；不入 git）
├── demo/                       # 自动化演示辅助脚本（会话引导；见 docs/DESIGN.md §6.4）
└── docs/                       # 设计 / 平台事实基线 / 实现与自测记录
```

`dist/` 不入库：克隆后请先执行上文「安装与启用」的构建步骤。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 完整设计：通道设计、状态机、并发控制、与 dsh-agent-teams 的机制对照、验证方案；
- [docs/PLATFORM.md](docs/PLATFORM.md) — zcode 插件/钩子/MCP/CLI 的平台事实基线；
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — 模块-文件对照、自测命令与结果记录、已知限制明细。

## License

[MIT](./LICENSE)
