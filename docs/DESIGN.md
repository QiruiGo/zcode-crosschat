# DESIGN：zcode-crosschat 插件设计（跨会话任务派发 → 执行 → 回传）

- 设计人：插件设计师（动态工作流子代理）
- 日期：2026-11-09
- 目标：对齐 Claude Code「跨对话交流执行任务」能力——两个**独立** zcode 会话之间互相派发可检验任务、执行并回传结果（验收标准 4 条，见 §6.1 对照）。
- 插件名：`zcode-crosschat`（仓库 https://github.com/QiruiGo/zcode-crosschat ，本仓根即市场根，插件根 = `<仓根>/plugin/`）。

## 证据基线（本设计的每个结论从哪来）

| 类别 | 材料 | 使用方式 |
|---|---|---|
| 平台能力面 | `<仓库路径>\docs\PLATFORM.md`（本会话全文通读） | 会话机制（§4）、插件能力（§2）、安装（§2.3）、坑位（§4.6）、推荐栈（§5） |
| dsh 机制 | `<证据仓>\reports\07-机制分析.md`（全文通读）+ 抽查报告 `08-论断抽查.md`（任务材料给出） | 机制对照（§5） |
| dsh 源码抽查 | `<证据仓>\src\dsh-agent-teams-0.1.29\lib\{state,mailbox,tools}.js` | **本会话亲读**：state.js:1-30（邮箱布局注释）、state.js:114-123（TASK_TRANSITIONS，含 pending→cancelled 边）、state.js:37-56（withTeamLock）、mailbox.js:1-20（isCurrentMail）、mailbox.js:29-40（readCurrentMailboxLocked 的 **onMalformed 容错回调**——JSONL 读侧容忍损坏行的原版依据）、tools.js:2040-2100（send_message 四态/duplicate 判定）、tools.js:2100-2120（**2107-2109 为 halted 检查；sourceFields 快照在 2111-2114**，修订引用漂移） |
| 08 报告结构复核 | `<证据仓>\reports\08-论断抽查.md` | 本会话 grep 核实：§4 标题=「对 zcode 复刻最重要的 **3-5 条**机制要点」（仅 ①-⑤）；**质量门/工件论断在 §1.10，原子写论断在 §1.8（:113）与 §4-1（:205）**；全篇不存在 keyTakeaway ⑨，也不存在 verifiedClaims 标签（`grep -c verifiedClaims` 实测 **0**——初版两处引用标签均系虚构，R7 已修正） |
| zcode hook 契约 | `<用户主目录>\.zcode\cli\plugins\cache\zcode-plugins-official\zcode-guide\0.3.0\skills\diagnosing-hooks\SKILL.md`（本会话全文亲读） | 7 事件、matcher、process 型钩子、输出 JSON 严格 schema、`additionalContext` 注入、Stop 可请求继续（≤3 次）、`${CLAUDE_SESSION_ID}` 作为模板变量+环境变量 |
| 官方插件实例（本会话亲读） | documents/0.2.1、zcode-site/0.4.2、android-emulator/0.1.0、node-repl-host/0.7.0、browser-use/0.5.1、plugin-creator/0.1.1 的 manifest/SKILL/命令文件 | manifest 字段、commands frontmatter、userConfig+`${user_config.*}` 注入、`${CLAUDE_PLUGIN_ROOT}` 用法、工程化形态 |
| 本会话亲跑命令 | ① `which node` → `C:\Program Files\nodejs\node`，`node --version` → **v24.22.1**；② `ls <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs` → 均存在；③ `npm view @modelcontextprotocol/sdk version` → **1.32.2**；④ `zcode plugins --help` → 子命令 `list|install|uninstall|enable|disable|update|validate|marketplace` 实测存在（0.17.1）；⑤ `plugins install --help` / `plugins marketplace --help` → **未给出子命令专属参数**（打印的是通用 help），CLI 安装语法列为验证点 V4 | 见 §6.2、§9 |
| 选型与复核 | `<证据仓>\reports\03-候选与选型.md`（全文通读，含修订记录第 3 版第 5 条 / §6.6 独立性解读差异） | §3 形态选择 |

---

## 0. 结论速览

**一句话形态**：纯 zcode 声明式插件（skills + commands + hooks + mcpServers 四组件）——**MCP server 常驻进程**承担工具面与投递引擎，**文件邮箱是唯一持久真源**，**hooks 做身份锚定（`${CLAUDE_SESSION_ID}`）、lastSeen 刷新与收件箱拉取注入**，**`zcode --resume` 无头单发做跨进程推送唤醒（fire-and-forget，仅属主缺席会话，默认关闭）**；**身份绑定在 stdio 连接上**（xc_register 登记 self，未注册连接调用即报错）；会话形态选**全独立对等会话**（非 dsh 式 durable 子会话），任务状态机与 attempt_id 能力令牌 1:1 移植 dsh 版并做进 MCP 工具硬校验。

**验收四条 ↔ 设计落点**：

| 验收标准 | 落点 |
|---|---|
| 1. A 派发 B 执行、回传 A，闭环成立、证据落盘 | §2 通道设计 + §6 两阶段验证（Phase 1 交互闭环 / Phase 2 自动闭环），证据树见 §6.6 |
| 2. 过程人可观测 | `.crosschat/` 磁盘真源（team.json/inbox JSONL）+ `logs/engine.jsonl` 审计 + `xc_status` 快照落盘 snapshot.json + zcode 日志里的 hook 执行记录（§4.3） |
| 3. 任务有状态跟踪 | 六态状态机 + attempt 令牌（§2.6），`xc_status` 任意时刻可查 |
| 4. 形态自选 + 独立性边界 | §3：选「全独立对等会话」并写明理由与边界（正面回应 03 修订记录第 5 条的解读差异） |

**moduleCount = 5**（§7）。

---

## 1. 插件形态与目录结构

### 1.1 形态声明

zcode 插件是「声明式资源包」，**没有**「注册全局工具到主模型」的一等入口（PLATFORM.md §2.1 组件面 + §5 推荐栈；07-机制分析.md §8.1「关键结构差异」对照结论——注意 PLATFORM.md 自身 §8 是未确认事项清单并无 §8.1 小节；工具只能经 MCP server 暴露，本会话工具面板实测形态 `mcp__plugin_<plugin>_<server>__<tool>`，如 `mcp__plugin_documents_documents__open_document`）。因此本插件的可执行逻辑全部落在两处官方支持的执行面：

1. **MCP server**（`mcpServers` 内联 stdio 配置）：常驻 Node 进程，承担全部 `xc_*` 工具、磁盘真源读写、投递引擎。这是官方插件放可执行逻辑的标准位置（PLATFORM.md §5 选型表：documents/zcode-site 的 `__zcode-plugin-host` 模式；plugin-creator 脚手架 scaffold-files.mjs:57-63 亦生成 `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]}` 形态——本机 node v24.22.1 实测在 PATH）。
2. **hooks**（`hooks/hooks.json`，process 型）：SessionStart / UserPromptSubmit / Stop 三个生命周期点——SessionStart 做身份锚定（写 sessions + additionalContext 注入），UserPromptSubmit 做 **lastSeen 刷新**与收件箱拉取注入，Stop 为 V3 探针（v1 无收尾功能）。插件钩子自动启用 hook runner（PLATFORM.md §2.2 引 zcode-configuration-guide SKILL.md:72-73），无需用户额外开 `hooks.enabled`。

**不使用**的组件及原因：`ui.surfaces`（观测面用磁盘+工具即可，见 §5 对照表 Web 面板行）；`agents` 字段（官方文档自相矛盾，PLATFORM.md §2.1 明确「不要依赖」）。

### 1.2 目录结构（仓库 ↔ 插件 ↔ 开发市场三层）

```
<仓库路径>\            # 仓根 = 开发市场根（UI 添加市场时粘贴此目录）
├── marketplace.json                 # 市场清单（§8.2-B 全文，实现员原样落盘）
├── plugin\                          # 插件根（市场条目 source: "./plugin"）
│   ├── .zcode-plugin\plugin.json    # 插件清单（§8.2-A 全文）
│   ├── package.json                 # §8.2-C 全文（TS+esbuild+vitest，browser-use/0.5.1 同形态先例）
│   ├── tsconfig.json                # §8.2-D 全文
│   ├── scripts\build.mjs            # §8.2-E 全文（esbuild 打包 4 个入口 → dist/）
│   ├── hooks\hooks.json             # §8.2-F 全文（SessionStart/UserPromptSubmit/Stop，process 型）
│   ├── skills\crosschat\SKILL.md    # 协议技能（M4 实现；frontmatter 见 §4.2）
│   ├── commands\                    # 4 个斜杠命令（M4 实现；§4.2）
│   │   ├── xc-dispatch.md
│   │   ├── xc-status.md
│   │   ├── xc-inbox.md
│   │   └── xc-work.md
│   ├── src\
│   │   ├── core\                    # M1：磁盘真源与协议（types/paths/atomic/lock/sanitize/teamstate/mailbox/registry/jsonl/log）
│   │   ├── engine\                  # M2：投递唤醒（resume-cli/wake/lease）
│   │   ├── mcp\                     # M3：MCP 工具面（server/protocol/tools/identity/render）
│   │   └── hooks\                   # M4：钩子脚本源码（session-start/prompt-submit/stop/shared）
│   └── dist\                        # 构建产物（esbuild）：mcp\server.mjs + hooks\*.mjs（不入 git 或入 git 均可，安装前必须存在）
├── demo\                            # M5：验证与演示脚本（appserver-client/bootstrap-and-run/runbook/check-evidence）
├── docs\                            # 本文档 + PLATFORM.md
└── evidence\                        # 演示证据落盘（§6.6）
```

