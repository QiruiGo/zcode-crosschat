# IMPLEMENTATION：zcode-crosschat 插件实现说明（集成自检版）

- 写作人：集成工程师（动态工作流子代理）
- 日期：2026-11-09
- 对照设计：`docs/DESIGN.md`（2026-11-09 版，v0.1.0 底座）；**v0.2.0 增量对照 `docs/DESIGN-V0.2.md`（§7 新增）**；**v0.3.0 增量对照 `docs/DESIGN-V0.3.md`（§8-§9 新增）**；平台事实基线：`docs/PLATFORM.md`
- 本文档回答三件事：**每个模块落在哪些文件**、**整体自测跑了什么、结果如何**、**当前已知限制**。
- 所有结论均来自本会话实际执行的命令与输出；无法验证的条目显式标注「未确认/未执行」。
- **§1-§6 为 v0.1.0 历史记录（原样保留）；§7 为 v0.2.0 增量的模块对照与本会话自测记录；§8 为 v0.3.0 增量的模块对照（W3 寻址 + W7 组装/面/文档环节）；§9 为 v0.3.0 集成环节的结构核对、修复记录与全量自测；§10 为 v0.5.0 集成环节记录（lead 元数据化 ｜ 用户亲述溯源 ｜ 防卡死注入预算，对照 `docs/DESIGN-V0.5.md`）。**

---

## 1. 交付总览

设计要求的 54 个文件（任务下达清单）全部在盘，另有集成环节新增/修改 4 个文件（§4）。目录形态与 DESIGN §1.2 一致：仓根即市场根（`marketplace.json`），插件根 = `plugin/`，构建产物 `dist/` 已生成且与源码同步（§3.3）。

```
<仓库路径>\
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
| `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "<仓库路径>/plugin"` | **`Plugin manifest is valid`，exit 0** |
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

1. **构建**（✅ 已代跑）：`cd <仓库路径>/plugin && npm install && npm run build`——npm install 含 zod 声明后重跑通过；dist 四产物在盘且与源码字节一致（§3.2）。
2. **校验**（✅ 已代跑）：`zcode plugins validate "<仓库路径>/plugin"` → `Plugin manifest is valid`（§3.5）。
3. **UI 安装**（⏳ 用户执行）：桌面 **插件市场 → 添加 → 添加插件市场**，粘贴目录 `<仓库路径>`（市场根，`marketplace.json` 已在其下，条目 source="./plugin"）→ **个人 → 安装 zcode-crosschat → 启用**。流程依据 plugin-creator SKILL.md:44（「Plugin Marketplace → Add → Add Plugin Marketplace, paste that directory… Personal → market name → plugin → Install」）。
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
| 4 | `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "<仓库路径>/plugin"` | **`Plugin manifest is valid`，exit 0**（版本改动后复跑仍通过） |
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

---

## 8. v0.3.0 增量实现：跨会话 peer 轴（2026-11-09，W3 寻址 + W7 组装/面/文档）

设计见 `docs/DESIGN-V0.3.md`（模块划分与所有权表见 §10），规格见 `docs/SPEC-V0.3.md`（R-7..R-12 为寻址面规则）。v0.3 在队内协作之外**新增一条独立通道**：跨会话 peer（名字即地址 + 机器全局注册表 + 命名管道 + 入站三态）。队内 13 工具与其状态根**零改动**。

### 8.1 模块-文件对照（W1..W7，全部文件所有权不重叠）

| 模块 | 文件 | 本环节负责 | 说明 |
|---|---|---|---|
| W1 peer-registry | `plugin/src/core/peerdir.ts`、`peerregistry.ts`、`peerregistry.test.ts` | W1 | 机器全局 peer 根解析、记录 schema/扫描/活性/清扫/名字占用/formerNames |
| W2 transport | `plugin/src/transport/frames.ts`、`pipe.ts`（+ 两个 test） | W2 | 四帧白名单、命名管道 + 文件退化、token 鉴权、七类发送错误 |
| **W3 addressing** | **`plugin/src/core/peeraddr.ts`**、**`peeraddr.test.ts`** | **W3（本环节）** | 名正则/控制符剥离/保留名、路由 id 编码、行格式、`[ref]` 构造与解析、formerNames 别名回退、歧义分类（唯一命中 / `ambiguous`+候选 / `not-found`） |
| W4 inbound-gate | `plugin/src/core/peerpolicy.ts`（+ test） | W4 | 显式三层最严胜、mode-parity 自动档、hold 缓冲与释放、终态 |
| W5 msg-core | `plugin/src/core/peermsg.ts`、`peerenvelope.ts`（+ test） | W5 | inbox/queue/held 三区 IO、排空、入队闸四闸、信封渲染与归因尾注 |
| W6 peer-face | `plugin/src/mcp/peer-tools.ts`、`peer-drain.ts`（+ test） | W6 | 7 个 peer 工具注册、`withPeerDrain` 末尾追加 `content[2]` |
| **W7 integration** | **`plugin/src/mcp/server.ts`**、**`plugin/src/hooks/{session-start,prompt-submit,shared}.ts`**、**`plugin/skills/crosschat/SKILL.md`**、**`plugin/commands/xc-agents.md`**、**`plugin/.zcode-plugin/plugin.json`**、**`demo/peer-duo.mjs`**、**`README.md`**、**`docs/IMPLEMENTATION.md`** | **W7（本环节）** | 组装链 + peer 工具注册 + EOF 退出纪律、钩子 peer 基记录与信封注入、`/xc-agents` 面板、清单 v0.3.0、双会话演示驱动器、文档 |

### 8.2 W3 寻址面的自测（本环节实跑）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd plugin && npx vitest run src/core/peeraddr.test.ts` | **1 文件 / 33 例全绿**（`Test Files 1 passed (1)`、`Tests 33 passed (33)`）。覆盖 DESIGN-V0.3 §9.2 的单测矩阵：唯一命中 / 0 命中 / 2 命中（含别名持有者）/ `[ref]` 精确命中（同名被占用时仍命中）/ ref 非法按 `not-found` / 别名失效 / 保留名拒绝 / 正则拒绝 / 别名不参与「当前名占用」；另含控制符剥离、路由 id 编码、formerNames 32 条 FIFO、行文本 `[ref]` 仅在歧义时追加、保留名 `main` 不可寻址、无 sessionId 的行（工具面行型）仍可解析 |
| 2 | `node --check demo/peer-duo.mjs` | 无语法错误；缺参数时按约定 exit 2 并打印缺哪个参数 |
| 3 | `cd plugin && npm run typecheck` | **exit 0，零报错**（W1/W2/W4/W5/W6 全部落盘后复跑）；`npm run build` 五入口产物齐（`dist/mcp/server.mjs` + `dist/mcp/wake-helper.mjs` + `dist/hooks/*.mjs`）；`npm test` 全量 **34 文件 / 496 例全绿**（v0.2 基线 24 文件 / 294 例全绿 + v0.3 新增 10 文件 / 202 例）。中途出现过 2 例失败（W6 的 `src/hooks/prompt-submit.test.ts`），本环节定位为**测试侧模块缓存缺陷**并给出最小复现与修法，W6 随后在自有文件里补上 `vi.resetModules()`，复跑全绿（详见 §8.5） |
| 4 | `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "<仓库路径>/plugin"` | **`Plugin manifest is valid`，exit 0**（v0.3.0 清单落盘后复跑） |
| 5 | `node --check demo/peer-duo.mjs` + 缺参运行 | 无语法错误；缺 `--exe` 等必填参数时 exit 2 并打印缺哪个参数 |

### 8.3 W7 组装面的落点（逐条对应设计 §11）

