# IMPLEMENTATION：zcode-crosschat 插件实现说明（集成自检版）

- 写作人：集成工程师（动态工作流子代理）
- 日期：2026-11-09
- 对照设计：`docs/DESIGN.md`（2026-11-09 版，v0.1.0 底座）；**v0.2.0 增量对照 `docs/DESIGN-V0.2.md`（§7 新增）**；平台事实基线：`docs/PLATFORM.md`
- 本文档回答三件事：**每个模块落在哪些文件**、**整体自测跑了什么、结果如何**、**当前已知限制**。
- 所有结论均来自本会话实际执行的命令与输出；无法验证的条目显式标注「未确认/未执行」。
- **§1-§6 为 v0.1.0 历史记录（原样保留）；§7 为 v0.2.0 增量的模块对照与本会话自测记录。**

---

## 1. 交付总览

设计要求的 54 个文件（任务下达清单）全部在盘，另有集成环节新增/修改 4 个文件（§4）。目录形态与 DESIGN §1.2 一致：仓根即市场根（`marketplace.json`），插件根 = `plugin/`，构建产物 `dist/` 已生成且与源码同步（§3.3）。

```
D:\tools\zcode-crosschat\
├── marketplace.json                 # 市场清单（= DESIGN §8.2-B 原文）
├── docs\DESIGN.md / PLATFORM.md / IMPLEMENTATION.md（本文）
├── plugin\
│   ├── .zcode-plugin\plugin.json    # 插件清单（= DESIGN §8.2-A 原文）
│   ├── package.json / package-lock.json / tsconfig.json / .gitignore
│   ├── scripts\build.mjs            # esbuild 4 入口 → dist/
│   ├── hooks\hooks.json             # 3 个 process 型钩子（= DESIGN §8.2-F 原文）
│   ├── skills\crosschat\SKILL.md    # 协议技能
│   ├── commands\{xc-work,xc-dispatch,xc-inbox,xc-status}.md
│   ├── src\core\      (M1) 10 源文件 + 10 测试
│   ├── src\engine\    (M2) 3 源文件 + 3 测试
│   ├── src\mcp\       (M3) 5 源文件 + 4 测试（identity.test.ts 为集成补齐）
│   ├── src\hooks\     (M4) 4 源文件（shared/session-start/prompt-submit/stop）
│   └── dist\          mcp\server.mjs + hooks\{session-start,prompt-submit,stop}.mjs
└── .scratch\                        # 空目录，Phase 1 演示工作区占位
```

---

## 2. 模块-文件对照表

### M1 core-store（磁盘真源与协议；纯 Node，零引擎/MCP 依赖）