安装后宿主会把插件物化进缓存（PLATFORM.md §2.3：`cache/<marketplace>/<plugin>/<version>/` + `.zcode-plugin-seed.json` source:filesystem），所以**每次改源码后必须先 `npm run build` 再走市场刷新+更新**，否则装进去的是旧 dist。

### 1.3 组件实现机制明细

| 清单字段 | 组件 | 机制 | 依据 |
|---|---|---|---|
| `skills: "skills"` | `skills/crosschat/SKILL.md` | 主会话按需加载的协议全文（派发纪律/执行纪律/等待纪律）；description 决定自动触发 | plugin-json-spec.md:17（frontmatter 必填 name+description）；PLATFORM.md §2.2 |
| `commands: "commands"` | 4 个 `.md` 命令 | 快捷入口，正文=激活指令（照搬 dsh command.js:56-72 buildActivationDirective 的思路）；frontmatter `description`/`argument-hint`/`skills` + 正文 `$ARGUMENTS` | zcode-site/0.4.2/commands/site-badge.md:1-7 本会话亲读 |
| `hooks: "./hooks/hooks.json"` | 3 个 process 型钩子 | 事件恰好取官方 7 事件中的 3 个：SessionStart（写/刷新 sessions + additionalContext 身份注入）、UserPromptSubmit（**lastSeen 刷新** + 收件箱拉取注入）、Stop（V3 探针） | diagnosing-hooks SKILL.md §2（事件枚举/matcher/process 字段/输出 schema）本会话亲读 |
| `mcpServers.crosschat` | 内联 stdio 配置 | `command:"node"`, `args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"]`, `cwd:"${ZCODE_PROJECT_DIR}"`, env 注入 userConfig 值 | plugin-creator scaffold-files.mjs:57-63（node 形态）+ android-emulator/0.1.0 manifest（`${user_config.*}` 注入 env，本会话亲读） |
| `userConfig` | 3 项 | wake_enabled（默认 **false**）/ zcode_exe / zcode_cjs（经 `${user_config.*}` 进 MCP env；展开行为未确认，列 V7） | android-emulator manifest userConfig 实测（语法先例）；sensitive 类型不可持久化故不使用（PLATFORM.md §2.2） |

---

## 2. 跨会话通信通道设计

### 2.1 通道总图

```
会话 A（交互/无头，key=a）                    会话 B（独立，key=b）
  │ 模型调 xc_dispatch({to:"b",…})              ▲
  ▼                                            │ pull：UserPromptSubmit hook 注入
[A 的 MCP server 进程，身份=连接绑定 §2.3]       │ 「你有 N 条未读」→ 模型调 xc_check_inbox
  1 锁内：写 team.json(t1 pending) + inbox/b.jsonl
  2 返回 delivered + taskId
  3 锁外（仅当 wake_enabled=true 且目标属主缺席 §2.5）：
      写一次性 wake nonce → spawn 无头
      zcode --resume <B_sid> --prompt "<回执+身份+sid+wakeToken+任务票>" ──┘（fire-and-forget，不阻塞）
                                               ▼
                                    [B 的 MCP server 进程，身份=连接绑定]
                                      xc_register(wakeToken) → 本连接绑定身份
                                      xc_claim(t1) → attempt_id
                                      执行任务（写文件/算数/…）
                                      xc_report(completed, evidence)
                                        1 锁内：t1→completed + 结果写 team.json
                                        2 inbox/a.jsonl 追加回执消息
                                        3 锁外：wake nonce → spawn --resume 唤醒 A
  ▲                                            │
  │ pull：A 下一轮 UserPromptSubmit 注入        │
  │ 或 push：--resume <A_sid> "收到回执+wakeToken"│
  ─────────────────────────────────────────────┘
  A 调 xc_check_inbox / xc_status → 读结果、核对证据、向用户汇报
```

设计原则（从 dsh 版原样继承，08 抽查 keyTakeaway ①④）：**邮箱为真、唤醒为优化**——推送唤醒失败只延迟投递，不丢消息；推送是 **fire-and-forget**，v1 只对「属主缺席」的会话启用（§2.5 的三重启用条件）；「宿主接受投递 ≠ 模型消费了输入」（07 §3.1 引 state.js:510 注释），所以 ack 只发生在工具把消息返回给模型的那一刻（§2.8 xc_check_inbox）。

### 2.2 磁盘真源布局（1:1 移植 dsh 布局，state.js:4-12）

状态根固定为**会话工作区下的 `.crosschat/`**（两会话必须共用同一 workspace 才能互通——这是 v1 边界，见 §3.3）：

```
<workspace>/.crosschat/
├── registry\                      # 会话注册（hook 写 + xc_register 认领）
│   ├── sessions\<sessionId>.json  #   { sessionId, cwd, startedAt, lastSeen, boundName? }（SessionStart 与 UserPromptSubmit 两个钩子都写/刷新）
│   ├── names.json                 #   { <name>: { sessionId, role, registeredAt } }
│   └── wake\<nonce>.json          #   一次性唤醒 nonce：{teamId, agentKey, sid, ts, used?}（兼作在途唤醒标记，TTL=15min，§2.3-4/§2.5）
├── teams\<teamId>/
│   ├── team.json                  # 单文件整体 JSON：TeamState（§2.6）
│   ├── inbox\<agentKey>.jsonl     # 每会话一个邮箱，一行一条消息（§2.4）
│   └── snapshot.json              # xc_status 最近一次快照（人可读观测面）
├── locks\<name>.lock              # 跨进程 lockfile（O_EXCL，§2.7）
└── logs\
    ├── engine.jsonl               # 引擎审计：每次状态转移/投递/唤醒一行
    └── wake-<to>-<ts>.json        # 每次 --resume 推送唤醒的完整 stdout（--output-format json）
```

- `teamId` v1 固定 `default`（首个派发者自动建队并成为 founderKey；schema 保留多队扩展）。
- `agentKey` = 注册名经 `sanitizeKey` 归一（照抄 dsh state.js:88-99：NFC→小写→非字母数字折叠 `-`、超 48 字符截断加 sha256 前 8 位，保留 CJK）。

### 2.3 身份与注册（连接绑定 + 钩子锚定 + wakeToken 回退）

**问题 1**：dsh 的工具在宿主进程内执行自带 caller 身份；zcode 的 MCP server 进程内拿不到 sessionId（实测 manifest env 只有 `ZCODE_PLUGIN_ID`/`ZCODE_PLUGIN_DATA` 等，无会话变量）。
**问题 2**：一个 MCP server 进程服务几条连接（每会话一进程，还是每工作区共享）未确认（V8）——身份**不能绑在进程上**。

**解法：身份绑定在 stdio 连接上**（对 V8 的两种结果都成立：stdio MCP 一条连接对应一个客户端会话；若进程每工作区共享，各会话仍各有自己的连接）：

1. **钩子锚定**（交互会话正常路径）：SessionStart 钩子（matcher 省略=匹配 startup/resume/clear/compact）从环境变量读 `${CLAUDE_SESSION_ID}`（官方注入的模板变量+环境变量）与 `${ZCODE_PROJECT_DIR}` → 写/刷新 `registry/sessions/<sid>.json` → stdout 输出严格 JSON `{"additionalContext": …}`（注入会话上下文，模型由此知道自己的 sid）。**UserPromptSubmit 钩子同样刷新 lastSeen**——用户每次说话都刷新，会话开很久后再 `/xc-work` 也不会被新鲜度卡死（§1.3/M4 职责同步）。
2. **连接绑定**：`xc_register` 校验通过后，MCP server 把 {sessionKey, sessionId} 绑定到**当前 stdio 连接**；此后该连接上所有需身份的工具（dispatch/claim/report/message/check_inbox）直接使用绑定身份，**不接受也不需要任何 from/caller 参数**；未注册连接调用身份类工具 → 结构化错误 `not registered: call xc_register first`。**xc_status 豁免注册**（只读观测，验收 2 的「过程人可观测」不被注册门槛削弱）：未注册调用返回团队快照，仅省略「我的未读」等个人字段。绑定随连接关闭消亡；无头回合每次 `--resume` 都是一条新连接，因此**每个被驱动的回合都要重新注册**——这正是 wakeToken 路径存在的理由（第 4 条）。
3. **xc_register 校验**：`registry/sessions/<sessionId>.json` 存在（任意年龄；lastSeen 超 10 分钟仅告警不拒绝）∧ sid 未被其他名字绑定 ∧ 名字未被其他活 sid 绑定 → 写 `registry/names.json` + 加入 team.members（锁序见 §2.7-3）。
4. **wakeToken 回退路径**（V2 失败也能闭环）：唤醒方（引擎或演示脚本）在推送前生成一次性 nonce 写入 `registry/wake/<nonce>.json` {teamId, agentKey, sid, ts}（TTL=15 分钟）；唤醒 prompt **显式携带目标 sid 与 wakeToken**（唤醒方本来就知道 sid，不依赖钩子注入）；`xc_register({name, sessionId, wakeToken})` 命中未过期未使用的 nonce → 直接绑定，并由服务端**代写** `sessions/<sid>.json`（消除对钩子落盘的依赖），nonce 标记 used。该路径同时修掉两个断点：①模型拿不到自己的 sid（prompt 给了）；②sessions 文件不存在（服务端代写）。同一 nonce 文件兼作**在途唤醒标记**（§2.5）。