- `src/mcp/server.ts`：组装链 `base → withTaskEdges → withGuards → withPeerDrain`；注册 peer-tools；**EOF 退出纪律**（`process.stdin` 的 `end`/`close` 都要走 `shutdown()`：摘注册表记录 + 关管道 + `exit(0)`）——依据 FEASIBILITY-V0.3 §3.3 实测：SDK 的 `StdioServerTransport` 不监听 stdin `end`，进程内持有 net server 时会留下永不退出的僵尸端点。
- `src/hooks/session-start.ts`：写机器全局 peer 基记录 `peers/base/<sessionId>.json`（档类真源）+ 注入 peer 注册指引一行。
- `src/hooks/prompt-submit.ts`：排空 `peers/queue/<sid>.jsonl` → 渲染信封 → 与队内未读提示**合并成一段文本一次 emit**（stdout 严格单键单行）。
- `src/hooks/shared.ts`：追加 `peerRootFromEnv` / `readHookPermissionMode` / `writePeerBaseRecord` / `refreshPeerBaseRecord` 四个导出（纯追加，队内逻辑零改动）。
- `plugin/.zcode-plugin/plugin.json`：版本 0.2.0 → **0.3.0**（版本号必须递增，否则宿主不重新物化），新增 env `XC_CROSSCHAT_INBOUND` / `XC_PEER_RECEIVE` / `XC_HOLD_TTL_MS` / `XC_MESSAGING_DIR` 与对应 userConfig。
- **版本号三处一致**（沿用 v0.2 §7.3 的先例）：`plugin/.zcode-plugin/plugin.json`、`marketplace.json`、`plugin/package.json` 一并 0.2.0 → **0.3.0**（市场清单与 npm 包版本若不递增，宿主侧安装的仍是 0.2.0 产物，peer 工具面根本不会出现）。
- `demo/peer-duo.mjs`：两个**不同工作区**的 app-server 会话驱动 D0–D7（前置写项目层 `inbound.json`=accept → 双会话注册 → A 发送带校验串 → B 回合读信封 → B 拉 inbox 取 tool_result 载体 → A 读回执），逐步落证据到 `--evidence-dir`（默认 `.scratch-v03/evidence/phaseA`）；**失败步骤只记录不伪造**。

### 8.4 本环节未执行项（如实声明）

- **硬验收 1-7 的端到端演示未执行**：需真实多会话 + 宿主装插件，属验收环节职责；本环节只交付驱动脚本与单测。
- **实际安装/启用未执行**：需宿主插件设置面；`plugin.json` 的清单校验随全量 typecheck 一并留给集成环节。
- **W7 文件与并行同事的接口一致性**：本环节严格按 DESIGN-V0.3 §10.2 的签名对接（W1 `peerdir`/`peerregistry`、W2 `transport`、W5 `peermsg`/`peerenvelope`、W6 `mcp/peer-tools`/`peer-drain`）；若同事最终导出的名字与签名有偏差，需在集成环节对齐（**本环节不代改他人文件**）。

### 8.5 中途发现并已闭环的问题：W6 的钩子 stdout 契约测试（模块缓存）

`plugin/src/hooks/prompt-submit.test.ts`（所有权属 W6）的第 2、3 个用例曾**在任何钩子实现下都取不到 emit**：该文件在 `beforeEach` 里 `vi.clearAllMocks()` 但当时**没有 `vi.resetModules()`**，而 ESM 模块只求值一次——第 2 个用例的 `await import("./prompt-submit.js")` 命中模块缓存，钩子的顶层 `main()` 不会再次执行，于是 `writes` 为空，`JSON.parse(undefined)` 抛 `SyntaxError: "undefined" is not valid JSON`。本环节在仓库外做了等价最小复现（临时目录里的两用例探针）：第一次 import 写 1 次、第二次 import 写 0 次，**与钩子实现无关**。

本环节用一份临时副本（加 `vi.resetModules()`，跑完即删、仓库未留副本）验证：**同样的三个断言在本环节交付的 `prompt-submit.ts` 上全绿**——stdout 恰好一行 JSON、恰好一个 `additionalContext` 键、队内未读提示与 `<crosschat-peer-message>` 信封块合并成**一次** emit、`drainPeerQueue` 被调用。W6 随后在自有文件里补上了 `vi.resetModules()`，全量复跑 **34 文件 / 496 例全绿**。本环节按所有权纪律**全程未改动 W6 的文件**。

另注：W6 的 `peer-tools.ts` 用 `import(/* @ts-ignore */ "../core/peeraddr.js")` 动态引入本模块的寻址面（`sanitizePeerName` / `peerRef` / `resolvePeerTarget`），本模块已按该调用形状对齐（`PeerRow` 的 `sessionId`/`former`/`currentName` 放宽为可选，无 sessionId 的行仍能解析与消歧）。

---

## 9. v0.3.0 集成环节记录（2026-11-09，v0.3 集成工程师）

本节是**集成与全量自测环节**的落点：对照 `docs/DESIGN-V0.3.md` §10.1/§10.2 核对结构完整与模块衔接，小问题就地修并留记录，然后跑全量自测（typecheck + 全部单测 + validate + 按 `reports/10-v020验收.md` §2.2 的物化规则刷新安装）。

### 9.1 结构核对结论（对照 DESIGN §10.1 所有权表）

- **文件齐备**：§10.1 表列的 W1–W7 全部文件在盘（`core/{peerdir,peerregistry,peeraddr,peerpolicy,peermsg,peerenvelope}.ts`、`transport/{frames,pipe}.ts`、`mcp/{peer-tools,peer-drain}.ts`、`mcp/server.ts`、`hooks/{session-start,prompt-submit,shared}.ts`、`commands/xc-agents.md`、`skills/crosschat/SKILL.md` 第 9 章、`demo/peer-duo.mjs`）。
- **§10.2 对外签名逐条对得上**：`peerRootFromEnv`/`peerSessionsDir`/`peerKeyFile`/`peerInboxFile`/`peerQueueFile`/`peerHeldDir`/`peerBaseFile`、`writePeerRecord`/`readPeerRecord`/`scanPeers`/`isPeerNameFree`/`touchPeerRecord`（W1）；`PEER_FRAME_TYPES`/`encodeFrame`/`decodeFrame`/`startPeerEndpoint`/`stopPeerEndpoint`/`sendPeerFrame`/`PeerErrorClass`（W2）；`PEER_NAME_RE`/`PEER_RESERVED_NAMES`/`sanitizePeerName`/`peerRef`/`formatPeerRow`/`resolvePeerTarget`（W3）；`decideInboundPolicy`/`readPeerInboundPolicy`/`holdPeerMessage`/`releaseHeldMessages`（W4）；`drainPeerQueue`/`appendPeerQueue`/`appendPeerInbox`/`renderPeerEnvelope`/`parsePeerEnvelope`/`renderPeerReceipt`/`admitPeerMessage`（W5）；`registerPeerTools`/`withPeerDrain`（W6）；`composeCore`/`main`（W7）——全部存在且类型检查通过。
- **队内域零改动**：`git diff --name-only HEAD -- plugin/src/core/{mailbox,policy,identity,types,paths,atomic,jsonl,log,sanitize,lock,registry,teamstate,snapshot,graph}.ts plugin/src/mcp/{tools,guards,member-tools,lead-tools,protocol,render,task-edges}.ts plugin/hooks/hooks.json plugin/scripts/build.mjs plugin/src/hooks/stop.ts` 输出**为空**——DESIGN §9.5「队内域零改动」判据成立。
- **组装链与面**：`mcp/server.ts:40-45` = `createToolCore → withTaskEdges → withGuards → withPeerDrain`；`mcp/server.ts:78-83` 自建 stdin `end`/`close` 退出纪律（FEASIBILITY-V0.3 §3.3 的硬约束）；钩子面 `hooks/prompt-submit.ts:47-102` 一次 emit 一次输出。

### 9.2 集成环节发现并修复的问题（5 处，全部为小问题，就地修复 + 补测）

| # | 问题 | 依据 | 修法 | 验证 |
|---|---|---|---|---|
| F1 | `plugin/src/core/peerdir.ts` 源码里含**一个字面 NUL 字节**（`join('\0')` 写成裸字节）→ 整文件被工具判为二进制（`file` 报 `data`、Read 拒绝、git 视作 binary） | 全仓扫描：仅此 1 个文件含 NUL | 改成转义写法 `'\u0000'`（语义等价） | 该文件回到纯文本；typecheck + 全量单测复跑仍绿 |
| F2 | `xc_peer_review --action accept` 放行后**没给发方补 `delivered` 回执**（只有 discard 分支发了 `denied`） | DESIGN §9.3「放行 → A 侧收到 delivered」/§6.3「accept → 放行 + 回执 delivered」 | `mcp/peer-tools.ts` 的 `releaseHeldMessages` 补 `onOutcome` 回调 → `sendReceipt(sender, msgId, receipt)` | 新增 `mcp/peer-tools.integration.test.ts`：真命名管道 + 真注册表，放行后发方端点收到 `status:delivered`（实测通过） |
| F3 | `xc_peers` 的**缺省口径**只返回 `session` 行 → 硬验收 2 要求的「`self(alice)` 与 `session(bob)` 同行」不成立 | DESIGN §8.1（ListAgents 等价物）+§9.2（一次调用同时见 self 与 session、在队成员行同表） | 缺省改为 **self + member + session 三类**；`kind` 显式给出时仍只看那一类 | 集成单测实测：缺省列表含 `alice:self` 与 `bob:session`；`list('session')` 只有 bob |
| F4 | `xc_peers` 的行文本是自造的 tab 分隔格式，**没用 W3 的规范行渲染器**（`formatPeerRowText`/`formatPeerRows` 实现完备但零调用方） | DESIGN §5.2 行格式 `<名字> [<kind>] [<ref>] cwd=… status=… seen=…`；§5.2「身份串只进结构化字段，不进紧凑行文本」 | `xc_peers` 摘要行改用 `formatPeerRows`；结构化 payload 不变 | 工具层单测：行文本含 `bob [session]` / `cwd=D:\ws-b` / `status=idle`，**不含**身份串，身份串仍在 payload 里 |
| F5 | `xc_agents` 面板**没给会话级查询面**（CC `H()` 的 `bypass-default`），只给了逐消息裁决口径 | DESIGN §6.2 DV-2（`H()` 与 `k()` 不是同一条件）+§8.3 返回体示例（`inboundPolicy.sessionLevelQuery`）+§14 U16（两者都要展示） | 面板加 `inboundPolicy.sessionLevelQuery`，由 W4 已有的 `decideSessionInboundPolicy` 计算；摘要行同列 | 集成单测实测：显式 accept 时 `{policy:"accept"}`；W4 侧 `decideSessionInboundPolicy` 本就有独立单测矩阵 |