| 文件 | 职责 | DESIGN 依据 |
|---|---|---|
| `src/core/types.ts` | 协议字段唯一定义处：六态状态机 `TASK_TRANSITIONS`（含 pending→cancelled 保留边）、TeamState/Task/TeamMessage/SessionRecord/WakeNonce 类型与读侧严格校验（coerceTeamState 等） | §2.4/§2.6/§2.7-5 |
| `src/core/paths.ts` | 状态根解析（`ZCODE_PROJECT_DIR`→cwd 回退）、全部磁盘路径构建器、跨进程锁标识（进程内键 `team:<abs>:<teamId>`，Windows 文件名用 sha256 摘要 8 位规避 `:` 非法字符） | §2.2/§2.7 |
| `src/core/atomic.ts` | Windows 原子写：同目录临时文件 → rename，EPERM/EACCES/EBUSY/EEXIST/ENOTEMPTY 重试后降级直写；BOM 剥离 | §2.7-6（state.js:525-631 移植） |
| `src/core/lock.ts` | 两级锁：进程内 promise 链（withTeamLock 含 settled 清理）+ 跨进程 O_EXCL lockfile（15s 等待→`{error:"busy"}`、pid 死亡或 120s 陈旧强夺、token 防误删）；`withRegistryThenTeamLocks` 固定 registry→team 锁序 | §2.7-1/2/3 |
| `src/core/sanitize.ts` | sanitizeKey（NFC→小写→非字母数字折叠 `-`→48 字符截断+摘要；CJK 保留） | §2.2（state.js:64-99 移植） |
| `src/core/teamstate.ts` | team.json 读写（读侧严格校验、坏数据抛诊断）、建队/建任务/attempt 令牌（beginTaskAttempt）/报告硬校验纯函数（reportTransitionError） | §2.6 |
| `src/core/mailbox.ts` | JSONL 邮箱全部操作：isCurrentMail 新鲜性裁决（1:1 移植）、ack/discard/lease、回执前缀 `[CrossChat inbox receipt: …]` 的组装与解析 | §2.4/§2.8/§2.9 |
| `src/core/registry.ts` | sessions/*.json、names.json、一次性 wake nonce（TTL=WAKE_INFLIGHT_MS=15min，兼在途唤醒标记）、nonce 消费与扫描 | §2.2/§2.3-4/§2.5-3 |
| `src/core/jsonl.ts` | 容错 JSONL：解析失败行跳过+回报、半行尾先截断再追加（O_APPEND）、整行改写走原子提交 | §2.7-5（mailbox.js:29-40 移植） |
| `src/core/log.ts` | engine.jsonl 审计（尽力而为，写失败不阻断业务） | §2.2/§4.3 |
| `src/core/*.test.ts` ×10 | 覆盖：状态机非法转移拒绝、attempt 令牌、锁竞争与 busy（真实跨进程持锁者）、半行 JSONL 跳过、原子写、nonce TTL 等 | §7 M1 产出判据 |

### M2 wake-engine（推送唤醒；只依赖 M1）

| 文件 | 职责 | DESIGN 依据 |
|---|---|---|
| `src/engine/resume-cli.ts` | 无头 `--resume` spawn 封装：`ELECTRON_RUN_AS_NODE=1` + detached + unref + stdout/stderr 落 `logs/wake-<to>-<ts>.json`；同步失败抛出（调用方降级 mailbox）、异步失败经 onAsyncError 善后；userConfig 默认值兜底（XC_ZCODE_EXE/XC_ZCODE_CJS） | §2.5 wake 态 |
| `src/engine/wake.ts` | delivered 三态决策（wake\|mailbox\|duplicate；V7：非 `"true"` 一律按关）、在途 nonce 去重、唤醒 prompt 组装（回执+身份行含 sid+wakeToken+任务票 ≤4000 字符+派发场景成员守则）、attemptWake fire-and-forget 编排（锁外调用；spawn 成功 markDelivered / 失败 release+消费 nonce+降级 mailbox） | §2.5/§2.3-4/§4.2/§2.7-4 |
| `src/engine/lease.ts` | 60s 投递租约纯策略（与 15min 在途窗口两个计时不混用） | §2.5 |
| `*.test.ts` ×3 | 覆盖：prompt 截断 4000、duplicate 去重、在途 nonce 去重、失败降级 mailbox、非 `"true"` 按关（25+8+11 测试） | §7 M2 产出判据 |

### M3 mcp-server（工具面；依赖 M1+M2）

| 文件 | 职责 | DESIGN 依据 |
|---|---|---|
| `src/mcp/server.ts` | stdio MCP 入口（SDK `@modelcontextprotocol/sdk`），stdout 协议独占；连接关闭即进程退出（绑定随连接消亡） | §1.3/§2.3-2 |
| `src/mcp/protocol.ts` | 结果/错误信封：成功=[人可读行, 机器 JSON] 两块；错误=isError+单 JSON 块；`{error:"busy"}`/not_registered/stale_attempt 等结构化码 | §2.7-2/§2.8 |
| `src/mcp/tools.ts` | 7 个 `xc_*` 工具全部硬校验：未注册连接拒绝（xc_status 豁免）、to 必须在册、dependsOn 存在性、一人双线约束、stale attempt 硬拒、completed 必须 result+evidence≥1（锁外现算 sha256）、duplicate 幂等判定；变更操作一律锁内「重读→校验→变更→写盘」，唤醒一律锁外 | §2.6/§2.7-4/§2.8 |
| `src/mcp/identity.ts` | 连接绑定身份表（stdio 一进程一连接，Map 为 HTTP 预留）；xc_register 双路径：hook 锚定（sessions 文件在场，lastSeen 超 10min 仅告警）与 wakeToken nonce（服务端代写 sessions 文件+消费 nonce）；锁序 registry→team、join 失败回滚绑名 | §2.3/§2.7-3 |
| `src/mcp/render.ts` | 人可读一行摘要（dsh render 思路）+ xc_status 快照落盘 snapshot.json（原子写） | §2.8/§4.3 |
| `protocol.test.ts` / `render.test.ts` / `tools.test.ts` | schema 校验、未注册拒绝、全链路闭环（register→dispatch→duplicate→inbox→claim→stale 拒→缺证据拒→in_progress→completed→回执 sha256→快照落盘）、依赖未满足/双线认领/自派发硬拒 | §7 M3 产出判据 |
| `identity.test.ts` | **集成环节补写**（原交付缺失，见 §4-F3）：hook 路径成功/缺文件拒绝/陈旧告警、name_taken/session_already_bound、wakeToken 绑定+代写+一次性、连接键缺省 | §7 M3 清单 |

### M4 hooks-and-face（身份锚定/拉取注入/协议文案；只 import M1）

| 文件 | 职责 | DESIGN 依据 |
|---|---|---|
| `src/hooks/shared.ts` | 钩子公共件：stdin 载荷解析（容忍空 stdin）、上下文解析（env 优先：`CLAUDE_SESSION_ID`/`ZCODE_PROJECT_DIR`，stdin/cwd 兜底）、严格单键输出 `{"additionalContext": …}`、钩子内注册锁预算 2s（<10s 超时）、失败只审计不阻断（永远 exit 0） | §2.3-1/§7 M4/钩子契约 |
| `src/hooks/session-start.ts` | SessionStart：写/刷新 sessions/<sid>.json + 注入身份上下文（sid、花名状态、工具面提示） | §2.3-1 |
| `src/hooks/prompt-submit.ts` | UserPromptSubmit：每轮刷新 lastSeen + 已注册会话的未读数注入（只读，ack 仍归 xc_check_inbox） | §2.3-1/§2.1 pull 路径 |
| `src/hooks/stop.ts` | Stop：v1=V3 纯探针——stdout 零输出 + exit 0 + engine.jsonl 探针行（续跑键名未确认前无收尾功能） | §8.2-F 注/§9 V3 |
| `skills/crosschat/SKILL.md` | 协议技能全文：身份注册、7 工具表、派发纪律（必须验收标准、不 busy-poll）、执行纪律（attemptId 凭证、claim 失败不重试、stale 停手）、等待纪律（busy 重试一次）、独立性边界 | §4.2 |
| `commands/xc-{work,dispatch,inbox,status}.md` | 4 个斜杠命令：frontmatter `description`/`argument-hint`/`skills: crosschat` + 正文 `$ARGUMENTS` | §4.2 |
| `hooks/hooks.json` | 3 事件 process 型钩子（= DESIGN §8.2-F 原文） | §1.3 |

### 构建与清单（共享面）

| 文件 | 说明 |
|---|---|
| `plugin.json` / `marketplace.json` / `tsconfig.json` / `scripts/build.mjs` / `hooks/hooks.json` | 与 DESIGN §8.2-A/B/D/E/F 逐字段一致（本会话逐一比对） |
| `package.json` | 与 §8.2-C 一致，**外加一行 `zod` 依赖**（集成修复 F1，见 §4） |
| `dist/`（4 个 .mjs） | esbuild 产物，与当前源码同步（§3.3）；`.gitignore` 忽略 dist/（DESIGN §1.2 允许不入 git，安装前必须在场——当前已在盘） |

### 模块依赖方向（实测 grep 全量 import 语句）

- M2 → 仅 `../core/*`（M1）+ 自目录 ✅
- M3 → `../core/*`（M1）+ `../engine/wake`（M2）+ 自目录 + SDK/zod ✅
- M4 → 仅 `../core/*`（M1）+ 自目录，无 engine/mcp ✅

与 DESIGN §8.1-1 的依赖约束完全一致，无反向、无旁路。

---

## 3. 整体自测（本会话实跑，含命令与结果）

### 3.1 类型与单测

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **通过**（零错误输出；修复后复跑仍通过） |
| `npm test`（vitest run） | 修复前 **16 文件 / 159 测试全绿**；补 identity.test.ts 后 **17 文件 / 167 测试全绿**（含真实跨进程锁竞争用例） |

### 3.2 构建与产物加载

| 命令 | 结果 |
|---|---|
| `npm run build` | 4 入口全部产出：`dist/mcp/server.mjs` 1.4mb、`dist/hooks/prompt-submit.mjs` 21.9kb、`session-start.mjs` 16.7kb、`stop.mjs` 4.3kb |
| dist 新鲜度 | 先备份旧 dist → 重建 → `diff` 逐文件比对：**4/4 字节一致**（盘上 dist 与源码同步） |
| `node --check` ×4 dist 文件 | 语法全部通过 |

### 3.3 MCP server 真实 stdio 冒测（驱动脚本 + 临时工作区，测毕即删）

以 JSON-RPC 逐行协议直连 `dist/mcp/server.mjs`，**11/11 项通过**：

1. `initialize` 握手返回 `serverInfo.name="zcode-crosschat"`；
2. `tools/list` 恰好暴露 7 个 `xc_*` 工具；
3. 未注册连接调 `xc_dispatch` → `{"error":"not_registered"}`（§2.8 身份门槛）；
4. `xc_status` 免注册可调（快照 phase=none）；
5. 调用后磁盘出现 `<ws>/.crosschat/teams/default/snapshot.json` 与 `logs/engine.jsonl`；
6. 无钩子锚定时 `xc_register` → `{"error":"session_not_anchored"}`（提示走 wakeToken）；
7. 手工落一个 wake nonce 后 `xc_register(wakeToken)` → 绑定成功 `sessionKey=xc:default:a`；
8. wakeToken 路径由**服务端代写** `registry/sessions/<sid>.json`（§2.3-4）；
9. 派发给未注册成员 → `{"error":"not_a_member"}`；
10. team.json 自动建队，首个注册者成为 founder；
11. 修复（F1/F2）后复测握手 + tools/list + xc_status **3/3 通过**。

### 3.4 钩子真实进程冒测（临时工作区，测毕即删）

| 钩子 | 输入 | 结果 |
|---|---|---|
| session-start | `CLAUDE_SESSION_ID=sess_hook1` + stdin JSON | stdout **恰好一个键** `{"additionalContext": …}`（含 sid、注册指引、状态根路径），exit 0；`registry/sessions/sess_hook1.json` 落盘 |
| prompt-submit | 已绑名 + 邮箱 1 条未读 | 注入「你（a）有 1 条未读协作消息，来自 b」，exit 0；未注册时保持静默 |
| prompt-submit（lastSeen） | 同会话二次运行 | `sessions/sess_hook1.json` 的 lastSeen 被刷新（> startedAt） |
| prompt-submit（容错） | 邮箱尾行注入半行 JSON | 半行被**跳过**并在 engine.jsonl 记 `{"event":"malformed-line",…,"lineNo":2,"error":"invalid JSON"}`；剩余 2 条正常消息计数正确（§2.7-5 契约实测成立） |
| stop | 任意输入 | stdout **0 字节**、stderr 0 字节、exit 0（V3 探针契约），engine.jsonl 记探针行 |

### 3.5 插件清单校验与安装基线

| 命令 | 结果 |
|---|---|
| `ELECTRON_RUN_AS_NODE=1 /e/ZCode/ZCode.exe /e/ZCode/resources/glm/zcode.cjs plugins validate "D:\tools\zcode-crosschat\plugin"` | **`Plugin manifest is valid`，exit 0** |
| `… plugins list` | 当前已装 18 个官方插件，zcode-crosschat **尚未安装**（本插件未启用状态，属预期基线） |
| `… plugins marketplace --help` | 仅打印通用 help（无子命令专属参数），证实 DESIGN §9-V4 仍开放 |

### 3.6 未执行项（如实声明）

- **实际安装与启用**：未执行——UI 安装是面向用户的桌面操作（plugin-creator SKILL.md:44 权威流程），留待用户按 §5 步骤执行；
- **两会话闭环演示（DESIGN §6 Phase 1/2）**：未执行——Phase 2 依赖的 `demo/` 脚本未交付（§6 已知限制 L1），Phase 1 需要真实桌面双会话，属验证环节职责；
- **git 提交/推送**：未执行（不在本任务范围；当前仓库仅 README/LICENSE 有提交，其余全部为未跟踪文件）。

---

## 4. 集成修复记录（本环节改动，共 3 项 + 1 份文档）

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| F1 | `plugin/package.json`（+`package-lock.json` 同步） | **清单缺项**：`src/mcp/tools.ts:26` 与 `src/mcp/tools.test.ts:15` 直接 `import "zod"`，但 dependencies 只声明了 MCP SDK——当前仅靠 SDK 的传递依赖提升（hoisting）才能解析，属幻影依赖 | dependencies 增加 `"zod": "^3.25 || ^4.0"`（与 SDK 声明范围一致），`npm install` 同步 lockfile。注：DESIGN §8.1-2 要求共享文件原样落盘、冲突回报设计员；此处按本任务「清单缺项直接修复」授权做**最小附加改动**（未动任何既有字段），并在此披露供设计员追认 |
| F2 | `plugin/src/mcp/tools.ts`（xc_report 注释，约 :538） | 注释与 M1 行为矛盾：声称「M1 applyReport 在终态消费 attempt 令牌（task.attemptId → null）」，而 `teamstate.ts:225-230` 明确「attemptId is NOT cleared on terminal (dsh parity)」 | 注释改写为与 M1 实际行为一致（终态保留 attemptId；回执不带 sourceAttemptId 的理由改为「新鲜性只由任务终态承担，语义更简单」）；**行为零改动** |
| F3 | `plugin/src/mcp/identity.test.ts`（**新增**） | **漏文件**：DESIGN §7 M3 文件清单要求 identity.ts 配 `*.test.ts`，交付缺失 | 补写 8 个测试：hook 路径成功/缺文件拒绝/陈旧仅告警、name_taken/session_already_bound、wakeToken 绑定+代写+一次性消费、连接键缺省与未注册拒绝；全部通过（3.1） |
| F4 | `docs/IMPLEMENTATION.md`（本文，新增） | 任务要求的实现说明 | — |

---

## 5. 安装启用步骤推演（结合实测证据）

以下步骤每一步都标注了本会话已验证的证据或剩余风险：

1. **构建**（✅ 已代跑）：`cd D:\tools\zcode-crosschat\plugin && npm install && npm run build`——npm install 含 zod 声明后重跑通过；dist 四产物在盘且与源码字节一致（§3.2）。
2. **校验**（✅ 已代跑）：`zcode plugins validate "D:\tools\zcode-crosschat\plugin"` → `Plugin manifest is valid`（§3.5）。
3. **UI 安装**（⏳ 用户执行）：桌面 **插件市场 → 添加 → 添加插件市场**，粘贴目录 `D:\tools\zcode-crosschat`（市场根，`marketplace.json` 已在其下，条目 source="./plugin"）→ **个人 → 安装 zcode-crosschat → 启用**。流程依据 plugin-creator SKILL.md:44（「Plugin Marketplace → Add → Add Plugin Marketplace, paste that directory… Personal → market name → plugin → Install」）。
   - 装通判据：`zcode plugins list` 输出含 `zcode-crosschat` 且 `skills: 1, commands: 4, hooks: 3, mcp: plugin:zcode-crosschat:crosschat` 计数非零。
   - 风险点：CLI `plugins install` 语法未文档化（V4，§3.5 实测仍无子命令专属 help）——**UI 是权威路径**。
4. **安装后注意**：宿主把插件物化进缓存（`cache/<marketplace>/zcode-crosschat/0.1.0/`），**每次改源码必须先 `npm run build` 并递增 `plugin.json`/`marketplace.json` 两处 version，再走市场刷新+更新**，否则装的是旧 dist（DESIGN §1.2/§8.1-4）。
5. **启用后首次会话**：SessionStart 钩子应注入「本会话 sessionId：…」（冒测已验证输出形态，§3.4）；`/xc-work a` 注册 → `xc_status` 免注册可见花名册。
6. **推送唤醒开关**（Phase 2 前才开）：插件设置里把 `wake_enabled` 设为 true（默认 false）。V7 风险已被引擎侧消化：`${user_config.*}` 展开成什么值都行，非 `"true"` 一律按关并把原始值记入 engine.jsonl（wake.ts isWakeEnabled + decideDelivery，单测覆盖）。
7. **两会话闭环**：按 DESIGN §6.3 Phase 1（pull-only，无需开 wake）即可完成验收闭环；Phase 2 自动闭环当前被 L1 阻塞（见下）。

---

## 6. 已知限制与未确认事项（如实声明）

**结构性缺口**

- **L1：M5 verify-demo 未交付**。DESIGN §1.2/§7 的 `demo/`（appserver-client.mjs、bootstrap-and-run.mjs、check-evidence.mjs、check-db.mjs、runbook.md）与 `evidence/` 目录不在 54 文件交付清单内，亦不在盘。影响：**Phase 2 自动闭环（§6.4）暂无法执行**；Phase 1 交互闭环与插件全部功能不受影响。属整模块级缺口，集成环节不硬造（避免无 app-server 实测条件下虚构验证脚本），留待验证环节或后续任务补齐。
- **L2：插件尚未真实安装/启用**（§3.6），「装通判据」与两会话闭环证据（验收 1-3 的实证）尚未产出。

**有意偏差（已审计，非缺陷）**

- `xc_dispatch` 消息不带收件人 attemptId 快照（DESIGN §2.4 示例含该字段）：收件人对**新任务**尚无 attempt；若快照其对**其他任务**的开放 attempt，该派发消息会在对方完成任务时被 isCurrentMail 误判过期而丢弃。现状=派发消息永远新鲜、由任务状态（claim 后 task_not_pending）与 readAt 承担时效，tools.ts 内有注释说明。
- `wake.ts` 自带 `findDuplicateMail` 与 `tools.ts` xc_dispatch 的内联 duplicate 判定是**两份同语义实现**（派发场景幂等键不含 taskId——新 taskId 不可预知），文件头已互相注明，供单测与复用。

**沿袭 DESIGN §9 的开放验证点**（本环节无新证据）：V1（无头/CLI 会话内 MCP 可用性，Phase 2 硬前置）、V2（--resume 是否触发 SessionStart 钩子；wakeToken 路径已内建兜底且冒测通过）、V3（Stop 续跑键名；现按探针实现）、V4（CLI 安装语法；§3.5 实测仍开放）、V5（活属主会话跨进程 resume；默认 wake 关闭+属主缺席约束规避）、V6（无头 setModel 合法 providerId）、V7（userConfig 展开形态；引擎对非 "true" 一律按关）、V8（MCP 进程生命周期；身份已按连接绑定设计，两种结果都成立）。

**残余风险（设计已声明，集成复述）**：身份是协作假设而非密码学校验（模型可谎报 sid）；三重交叉（hook 落盘文件 + wake nonce + 新鲜度告警）是 v1 的全部校验面。锁内纪律/原子写/JSONL 容错已有单测与冒测背书，但「多进程高并发同写一个状态根」只有单测级双进程用例，无长时间并发压测。

---

## 7. v0.2.0 增量实现与全量自测（2026-11-09 集成环节实跑）

对照设计：`docs/DESIGN-V0.2.md`（模块划分 §9.1 文件所有权表 / §9.2 接口签名 / §10 共享文件全文）。本节全部结论来自集成会话实际执行的命令与输出；v0.2 六模块（W1-W6）由并行实现交付，集成环节做结构核对、小修与全量自测。

### 7.1 交付总览与结构核对

相对 v0.1.0（git HEAD `b79869a`），工作区共 45 处变更（`git status --short` 计数）：插件侧 **18 个改动文件 + 19 个新文件**，另含 3 份新文档（DESIGN-V0.2 / FEASIBILITY-V0.2 / GAP-V0.2）、README、本文件。逐条核对 §9.1 文件所有权表：**W1-W6 全部文件在盘、归属与设计一致，无缺件**：

| 模块 | 文件（★新 / ▲改） | 集成核对要点（实测） |
|---|---|---|
| **W1 spawn-escape** | `src/engine/wake-helper.ts` ★、`src/engine/resume-cli.ts` ▲、`scripts/build.mjs` ▲ | `spawnResume` 默认 `mode="helper"`（resume-cli.ts:144），经 `resolveWakeHelperPath()` 解析 `dist/mcp/wake-helper.mjs`（:64），新增 `onHelperSpawned?` 回调（:117），导出签名不变；build.mjs 用 `{in,out}` 入口保证产物落在 `dist/mcp/wake-helper.mjs`（见 §7.4 有意偏差）；resume-cli 实测端到端用例（真实 spawn → fixture helper → 孤儿孙进程落 marker）通过 |
| **W2 member-engine** | `src/engine/appserver.ts` ★（AppServerKeeper 类）、`src/engine/provision.ts` ★（provisionMember + pickModel + buildWelcomePrompt）、`src/mcp/member-tools.ts` ★（registerMemberTools）、`src/core/types.ts` ▲ | `provisionMember(deps, spec): Promise<ProvisionResult>` 与 §9.2 签名一致；member-tools 导入 `revokeAttempt`（graph）、`attemptWake`（wake）、名额/lead 纯函数（maxMembersFromEnv/countActiveMembers/resolveReprovision）均有单测 |
| **W3 task-flow** | `src/mcp/task-edges.ts` ★（withTaskEdges）、`src/core/snapshot.ts` ★（refreshSnapshot，只 import M1）、`src/core/graph.ts` ★（downstreamReady/collectDependencyOutputs 2000/12000 预算/revokeAttempt/staleTasks/findTaskRecipient）、`src/engine/wake.ts` ▲（MEMBER_RULES_V2 + WAKE_SCENES 含 unblock/idle/post-provision/shutdown） | `refreshSnapshot(stateRoot, teamId=DEFAULT_TEAM_ID)` 签名符合 §9.2；graph.ts:85 `DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000` 与设计预算一致；wake.ts:201 `MEMBER_RULES_V2` 在盘且 `WAKE_RULES_SCENES = ["dispatch","post-provision"]`（:251） |
| **W4 lead-face** | `src/mcp/lead-tools.ts` ★（registerLeadTools：xc_team_init/xc_idle/xc_cancel）、`src/hooks/stop.ts` ▲（回合收尾 `refreshSnapshot`，best-effort 恒 exit 0，stop.test.ts ★）、`src/mcp/render.ts` ▲（renderPanorama 全景 + PanoramaExtras 门控，旧快照回落 v0.1.0 渲染）、`skills/crosschat/SKILL.md` ▲（v2：lead 协议章/成员守则 v2 章/消息安全章）、`commands/xc-team.md` ★ + `xc-member.md` ★ | stop.ts:49 `await refreshSnapshot(ctx.stateRoot)`；SKILL.md 宣告 13 个 `xc_*` 工具（与 §7.3 冒测实测数一致）；两条新斜杠命令 frontmatter 完整（description/argument-hint/skills） |
| **W5 security** | `src/core/policy.ts` ★（InboundMode accept/hold/refuse + `.held.jsonl` + accept/discard）、`src/mcp/guards.ts` ★（withGuards + registerSecurityTools + FRAME_TYPES 转出口）、`src/core/mailbox.ts` ▲（FRAME_TYPES 读侧白名单 + frame-rejected 审计，mailbox.ts:49）、`src/mcp/identity.ts` ▲（removed 成员注册硬拒，identity.ts:152-159） | `FRAME_TYPES` 六值在 mailbox.ts:49 定义、guards.ts:45 转出口（§9.2 契约）；`withGuards(core, deps): ToolCore`、`registerSecurityTools(server, deps)` 签名符合 §9.2 |
| **W6 integration** | `src/mcp/server.ts` ▲（= §10.3 全文：composeCore 组装链 base → withTaskEdges → withGuards，四个 register* 全部挂载，SERVER_VERSION="0.2.0"）、`src/mcp/tools.ts` ▲（仅 §10.4 唯一缝隙：`registerTools(server, deps, coreOverride?)`，tools.ts:764-765）、`plugin/.zcode-plugin/plugin.json` ▲（= §10.1 全文，version 0.2.0 + 10 项 userConfig） | server.ts 与设计逐行一致；tools.ts 其余部分未动（git diff 仅缝隙行）；hooks.json 三个钩子原样（§10.5 不变项核实） |

依赖方向复核（grep 全量 import）：W2/W3/W4/W5 均只按设计方向 import（member-tools→graph/wake、lead-tools→wake、task-edges→snapshot/wake、guards→policy/mailbox、snapshot 只依赖 M1），**无反向、无环**。

### 7.2 全量自测记录（本会话实跑，命令与结果）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm run typecheck`（tsc --noEmit，strict） | **通过**，零错误 |
| 2 | `npm run build`（node scripts/build.mjs） | **通过**：5 入口全部产出——`dist/mcp/server.mjs` 1.5mb、`dist/mcp/wake-helper.mjs` 1.3kb（新）、`dist/hooks/{session-start,prompt-submit,stop}.mjs`，exit 0；产物路径与 W1 `resolveWakeHelperPath` 解析路径一致 |
| 3 | `npm test`（vitest run，全量） | **24 文件 / 294 测试全绿，0 失败**（v0.1.0 基线 167 例全部保留通过 + v0.2 新增用例；含真实跨进程锁竞争、真实 spawn 端到端 helper 链、535ms/1.3s/2.0s 级真实 IO 用例）。分文件计数：wake 36、types 24、mailbox 22、graph 21、resume-cli 18、teamstate 15、render 14、member-tools 14、guards 12、lock 11、jsonl 11、lease 11、identity 11、task-edges 11、registry 10、snapshot 9、protocol 9、policy 6、stop 6、sanitize 7、tools 5、paths 4、atomic 4、log 3 |
| 4 | `ELECTRON_RUN_AS_NODE=1 /e/ZCode/ZCode.exe /e/ZCode/resources/glm/zcode.cjs plugins validate "D:\tools\zcode-crosschat\plugin"` | **`Plugin manifest is valid`，exit 0**（版本改动后复跑仍通过） |
| 5 | dist stdio 冒测（临时驱动脚本经 `$TEMP`，测毕即删；临时工作区 cwd） | `initialize` → `serverInfo {"name":"zcode-crosschat","version":"0.2.0"}`；`tools/list` 恰好 **13 个工具**：`xc_cancel, xc_check_inbox, xc_claim, xc_dispatch, xc_idle, xc_inbound_review, xc_member_add, xc_member_stop, xc_message, xc_register, xc_report, xc_status, xc_team_init`——7 个 v0.1.0 工具 + W2 两个 + W4 三个 + W5 一个，与 SKILL.md「13 个 xc_* 工具」宣告一致 |

### 7.3 v0.2.0 版本递增（三处一致）

| 文件 | 版本 | 依据 |
|---|---|---|
| `plugin/.zcode-plugin/plugin.json:3` | 0.2.0 | W6 交付已带；grep 实证 |
| `marketplace.json:8` | 0.2.0 | 集成修复 I1（原 0.1.0） |
| `plugin/package.json:3` | 0.2.0 | 集成修复 I2（原 0.1.0，与上述两处保持一致） |

### 7.4 集成环节修复记录（小修，均为最小改动）

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| I1 | `marketplace.json` | 任务要求 version → 0.2.0，W6 只改了 plugin.json，市场清单仍 0.1.0 | version 0.1.0 → 0.2.0（仅此一字段） |
| I2 | `plugin/package.json` | npm 包版本仍 0.1.0，与插件清单两处 0.2.0 不一致（§5-4 要求「递增 version 再走市场更新」，npm 包版本漂移会误导） | version 0.1.0 → 0.2.0 |
| I3 | `README.md:181` | 验证基线一句残留 v0.2 实现中途口径「19 文件 / 221 例」，与全量实测不符 | 更正为「24 文件 / 294 例」（本节 §7.2-3 实测数） |

**有意偏差（已核对，非缺陷）**：`scripts/build.mjs` 未逐字照抄 §10.2——设计稿的普通 entries 数组会让 esbuild 以公共祖先 `src/` 为 outbase，wake-helper 被输出到 `dist/engine/`，与 §4.2 `resolveWakeHelperPath` 解析的 `dist/mcp/wake-helper.mjs` 不符；实现改为 `{in, out}` 显式入口（build.mjs:13-19 有注释说明），产物布局与 v0.1.0 兼容。build 实测（§7.2-2）产物路径正确。

### 7.5 v0.2.0 未执行项（如实声明）

- **硬验收 1-5 的端到端演示**（DESIGN-V0.2 §8）：未执行——属验证环节职责，且验收 1/2/3 需要真实多会话 + `wake_enabled` + 本机 `zcode_exe`/`zcode_cjs` 配置；本环节自测覆盖构建/单测/清单校验/stdio 工具面冒测（§7.2），不含真实建员（`xc_member_add` 走 app-server 全链路）与真实唤醒回合。
- **实际安装/启用**：未执行（同 §3.6 口径）。
- **git 提交**：未执行（不在任务范围）。
- **V12-V20 实现期验证点**（DESIGN-V0.2 §13）：FEASIBILITY-V0.2 已实测 P1-P5 与 E1-E3c2 并回填 DESIGN.md §9 / PLATFORM.md §9，其余标注「未确认」者（如 V13/V15/V20）维持原状，本环节无新证据。

> **交付环节状态更新（2026-11-09，v0.2.0 交付工程师）**：上列前三项在集成环节之后已完成——① 硬验收 1-5 已由验收环节执行并全部通过（报告：`deepseek-crosschat/reports/10-v020验收.md`，判定 passed=true；验收中修复 provision.ts 供给回调注册缺陷并全量复测，§2.3）；② 插件已实际安装启用（`zcode-crosschat@dev-zcode-crosschat 0.2.0 [enabled]`，报告 §2.1）；③ git 提交由交付环节执行。V13/V20 于验收闭合，V15 及 E-e/E-b 端到端构造仍未做（不作已验证宣称），现状见 README「已知限制」。