威胁模型声明：身份是**协作假设**而非密码学校验（模型可谎报 sid）；校验=hook 落盘文件 + wake nonce + 新鲜度三重交叉，v1 接受残余风险并如实声明。

### 2.4 消息格式与回执协议（照抄 dsh createMessage，07 §3.1）

`inbox/<agentKey>.jsonl` 每行一条 JSON：

```json
{ "id": "<uuid>", "from": "a", "to": "b", "content": "…", "ts": 1762660000000,
  "taskId": "t1", "attemptId": "<收件人当前开放 attempt，投递时快照>",
  "sourceTaskId": "t1", "sourceAttemptId": "<发送者来源 attempt>", "sourceTaskStatus": "in_progress",
  "deliveryClaimedAt": 1762660000000, "deliveredAt": 1762660001000, "readAt": null, "discardedAt": null }
```

推送唤醒时投递进模型正文的**机器可解析回执前缀**（移植 dsh mailbox.js:49 `AgentTeams inbox receipt: ` 前缀思路）：

```
[CrossChat inbox receipt: {"teamId":"default","recipient":"b","ids":["<uuid>",…]}]
```

**新鲜性裁决 `isCurrentMail`**（1:1 移植 mailbox.js:6-17，本会话亲读）：消息的 `sourceAttemptId` 已不是该任务当前 attempt、或收件人 attempt 已换代 → 判过期，`discardedAt` 落盘后不再投递。**attempt_id 就是消息的能力令牌**——重派/接管后旧消息自动作废。

### 2.5 投递与唤醒（delivered 状态、fire-and-forget、在途去重）

dsh send_message 的四态（tools.js:2054 output schema，本会话亲读）→ zcode 版三态：

| dsh 态 | zcode 版 | 实现 |
|---|---|---|
| `live`（steer 注入驻留回合） | **弃用** | zcode 无对等 steer API（PLATFORM.md §6：旧报告该论断已被 app-server 实测推翻，但 steer 本身仍无入口）；最接近的是 UserPromptSubmit hook 注入，但那是用户驱动，不算插件主动投递 |
| `wake`（唤醒空闲成员） | **`wake`** | **fire-and-forget**：引擎写一次性 wake nonce（§2.3-4）→ spawn 无头 CLI（`ELECTRON_RUN_AS_NODE=1 <zcode_exe> <zcode_cjs> --resume <sid> --prompt "<回执+身份行(含sid)+wakeToken+任务票>" --cwd <workspace> --output-format json`）**detached、不等待退出、不阻塞工具返回**，stdout/stderr 直落 `logs/wake-<to>-<ts>.json`，engine.jsonl 记 {event:"wake", pid}。**不看唤醒的返回值判定成败**——唤醒效果由任务状态推进间接观测（B 若 claim/report，状态自会变）。无属主会话的 CLI resume 跨进程续聊已实测（PLATFORM.md §4.4：391→782→2346→11730 记忆连续） |
| `mailbox`（只落盘等拉取） | **`mailbox`** | wake 未启用/被约束跳过/spawn 失败；消息留邮箱，pull 路径（hook 注入 / xc_check_inbox）兜底，投递租约到期后可重试 |
| `duplicate` | **`duplicate`** | 同文且仍在效期的消息已存在（移植 tools.js:2088-2093 幂等判定：from+content+taskId+attemptId+source* 全等且 isCurrentMail） |

**push 的启用条件（三重与，任一不满足即 mailbox 态）**：

1. `XC_WAKE_ENABLED === "true"`（userConfig，**默认 false**——交互会话间的派发不自动 resume 可能正被桌面持有的目标；引擎对非 `"true"` 的任何值一律按关闭处理并把原始值记入 engine.jsonl，V7）。
2. 目标**属主缺席**：v1 无法检测属主，以**约束代替检测**——push 只用于「以无头/CLI 形态驱动的会话」（属主即起即退，如 §6.4）；桌面正打开的会话与常驻 app-server 持有的会话一律靠 pull。「CLI --resume 打到活属主会话」是未验证形态，v1 明令禁用（V5）。
3. 该目标**无在途唤醒**：`registry/wake/` 存在该目标的未使用未过期 nonce（TTL=**WAKE_INFLIGHT_MS=15 分钟**）则跳过推送。**两个计时不混用**：60 秒投递租约（state.js:26 `MAILBOX_DELIVERY_LEASE_MS` 移植）只管「投递尝试的重试资格」；15 分钟在途窗口管「不重复 --resume 同一会话」（无头回合常超 60 秒，同会话并发回合行为未验证）。

**任务票截断**：唤醒 prompt 上限 4000 字符（移植 dsh assignmentPrompt 2000/12000 截断思想，07 §4；v1 单任务放宽）。

### 2.6 任务状态机与 attempt 令牌（硬校验，不只靠 prompt 纪律）

**六态状态机**（1:1 移植 dsh TASK_TRANSITIONS，state.js:115-122 本会话亲读，转移表**原样含全部边**；终态无出边）：

| 当前态 | 允许转到（dsh 原文逐边） |
|---|---|
| pending | claimed, **cancelled** |
| claimed | in_progress, failed, cancelled |
| in_progress | completed, failed, cancelled |
| completed / failed / cancelled | （终态，无出边） |

（claimed 不可直接跳 completed：先 in_progress 再完成——dsh 原语义保留。）

**v1 已知边界（如实声明）**：① v1 工具面**无 cancel 入口**（无 halt、无 xc_cancel 工具）——cancelled 边是「可达性为零的保留边」，供 v1.5 的 halt/reassign 使用；② **无认领超时/自动回收**——认领方进程死亡则任务停留 claimed/in_progress，v1 只能人工处置（认领方补报 xc_report(failed) 或人工修盘），自动重派属 v1.5；③ 单队 default，无多队。

**team.json（TeamState）**：

```jsonc
{ "teamId": "default", "name": "default", "founderKey": "a", "phase": "open|halted",
  "members": [ { "key": "a", "sessionId": "sess_…", "role": "peer|worker", "joinedAt": …, "lastSeen": … } ],
  "tasks": [ { "id": "t1", "title": "…", "prompt": "…", "acceptance": "…", "dependsOn": [],
               "status": "pending|claimed|in_progress|completed|failed|cancelled",
               "assignee": null, "attempt": 0, "attemptId": null,
               "createdBy": "a", "createdAt": …, "updatedAt": …,
               "result": null, "error": null, "evidence": [],
               "history": [ { "ts": …, "event": "claimed|in_progress|completed|failed|cancelled", "by": "…", "attemptId": "…" } ] } ],
  "seq": 1, "createdAt": … }
```

**attempt 令牌机制**（移植 state.js:138-187 beginTaskAttempt/invalidateTaskAttempt，08 抽查 keyTakeaway ①③）：

- `xc_claim` 成功 = `attempt+1`、`attemptId=uuid`、`assignee=me`、status=pending→claimed（原子，锁内）；
- `xc_report` 必须携带当前 `attemptId`，不匹配即**硬拒绝**（移植 tools.js:1839-1841 stale 即拒）；状态转移不合法即硬拒；
- 重派（v1.5）：吊销旧 attempt（attemptId=undefined + handoffId）→ 旧消息经 isCurrentMail 自动作废。

**硬校验点**（全部做进 MCP 工具实现，对应 08 抽查 keyTakeaway ③「把同等硬校验做进 MCP 工具实现而非只靠 skill 提示词」）：

| 工具 | 校验 |
|---|---|
| xc_claim | 会籍有效；任务存在；status=pending；dependsOn 全 completed；我无第二开放任务（防一人双线，移植 dsh memberOpenTask 约束） |
| xc_report | attemptId==当前（否则 stale 拒绝）；claimed/in_progress→completed|failed 合法转移；completed 必须带 result 与 evidence≥1 条 |
| xc_message | **无 from 参数**——from≡连接绑定身份（§2.3），结构性防伪造（dsh tools.js:2063-2067「from must be your own identity」的等效机制移到了连接绑定层） |
| xc_dispatch | 目标 to 必须是已注册成员；同 workspace 存在 |

### 2.7 并发控制与原子写

与 dsh 的**真实差异**：dsh 全部并发在同一宿主进程内（一 workspace 一进程，07 §5.2/§10.1），进程内 promise 链锁就够；zcode 每会话一个 MCP server 进程（多会话=多进程同写一个 .crosschat），**必须加跨进程锁**。