另修一处文档笔误：README 的 peer 轴文件表把 `peers/inbox/<sessionId>.jsonl` 写成「已消费队列」——按 DESIGN §3.1/§7.1 它是**传输级收件箱**（管道不可达、对端缺席时的退化投递落点，由发送方写入），已改为正确描述；`peers/queue/<sessionId>.jsonl` 才是投递级队列（过闸后、模型可见）。

### 9.3 全量自测（本环节亲跑，命令与输出见证据目录）

证据根：`<证据仓>\evidence\13-v030\acceptance\phase0\`

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `cd plugin && npx tsc --noEmit` | **exit 0，零报错** | `typecheck.log` |
| 2 | `cd plugin && npx vitest run` | **35 文件 / 501 例全绿**（v0.2 基线 34 文件 / 496 例全数保留 + 本环节新增 1 文件 / 5 例），2.5s | `unit-tests.log` |
| 3 | `cd plugin && npm run build` | exit 0；5 入口产物齐：`dist/mcp/server.mjs`（1.6MB）+ `dist/mcp/wake-helper.mjs` + `dist/hooks/{session-start,prompt-submit,stop}.mjs` | 构建输出（终端） |
| 4 | `zcode.cjs plugins validate "<仓库路径>/plugin"` | **`Plugin manifest is valid`**，exit 0 | 终端输出 |
| 5 | `zcode.cjs plugins marketplace update dev-zcode-crosschat` | `Updated marketplace dev-zcode-crosschat (1 plugins)`；快照 `marketplace.json` 与 `plugin/.zcode-plugin/plugin.json` 均已是 **0.3.0**，快照 `dist/mcp/server.mjs` 与本地构建 **md5 一致**（`e6062ad3…`） | `marketplace-update.log` |
| 6 | `zcode.cjs plugins install zcode-crosschat@dev-zcode-crosschat` | **`Installed plugin zcode-crosschat@dev-zcode-crosschat (0.3.0) [enabled]`** | `install.log` |
| 7 | `zcode.cjs plugins list` | `zcode-crosschat@dev-zcode-crosschat [enabled]`，安装路径 `…/cache/dev-zcode-crosschat/zcode-crosschat/0.3.0`，skills:1 commands:1 hooks:3 mcp:plugin:zcode-crosschat:crosschat | `plugins-list-after.log` |
| 8 | 缓存物化新鲜度（md5 比对，v0.2 报告 §2.2 的 CACHE-FRESH 口径） | 缓存 `0.3.0/dist/mcp/server.mjs`、`dist/hooks/prompt-submit.mjs`、`dist/hooks/session-start.mjs` 三项 md5 与本地构建**逐项相同** | 终端输出 |
| 9 | `zcode.cjs commands list` | 宿主已识别 **`/xc-agents`**（描述取自 0.3.0 缓存路径 `…/0.3.0/commands/xc-agents.md`），7 个 `xc-*` 命令齐 | 终端输出 |
| 10 | stdio 冒测（`initialize` + `tools/list`，对着**构建产物** `dist/mcp/server.mjs`） | `serverInfo.version = "0.3.0"`；**共 20 个工具 = 13 个队内 + 7 个 peer**（`xc_agents`/`xc_peer_{register,inbox,rename,review,send}`/`xc_peers` 全在） | `stdio-tools-list.json` |

**物化规则沿用 v0.2 报告 §2.2**：市场源是快照副本 → 必须先 `marketplace update` 刷新快照 → 再 `install`（版本变化即触发物化）→ 最后 md5 比对确认缓存与新构建一致。本轮**未执行** `plugins uninstall`（v0.2 报告 §2.4 的事故：`uninstall --force` 会清空 `plugins.options`，导致 `zcode_exe`/`zcode_cjs` 丢失）。

### 9.4 版本号（三处 + 附一处顺手同步）

- `plugin/.zcode-plugin/plugin.json` = **0.3.0**、`marketplace.json` = **0.3.0**、`plugin/package.json` = **0.3.0**（版本必须递增，否则宿主不重新物化——FEASIBILITY-V0.3 §6.1 实测）。
- 附带：`plugin/package-lock.json` 的根版本字段此前仍停在 **0.1.0**（v0.2 递增时漏更），已同步为 0.3.0（`name: zcode-crosschat-plugin` 的两处 `version`），JSON 复校有效。

### 9.5 本环节未执行项（如实声明）

- **硬验收 1-7 的端到端演示未执行**（两个真实会话互发、三态对照、`/xc-agents` 面板实拍、信封呈现取证）：属验收环节职责；本环节只交付驱动脚本 `demo/peer-duo.mjs`、单测与已安装的 0.3.0 产物。
- **peer 轴的真实宿主行为仍未实测**：命名管道在真实 zcode 宿主拉起的 MCP server 进程内的绑定与共存（DESIGN §12.3 V-P7）、钩子 `additionalContext` 在 app-server 形态会话是否进入模型上下文（V-P6 / U7）、SessionStart 钩子在 app-server 形态是否触发（V-P1 / U8）——三项均未实测，不得作已验证宣称。
- **F2 的回执补发只在单测层面闭环**（假发方端点 + 真注册表 + 真管道）：真实双会话下的回执往返属硬验收 1 的取证范围，本环节未跑。

### 9.6 集成环节对并行实现的接口核对备注

W3/W7 环节的记录（§8.4）提到「若同事最终导出的名字与签名有偏差，需在集成环节对齐」。核对结果：**W3 的 `peeraddr.ts` 导出（`sanitizePeerName`/`peerRef`/`resolvePeerTarget`/`formatPeerRow(s)`）与 W6 的 `peer-tools.ts` 静态 import 形状一致，无偏差**；`PeerRow` 的 `sessionId`/`former`/`currentName` 为可选，W3 侧对齐无误。**无跨模块签名冲突需要额外对齐**。

### 9.7 硬验收环节补录（2026-11-09，v0.3 硬验收员）

§9.5 声明的三项「未实测」与端到端演示，已由硬验收环节全部执行完毕，结论如下（报告 `reports/12-v030验收.md`，证据 `evidence/12-v030/acceptance/`）：

| §9.5 的未执行项 | 实测结论 |
|---|---|
| 硬验收 1-7 端到端演示 | **七条全部通过**（peer 闭环 11/11 步、发现 6/6、三态 20/20、面板 6/6、信封 8/8、回归全过） |
| 命名管道在真实宿主拉起的 MCP server 进程内绑定与共存（V-P7） | **成立**：真实双会话下 `via:"pipe"` 投递成功，管道与 stdio 协议流共存（`phaseA/registry/peer-audit.jsonl`） |
| 钩子 `additionalContext` 在 app-server 形态会话是否进入模型上下文（V-P6 / U7） | **进入**：B 的下一回合 reasoning 里出现信封正文原文（`phaseA/turns/b-turn3.json`）。**仍未实测**它是否以独立上下文块呈现，故不宣称「不占用用户消息通道」 |
| SessionStart 钩子在 app-server 形态是否触发（V-P1 / U8） | **触发**：`phaseR/autostart/engine.jsonl` 有 4 条 `hook-session-start`（lead + 3 成员），基记录 `peers/base/<sid>.json` 由钩子写出 |

**验收期修复**（均先复现留证再修，均已补回归用例；详见报告 §6）：

1. `src/transport/pipe.ts`：注册表心跳缺失（记录 60 s 后被判 stale 清扫 ⇒ `peer_not_found`）→ 补 15 s 周期心跳 + 退出摘记录；
2. `src/mcp/peer-tools.ts`：peer 工具不走面 B 排空（工具结果里永远不出现信封块）→ `call()` 统一走 `appendPeerEnvelopes`；另修 `xc_peer_send` 寻址行集漏掉 self 行导致重名歧义检测失效；
3. `src/transport/pipe.ts`：发送方 data 处理器在「不合法帧行」上死循环（`continue` 在推进游标之前）→ 调整顺序；
4. 测试基建（非产品缺陷）：`src/engine/resume-cli.test.ts` 固定 sleep 改轮询（并发饿死）、`src/transport/pipe.test.ts` 的 `afterEach` 清理加重试（`ENOTEMPTY`）。

**版本**：v0.3 开发期 manifest 由 0.3.0 递增至 0.3.4（每次改代码都递增，否则宿主不重新物化）；发布定稿 **0.3.0**（git tag `v0.3.0`，`plugin.json` / `marketplace.json` / `SERVER_VERSION` 同步定稿，与 v0.2.0「tag 版本 = manifest 版本」的约定一致）。当前全量 **36 文件 / 509 例**，默认并发下连跑 5 次全绿。

---

## 10. v0.5.0 集成环节记录（2026-11-11，v0.5 集成工程师）

本节是 v0.5.0 **集成与全量自测环节**的落点：三轴（①lead 元数据化可指派可移交 ②用户亲述溯源 ③防卡死注入预算+分页）由并行实现交付 38 个变更路径（27 修改 + 11 新增），本环节对照 `docs/DESIGN-V0.5.md` §6.2 所有权表逐模块核对衔接、留记录，然后跑全量自测（typecheck + 全部单测 + validate）。

### 10.1 结构核对结论（对照 DESIGN-V0.5 §6.2 所有权表，本环节实读全部 diff）

- **文件齐备**：§6.2 表列 7 模块全部在盘。新增 11 文件（`docs/{DESIGN,SPEC,GAP}-V0.5.md` 3 份 + `plugin/commands/xc-say.md` + `plugin/src/core/{budget,msgstore,uservoice}.ts` 3 源 + 3 测试 + `plugin/src/mcp/lead-tools.test.ts`）；修改 27 文件与所有权表一一对应（types/frames/peermsg/peerenvelope/peerdir/mailbox/peerregistry= M1/M3/M4 契约，lead-tools/member-tools= M2，peer-tools/peer-drain= M5，tools/snapshot= M6，plugin.json= M7，命令面 xc-team.md / SKILL.md = M2）。
- **关键 hunk 逐条核对通过**：frames.ts 四处同步（接口/FRAME_FIELDS 封闭集/validateFrame msg 分支校验与拷贝/发送侧仅 user 写出——P1）；peer-tools.ts origin 传播链四处构造点（receivePeerMessage 形参/队列项构造/fallbackItem/heldItemToQueueItem——P8）+ F-3 两处 store 落点（pipe 接受 :1068 后、held 晋升 :729 后，`storeAfterEnqueue` 共用且失败只审计）；lead-tools.ts F-4 takeover 三 hunk + F-2 to===me invalid_params + P9 reason 清洗（`sanitizeLeadReason` 控制符→空格、截 500）；M1 `budget.ts` = 设计 §6.3-1 全文；M4 `uservoice.ts`/`msgstore.ts` = 设计 §6.3-8/9 全文（环形 8 条、TTL 600s、uses≤3、匹配方向 outgoing ⊂ prompt）。
- **工具面 21→26 核验**：`grep -c 'server.tool(' ` = 26 处注册，唯一名单 26 个（新增 `xc_lead_transfer`/`xc_lead_release`/`xc_peer_read`/`xc_mail_read`/`xc_task_read`）。`server.ts` 组装链/注册面**零 diff**（唯一改动 = `SERVER_VERSION` 常量，版本冻结五处之一，RELEASING §2.5）。
- **R-5 负面清单 grep 反证（A1d 同款命令）**：`grep -n "leadKey\|leadKeyOf" plugin/src/mcp/tools.ts plugin/src/mcp/guards.ts` → guards.ts **零命中**；tools.ts 命中 4 行全部在 `xc_status` 域（history schema 描述、isLead 现算、payload leadKey/leadSince）——dispatch/claim/message/guards 路径零 lead 门。
- **命令面/技能面**：`xc-team.md` 三子形态（transfer/release/takeover）+ lead_exists 三分支文案；`SKILL.md` 三处锚点（角色表 lead 行、工具表 xc_team_init 行、L1）按 §2.3 最小插入；`xc-say.md` 正反例齐。

### 10.2 集成环节记录（对照设计「不改」表的两处偏差与既有用例调整，逐条留痕）

| # | 项 | 性质 | 核实结论 |
|---|---|---|---|
| 1 | `src/mcp/guards.ts` 被 MODIFY（DESIGN §6.2 将其列「不改」） | **必要波及的最小适配**（实现方所改，本环节核实放行） | M6 把 `MessageShape.content` 改为可选（forwardOf 转发不带正文，R-13）后，inbound hold 路径 `createMessage(me.agentKey, toKey, a.content, …)` 类型不兼容；现为 `a.content ?? (a.forwardOf !== undefined ? "[forwardOf:<id>]" : "")`——hold 隔离副本带转发指针占位，accept 后收件人经 core 侧解析原文。typecheck/全测通过；除该 hunk 外 guards.ts 其余零改动。**结构性说明**：这是设计未预见 content 可选化的连带面，改动最小且方向正确，如实上报记录在案 |
| 2 | `budget.ts` 两处偏离 §6.3-1 初稿 | 带注释的等义改进 | ① `degradedCount`：摘要降级（无 item 截断且条数不减）也上报 `budgetTruncated`——对齐 CC gca `budget_truncated` 语义；② TS5.5 `spent.every()` 元素收窄的布尔中转（同语义） |
| 3 | `peer-tools.test.ts` 既有用例「7 个工具全部注册」→「8 个工具全部注册（v0.5 增 xc_peer_read）」 | 既有用例调整 1 处（A4a 要求逐条列理由） | 断言是**精确工具名单**，注册面 7→8 必然改名单；原 7 项名字与顺序全保留，仅增 `xc_peer_read` 一项。另 `tools.test.ts` 仅 import 行扩展 + 新增 9 例，零删除 |

### 10.3 全量自测（本环节亲跑，版本递增后复跑）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd plugin && npm run typecheck` | **exit 0 零报错**（banner `zcode-crosschat-plugin@0.5.0`） |
| 2 | `cd plugin && npx vitest run` | **42 文件 / 681 例全绿**（交付环节 2026-11-11 复跑复核，与验收环节口径一致）。基线核对（GAP-V0.5.md:7 记 v0.4 基线 38 文件/544 例）：对 9 个被改测试文件逐文件 `git show HEAD` 计数 = 125 例 → 现 191 例（**全数保留，仅 §10.2-3 一处更名**），4 个新测试文件 71 例（budget 27 / msgstore 11 / uservoice 18 / lead-tools 15）；544 − 125 + 191 + 71 = 681 ✓ |
| 3 | `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "<仓库路径>/plugin"` | **`Plugin manifest is valid`**，exit 0 |
| 4 | `cd plugin && npm run build`（冒测，非验收命名项） | `build ok`，5 产物齐（`dist/mcp/server.mjs` 1.6mb 等）；`xc_lead_transfer`/`xc_peer_read` 与 `inject-budget` 事件名在 server bundle、`uservoiceWrite`/`layoutInjectBlocks` 在 hooks bundle 内 grep 命中（新模块确已进 bundle） |

### 10.4 版本冻结（五处，RELEASING §2）

`plugin/.zcode-plugin/plugin.json` / `marketplace.json` / `plugin/package.json` / `plugin/package-lock.json`（根 + packages[""] 两处）/ `plugin/src/mcp/server.ts SERVER_VERSION` 全部 = **0.5.0**（sed 递增后 grep 复核：五处均 0.5.0、无 0.4.0 残留）。打包发布（RELEASING §3-§6）属发布环节，本环节未执行。

### 10.5 本环节未执行项（如实声明）

- **DESIGN §7 硬验收 A1-A5 的两会话端到端演示未执行**（移交/接管真回合、盖章链真实钩子取证、≥500KB 防卡死实测、三轴冒烟、V-4/V-6 键名实验）：属验收环节职责；本环节交付 = 结构核对 + 全量自测 + 版本冻结 + 单测层断言（盖章/转发/截断/takeover 均已有单测覆盖并全绿）。
- **`marketplace update` + `install` 物化刷新未执行**（§9.3 步骤 5-8 的 CACHE-FRESH 口径）：版本已递增 0.5.0，物化由验收/发布环节按 §9.3 物化规则执行即可。

---

## 11. v0.5.0 交付与发布环节记录（2026-11-11，v0.5 交付工程师）