1. **进程内**：每 team 一条 promise 链 `withTeamLock(key, fn)`（照抄 state.js:37-56，本会话亲读，含 settled 清理纪律）。
2. **跨进程**：`locks/<name>.lock` 用 `fs.openSync(path, 'wx')`（O_EXCL）独占创建；内容 `{pid, ts}`。获取=指数退避重试，**总等待 15 秒**；超时→**变更类工具返回结构化错误 `{error:"busy", lock:<name>}`，不产生半状态**（协议指示：稍后重试一次，仍忙则上报用户）。陈旧强夺条件=**pid 不存活 或 lock 文件年龄>120 秒**（等待期 15 秒内持锁者多半活着且在干活，不夺）。锁粒度=team（`team:<abs stateRoot>:<teamId>`）与 registry。
3. **锁序全局固定：registry → team**。唯一同时持两把的路径是 xc_register（先 registry 绑名、后 team 入队；team join 失败则回滚绑名）；其余路径至多持一把；**禁止任何路径先 team 后 registry**（防死锁，I8）。
4. **锁内纪律**（移植 tools.js:109-123「锁内重读重验」）：持锁后先从盘重读 team.json 再验身份/状态，不用调用方传入的陈旧对象决策；慢操作（唤醒 spawn）一律锁外做，失败不回滚任务（mailbox 态兜底，无需 dsh scheduler.js:366-368 的 CAS 回滚——我们没有锁外改任务状态的操作）。
5. **读侧校验范围**（08 抽查修正 C1 的直接应用 + I6 修正）：严格 coerce+全量形状校验**只施于 team.json 等整文件**（rename 原子写保证读者看到的总是完整文件，坏数据抛诊断不进内存）；**JSONL（inbox/*.jsonl、engine.jsonl）一律容忍读**——它们是跨进程**追加写**（O_APPEND，不走 rename），崩溃可能留半行：解析失败的行**跳过**并在 engine.jsonl 记 `{event:"malformed-line", file, lineNo}`，追加前若尾行不完整先截断。这是 dsh 原版行为（readMailbox 带 onMalformed 容错回调，mailbox.js:29-40 本会话亲读复核），此前「1:1 移植」漏列，现补。
6. **Windows 原子写**（照抄 dsh state.js:525-631，08 抽查 §1.8/§4-1）：写临时文件 → `rename` 覆盖目标，EPERM/EACCES/EBUSY 时小睡重试（Windows 上目标被占用是常态）；只用于 team.json/names.json/wake nonce/snapshot 等整文件。
7. **归档非物理删除**（移植 state.js:1134-1170）：`xc_archive`（v1.5）rename 到 `archive/<teamId>`。

### 2.8 MCP 工具面规格（7 个 `xc_*` 工具，v1）

工具经 `mcpServers.crosschat` 暴露，会话内实际名形如 `mcp__plugin_zcode-crosschat_crosschat__xc_dispatch`。**身份=当前 stdio 连接的绑定身份（§2.3）**：身份类工具（dispatch/claim/report/message/check_inbox）要求已注册连接，未注册即结构化报错；**xc_status 无需注册**（只读观测豁免）；所有工具一律**不接受 from/caller 参数**。每个工具实现都在锁内走「重读→校验→变更→写盘→（锁外）投递」。

| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `xc_register` | `name*`, `sessionId*`, `role?`(peer/worker), `wakeToken?` | §2.3（hook 路径或 wakeToken 路径）；join default team | `{sessionKey, teamId, roster[], protocolDigest}` |
| `xc_dispatch` | `to*`, `title*`, `prompt*`, `acceptance?`, `dependsOn?` | 锁内建任务(pending)+写 to 邮箱；锁外按 §2.5 三重条件决定推送 | `{taskId, status:"pending", delivered:"wake|mailbox|duplicate", wakeLog?}` |
| `xc_check_inbox` | —（身份=连接绑定） | 读自己邮箱；isCurrentMail 过滤（过期→discarded）；正当消息标记 readAt（**此刻即消费**） | `{messages[], unreadCount}` |
| `xc_claim` | `taskId*` | §2.6 硬校验；beginTaskAttempt | `{taskId, attemptId, title, prompt, acceptance, dependsOn}` |
| `xc_report` | `taskId*`, `attemptId*`, `status*`(in_progress/completed/failed), `result?`, `error?`, `evidence?[]` | §2.6；终态则给派发方邮箱写回执消息（带 source 字段）；锁外唤醒派发方 | `{taskId, status, reportedAt, wakeBack:"wake|mailbox"}` |
| `xc_message` | `to*`, `content*`, `sourceTaskId?`, `sourceAttemptId?` | 自由消息（对等互发，移植 dsh 成员横向通信 members.js:821）；duplicate 去重 | `{messageId, delivered}` |
| `xc_status` | `teamId?`（**无需注册**；未注册调用省略个人字段） | 组装快照：members+tasks+各邮箱 unread；**落盘 snapshot.json**；写 engine.jsonl | 人可读表格文本 + `{snapshot}` |

工具 render（人可读一行摘要）沿用 dsh tools.js render 思路（如 `Task t1 dispatched to b via wake`）。

**evidence 条目格式**：`{ "path": "<abs>", "sha256": "<hex|null>", "note": "…" }`——报告完成必须附至少 1 条（文件类证据由工具实现计算 sha256，移植 artifacts.js 思路的极简版；完整质量门延后 v1.5，见 §5）。

### 2.9 结果回传与证据链

回传闭环 = 三段（对应 dsh「回执-ack」三段式，08 抽查 keyTakeaway ④）：

1. B `xc_report` → team.json 状态落盘（completed + result + evidence）→ `inbox/a.jsonl` 追加回执消息（sourceTaskId/sourceAttemptId 快照，移植 tools.js:2111-2114——2107-2109 是 halted 检查行，08 报告沿袭的引用漂移已在本版修正）；
2. 唤醒 A：push（--resume A "收到 CrossChat 回执：<receipt JSON>…+wakeToken"，A 在新连接上先 xc_register(wakeToken) 再核对——每个被驱动的回合金都要重新注册，§2.3-2）或 pull（A 下一轮 UserPromptSubmit 注入）；
3. A `xc_check_inbox` 读回执 → `xc_status` 看全程 → 按 acceptance 用自己的文件工具复核 evidence（如直接读 result 文件比对数值）→ 向用户汇报。

---

## 3. 会话独立性形态选择（回应验收标准第 4 条）

### 3.1 两个候选形态

| | 形态甲：durable 子会话（对齐 dsh 版） | 形态乙：文件邮箱全独立（本设计选择） |
|---|---|---|
| 会话来源 | 引擎经 app-server `session/create` 创建「成员会话」，归属派发方 | 任意已存在的 zcode 会话（桌面/CLI/无头），自注册加入 |
| 生命周期 | 引擎持有句柄（create/send/poll/resume），随队创建销毁 | 互不归属，各自独立开始/结束 |
| 执行驱动 | 引擎 `session/send` + `session/messages` 轮询 | 任务票推送（--resume）或收件箱拉取（hook 注入） |
| 宿主依赖 | 需要引擎常驻持有一个 app-server 客户端 | 唤醒是无头单发进程，用完即退 |

### 3.2 选择：形态乙（全独立对等会话），四条理由

1. **平台无对等物，硬模仿只会得到弱化版**。dsh 成员是宿主 cordis 进程内的 durable continuable subagent，依赖 `ctx.subagents`/`registerContinuableSetup`/steer 等宿主 API（07 §2.5）；zcode 插件**没有**这些一等入口（PLATFORM.md §2.1：工具只能经 MCP 暴露；`agents` 字段文档矛盾不可依赖）。引擎自建的 app-server 会话只是「引擎的下游」，做不出「宿主承认的、可被 steer 的子会话」，只会有轮询版半成品。
2. **zcode 已验证的强通道恰好利好全独立模式**。CLI `--resume` 跨进程续聊**记忆连续已实测**（PLATFORM.md §4.4：391→782→2346→11730）——「可续聊」这个 dsh 版用 durable 子会话达成的性质，独立会话用 resume 同样达成；hooks 提供 `${CLAUDE_SESSION_ID}` 注入 + `additionalContext` 上下文注入 + Stop 续跑（diagnosing-hooks §2 亲读）——身份锚定与收件箱播报不需要宿主会话系统配合。
3. **对验收第 1 条是最严格满足**。「两个独立 zcode 会话」按 03 §6.6 记录的解读分歧，存在「队长创建的同进程子会话」与「互不归属的平等会话」两种理解；形态乙直接落在更严格的一侧：A、B 可以一个在桌面、一个在 CLI，谁也不是谁的父亲。
4. **崩溃可恢复性更好**。全部协调状态在磁盘（邮箱+状态机），任何进程（任一 MCP server、任一被唤醒的会话、甚至引擎本身）死亡都不损失状态——dsh 版也只有磁盘真源存活于进程之外，这一点我们原样继承（07 §1.1「文件态是唯一权威真源」）。

代价（如实）：没有宿主级护栏——dsh 的每步准入重验会籍（members.js:529-541）、savedSetup 缺失拒绝（550-554）在 zcode 无对应挂点；替代护栏=工具硬校验（§2.6 表）+ hook 每轮刷新 lastSeen + 邮箱新鲜性裁决。**「迟到错误不污染新工作」由 isCurrentMail + attempt 令牌承担**（08 抽查 keyTakeaway ⑤ 的等效物）。

### 3.3 独立性边界（正面清单）

**是独立的**：① 无父子归属——B 不是 A 的子会话，team.json 只记 founderKey 作溯源，无控制权；② 生命周期互不绑定——A 归档/退出不销毁 B，B 拒绝任务不影响 A；③ 进程无耦合——两会话可分属不同进程甚至不同端（桌面/CLI），仅共享文件系统；④ 上下文互不渗透——A 看不到 B 的对话历史，只能看到 B 主动写入邮箱/任务报告的内容。

**共享面（恰好两样）**：① 同一磁盘真源目录 `<workspace>/.crosschat/`（v1 要求两会话同一 workspace；跨 workspace 派发留 v2，届时把状态根提为绝对路径配置）；② 同一插件安装（提供相同的工具与协议）。

**v1 放弃的独立性无关项**：身份校验是协作级（§2.3）；推送唤醒 v1 仅用于属主缺席会话（V5 约束规避，§2.5），桌面正打开的会话一律靠拉取——不影响独立性，只影响实时性。

**对 03 修订记录第 5 条（§6.6）的直接回应**：该条指出 dsh 胜者的成员是「队长创建、驻留同一 harness 进程内的持久子会话」，若验收方期望「互不归属的完全独立会话」需实测确认。本设计显式选择后者：执行体=完全独立的顶层会话（用户既有会话或脚本起的独立会话均可），「A 派发 B、B 回报唤醒 A」的闭环口径成立且会话间关系是**对等邮箱通信**而非「队长-队员」。

---

## 4. 用户使用面

### 4.1 一次性安装

1. 构建：`cd <仓库路径>\plugin && npm install && npm run build`（dist/ 生成）。
2. 校验：`zcode plugins validate "<仓库路径>\plugin"` → 期望 `Plugin manifest is valid`（该命令 0.17.1 实测存在，本会话亲跑 `plugins --help` 确认子命令）。
3. 安装（UI，plugin-creator SKILL.md §4-5 权威流程，本会话亲读）：桌面 **插件市场 → 添加 → 添加插件市场 → 粘贴 `<仓库路径>` → 个人 → 安装 zcode-crosschat → 启用**。CLI `plugins install` 语法未文档化（本会话亲跑 `--help` 无子命令专属参数），列为 V4，装通则可替代 UI。
4. 更新：改源码 → 递增 manifest version → 市场源刷新 → 插件详情「更新」（PLATFORM.md §2.3-6）。

### 4.2 日常操作

**斜杠命令**（4 个，frontmatter 均含 `description`/`argument-hint`/`skills: crosschat`，正文引用技能并带 `$ARGUMENTS`——zcode-site/0.4.2/commands/site-badge.md 同构）：

| 命令 | argument-hint | 行为 |
|---|---|---|
| `/xc-work` | `[名字] [worker]` | 把**当前会话**注册进协作网络：调 xc_register（sessionId 取 hook 注入的上下文），返回花名册；带 worker 则角色=值班执行 |
| `/xc-dispatch` | `<目标名> <任务描述>` | 发起派发：模型按 crosschat 技能调 xc_dispatch（可检验任务=标题+内容+验收标准），回报 taskId 与 delivered 状态 |
| `/xc-inbox` | — | 调 xc_check_inbox 并逐条摘要 |
| `/xc-status` | — | 调 xc_status 渲染任务板（六态+认领人+attempt 代数+未读数） |

**典型对话**（交互闭环）：

```
用户（会话 A）：/xc-dispatch b 计算 17*23，把结果写入 result-a2b.txt，只写数字
  A 的模型：调 xc_dispatch → 「任务 t1 已派发给 b（delivered=mailbox，b 下一回合开始时会收到未读提示；delivered=wake 仅在推送开启且目标属主缺席时出现，见 §2.5）」
用户（会话 B）：继续            ← 随便说什么；UserPromptSubmit hook 已注入「你有 1 条未读」
  B 的模型：xc_check_inbox → xc_claim(t1) → 执行写文件 → xc_report(completed, evidence=[result-a2b.txt+sha256])
用户（会话 A）：收结果          ← hook 注入未读回执，模型核对后汇报
  A 的模型：xc_check_inbox → 读 result-a2b.txt 核对 391 → 「b 已完成 t1：391，证据文件已核验」
```

**跨chat 技能（skills/crosschat/SKILL.md）**承载协议纪律（移植 dsh usageSectionText index.js:106-118 的等待纪律思想）：派发必须写验收标准；等待时让位不 busy-poll（报告会唤醒你/下轮自动注入）；被唤醒先 xc_check_inbox；**xc_claim 失败（任务已被他人认领）→ 立即 xc_check_inbox 看是否还有其他未读，没有则直接结束回合——不得重试同一任务、不得 busy-poll**；报告必须带证据；stale attempt 立即停手；变更工具返回 `error:"busy"` 时稍后重试一次，仍忙则上报用户。frontmatter：

```yaml
---
name: crosschat
description: 在独立 zcode 会话之间派发、认领、执行、回传任务。当用户要跨会话派活、查看协作收件箱、报告任务结果或询问任务状态时使用。
---
```

worker 会话的无头驱动（自动闭环用）：引擎唤醒 prompt 内嵌**成员守则摘要**（claim→执行→report→结束回合，不 busy-poll；移植 dsh memberPersona capabilities.js:9 思想），不依赖技能自动触发。

### 4.3 可观测面（验收标准 2）

| 观测点 | 位置 | 内容 |
|---|---|---|
| 任务真源 | `<ws>/.crosschat/teams/default/team.json` | 全部任务六态+attempt 代数+history 时间线 |
| 邮箱 | `<ws>/.crosschat/teams/default/inbox/*.jsonl` | 每条消息全生命周期字段（含 readAt/discardedAt） |
| 引擎审计 | `<ws>/.crosschat/logs/engine.jsonl` | 每次状态转移/投递/唤醒一行（who/what/when/attemptId） |
| 唤醒原始输出 | `<ws>/.crosschat/logs/wake-*.json` | `--resume --output-format json` 的完整返回 |
| 快照 | `<ws>/.crosschat/teams/default/snapshot.json` | xc_status 每次调用刷新 |
| hook 执行 | zcode 日志 | 官方记录 fired/timeout/blocked+时长+错误预览（diagnosing-hooks §3） |
| 会话审计（可选） | `~/.zcode/cli/db/db.sqlite` 只读 | session/part 表（PLATFORM.md §4.5 实测过） |

---

## 5. 与 dsh-agent-teams 的机制对照（等效，不同栈）

原则（任务要求）：**不追求同技术栈，只追求同等效果**，用 zcode 生态最自然的实现。行号均为 dsh 源码位置（07 报告+08 抽查+本会话抽查三方一致）。

| dsh-agent-teams 机制 | dsh 实现（证据） | zcode 版等效方案 | 差异与理由 |
|---|---|---|---|
| 14 个 `agent_teams_*` 全局工具 | tools.js:494 注册进共享工具表；宿主 cordis 直接把工具挂进模型工具表 | **7 个 `xc_*` MCP 工具**（§2.8） | zcode 无「注册全局工具」入口，工具只能走 MCP server（PLATFORM.md §2.1）；14→7 是 v1 验收裁剪：edit_plan/approve/profiles/reassign 依赖 Web 审批面与计划评审，v1 以对话内确认为等效；质量门族延后 v1.5 |
| `ctx.agents`（枚举/steer/followup/cancel） | harness 宿主服务，steerCaptainReport members.js:117-128 | **无对等 API**：推送唤醒=引擎 fire-and-forget spawn `--resume <sid> --prompt`（跨进程已实测 PLATFORM.md §4.4，仅属主缺席会话，§2.5）；拉取=UserPromptSubmit hook `additionalContext` 注入 | steer 的「注入驻留回合」做不到；等效达成「B 动作唤醒 A」，代价是唤醒粒度=新回合而非注入当前回合 |
| 调度器（agent/status 边沿→原子认领） | scheduler.js:465 监听宿主事件，kickMember 原子认领 | **无 per-agent 状态事件**：认领收敛到**收件人侧工具内原子完成**（xc_claim，锁+CAS 语义）；推送只是减少延迟的优化 | zcode 无宿主事件总线给插件；把「谁认领」从调度器搬进工具，消除对事件边沿的依赖，这正是 dsh 设计里状态机+工具硬校验已有的兜底层 |
| durable continuable subagent 成员 | ctx.subagents + registerContinuableSetup（harness-compat.js:168-244） | **全独立顶层会话 + `--resume` 续聊**（记忆连续实测）；见 §3 | 平台无该子系统；resume 等效「可续聊」，且独立性更强（03 §6.6 分歧的严格侧） |
| team.json + inbox/*.jsonl 磁盘真源 | state.js:4-12；mutateMailbox 原子改写 450-519 | **1:1 移植**（布局/消息格式/字段/租约/isCurrentMail 全保留） | 与宿主完全解耦，本就是最可移植资产（08 抽查 keyTakeaway ①） |
| withTeamLock 进程内 promise 链 | state.js:37-56 | 保留 + **新增跨进程 lockfile（O_EXCL+陈旧强夺）** | 真实差异：zcode 多会话=多 MCP 进程同写一个状态根（§2.7） |
| Windows 原子写（rename 重试） | state.js:525-631 | **照抄**（EPERM/EACCES/EBUSY 重试） | 08 抽查确认 Windows 实证可移植，同为 Windows 环境 |
| 校验在读侧 | coerceTeamState 仅 readTeam 调用（08 修正 C1） | 同样放读侧（§2.7-4） | 直接采纳抽查修正结论 |
| attempt_id 能力令牌 + isCurrentMail | state.js:138-187；mailbox.js:6-17 | **1:1 移植**，做进 MCP 工具硬校验（§2.6） | 08 keyTakeaway ③：硬校验进工具实现，不靠 prompt 纪律 |
| system prompt 角色分叉（captain/member 段） | capabilities.js:41 section order 117 | **skill（交互会话）+ 唤醒 prompt 内嵌成员守则（无头会话）** | zcode 插件无 systemPrompt 注入入口；skill description 自动触发 + prompt 内嵌是等效注入点 |
| /agent-teams 斜杠命令 + 手势边界 | command.js:73-147 | **4 个 commands**（§4.2）+ skill 承担协议 | 手势边界（纯文本命中激活）不需要——zcode commands+skill 已覆盖 |
| Web 面板（花名册/DAG/活动/审批） | client/ 注入浏览器 UI | **弃用**（无插件 UI 注入点）→ `xc_status` 快照落盘 + engine.jsonl + 磁盘真源；审批改为对话内确认 | zcode ui.surfaces 是面板资源不是任意 DOM 注入；文本观测已满足验收 2 |
| 质量门 + 工件指纹 | quality-gates.js(1832) + artifacts.js(465) 纯函数零 I/O | **v1 只移植 evidence+sha256 极简版；完整族延后 v1.5 整体复制** | 验收不需要；纯函数零宿主依赖，延后无迁移成本（08 抽查 §1.10；Windows 原子写论断另见 08 §1.8/§4-1） |
| 计划评审（staged plan→Approve & Run） | index.js:258-404 Web 路由 + steer 批准消息 | **弃用**：v1 任务直接可派发，评审=派发前对话确认 | 无 Web 路由挂点；验收流程不需要 |
| 成员工具策略/派生深度护栏 | tool-policies.js；installMemberDelegationGuard | **v1 弃用**；session/create 原生 toolAllowlist/toolDenylist 留作 v2 引擎托管模式的安全面 | 对等全独立会话本就拥有完整工具权限，这是独立性的语义一部分（§3.3 声明） |
| 兜底模型路由/错误代际归属 | members.js:289-317 commitFallbackRoute；classifyMemberFailure 145-168 | **v1 弃用**（错误经 xc_report(status=failed) 正常回传）；代际归属由 isCurrentMail 承担 | zcode 会话模型路由由宿主管；无 agent/error 钩子挂点（7 事件里没有） |
| halt 双 cancel 竞态窗 | tools.js:437-454 | **v1 无 halt**（phase 字段保留）；Stop hook 续跑上限 3 次天然防失控（官方契约） | 验收无此需求；无宿主 cancel API |
| doctor 诊断 CLI | scripts/doctor.mjs | `xc_status` 自检段 + `zcode plugins validate` 入构建流程 | 无 bin 通道；校验命令实测存在 |

**移植优先级落位**（07 §8.2 建议的修正版）：07 曾建议「编排循环由动态工作流承担、插件只做状态读写」——**PLATFORM.md §6 已推翻其前提**（app-server 提供完整跨会话编程面），但本设计仍不把编排放动态工作流：验收要求的是**模型可自主调用的协调工具**（07 §8.3 自己指出的工作流做不到的三件事之一），且工作流实例运行结束即消亡、无跨轮持久 DAG。结论一致：插件自建磁盘真源+工具面，编排纪律在协议里，实时唤醒用 --resume。

---

## 6. 两会话闭环验证方案

### 6.1 验证目标 ↔ 验收映射

演示任务（可检验小任务，呼应 PLATFORM.md §4.4 的 17*23=391 先例）：

> **t1**：计算 17×23，把结果**只写数字**到 `<workspace>/result-a2b.txt`。验收标准：该文件存在且内容为 `391`。

Phase 1 与 Phase 2 各完整跑一遍闭环（互为备份：Phase 1 是 pull-only 的**保底验收路径**，全部落在已文档化契约内；Phase 2 主路径是**全自动证据链**，构造性规避 V5——它不依赖 V1 的 app-server 会话子情形，也不依赖 V2（wakeToken 兜底），**但 V1 的无头 CLI 子情形（CLI `--resume` 回合内插件 MCP 可用）是主路径硬前置**，该子情形失败即走半自动回退；前置还有 wake_enabled 开启与 V6 模型选择）。

### 6.2 Phase 0：准备与安装

```bash
cd /d/tools/zcode-crosschat/plugin
npm install && npm run build && npm run test        # dist/mcp/server.mjs + dist/hooks/*.mjs + 单测全绿
ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs \
  plugins validate "D:\\tools\\zcode-crosschat\\plugin"   # 期望: Plugin manifest is valid
```
然后 UI 安装（§4.1 步骤 3）。**装通判据**：`zcode plugins list` 输出含 zcode-crosschat 且 skills/commands/hooks/mcp 计数非零（命令本会话亲测存在）。并在插件设置里确认 wake_enabled 开关位置（Phase 1 保持默认 false 不动；Phase 2 开跑前开启为 true）。证据存 `evidence/phase0/`。

### 6.3 Phase 1：交互闭环（桌面两会话，**pull-only**，全在已验证契约内）

**前置：保持 wake_enabled=false（v1 默认值，本阶段不开）**——本阶段不发生任何 `--resume`，与 V5（活属主会话被跨进程 resume）零接触；第 3 步的 delivered 证据预期值即 **mailbox**。本阶段依赖的全部是已文档化契约：插件 MCP 自动连接（PLATFORM.md §3.2）、插件钩子自动启用 hook runner（§2.2）、7 事件/matcher/additionalContext/`${CLAUDE_SESSION_ID}`（diagnosing-hooks §2 亲读）。

| 步 | 操作 | 即时证据 |
|---|---|---|
| 1 | 桌面开**会话 A**（workspace=`<仓库路径>\.scratch`），输入 `/xc-work a` | `registry/sessions/<A_sid>.json`（SessionStart hook 写入）+ `teams/default/team.json` members+a + A 回复花名册 |
| 2 | 桌面开**会话 B**（同 workspace），输入 `/xc-work b` | 同上 +b |
| 3 | A 输入 `/xc-dispatch b 计算 17*23，把结果只写数字到 result-a2b.txt` | team.json t1=pending；`inbox/b.jsonl` 1 条；engine.jsonl dispatch 行且 **delivered=mailbox**（wake 关闭的预期值）；A 回复 taskId |
| 4 | 切到 B 输入「继续」 | UserPromptSubmit hook 注入未读提示 + lastSeen 刷新（hook 执行记录在 zcode 日志可查）；B：xc_check_inbox→xc_claim（t1=claimed+attemptId）→写文件→xc_report（t1=completed+evidence）；`inbox/a.jsonl` 回执；`result-a2b.txt` 内容=391 |
| 5 | 回 A 输入「收结果」 | A：xc_check_inbox 读回执→读文件核对 391→向用户汇报；inbox/a.jsonl 消息 readAt 落盘 |

每步之后把 `.crosschat/` 全量拷贝到 `evidence/phase1/snapshots/step-<n>/`。

### 6.4 Phase 2：自动闭环（脚本驱动，push 路径，**属主缺席形态**）

**主路径构造性规避 V5**：全程没有进程「常驻持有」目标会话——每个属主都是即起即退的 CLI 单发进程，引擎的 `--resume` 打到的永远是属主缺席的会话（与 PLATFORM.md §4.4 实测形态同构：属主退出后续聊、记忆连续）。

`node demo/bootstrap-and-run.mjs --workspace "<仓库路径>\.scratch" --evidence "<仓库路径>\evidence\phase2"`：

1. **bootstrap（模型选择）**：脚本起 app-server → `session/create` A，参数**显式带 `mode:"yolo"`**（防无头回合撞权限请求卡死；PLATFORM.md §4.3-1 示例同款；workspace 两字段必填）→ 应答 `session/requestRuntimePreferences` 回调 `{"nativeSearchEnhancementsEnabled":false}`（15s 超时坑）→ `session/setModel`（必须带 `options.reasoningLevel`；providerId 以运行时 `state.updated` 的 `model.available[]` 枚举为准，V6）→ 同法建 B → **关闭 app-server 退出**（会话已持久化）。两 sid 落 `evidence/phase2/sessions.json`。注：**V1 有两个子情形**——①app-server 会话内插件 MCP 可用（bootstrap 阶段，主路径不依赖，此时 app-server 已退出）；②**CLI `--resume` 无头回合内插件 MCP 可用（第 2-5 步全部依赖，主路径硬前置）**；②失败 → 半自动回退形态。V2 由 wakeToken 兜底，不构成前置。
2. **注册（顺带验证 wakeToken 路径）**：脚本为 A/B 各写一个 wake nonce → CLI 单发 `--resume A_sid --output-format json`，prompt 为自包含自然语言指令："你是 zcode 会话 a，sessionId=<A_sid>。本连接是新的，请先调用 xc_register 工具绑定身份：name 填 'a'，sessionId 填 '<A_sid>'，wakeToken 填 '<nA>'；注册成功后复述返回的花名册。"（进程自然退出，属主即逝）→ 同法 B。判据：team.json members 含 a、b；`registry/names.json` 绑定正确。
3. **派发**：脚本再写 A 的 nonce（新连接必须重新注册，§2.3-2）→ CLI 单发 resume A，prompt："你是 zcode 会话 a，sessionId=<A_sid>。先调用 xc_register 绑定本连接身份：name 填 'a'，sessionId 填 '<A_sid>'，wakeToken 填 '<nA2>'；绑定成功后调用 xc_dispatch 给 b 派任务：计算 17*23，把结果只写数字到 result-auto.txt，验收标准=文件内容为 391；最后报告 taskId 与 delivered 状态。"。A 模型先 xc_register（wakeToken 命中）再 xc_dispatch → **A 的 MCP server 引擎**写 B 的 nonce → spawn `--resume B_sid`（detached，stdout→`logs/wake-b-*.json`）→ engine.jsonl 记 wake 行。A 的 CLI 进程此时已退出 → B 无活属主。
4. **执行**：B 被唤醒回合：xc_register(wakeToken)→xc_claim→写文件→xc_report(completed, evidence) → B 的引擎写 A 的 nonce → spawn `--resume A_sid`（stdout→`logs/wake-a-*.json`）。B 进程自然退出。
5. **回传**：A 被唤醒回合：xc_register(wakeToken)→xc_check_inbox→读文件核对→输出总结；`--output-format json` 的 response 字段落盘于 wake-a-*.json（此即 `evidence/phase2/a-final.json`）。
6. **判收**：脚本轮询磁盘证据（超时 10 分钟）生成 `evidence/phase2/checklist.md`，条件全真：① team.json t1 转移链 pending→claimed→in_progress→completed；② `result-auto.txt`==`391`；③ inbox/a.jsonl 回执 readAt 非空；④ wake-a-*.json 的 response 含 `391`；⑤ engine.jsonl 有两条 delivered=wake 行（dispatch 与 report 各一）。

**回退（半自动）形态**（V1 查明无头/CLI 会话内插件 MCP 不可用时启用）：脚本保持 app-server 属主，**派发/认领/报告仍全部走插件工具**（app-server `session/send` 驱动模型，PLATFORM.md §4.3 实测），仅「投递传输」由脚本代行——脚本轮询 `inbox/b.jsonl` 出现未读消息即对**自己属主内的** B 做 `session/resume`+`session/send`（同属主单进程操作，无跨进程并发，V5 不涉及），runbook 如实标注「传输由演示脚本代行，等效引擎的 app-server 传输形态（v2 可内置于引擎）」；此形态 delivered 证据=mailbox + 脚本投递日志。

### 6.5 Phase 3：状态观测核查

- `xc_status` 人工调一次 → snapshot.json 更新（验收 3）；
- （可选）`node demo/check-db.mjs`：node:sqlite 只读查询 db.sqlite 的 session 表两行（PLATFORM.md §4.5 实测只读可行）。

### 6.6 证据落盘位置

```
<仓库路径>\evidence\
├── phase0\build.log / validate.log / plugins-list.log
├── phase1\snapshots\step-<n>\…（.crosschat 全量拷贝）+ transcripts\（两会话关键回复文本）
├── phase2\sessions.json / wake-b-*.json / wake-a-*.json / a-final.json / checklist.md / snapshots\…
└── runbook.md（本次实际执行的命令序列+时间戳）
```

---

## 7. 模块划分（moduleCount = 5，供并行实现拆分）

| 模块 | 目录（独占，互不重叠） | 文件清单 | 职责 | 依赖 | 产出判据 |
|---|---|---|---|---|---|
| **M1 core-store** | `plugin/src/core/` | `types.ts`（TeamState/Message/Task/wake-nonce 类型+校验）`paths.ts`（状态根解析）`atomic.ts`（Windows 原子写）`lock.ts`（进程内 promise 链+跨进程 lockfile：15s 等待/busy 错误/pid-or-120s 强夺/registry→team 锁序）`sanitize.ts`（sanitizeKey）`teamstate.ts`（读侧校验/状态机/attempt 操作/写盘）`mailbox.ts`（append/lease/ack/discard/isCurrentMail/**onMalformed 容错读+尾行截断**，移植 mailbox.js:29-40）`registry.ts`（sessions/names/**wake nonce** 读写+lastSeen 刷新）`jsonl.ts` `log.ts`（engine.jsonl）+ 各自 `*.test.ts` | 磁盘真源全部读写与不变量；纯 Node，零引擎/MCP 依赖 | 无 | 单测覆盖状态机非法转移拒绝/attempt 令牌过期/锁竞争与 busy/半行 JSONL 跳过 |
| **M2 wake-engine** | `plugin/src/engine/` | `resume-cli.ts`（spawn 无头 --resume，env 组装，detached+stdout 落文件）`wake.ts`（回执+身份行(含sid)+wakeToken+任务票 prompt 组装≤4000、nonce 写入、delivered 三态决策、**fire-and-forget**、在途 nonce 去重 WAKE_INFLIGHT_MS=15min、属主缺席约束）`lease.ts`（60s 投递租约）+ `*.test.ts` | 推送唤醒；只依赖 M1 | M1 | 单测：prompt 截断 4000/duplicate 去重/在途 nonce 去重/失败降级 mailbox/非 "true" 按关 |
| **M3 mcp-server** | `plugin/src/mcp/` | `server.ts`（stdio MCP 入口，官方 SDK `@modelcontextprotocol/sdk@^1.32.2`，本会话 npm view 实测在案）`protocol.ts`（请求解析/错误映射，含 `{error:"busy"}` 结构化错误）`tools.ts`（7 工具 schema+处理器，§2.8 全部硬校验）`identity.ts`（**连接绑定身份表**、xc_register 双路径校验：hook 落盘文件/wakeToken nonce，服务端代写 sessions）`render.ts`（人可读输出+snapshot 落盘）+ `*.test.ts` | 工具面 | M1+M2 | 构建 `dist/mcp/server.mjs`；7 工具 schema 校验单测（含未注册连接拒绝） |
| **M4 hooks-and-face** | `plugin/src/hooks/` + `plugin/skills/` + `plugin/commands/` | `src/hooks/session-start.ts`（写/刷新 sessions+注入身份）`prompt-submit.ts`（**刷新 lastSeen**+未读注入）`stop.ts`（**v1=V3 探针**，确认续跑键名前输出空）`shared.ts`（状态根解析+输出 JSON 组装，复用 M1 读邮箱——只 import M1）+ `skills/crosschat/SKILL.md` + `commands/{xc-dispatch,xc-status,xc-inbox,xc-work}.md`；`hooks/hooks.json` 按 §8.2-F 原样落盘 | 身份锚定/lastSeen 刷新/收件箱注入；协议与命令文案 | M1（仅读路径） | 构建出 dist/hooks/*.mjs；输出 JSON 严格符合 diagnosing-hooks schema（多余键即失效） |
| **M5 verify-demo** | `demo/` + `evidence/` | `demo/appserver-client.mjs`（行分隔 JSON 协议客户端+回调应答，自包含不 import 插件源码）`bootstrap-and-run.mjs`（§6.4 五步）`check-evidence.mjs` `check-db.mjs`（node:sqlite 只读）`runbook.md` | 验证与演示；证据收集 | 无（独立运行） | 跑通 Phase 2 生成 checklist.md |

构建入口 4 个（build.mjs 已定死）：`src/mcp/server.ts`、`src/hooks/{session-start,prompt-submit,stop}.ts`。

---

## 8. 并行实现约束与共享文件全文

### 8.1 约束规则

1. 各模块**只允许写自己目录**（§7 文件清单）；跨模块复用只许 import（M2/M3/M4 → M1；M3 → M2；M4 → M1），禁止反向与旁路。
2. 以下 6 个共享/入口文件**由本文档给定全文，实现员原样落盘、不得改结构与字段**（发现冲突回报设计员，不许自行变更）：§8.2 A-F。
3. `team.json`/消息 JSON 的字段名与状态机取值以 §2.4/§2.6 为准，M1 是唯一定义处（types.ts），其他模块只 import。
4. 版本迭代：改源码 → 递增 `plugin/.zcode-plugin/plugin.json` 的 `version` → 同步 `marketplace.json` 条目 version → build → 市场刷新 → 详情页更新。

### 8.2 共享文件全文

#### A. `plugin/.zcode-plugin/plugin.json`

```json
{
  "name": "zcode-crosschat",
  "version": "0.1.0",
  "description": "Dispatch verifiable tasks between independent ZCode sessions: file-mailbox source of truth, attempt-token state machine, hook-based identity anchoring, and headless wake-ups.",
  "description_i18n": {
    "en": "Dispatch verifiable tasks between independent ZCode sessions. File mailbox as source of truth, six-state task machine with attempt tokens, hook-based session identity, and push/pull wake-ups.",
    "zh-CN": "在独立 zcode 会话之间派发可检验任务并回传结果：文件邮箱真源、六态任务状态机与 attempt 令牌、钩子身份锚定、推送/拉取双通道唤醒。"
  },
  "author": { "name": "QiruiGo" },
  "license": "MIT",
  "skills": "skills",
  "commands": "commands",
  "hooks": "./hooks/hooks.json",
  "mcpServers": {
    "crosschat": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "ZCODE_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "ZCODE_PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "ZCODE_PLUGIN_ID": "zcode-crosschat",
        "XC_WAKE_ENABLED": "${user_config.wake_enabled}",
        "XC_ZCODE_EXE": "${user_config.zcode_exe}",
        "XC_ZCODE_CJS": "${user_config.zcode_cjs}"
      }
    }
  },
  "userConfig": {
    "wake_enabled": {
      "type": "boolean",
      "default": false,
      "title": "推送唤醒",
      "description": "派发/回传后用 zcode --resume 无头唤醒目标会话（fire-and-forget，仅属主缺席会话）。默认关闭：交互会话间的派发不自动 resume 可能正被桌面持有的目标；docs/DESIGN.md §6.4 自动演示的前置步骤会开启。引擎对非 \"true\" 值一律按关闭处理（V7）。"
    },
    "zcode_exe": {
      "type": "file",
      "default": "E:\\ZCode\\ZCode.exe",
      "title": "ZCode 可执行文件",
      "description": "推送唤醒用的 ZCode.exe 绝对路径。"
    },
    "zcode_cjs": {
      "type": "file",
      "default": "E:\\ZCode\\resources\\glm\\zcode.cjs",
      "title": "zcode.cjs CLI 入口",
      "description": "与 zcode_exe 配套的 CLI 入口脚本绝对路径。"
    }
  }
}
```

（说明：node 直接作为 MCP command 是 plugin-creator 脚手架的官方形态 scaffold-files.mjs:57-63；本机 node v24.22.1 在 PATH 实测。状态目录名 `.crosschat` 为代码常量，不设 userConfig——hooks 进程拿不到 userConfig，避免两处解析不一致。）

#### B. `marketplace.json`（仓根）

```json
{
  "name": "dev-zcode-crosschat",
  "owner": { "name": "QiruiGo" },
  "plugins": [
    {
      "name": "zcode-crosschat",
      "source": "./plugin",
      "version": "0.1.0",
      "displayName": "ZCode CrossChat",
      "displayName_i18n": { "zh-CN": "跨会话协作" },
      "description": "Dispatch verifiable tasks between independent ZCode sessions with a file mailbox and attempt tokens.",
      "description_i18n": { "zh-CN": "在独立 zcode 会话之间派发可检验任务：文件邮箱、六态状态机、回执唤醒。" },
      "category": "developer-tools"
    }
  ]
}
```

#### C. `plugin/package.json`

```json
{
  "name": "zcode-crosschat-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Source package for the zcode-crosschat plugin (plugin root = this directory).",
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.5"
  }
}
```

#### D. `plugin/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

#### E. `plugin/scripts/build.mjs`

```js
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = [
  join(root, "src/mcp/server.ts"),
  join(root, "src/hooks/session-start.ts"),
  join(root, "src/hooks/prompt-submit.ts"),
  join(root, "src/hooks/stop.ts"),
];
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  entryPoints: entries,
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
console.log("build ok -> dist/mcp/server.mjs + dist/hooks/*.mjs");
```

#### F. `plugin/hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.mjs"],
            "timeoutMs": 10000,
            "statusMessage": "crosschat: 锚定会话身份"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/prompt-submit.mjs"],
            "timeoutMs": 10000,
            "statusMessage": "crosschat: 检查收件箱"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop.mjs"],
            "timeoutMs": 10000,
            "statusMessage": "crosschat: 回合收尾检查"
          }
        ]
      }
    ]
  }
}
```

（matcher 省略=匹配全部（含 startup/resume/clear/compact 与一切工具无关事件）；`type:"process"` 免 shell、跨平台最稳——diagnosing-hooks §2 与坑位 10。**Stop 钩子 v1 定位=V3 探针**：续跑输出键名未确认前只输出空+exit 0，无收尾功能；SessionStart/UserPromptSubmit 是实功能钩子。）

---

## 9. 未确认事项与实现期验证点（如实声明）

| # | 事项 | 影响 | 验证方法 / 回退 |
|---|---|---|---|
| V1 | 插件 MCP 是否在 **app-server 建的会话**与 `--prompt` 无头会话中加载（钩子随会话机走，倾向可用但未实测） | 决定 Phase 2 走主路径还是回退 | 实测：无头会话里调 xc_status；**回退=§6.4 半自动形态（插件工具仍承担派发/认领/报告，仅传输由脚本代行）**；保底=Phase 1 桌面交互闭环 |
| V2 | `--resume` 无头回合是否触发 SessionStart(resume) 钩子 | 钩子注册路径在无头回合是否可用 | 实测看 `registry/sessions/` 是否刷新；**回退已内建：wakeToken 路径完全不依赖钩子**（§2.3-4，服务端代写 sessions 文件） |
| V3 | hook 输出 JSON 的**确切键名**：`additionalContext` 的注入效果需逐事件实测（身份链第一环，官方文档仅笼统写 "additionalContext is injected"）；Stop「请求继续」的键名未在文档给出 | SessionStart 身份注入 + worker 自动循环 | 实现期先只发 additionalContext 观测上下文是否到达模型；未确认前 Stop 钩子只输出空+exit 0（合法）=纯探针，无收尾功能 |
| V4 | CLI `plugins install` 子命令参数（本会话亲跑 --help 无子命令专属文档） | 安装自动化 | UI 流程为权威路径（plugin-creator）；CLI 语法实测摸索后补 runbook |
| V5 | CLI `--resume` 打到**活属主**会话（桌面正打开 / 常驻 app-server 持有）的并发语义（PLATFORM.md §8.2 明示跨进程互斥未验证；§4.4 的实测是属主退出后的 resume） | 唯一未验证的唤醒形态 | **v1 按约束规避而非验证**：push 仅用于属主缺席会话（§6.4 构造性保证），Phase 1 wake 默认关（§6.3）；未来若要支持桌面实时唤醒，必须先实测本项 |
| V6 | 无头会话 setModel 的 providerId 合法值（PLATFORM.md §5 提示账号 provider 不在注册表） | Phase 2 bootstrap | 运行时枚举 `state.updated` 的 `model.available[]` 再 setModel（PLATFORM.md §4.3-2 方法） |
| V7 | `${user_config.*}` 模板展开行为（含布尔→字符串形态；PLATFORM.md §8.5 明示未确认，android-emulator 仅证明语法先例存在） | wake 开关 env 到达形态 | 引擎对非 `"true"` 的任何值一律按关处理并把原始值记入 engine.jsonl；实测后在本文档补记展开规则 |
| V8 | 插件 MCP server 进程生命周期与 manifest `isolation:"workspace"` 语义（每会话一进程 vs 每工作区共享；PLATFORM.md §2.1 仅记载该字段存在、语义未解释） | 身份模型与锁规模（身份已按**连接绑定**设计，两种结果都成立；锁以 registry→team 固定顺序跨进程生效） | 实测：同工作区两会话，数 MCP 进程/连接（日志或任务管理器）；结论回填本文档 §2.3 |
| — | 本设计未运行任何插件代码（设计环节无实现物） | — | 全部运行时判据列入 §6 判收条件与 V1-V8，由实现/验证环节执行 |

**v0.2.0 回填（2026-11-09，`docs/FEASIBILITY-V0.2.md` 实测；v0.2 的实现期验证点 V12-V20 见 `docs/DESIGN-V0.2.md` §13，不在此重复编号）：**

| # | 事项 | 回填结论 | 依据 |
|---|---|---|---|
| V9 | CLI 单发派发方退出连带清杀唤醒子进程（09 报告 §4.3 现象） | **已修复并实测**：机理修正为「清杀沿活父链传播，孤儿链杀不到」（非作业对象，breakaway 探针无 ACCESS_DENIED）；v0.2 唤醒一律经立即退出的 node 跳板孤儿化（`dist/mcp/wake-helper.mjs`），E3b 端到端通过（派发方 5.7s 退出后孤儿唤醒全自动完成任务） | FEASIBILITY §1.3/§2.1（E1-E3b）、P5 |
| V10 | WMI 逃逸路径的 SYSTEM 环境坑 | WMI 子进程继承 WmiPrvSE 的 SYSTEM 环境（无用户 env，CLI 起不来）；解法=派发方落盘 `process.env` → wrapper 读回整体替换（E3c2 已验证）。v0.2 不进代码，作为 helper 路径失败时的预设计备选 | FEASIBILITY §2.2、P3 |
| V11 | 「回合完成等待器」误判 timeline 事件消息 | 完成判定收紧为：assistant ∧ finish∈{completed,stop} ∧ ≥1 个 text part（baseline 与 done 两处都过滤）；产品化于 `plugin/src/engine/provision.ts` | FEASIBILITY §4-P2 |
| — | V6（模型枚举 providerId） | 更新：枚举主路径改为 `session/create` 结果内联 `settings.model.available[].ref`（`state.updated` 不可依赖）；E4 以回合 modelId=设定值验证 setModel 生效 | FEASIBILITY §4-P1、§3.1-1 |
| — | 会话持久化时机（原「未知」） | 实测：`session/send` accept 后 ≤3s 落库，硬杀 app-server 不丢——供给完成即 kill keeper 安全 | FEASIBILITY §4-P4 |
| — | V3/V8/V5 | 维持原口径未确认；V5（resume 活属主）v0.2 全路径不依赖（成员恒 owner-absent，lead keeper 仅引导并在派发回合后退出） | DESIGN-V0.2 §13 末行 |

## 10. 与验收标准的最终对照

| 验收 | 设计保证 | 证据产出 |
|---|---|---|
| 1 派发→执行→回传闭环 | §2 通道 + §6 Phase 1（保底，pull-only）/Phase 2（主路径属主缺席 + 回退半自动） | evidence/phase1、phase2 全套 + checklist.md |
| 2 过程人可观测 | §4.3 六个观测点 | team.json/inbox JSONL/engine.jsonl/wake-*.json/snapshot.json/zcode 日志 |
| 3 状态跟踪 | §2.6 六态状态机+attempt 令牌，工具硬校验 | team.json history 时间线 + xc_status |
| 4 形态自选+独立性边界 | §3 选择全独立对等会话，理由 4 条+边界正面清单+对 03 §6.6 的回应 | 本文档 §3 |