本节是 v0.5.0 **交付与发布环节**的落点：交付 = 核查 README/docs 反映 v0.5.0（缺口先补）、核查零本机敏感信息、git commit → push → tag → 打包（预构建包 + SHA256）→ `gh release create` → 发布后自检（RELEASING §1-§6）。
本环节**未改动产品代码逻辑**：§10 记录的 38 个变更路径原样提交；本环节的改动集中在文档/清单/打包脚本注释，以及一处测试计数勘误。

### 11.1 README/docs 反映 v0.5.0 的缺口修补（逐项）

| # | 缺口（交付环节实测定位） | 修补 | 落点 |
|---|---|---|---|
| 1 | README 快速开始仍指向 **0.4.0** 的预构建资产名与安装期望输出（下载/`sha256sum -c`/`tar -xzf`/解包目录名/`marketplace add`/`Installed … (0.4.0)` 共 7 处） | 全部递增到 `0.5.0` | README.md:23-58 |
| 2 | README 第 3 步判据仍写「7 个斜杠命令文件」（v0.5 新增 `/xc-say` 后实为 8 个） | 改为 8 | README.md:77 |
| 3 | README 缺 v0.5 的两项能力首达说明：lead 可移交/释放/接管、用户原话可逐字转达 | 各补一段（说明元数据角色语义与盖章链的逐字匹配口径） | README.md:131（peer 段）、README.md:152（团队段） |
| 4 | README 文档索引缺 v0.5 三件套（`DESIGN-V0.5.md`/`SPEC-V0.5.md`/`GAP-V0.5.md`）与 `RELEASING.md`，且把 DESIGN 序列写成「三代」 | 补齐并改为「五代」 | README.md:264-273 |
| 5 | `plugin/.zcode-plugin/plugin.json` 与 `marketplace.json` 的描述仍是 v0.3/v0.2 口径（只讲 peer 轴与任务派发），与 v0.5 能力不符 | 两处描述改写为 v0.5 口径（可移交 lead、origin=user、上下文预算截断） | plugin.json:4-8、marketplace.json:11-12 |
| 6 | `docs/RELEASING.md` 全篇硬编码 `v0.4.0`（照抄即会发布错版本号） | 改为 `<VER>`/`<VERNUM>` 占位符版，并标注「占位未替换即发布是唯一硬性失败模式」 | docs/RELEASING.md |
| 7 | `scripts/pack-release.mjs` 文件头把用法写死为 `v0.4.0`（脚本本身与版本无关，按 tag 动态断言） | 改为 `v<x.y.z>` 占位 | scripts/pack-release.mjs:3-5 |
| 8 | `docs/IMPLEMENTATION.md` §10.3 记「42 文件 / 680 例」且基线算式写 `544 + 65 + 71 = 680`（与实测 681 差 1；被改测试文件实为 9 个、HEAD 计数 125 → 现 191） | 按交付环节复跑实测值勘误为 681 并补齐算式 | docs/IMPLEMENTATION.md:424 |

### 11.2 本机敏感信息核查（零本机路径）

- 核查口径：全仓（排除 `.gitignore` 覆盖的 `.scratch-*`/`.crosschat/`/node_modules）扫描 `qdqir`、`E:\ZCode`、`D:\tools`、`C:\Users` 四类本机路径标记。
- 实测结论：入库前**全仓 14 个文件命中**（含 v0.4.0 时代遗留的 `DESIGN*.md`/`FEASIBILITY*.md`/`PLATFORM.md`/`RELEASE-RECON.md`/`IMPLEMENTATION.md`/源码注释/打包脚本注释）；本环节统一替换为占位符 `<仓库路径>`/`<安装目录>`/`<证据仓>`/`<本机工作区>`/`<用户主目录>`，替换后**仅剩 2 处元描述**（`docs/DESIGN-V0.4.md:804/828` 的「零本机信息」规则条文本身，需保留被禁字符串的字面样例）。
- `plugin/run-lead.log`（一次失败验收跑留下的本机绝对路径日志，无任何内容被引用）已删除；根 `.gitignore` 增 `*.log`（含本机绝对路径与会话 id 的运行日志一律不入库）。
- **仍存在且如实声明**：历史文档（`docs/PLATFORM.md:151/182-197/249`、`docs/FEASIBILITY-V0.2.md`、`docs/FEASIBILITY-V0.3.md`）保留 v0.1-v0.3 期实测会话 id（`sess_*`）作为实验证据引文——它们是本机局部标识符，远程读者无法据此访问任何本机状态，且属已随 v0.4.0 发布的既有内容；本环节不做抹除性改写（会破坏历史实验记录的可核查性）。

### 11.3 交付环节亲跑的校验（命令 + 输出）

| # | 命令 | 输出 |
|---|---|---|
| 1 | `cd plugin && npm run typecheck` | exit 0，零报错（banner `zcode-crosschat-plugin@0.5.0`） |
| 2 | `cd plugin && npx vitest run` | **Test Files 42 passed / Tests 681 passed**，Duration 2.06s |
| 3 | `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "<仓库路径>/plugin"` | `Plugin manifest is valid`，exit 0 |
| 4 | 版本冻结复核（五处，RELEASING §2） | `plugin.json` 0.5.0、`marketplace.json` 0.5.0、`plugin/package.json` 0.5.0、`package-lock.json` root 0.5.0 与 `packages[""]` 0.5.0、`server.ts:37` `SERVER_VERSION = "0.5.0"` — 全部一致，无 0.4.0 残留 |
| 5 | 本机路径扫描（全仓 tracked + untracked、排除 .gitignore 覆盖项） | 见 §11.2；替换后仅 2 处规则条文元描述 |

### 11.4 本环节未执行项（如实声明）

- **未做「全新目录隔离安装 + 匿名下载」复核**：该项属验收环节口径（`docs/ACCEPTANCE.md` v0.4.0 第 1 条的实测路径），本环节只做发布动作与发布后 `gh release view` 自检；预构建包的物化行为由 `scripts/pack-release.mjs` 内置的 dist import 冒测（`IMPORT_OK`）把关。
- **未改产品逻辑**：v0.5.0 的能力判定全部沿用验收环节结论（`docs/ACCEPTANCE.md` v0.5.0 五条硬标准全部通过），本环节不重复宣告、不做二次验收。

---

## 12. v0.5.1 集成环节记录（2026-11-13，v0.5.1 集成工程师）

本节是 v0.5.1 **修复集成收口环节**的落点。红队对抗测试（`deepseek-crosschat/evidence/adversarial/`，裁决见同目录 `adjudication.md`：19 项中 18 项 confirmed、1 项 unconfirmed；#17 与 #3/#4 同根因合并）确认的缺陷由五组修复员白盒修复（对照各组 cases.md 的精确复现步骤与根因）。本环节职责：跨组冲突检查、全量自测、版本递增、README 一致性核查、按物化规则刷新安装；集成中发现的缺口按「小错直接修（留记录）」纪律处理（见 §12.6）。

### 12.1 逐 bug 修复对照表（裁决编号 ↔ 修复 ↔ 防回归单测）

严重级口径：**裁决定级**（adjudication.md 逐项记录）；修复运行汇总口径（P1×4、P2×13、P3×1）中 边界与-4、故障注-7 按 P2 计，边界与-5 为唯一 P3——两口径下修复内容完全一致，本表以裁决原文为准。

| 裁决# | 红队 id | 裁决级 | 根因（裁决原文要点） | 修复（文件:要点） | 防回归单测 |
|---|---|---|---|---|---|
| #1 | 边界与-1 | P0→P1 | `xc_status.teamId` 穿越串经 join 逃出状态根建目录写 snapshot.json | `core/paths.ts` 新增 `isValidTeamId`（单安全路径段闸）+ `mcp/tools.ts` xc_status 触碰任何路径构建器前先过闸（invalid_params，附合法口径说明） | `core/paths.test.ts`「isValidTeamId (BND-1)」3 例：合法段接受/红队穿越载荷全拒（正反斜杠、深穿越、盘符）/`..`、`.`、分隔符、控制字符、超长、空串结构性排除 |
| #2 | 边界与-2 | P1 | peer 轴 hold→accept 假成功：释放时按当前策略重裁回 hold→held 件滞留/被删、消息永不投递、回执虚报「影响 1 条」 | `mcp/peer-tools.ts` accept 重裁只保留 refuse 一道闸（收方显式批准不回吞 hold）；`renderReviewSummary` 按真实终态分组播报；审计 `peer-hold-released` 附 `outcomes` 终态计数 | `mcp/peer-tools.test.ts`「renderReviewSummary（BND-2）」5 例（全放行/混合终态/无可处理项/list-discard 旧口径/未知终态计 other）+ `mcp/peer-tools.integration.test.ts` 2 例（repo 层 hold 件 accept 后入队+审计计数/策略转 refuse 仍拒放） |
| #3 | 边界与-3 | P2 | completed 证据门只查「有条目」：不存在文件被接受、sha256=null 落库 | `mcp/tools.ts` xc_report 证据门：`sha256File` 现算，文件缺失/不可读 → `evidence_file_missing`；缺省/显式 null 落**现算值**（不再落 null） | `mcp/evidence-gate.test.ts`（新文件）「红队 #3 回归」：不存在文件被拒、真源不动、回执不发 |
| #4 | 边界与-4 | P3（汇总口径 P2） | 调用方伪造 sha256 原样入库并随回执分发 | 同上门：声称值非 null 且与现算不符 → `evidence_checksum_mismatch`（整单拒绝，附 claimed/computed） | `mcp/evidence-gate.test.ts`「红队 #4 回归」伪造 sha256 被拒 +「正确声明的 sha256 通过；缺省/显式 null 均落现算值」 |
| #17 | 安全对-1 | P2（并入 #3/#4） | 与 #3/#4 同根因（证据门不查内容） | 同上门（一条实现覆盖三个可观察面） | `mcp/evidence-gate.test.ts` 另 2 例：in_progress 带缺失文件同样被拒 / failed 报告携带真实文件证据正常通过 |
| #5 | 边界与-5 | P3（汇总口径唯一 P3） | `xc_register` 放行保留名 lead/default（与 `xc_member_add` 双路径不一致） | `mcp/identity.ts` xc_register 锁外快拒 `name_reserved`（RESERVED_MEMBER_KEYS 同码，hook/wake 双路径均拦） | `mcp/identity.test.ts`「保留名注册拒绝（BND-5）」4 例：hook 路径/先于锚定校验/wake 路径 nonce 不被消费/零副作用 |
| #6 残留 | 并发与-1 残留观察 | P3（裁决 unconfirmed，残留观察 3） | `xc_peer_inbox` 的 count/汇总行只计 JSON 块信封（≤10），响应实际承载约 15 条 → 只读结构化块误判丢消息 | `mcp/peer-tools.ts`：xc_peer_inbox 抑制面 B 双排空（skipFaceB），count = 本次真实呈现数；`remaining` 字段 + 摘要行「另有 N 条待投递——再调一次」指针 | `mcp/peer-inbox-count.test.ts`（新文件）5 例：count=envelopes 一致/content.length===2/remaining 指针双向/面 B 不扩伤（xc_peers 仍追加）/schema 描述声明口径 |
| #7 | 并发与-2 | P1 | ≥10MiB 工具帧使 SDK ReadBuffer 溢出 → close → exit 0 静默自退出 | 新增 `transport/mcpstdio.ts` `GuardedStdioTransport`：上限提至 32MiB（覆盖红队 9~24MiB 全档位），溢出改显式 JSON-RPC 拒收（code -32700）+ 丢帧不关传输；`mcp/server.ts` 换用该传输 | `transport/mcpstdio.test.ts`（新文件）7 例：12/24MiB 正常解析、超限恰一条拒收不关传输、拒收后同连接继续服务、跨块/连续超限 + `mcp/injection-budget.test.ts` CONC-2 工具层腿（12MiB 消息磁盘保真入队） |
| #8 | 并发与-3 | P2 | ≥7 并发发送者打同一 peer → endpoint-busy（45−32=13/40−32=8/35−32=3，与实测逐位吻合：端点 maxConnections 缺省 32 低于现实 fan-in 突发） | **集成环节直接修（§12.6）**：`transport/frames.ts` 新增 `PEER_MAX_CONNECTIONS = 128`（缺省，附根因注记），`transport/pipe.ts` 缺省改引该常量；README 已知限制 6 声明上限与 busy 语义 | `transport/pipe.test.ts`「红队 CONC-3 回归」：45 并发（9×5 裁决档位、handler 延迟回执钉住全并发窗口）→ 0 busy 全投递；判别力实证：同测试配 maxConnections:32 恰失败于 13 条 busy |
| #9 | 故障注-1 | P2 | team.json 损坏 → 全队工具持续 internal、无自愈 | `core/teamstate.ts` readTeam：真源不可解析先从 last-known-good 镜像 `team.json.bak` 自愈（残损字节保全为 `team.json.corrupt` + 审计 `team-state-recovered`）；无备份抛带文件路径与修复指引的显式诊断（不再裸抛 JSON 错误）；writeTeam 每次成功落盘原子镜像 .bak | `mcp/fault-injection.test.ts`「FI-1」2 例（半行截断自愈+残损保全/无备份显式降级诊断）+ `core/teamstate.test.ts` 3 例（无备份诊断/从备份恢复/.bak 镜像） |
| #10 | 故障注-2 | P2 | team.json 合法但 tasks:[] → 在途凭证无声蒸发 | `core/mailbox.ts` 新增 `orphanTaskIds`（纯函数）+ `mcp/tools.ts` xc_claim unknown-task 诊断富化（`orphan_task_reference` + 恢复指引）、xc_status 计算孤儿引用 + `core/snapshot.ts` 快照增 `orphanTasks` + `mcp/render.ts` 状态表 WARNING 行 | `mcp/fault-injection.test.ts`「FI-2」1 例（status 披露 + claim 诊断）+ `core/mailbox.test.ts`「orphanTaskIds + 孤儿信封陈旧判定」2 例 |
| #11 | 故障注-3 | P2 | inbox JSONL 坏行静默吞（整箱乱码静默当空箱） | `core/mailbox.ts`：读取诊断收集器（`MailboxReadDiagnostics.malformed/discarded`）+ `mcp/tools.ts` 摘要行披露 `N unreadable line(s) skipped` + payload `malformedLines` | `mcp/fault-injection.test.ts`「FI-3」1 例（坏行跳过好行照常投递 + 摘要披露）+ `core/mailbox.test.ts` 1 例（collector 透出） |
| #12 | 故障注-4 | P2 | `xc_check_inbox` 无条件重投已读消息（重注入随历史无界增长） | `mcp/tools.ts` xc_check_inbox 只消费 `readAt === undefined` 的未读件（陈旧清扫仍作用于全部现行消息）；第二次起 `0 message(s) consumed` | `mcp/fault-injection.test.ts`「FI-4」1 例（已读不再重注入、走完生命周期也只返回未读） |
| #13 | 故障注-5 | P2 | 删 team.json → 静默整队重置、taskId 撞号、旧分派复活 | `core/types.ts` TeamState 增 `era` 纪元令牌 + `core/teamstate.ts` `nextTaskId` 带 `<era>-t` 前缀（旧记录宽容保持 `t<n>`）、`noteTeamReset` 残迹检测（审计 `team-reset-detected` + 注册/派发响应带告警）+ `mcp/identity.ts` joinTeam 接告警 + `core/mailbox.ts` 无 attemptId 但带 taskId 的信封在任务不存在时判陈旧（旧分派不复活） | `mcp/fault-injection.test.ts`「FI-5」2 例（重置告警+审计/纪元前缀不撞号+旧信封判陈旧）+ `core/teamstate.test.ts` 2 例（era 前缀分配/legacy 无 era 保持旧形态） |
| #14 | 故障注-6 | P2 | 不可解析残留锁 → 每次 15s 等待→busy 永久饥饿 | `core/lock.ts`：不可解析锁（0 字节/乱码/缺字段）超过 1s 宽限期即判定无主残留、安全清除 + 审计 `lock-repaired`（宽限挡住 openSync↔writeSync 之间被打断的瞬时 0 字节窗口） | `core/lock.test.ts` 4 例：旧 mtime 不可解析锁清除后夺取/0 字节锁清除/宽限期内 fresh 锁被尊重/合法活锁永不清除 |
| #15 | 故障注-7 | P3（汇总口径 P2） | wake 供应商失败回执仍宣称 delivered=wake（子进程失败只落 wake 日志，无失败标记） | `engine/wake.ts`：spawn 后 20s 有界失败侦听（轮询 wake 日志，`findWakeFailureEvidence` 只认正向失败证据——行首 `Error` / isError:true / success:false / 顶层 error 字符串），命中 → `wake-failed` 审计 + 释放投递租约 + 消费 nonce；回执 note 写明「非送达确认」+ 探测回落标注（`wakeFallbackNote`）；窗口静默不表态（不虚报成败） | `engine/wake.test.ts` 6 例新增（findWakeFailureEvidence 正反例/失败侦听释放租约/窗口静默不表态/回落标注） |
| #16 | 故障注-8 | P2 | 僵尸任务清扫从未发生（README L215 承诺落空；边沿清扫只在有成员成功报告时运行） | **承诺实现**：`mcp/task-edges.ts` 新增 `sweepStaleTasksOnce`（读盘预检→锁内清扫回待领+回执派发方+审计→锁外唤醒→刷快照，永不抛）+ `startStaleSweeper` 周期定时器（节拍=阈值/6 钳 [10s,60s]，unref）+ `mcp/server.ts` main() 启动 | `mcp/stale-sweep.test.ts`（新文件）9 例：claimed/in_progress 僵尸清扫+回执+审计+快照/清扫后他人可认领/未超阈值不动/在途 wake 豁免/并发一轮只清一次/损坏 team.json 静默跳过/定时器独立兑现/节拍与阈值解析 |
| #18 | 规模压-1 | P1 | `xc_check_inbox` 批量消费无批次预算截断（300 条直灌 201,193 字符，超批次上限 3.1 倍，无指针） | **承诺实现**：`core/budget.ts` 新增 `batchWindowCount`（到达序前缀窗口，保底一条）+ `mcp/tools.ts` xc_check_inbox 只消费「JSON 面+信封面」联合成本 ≤ 批次预算的前缀（其余保持未读）+ 摘要行/payload/信封尾行三处「再调一次」指针 | `mcp/injection-budget.test.ts`（新文件）SCALE-1 3 例：40 条+小预算只消费窗口前缀且三处指针/默认预算小批量行为不变（无 batchTruncated 字段）/单条超预算保底一条 |
| #19 | 规模压-2 | P2 | `xc_claim` 全文回显 600KB prompt（claim 路径未接入预算截断） | `mcp/tools.ts` xc_claim 回显接入预算：prompt/acceptance 超单条预算截断（`promptTruncated`/`acceptanceTruncated` 携全文 sha256，与 xc_status 同款）+ `xc_task_read` 指针 + TaskReadShape 增 `acceptance` 枚举（全文分页取回通道）；真源全文不动 | `mcp/injection-budget.test.ts` SCALE-2 3 例：600KB 认领响应有界+分页拼回 sha256 一致/acceptance 同样截断且未超时 payload 与 v0.5.0 逐字段一致/acceptance 枚举锁定 |

修复面合计：**37 个文件** = 修复员交付 34（27 修改 + 7 新增，其中 README 1）+ 集成环节 CONC-3 补修 3（transport/frames.ts、transport/pipe.ts、transport/pipe.test.ts，均为修复员未触碰的文件，见 §12.6）。README 承诺落空两项（#16 僵尸清扫、#18 批量截断）均**选择实现承诺**而非改 README 缩水（修复纪律优先项），README 相应更新为已兑现口径并注明 v0.5.1 起。
### 12.2 跨组冲突检查（公共文件语义一致性，本环节逐 hunk 实读全量 diff）

- **`mcp/tools.ts`（7 项修复叠放，最高风险公共文件）**：改动落在**互不重叠的工具处理器**——xc_status（BND-1 闸 + FI-2 孤儿计算）、xc_report（BND-3/4 证据门）、xc_claim（FI-2 诊断 + SCALE-2 截断，同一处理器内先抛诊断后塑形成功负载，两修复顺序兼容）、xc_check_inbox（FI-3 诊断 + FI-4 未读过滤 + SCALE-1 批次窗口，三者叠加在同一消费路径：`readCurrentMailboxLocked`（含陈旧清扫）→ `unread` 过滤 → `inboxEntry` 成本化 → `batchWindowCount` 窗口 → 只 ack 窗口内未读件，语义链条自洽且各自有独立单测锁定）、xc_dispatch（FI-5 重置告警透传）。无同 handler 内的语义对撞。
- **纪元前缀（FI-5 `<era>-t1`）的波及面**：产品代码无任务 id 形态解析（grep `t${`/`/^t`/parseInt 反证零命中）；既有用例硬编码 `t1` 的 1 处断言已由修复员改为 `toMatch(/-t1$/)`（guards.test.ts）；legacy 无 era 记录宽容读取保持 `t<n>` 旧形态（teamstate.test.ts 锁定）。
- **`mcp/peer-tools.ts`（BND-2 + P3 口径）**：二者分属 review 与 inbox 两条链路 + `call` 包装器加 `skipFaceB` 选项（缺省 false，其余 peer 工具行为不变，peer-inbox-count.test.ts 有「面 B 不扩伤」反例锁定）；`PeerServices.inbox` 接口增 `remaining` 字段——typecheck 强制全部实现点同步，集成 typecheck 通过即证无遗漏。
- **`mcp/task-edges.ts`（FI-8）**：`refreshSnapshotBestEffort`/`runWakePlan` 从包装器闭包提升为模块级（签名加 deps），E-b 边沿路径与新增周期清扫共用同一 `sweepStaleTasksLocked` 实现（单一事实源，无双实现漂移）；`sweepStaleTasksOnce` 永不抛（损坏状态让路给 FI-1 的错误信封面，下一轮重试）。
- **`engine/wake.ts`（FI-7）**：纯增量（失败侦听 + note 文案），未触碰 delivered 三态契约与投递租约主流程；侦听定时器全部 unref，不改进程退出语义。
- **`mcp/server.ts`（CONC-2 + FI-8）**：传输层替换与清扫定时器启动互相独立；本环节仅改 `SERVER_VERSION`（版本冻结项）。
- **`mcp/identity.ts`（BND-5 + FI-5）**：保留名快拒在锚定/绑定之前（零副作用，identity.test.ts 锁定），与 joinTeam 残迹告警无交叠。
- **结论**：五组修复无语义冲突；未发现「同文件同路径多组各改一处」的对撞。发现并处置 1 处**范围缺口**（CONC-3，§12.6）。

### 12.3 全量自测（本环节亲跑，版本递增前后各跑一轮，结果一致）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd plugin && npm run typecheck` | **exit 0 零报错**（修复交付态、版本递增后、CONC-3 补修后共三轮全绿） |
| 2 | `cd plugin && npm test` | **48 文件 / 757 例全绿**（版本递增后复跑同结果）。基线核对：v0.5.0 = 42 文件 / 681 例 → 新增 6 测试文件（evidence-gate 5、fault-injection 8、injection-budget 7、peer-inbox-count 5、stale-sweep 9、mcpstdio 7 = 41 例）+ 既有测试文件新增 35 例 = **+76 例**；681+76=757 ✓（CONC-3 补修后再 +1 = 758，见 §12.6） |
| 3 | `ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "D:/tools/zcode-crosschat/plugin"` | **`Plugin manifest is valid`**，exit 0 |
| 4 | `cd plugin && npm run build` | `build ok`，5 产物齐；`SERVER_VERSION = "0.5.1"` 在 dist bundle 内 grep 命中，`"0.5.0"` 零命中 |
| 5 | 红队原始复现黑盒回归（evidence/adversarial/fix-verify/，本环节对**最终 dist** 实跑） | `repro-group.mjs`：CONC-2（10~24MiB 正常入队、40MiB 显式拒收且 server 存活）/ SCALE-1（poll1 17,494 字符、25/300 窗口消费、12 轮排空 300/300）/ SCALE-2（claim 4,420 字符、promptTruncated.sha256 分页拼回一致）/ P3（count=envelopes=真实呈现数、15/15 对账 lost=0）；`fix-v051-case-evi.mjs` 11/11（不存在文件拒收/伪造 sha256 拒收/缺省落现算值）；`fix-v051-case-fi8.mjs` 7/7（75s 实测窗内清扫回 pending + 派发方回执 + task-swept 审计 + 第三人可认领）。三脚本全绿 |

### 12.4 版本冻结（五处，RELEASING §2）

`plugin/.zcode-plugin/plugin.json` / `marketplace.json` / `plugin/package.json` / `plugin/package-lock.json`（根 + packages[""] 两处）/ `plugin/src/mcp/server.ts SERVER_VERSION` 全部 **0.5.0 → 0.5.1**（grep 复核五处均 0.5.1、无 0.5.0 残留；RELEASING.md「当前实例」同步 v0.5.1，基线行更新为 48 文件/757 例）。README 安装指引的 Release 资产名/解包目录/marketplace add 路径同步 0.5.1（8 处）。打包发布（RELEASING §3-§6）属发布环节，本环节未执行。

### 12.5 README 与行为一致性核查（承诺落空两项的处理结果如实反映）

- **僵尸清扫（裁决 #16）**：README L215 的承诺「在途任务超过 stale_task_minutes 无任何更新且成员无在途唤醒时，被引擎清扫回待领并回执队长」由 `startStaleSweeper` 周期定时器兑现——README 无需改口，行为与承诺一致（stale-sweep.test.ts 红队 75s 场景的加速等价单测锁定）。
- **批量截断（裁决 #18）**：README L225「批次基准 16000」的承诺由批次窗口兑现；README 工具表 xc_check_inbox 行与防卡死段已由修复员更新为如实描述（单次只消费窗口内消息、其余保持未读、三处指针），核查与实现一致（injection-budget.test.ts 锁定）。
- **新增承诺的落地声明**：README 已知限制 6 追加「MCP stdio 传输层 32 MiB 单帧上限 + 超限显式拒收」（CONC-2）与「pipe 端点并发连接上限 128 + busy 语义」（CONC-3，§12.6）；硬校验清单与 xc_report 工具行追加「证据文件存在性与 sha256 现算复核」（BND-3/4）；xc_claim/xc_peer_inbox 工具行与实现逐字对照一致。
- **核查方法**：本环节对 README 全部 26 工具行、已知限制 1-12、硬校验清单逐条与实现/单测对照；未发现承诺落空或描述失真残留。

### 12.6 集成环节直接修（留记录）

| # | 项 | 依据 | 处置 |
|---|---|---|---|
| 1 | **CONC-3（裁决 #8，P2）五组修复未覆盖**：全量 diff 中 `transport/pipe.ts`/`frames.ts` 零改动、无发送侧重试、README 无并发上限声明；红队三档失败数（3/8/13）与端点 `maxConnections ?? 32` 逐位吻合（45−32=13、40−32=8、35−32=3） | 集成纪律「小错直接修（留记录）」；根因明确、改动面最小（常量缺省值 + 1 处引用） | `transport/frames.ts` 新增 `PEER_MAX_CONNECTIONS = 128`（附根因注记：fan-in 是主路径、max_members=8、128 覆盖 8 成员×在途突发×余量、超限仍显式 fail-closed）；`transport/pipe.ts` 缺省改引该常量；README 已知限制 6 声明；回归单测 1 例（45 并发全投递）并实证判别力（配 32 恰失败 13 条）。补修后 typecheck + 全量 758 例复跑全绿 |

### 12.7 物化刷新（按 IMPLEMENTATION §9.3 物化规则，本环节实跑）

`marketplace update dev-zcode-crosschat`（快照刷新）→ `plugins install zcode-crosschat@dev-zcode-crosschat` → **`Installed plugin zcode-crosschat@dev-zcode-crosschat (0.5.1) [enabled]`**（版本变化触发重新物化）→ `plugins list` 缓存路径 `…/cache/dev-zcode-crosschat/zcode-crosschat/0.5.1`（skills:1 commands:1 hooks:3 mcp:1）→ md5 比对：仓库 dist 5 产物（server.mjs `fabf06af…` / wake-helper.mjs / hooks 3 件）与安装态**逐一相同**；缓存 `.zcode-plugin/plugin.json` version = 0.5.1。**未执行** `plugins uninstall`（v0.2 §2.4 事故先例：`--force` 清空 plugins.options 丢失 zcode_exe/zcode_cjs）。旧 0.5.0 缓存目录保留未动（多版本共存，宿主按安装版本取用）。

### 12.8 本环节未执行项（如实声明）

- **红队 19 项的端到端黑盒复验未执行**（属复验环节职责，evidence/17-v051/reverify/ 监视区；本环节交付 = 跨组冲突检查 + 全量单测层自测 + CONC-3 补修 + 版本冻结 + README 核查 + 物化刷新）。工具层可自动化部分的防回归由 §12.1 表右列单测承载（全部绿）。
- **发布环节未执行**（RELEASING §3-§6：pack-release、gh release create/upload、发布后自检）。
- **打包自断言（pack-release.mjs 五处版本一致）未跑**：属发布环节第一步，版本五处已按其断言口径对齐（§12.4）。

## 13. v0.5.1 交付与发布环节记录（2026-11-13，v0.5.1 交付工程师）

本节是 v0.5.1 **交付发布环节**的落点：README/docs 一致性核查、敏感信息扫描、逐 bug 发布说明、commit/tag/push、预构建包 + gh release。

### 13.1 交付态亲跑校验（命令 + 输出）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd plugin && npm run typecheck` | exit 0 零报错 |
| 2 | `cd plugin && npm test` | **48 文件 / 758 例全绿**（与 §12.3、复验报告 §2.1 三方一致） |
| 3 | 版本冻结五处 grep 复核 | `plugin.json` / `marketplace.json` / `package.json` / `package-lock.json`（根+packages[""]）/ `server.ts SERVER_VERSION` 全部 `0.5.1`，无 0.5.0 残留 |

### 13.2 README/docs 一致性核查

- **发现并修正 1 处文档过期**：`docs/RELEASING.md` §1 前置项基线行写「48 文件 / **757** 例」，为 §12.6 CONC-3 补修（+1 例）前的旧值；实测与 README「基线 48 文件 / 758 例全绿」均为 **758**——已改为 758（其余 README/docs 口径逐条核对一致：26 工具行、已知限制 1-12、硬校验清单、安装资产名 0.5.1、RELEASE-RECON.md 已在库）。
- **承诺落空两项**（僵尸清扫 #16、批量截断 #18）均为实现承诺而非改 README 缩水，README 已按兑现口径更新（§12.5 核查记录），本环节复核无异。

### 13.3 本机敏感信息核查

对全部 130 个 tracked 文件扫描 `C:\Users` / `D:\tools` / `E:\` / `sess-` / `qdqir` / `/d/tools` 等模式（`git ls-files -z | xargs -0 grep -nEI …`，含 package-lock.json 单独复核）：**零命中**。`.gitignore` 已排除 `.crosschat/`、`.scratch-*/`、`evidence/`、`*.log` 等含本机路径与会话 id 的运行数据。

### 13.4 发布说明

逐 bug 发布说明（18 项：症状/修复/验证参照）写入 `.scratch-release/notes-v0.5.1.md`（gitignore 覆盖、不入库），gh release create 直接采用；每项验证参照指向复验证据 `evidence/17-v051/reverify/01~20-*.md` 与对应防回归单测文件，并整体引用复验报告 `deepseek-crosschat/reports/17-v051复验.md`。未确认项（并发与-1）与附带观察如实单列，不混入 18 项。

### 13.5 发布执行（RELEASING §2-§6）

- commit：`fix: red-team findings batch (v0.5.1)`（**43 files changed, +3263/−284**；其中修复面 37 个文件见 §12.1，余为版本冻结五处与文档记录：README、docs/IMPLEMENTATION.md、docs/RELEASING.md、marketplace.json、plugin/.zcode-plugin/plugin.json、plugin/package.json、plugin/package-lock.json）；
- tag：`v0.5.1`（annotated），指向上述 commit；
- push：`git push origin main v0.5.1`；
- 打包：`node scripts/pack-release.mjs v0.5.1`（worktree 导出 tag 树 → npm ci → build → prune → dist 冒测 IMPORT_OK → tar + SHA256；五处版本断言过）；
- 发布：`gh release create v0.5.1 --target <SHA> --notes-file .scratch-release/notes-v0.5.1.md` + `gh release upload` 两资产（tgz + .sha256）；
- 发布后自检：`gh release view`（isDraft=false、资产在、body 引用复验报告）。

### 13.6 本环节未执行项（如实声明）

- **发布后匿名下载 `sha256sum -c` 复验与隔离安装冒测**（RELEASING §6 后半）：本机直连 github.com 下载通道按用户全局规则不保障，未执行匿名拉取；资产完整性由打包环节的 node crypto SHA256 + `.sha256` 随包发布保障，安装侧校验留给用户执行（README 第 1 步有指引）。
- **真实宿主会话级验证**：同复验报告 §5.4，未执行（非本环节职责）。
