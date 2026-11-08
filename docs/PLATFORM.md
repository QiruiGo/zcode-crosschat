# zcode 插件能力面与会话机制调研报告（PLATFORM）

- 调研人：平台调研员（动态工作流子代理）
- 日期：2026-11-09
- 环境：Windows 11 + Git Bash；ZCode 桌面版 `E:\ZCode\ZCode.exe`（CLI 版本 **0.17.1**，实测输出「zcode 0.17.1」）
- 方法：全部结论来自本会话内实际读取的文件（路径+行号）与实际执行的命令（命令+输出摘录）。未运行/未确认之处在 §8 明示。
- 术语：无特别说明时 `~` = `C:\Users\qdqir`。

---

## 1. 调研对象总览

实测研读了 7 个官方插件（超过要求的 4 个，含指定 2 个）：

| 插件 | 实测版本 | 组件构成 | 关键发现 |
|---|---|---|---|
| plugin-creator | 0.1.1 | skills(1) + references + 脚手架脚本 | 插件开发的权威工作流与清单规范 |
| browser-use | 0.5.1（另有 0.1.0/0.1.2/0.4.1/0.4.2 共存于缓存） | skills(2) + docs/ + scripts/ | `ZCODE_PLUGIN_ROOT` 运行时变量；自身无 mcpServers，依赖 node-repl-host 提供 MCP |
| documents | 0.2.1 | skills(2) + agents(1) + dist/server.mjs + ui | **最全 manifest**：mcpServers 内联 + ui surfaces + agents |
| github | 0.1.4 | skills(9) + references + scripts | **双清单兼容**：`.zcode-plugin/` + `.claude-plugin/` 并存 |
| zcode-guide | 0.3.0 | skills(6) | 官方配置地图 + 诊断流程（本文 §3 主要来源） |
| zcode-site | 0.4.2 | skills + commands(7) + mcpServers + ui | **commands 实例**：frontmatter `description`/`argument-hint`/`skills` + `$ARGUMENTS` |
| node-repl-host | 0.7.0 | dist/mcp/server.js | 共享 MCP 宿主插件，manifest 极简（无 skills 字段） |

用户级目录结构（`ls` 实测）：

```text
~/.zcode/cli/plugins/
├── installed_plugins.json      # 显式安装记录（本机仅 github、zcode-context 两条，见 §2.3）
├── known_marketplaces.json     # 市场源注册表（官方 CDN + claude-plugins-official）
├── cache/<marketplace>/<plugin>/<version>/   # 插件实体，按版本目录存放
├── data/<plugin>@<marketplace>/              # 插件数据目录（本机均为空）
└── marketplaces/zcode-plugins-official/      # marketplace.json（68 个插件）+ bundled/cdn 快照
```

---

## 2. 插件能力面

### 2.1 清单文件（manifest）——`.zcode-plugin/plugin.json`

探测顺序（diagnosing-plugins SKILL.md:17）：`.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json`。插件身份 = `<name>@<marketplace>`。

**最小清单**只要求 `name`（正则 `^[a-z0-9][a-z0-9._-]{0,127}$`，zcode-guide/diagnosing-plugins SKILL.md:25）；初始版本惯例 `0.1.0`（plugin-json-spec.md:3）。

**完整字段**（综合 documents/0.2.1 实测 + 两份官方文档）：

```jsonc
{
  "name": "documents",                      // 必填，稳定标识符
  "version": "0.2.1",                       // 可选，缺省 0.0.0
  "description": "...",                     // 可选
  "description_i18n": { "en": "...", "zh-CN": "..." },
  "author": { "name": "Z.ai", "url": "..." },
  "license": "Apache-2.0",
  "skills": "skills",                       // 组件：技能目录（<name>/SKILL.md）
  "commands": "commands",                   // 组件：斜杠命令 Markdown 目录
  "hooks": "./hooks/hooks.json",            // 组件：钩子配置文件
  "mcpServers": { ... },                    // 组件：内联 MCP 配置 或 ".mcp.json" 路径
  "agents": "agents",                       // ⚠️ 存疑字段，见下
  "userConfig": { ... },                    // 插件用户配置 schema（type/title/default/required/sensitive）
  "ui": { "surfaces": [ ... ] }             // 桌面面板（documents/zcode-site 有）
}
```

- **组件字段形态**：可以是目录名、数组或内联（zcode-configuration-guide SKILL.md:78）。组件路径必须是相对路径且不得逃出插件根（diagnosing-plugins SKILL.md:26；validate-plugin.mjs:42-47 有同样的越界检查）。
- **`agents` 字段存在文档冲突**：zcode-configuration-guide SKILL.md:78 说 `agents` 是可执行组件字段（「each may be a directory name, an array, or inline」），而同版本 diagnosing-plugins SKILL.md:25 说「Recorded but not executed: agents, channels, lspServers, outputStyles, settings」。**结论：不要依赖插件级 `agents` 字段承载核心逻辑**；documents 插件的 agents/visual-judge.md 更像给模型读的角色说明。
- **`channels`/`lspServers`/`outputStyles`/`settings` 仅记录不执行**（两份文档一致）。

**mcpServers 两种写法（均实测到实例）：**

1. 外部 `.mcp.json`（plugin-creator 脚手架 scaffold-files.mjs:57-63 生成）：
   ```json
   { "mcpServers": { "<name>": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"] } } }
   ```
2. 内联完整配置（documents/0.2.1 `.zcode-plugin/plugin.json` mcpServers 节）：`type:"stdio"`、`command`、`args`、`cwd`、`env`、`auth`、`isolation:"workspace"`。官方插件由宿主拉起：`ZCode.exe <zcode.cjs> __zcode-plugin-host <plugin>/dist/server.mjs`（documents 与 zcode-site 的 manifest 均如此，且带 `ELECTRON_RUN_AS_NODE:"1"`）。

**运行时变量**（实测引用处）：

- `${CLAUDE_PLUGIN_ROOT}`：MCP args 与 hook command 中的插件根定位 token（plugin-json-spec.md:15；scaffold-files.mjs:40,63）
- `ZCODE_PLUGIN_ROOT`（`CLAUDE_PLUGIN_ROOT` 为兼容回退）：运行时环境变量，browser-use skill 要求用它解析插件根（browser-use/0.5.1/skills/control-browser/SKILL.md:21-27）
- 其他实测存在的变量：`${ZCODE_PROJECT_DIR}`、`${ZCODE_PLUGIN_DATA}`、`${ZCODE_PLUGIN_ID}`（documents manifest cwd/env 字段；07-机制分析报告 §8.1 亦记录）

### 2.2 组件文件格式

- **skills**：`skills/<name>/SKILL.md`，YAML frontmatter 必须 `name` + `description`（plugin-json-spec.md:17；documents/docx/SKILL.md、browser-use/control-browser/SKILL.md 均验证）。description 决定自动触发时机，是技能被选中的唯一入口。
- **commands**：`commands/*.md`（zcode-site 实测）。frontmatter 实测字段：`description`、`argument-hint`、`skills`（声明依赖的技能）；正文用 `$ARGUMENTS` 接收参数（zcode-site/0.4.2/commands/site-badge.md:1-7）。嵌套目录映射为冒号名：`review/code.md` → `/review:code`（zcode-configuration-guide SKILL.md:63）。命令名冲突时先发现者胜（用户域覆盖工作区，插件域最低）。
- **hooks**：`hooks/hooks.json`。**支持的事件恰好 7 个**：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`（zcode-configuration-guide SKILL.md:72）。配置文件里的钩子必须 `hooks.enabled: true` 才生效；**插件贡献的钩子会自动启用 hook runner**（同文件 :73）。命令里可用 `${CLAUDE_PLUGIN_ROOT}`。用户 `~/.zcode/cli/config.json` 实测有同形 hook 配置（type:"process"、command、args、timeoutMs）。
- **userConfig**：type ∈ `string|number|boolean|directory|file`，可带 title/description/default/required/sensitive；**sensitive 目前无法在界面输入或持久化**（diagnosing-plugins SKILL.md:27）。

### 2.3 安装与启用机制

**分发与安装路径**：

1. 市场来源（known_marketplaces.json 实测）：官方市场 `zcode-plugins-official` 指向 CDN `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json`；也支持 GitHub 仓库 / Git URL / 本地目录 / 本地文件（diagnosing-plugins SKILL.md:36）。marketplace.json 条目 source 支持 kind `directory|github|git|url|git-subdir`，**不支持 npm/pip**（同文件 :28）。
2. 本机缓存布局：`cache/<marketplace>/<plugin>/<version>/`，每个版本旁有 `.zcode-plugin-seed.json`（实测内容：hash/marketplace/plugin/pluginVersion/source/filesystem，如 browser-use/0.5.1/.zcode-plugin-seed.json）。**多版本共存**（browser-use 有 5 个版本目录），运行取 installed 记录指向的版本。
3. 显式安装记录：`installed_plugins.json`（version:1，plugins 数组，每条含 id/name/marketplace/version/installPath/installedAt/updatedAt/scope/source{url,sha256}/cacheTransactionId）。**本机只记录了 github 与 zcode-context 两条**，其余 18 个启用中的插件是**内置插件播种**（diagnosing-plugins SKILL.md:20「bundled official plugins are materialized into the plugin cache」）。
4. 启用状态：`~/.zcode/cli/config.json` → `plugins.enabledPlugins`（实测本机 3 条 true），以及 per-plugin 配置值、内置插件抑制表（diagnosing-plugins SKILL.md:18-19）。总开关 `plugins.enabled`。
5. CLI 管理命令（`zcode plugins --help` 实测）：`plugins list|install|uninstall|enable|disable|update|validate|marketplace`。实测 `plugins list` 输出 18 个插件及各自 skills/commands/hooks/mcp 计数；`plugins validate "C:\...\browser-use\0.5.1"` 输出「Plugin manifest is valid: ...」exit=0。
6. UI 流程（plugin-creator/references/installing-and-updating.md:24-28）：插件市场 → 添加 → 添加插件市场（粘贴目录）→ 个人 → 安装；更新 = 改源码+版本号 → 同步 marketplace 条目 → 市场源刷新 → 插件详情点更新。
7. 本地开发市场布局（plugin-json-spec.md:43-53）：`<workspace>/plugins/marketplace.json` + 平级插件目录；市场名惯例 `dev-<workspace>-<canonical-path-hash>`；开发期条目 source 用相对路径 `./<plugin>`。

**版本与命名约定**：name 小写连字符 ≤64 字符（spec 建议）且匹配上面的正则；语义化版本，迭代 = 改源码 + 递增 manifest 版本 + 同步市场条目（installing-and-updating.md:40）；官方 CDN 插件按 sha256 固定 zip、按 commit 跟踪更新（diagnosing-plugins SKILL.md:48）。

**代理坑**：市场克隆只读 `ZCODE_HTTP_PROXY`，忽略裸 `http_proxy`（diagnosing-plugins SKILL.md:12,41）——与本机 GitHub 访问纪律吻合。

---

## 3. 官方插件文档要点

### 3.1 plugin-creator（0.1.1，开发工作流权威）

`skills/plugin-creator/SKILL.md`（6 步）：① 定结果与源码位置（默认 `<workspace>/plugins/<slug>/`）→ ② 建 `.zcode-plugin/plugin.json` + 只实现需要的组件（`scripts/create-basic-plugin.mjs my-plugin --with-skills|--with-mcp|--with-hooks|--with-commands`）→ ③ 环境内可验证的检查（`scripts/validate-plugin.mjs` 可再调 `zcode plugins validate`）→ ④ 生成/更新本地测试市场 `<workspace>/plugins/marketplace.json`（`scripts/upsert-dev-marketplace.mjs`）→ ⑤ 指导用户 UI 安装 → ⑥ 交付状态如实（市场待添加/插件待安装/试用待验）。

**重要纪律**（SKILL.md:10）：普通 Desktop 用户可能没有全局 `zcode` CLI 或 `node`——所有「注册市场/安装/更新」动作是**手动 UI 步骤**，插件 agent 不代做。脚手架生成的 MCP server 只有握手骨架，「实现真实工具后才能报成功」。

`references/plugin-json-spec.md`：清单规范（§2.1 已引）；marketplace.json 格式（name/plugins[]/source 相对路径/version/displayName_i18n/description_i18n/category；常用 category：developer-tools/productivity/utilities/legal/template/finance/other）。

### 3.2 zcode-guide（0.3.0，配置地图）

`skills/zcode-configuration-guide/SKILL.md` 核心结论：

- 两级作用域：用户级 `~/.zcode/cli/config.json`（MCP servers、hooks、插件启停、技能/命令禁用覆盖）+ 工作区级 `<repo>/.zcode/config.json`（或 `zcode.json`）；指令文件 `~/.zcode/AGENTS.md` → `<repo>/AGENTS.md` 顺序注入。
- 技能/命令发现顺序（后者可被前者遮蔽）：显式配置根 → `~/.zcode/skills` → `~/.agents/skills` → 工作区逐级 `.zcode/skills` → `.agents/skills` → **启用的插件根（最低优先级）**。
- MCP 合并：CLI 覆盖 → 环境变量 → 用户 → 工作区 → 系统默认；**所有作用域（含工作区）的 MCP 服务器在会话启动时自动连接**（以前工作区要手动信任，现在默认信任）。
- 诊断技能 5 个（diagnosing-mcp/skills/commands/hooks/plugins），每个都是「症状→原因→检查→修复」流程。

---

## 4. 会话的脚本化/非交互机制（本报告核心，全部实测）

### 4.1 CLI 调用方式

`zcode` 不在 PATH；CLI 实体是 ZCode 桌面版内置的 Node 入口（documents 插件 manifest 同款调法）：

```bash
ELECTRON_RUN_AS_NODE=1 /e/ZCode/ZCode.exe /e/ZCode/resources/glm/zcode.cjs <command|options>
```

`--help` 实测（0.17.1）关键项：`app-server`（stdio 协议服务器）、`-p/--prompt <text>`（无头单发）、`--resume <sessionId>`（sess_...）、`-c/--continue`、`--output-format`（text|json|stream-json，从 bundle 解析出但未印在 help）、`--mode`（build|edit|plan|yolo|guarded，--prompt 默认 yolo）、`--target`、`--attach`、`--cwd`、`--workflow-mode`。完整参数 schema 从 zcode.cjs 解出（parseArgs 严格模式）：另有 `json/output-format/no-browser/browser-use/browser-executable/memory-bench/attach/cwd/locale/resume/target/target-replace/continue/force/toolsearch-mode/force-mcs/mode/verbose/prepare-storage/stdio/surface/workflow-mode/all/available/keep-data/scope/sparse`。

### 4.2 无头单发 `--prompt`：机制可用，但默认模型选择有坑

实测命令（scratch = `D:\tools\zcode-crosschat\.scratch`，为测试专建）：

```bash
ELECTRON_RUN_AS_NODE=1 /e/ZCode/ZCode.exe /e/ZCode/resources/glm/zcode.cjs \
  --prompt "只回复四个字符: PONG" --cwd "D:\tools\zcode-crosschat\.scratch"
```

- 会话确实创建并持久化（db.sqlite `session` 表新增 `sess_9162eb78-...`、`sess_bffa1a12-...`，directory=scratch，task_type=interactive——只读 SQL 实查）。
- **但本机该命令失败**：`APICallError Unauthorized ... url: https://cp.compshare.cn/v1/chat/completions, model: 'glm-5.2', responseBody: '{"error":"invalid api key"}'`。
- 根因（bundle + provider_config.json 佐证）：CLI 无 `--model` 参数；新无头会话的模型回落规则是「注册表里第一个非 hidden provider 的第一个可用模型」（zcode.cjs 内 `int()` 函数：`for (let t of e.registry.providers) if (t.config.visibility!=="hidden") for (let n of t.models) ...`），即 `~/.zcode/v2/provider_config.json` 的 `providerOrder[0]` =「优云智算」glm-5.2，其 API key 已失效。桌面端会话用的是账号 provider（`account:bigmodel-start-plan/GLM-5.3-Flash`，见 v2/config.json `builtin:bigmodel-start-plan` 节点），不走这个回落，所以桌面端正常、纯 CLI 新会话踩坑。
- 修复路径实测过三条：① `--model` 参数——**不存在**（parseArgs schema 无此项，传了会打印 help）；② prompt 里写 `/model`——**不会**被解析为斜杠命令（原样发给 LLM）；③ `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 环境变量重定向个人 provider 配置（bundle 内常量 `roe="ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"`、`Dit="provider_config.json"`）+ 注入 `defaultModelSelection`——配置文件能被读取（破坏 schema 时报「Select a model before sending a message」，证明读取生效），但 `defaultModelSelection`（根级与 config 级都试过）**在 --prompt 路径未被采用**，最终放弃该路径。
- **可行的正道是 §4.3/§4.4：用 app-server 显式 setModel，或 --resume 已有模型选择的会话。**

### 4.3 `app-server`：ZCode Protocol stdio 服务（推荐的编程通道）

启动：`ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs app-server`。协议实测特征：

- **行分隔 JSON，非 JSON-RPC 信封**：请求 `{"id":N,"method":"<name>","params":{...}}`，响应 `{"id":N,"result":{...}}` 或 `{"id":N,"error":{"code":...}}`；服务器主动事件只有 `{"method":"...","params":{...}}`。发 JSON-RPC 会被 zod 拒绝（`Unrecognized key: "jsonrpc"`，实测输出）。
- **无需握手**：启动后直接分发请求（发 `initialize` 得 `-32601 Method not found`，实测）。
- 方法面（zcode.cjs 常量表 + dispatch switch 实读）：`session/create|resume|list|send|stop|close|fork|compact|goal|setModel|setThoughtLevel|setMode|subscribe|messages|read|events|subagents|usage|cancelBackgroundTask`、`session/lifecycle/*`、`runtime/capabilities`、`provider/refreshRegistry|updateAccountConfig|testModelConnectivity`、`mcp/list`、`workspace/*`、attachment 系列、conversation 系列（v4 gateway）。

**完整闭环实测脚本**（临时脚本已删，命令与输出如下；脚本逻辑：spawn app-server → 行解析 → 回调应答）：

1. `session/create`：
   请求 `{"id":100,"method":"session/create","params":{"workspace":{"workspacePath":"D:\\tools\\zcode-crosschat\\.scratch","workspaceKey":"D:\\tools\\zcode-crosschat\\.scratch"},"mode":"yolo","titleGenerationEnabled":false}}`
   （workspace 两字段均必填，schema strict——zcode.cjs 内 `Il=m.object({workspacePath:Ru,workspaceIdentity:Ru.optional(),remoteSessionId:Ru.optional(),workspaceKey:Ru}).strict()`；params 其余可选字段：sessionId/parentSessionId/mode/model/persistence/thoughtLevel/titleGenerationEnabled/mcpServers/toolAllowlist/toolDenylist/importedHistory/offPeakToolEnabled/dynamicWorkflowEnabled/dynamicWorkflowMode）
   **注意**：create 过程中服务器会反问客户端 `{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_...","scope":"runtime-materialization"}}`，15 秒不答则 create 超时（`-32022 Client request timed out`，实测）。应答 `{"id":"server-1","result":{"nativeSearchEnhancementsEnabled":false}}` 即可（字段名由 zod 报错反推并实测通过；多给无关键会报 `Unrecognized key`）。
2. `session/setModel`：`{"method":"session/setModel","params":{"sessionId":"<sid>","model":{"providerId":"d1b9bdca-05ff-4937-ae0f-3d6069073761","modelId":"glm-5.3-flash","options":{"reasoningLevel":"max"}}}}` → 返回全量 projection。**必须带 reasoningLevel**（该模型要求；`options.reasoningLevel` 合法值会出现在 state.updated 事件的 `model.available[].reasoning.levels`，本机 glm-5.3-flash 为 low/high/max、默认 max）。只在 create params 里带 model 而不 setModel 时，turn 会以 `invalid_model_request: Reasoning level is required for ...` 失败（实测两次）。
3. `session/send`：`{"method":"session/send","params":{"sessionId":"<sid>","content":"只回复四个字符: PONG"}}` → `{"accepted":true,"sessionId":"...","stateRevision":2}`（params 用 `content` 字段；带 `message/kind/delivery` 会被 zod 拒绝，实测）。
4. 事件流（自动推送，无需 subscribe）：`state.updated`（status running/idle、model.available）、`v4/telemetry/event`（turn.started → model.request.status started/completed → stream.chunk → usage.delta → **turn.terminal status:"success"**）。`session/subscribe` 需要 transport 枚举（desktop-continuous|web-remote-replayable），本轮未调通完整 schema，但不影响收事件与轮询。
5. 回读：`session/messages` → `{"result":{"messages":[{"info":{role,finish,modelId,providerId,mode,tokens,...},"parts":[...]}}`（完整助手消息在 db `part` 表：type=text/reasoning/step-start/step-finish；`finish` 取值实测有 `"completed"` 与 `"stop"` 两种，提取时都要接受）。
6. `session/resume`：`{"method":"session/resume","params":{"sessionId":"<sid>","workspace":{...}}}` → 恢复会话（含持久化的模型选择），再 send 即续聊（实测：A 会话先答 391，resume 后问「乘以 2」答 **782**——记忆连续）。

### 4.4 两个独立会话并行（任务要求的直接证据）

同一 app-server 进程内并行创建/派发两个会话（`zc_two_sessions.py`，已删，输出摘录）：

```text
[3.9s] session A = sess_09386566-554e-4b2d-a80b-0784b740d0f8
[3.9s] session B = sess_33dc5b67-8aee-4c42-9e19-b7cf70db4f61
[4.0s] send A => {"accepted": true, ...}   # A 任务: 17*23 只回数字
[4.0s] send B => {"accepted": true, ...}   # B 任务: 反转 zcode-crosschat
# 两轮并行执行后（db part 表实查）：
#   A 助手回复 text: "391"            （tokens total 22869）
#   B 助手回复 text: "tahcssorc-edocz" （tokens total 23094）
```

随后 CLI 单发续聊同样验证记忆链（`--resume` + `--output-format json`，实测两次）：

```bash
ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs --resume sess_09386566-... \
  --prompt "把上一次结果再乘以 3，只回复数字" --cwd "D:\tools\zcode-crosschat\.scratch" --output-format json
# 第 1 次（×3）：tail 只截到 usage/projection 段（turn 成功、totalTokenCount 20784），response 字段未入摘录；
# 第 2 次（×5）完整输出：{"sessionId":"sess_09386566-...","response":"11730","usage":{...,"totalTokens":20829},
#                        "projection":{"status":"idle","turnCount":1,...}}
# 11730 = 2346×5 且 2346 = 782×3，反证第 1 次确实返回 2346：CLI resume 的跨进程会话记忆连续成立。
```

**结论：跨会话派发/执行/回收在 zcode 上完全可行**，两条通道都实测打通：
- 通道一（一次性）：`zcode --resume <sessionId> --prompt "<text>" --output-format json`——最简，前提是该会话已有持久化模型选择；
- 通道二（常驻编程面）：`zcode app-server`——session/list 枚举、create、setModel、send、messages、resume、fork、goal 全可用，是最接近 dsh `ctx.agents` 的对等物。

### 4.5 会话持久化（供状态查询/审计）

`~/.zcode/cli/db/db.sqlite`（只读查询实测）：表 `session`（id sess_...、directory、title、task_type: interactive|subagent_child|workflow_child、time_created/updated、last_outcome）、`message`、`part`（助手文本在此）、`session_input`（输入队列：sendText/sendGoalCommand/backgroundNotification × delivery startNow/queue）、`session_entry`（类型化条目，含 `runtime/model_selection`——模型选择按会话持久化的载体）、`model_usage`/`turn_usage`（token 审计）。另有 `~/.zcode/cli/rollout/model-io-*.jsonl` 落盘模型 IO。

### 4.6 本节坑位清单（给插件实现者）

1. 无头新会话默认模型回落到个人 providerOrder[0]，本机该 provider key 失效 → 新会话一律走 app-server setModel 或 resume 有模型选择的会话。
2. `session/create` 必须应答 `session/requestRuntimePreferences` 回调（15s 超时）；可能还有 `interaction/requestOfficialMcpAuthHeaders` 回调（实测回 `{}` 被接受，官方 MCP 相关）。
3. `session/setModel` 的 model 需要 `options.reasoningLevel`（至少对要求 reasoning 的模型）。
4. `session/send` 参数是 `content`；`session/messages` 的助手消息 `finish` 有 `completed`/`stop` 两种，且要过滤 `semantics.kind=="timeline_event"` 的系统时间线消息。
5. `session/subscribe` 参数 schema 未完全摸清（transport 枚举已知），但不订阅也能收到事件与轮询，非必需。
6. app-server 是单进程多会话：一个 app-server 进程可同时跑多个 session（§4.4 即两并行）；整个调研期间先后起过十余个 app-server 进程（串行、各即起即停），均与正在运行的桌面端互不干扰，但**多进程同时常驻的官方并发语义未确认**。
7. Windows 下必须 `ELECTRON_RUN_AS_NODE=1` 前缀调用 ZCode.exe（documents/zcode-site manifest 与本机全部实测一致）。

---

## 5. 推荐技术栈（对齐官方插件惯例）

**形态**：纯 zcode 插件（declarative resource pack），四组件全用官方支持的可执行面：

| 层 | 选型 | 依据 |
|---|---|---|
| 跨会话引擎 | 独立 Node **MCP server**（插件 `mcpServers` 内联配置，stdio），内部 spawn/长持一个 `zcode app-server` 子进程并实现协议客户端（行分隔 JSON） | 官方插件把可执行逻辑全部放 MCP（documents/zcode-site 的 `__zcode-plugin-host` 模式）；app-server 提供session/create|send|resume|list 全编程面（§4.3/4.4 实测） |
| 磁盘真源 | `<workspace>/` 下任务邮箱目录（team.json + inbox/*.jsonl 思路），MCP server 单进程读写 + lockfile(O_EXCL)/原子 rename | 07-机制分析 §8.2：这部分与宿主无关，可 1:1 移植；MCP server 常驻进程天然单写者 |
| captain 协议 | 插件 `skills`（SKILL.md 正文 = 协议全文 + 工具使用规范） | plugin-creator spec：skill 是给主会话模型的工作流注入点 |
| 快捷入口 | 插件 `commands`（如 `/xc-dispatch`、`/xc-status`，frontmatter 声明 `skills` + `$ARGUMENTS`） | zcode-site commands 实测格式 |
| 生命周期触发 | 插件 `hooks/hooks.json`（`SessionStart` 恢复值班状态、`Stop` 派发收尾），注意插件钩子自动启用 hook runner | zcode-configuration-guide :72-73 |
| 安全面 | `toolAllowlist`/`toolDenylist`（session/create 参数原生支持）+ 成员会话 `mode:"plan"` 限额 | vot schema 实测字段 |
| 工程化 | TypeScript + esbuild 打包单文件 `dist/mcp/server.mjs`；`zcode plugins validate` 入 CI；本地 `<workspace>/plugins/marketplace.json` 开发市场；发布走 GitHub 仓库源（本机 GitHub 访问按全局纪律走 codeload/api 通道） | browser-use/documents 均为 ts+esbuild 产物（package.json scripts 实测）；validate 实测可用 |
| 模型 | 会话默认用账号 provider（`account:bigmodel-start-plan/GLM-5.3-Flash`）——**注意：app-server 侧 setModel 用该 providerId 会报「Provider Registry 中不存在」**（实测），成员会话先用注册表内可用的模型（如本机 opencode glm-5.3-flash）或不显式 setModel 而依赖回调缺省；providerId 合法值可用 `state.updated` 事件的 `model.available[]` 在运行时枚举 | §4.3 实测 |

**最小可行切片**（对应第二目标两会话闭环）：MCP server 实现 4 个工具——`xc_spawn_member`（session/create+回调应答+setModel）、`xc_send`（session/send）、`xc_poll`（session/messages 轮询+提取 text parts）、`xc_resume`（session/resume+send）；磁盘真源只存 `sessions.json`（sid↔成员名映射）与任务 JSONL；skill 写 captain 协议。两会话闭环 = captain 会话调 xc_spawn_member 起 A/B，xc_send 派任务，xc_poll 收 A/B 结果——与 §4.4 的验证一一对应。

---

## 6. 对 07-机制分析报告 §8 的修正

- §8.2 「插件 MCP server 无法枚举/steer 任意会话」「跨会话通信只能邮箱轮询的弱化形态」——**已被实测推翻**：`zcode app-server` 提供完整的跨会话编程面（session/list 枚举、对任意会话 send、resume 续聊、fork、goal），本机两会话并行派发回收闭环已跑通（§4.4）。插件可以「MCP 常驻进程 + app-server 协议客户端」承担原报告中调度器的位置，邮箱仍保留作磁盘真源与崩溃恢复，但不再需要忍受「只有轮询」。
- §8.1 对插件结构的描述与本报告 §2 一致（双清单、`${CLAUDE_PLUGIN_ROOT}`、marketplace 格式），互为印证。

## 7. 给后续环节的直接可用资产

- 测试工作区：`D:\tools\zcode-crosschat\.scratch`（本次全部会话落点；可复用作联调工作区）。
- 已验证的会话样例（db.sqlite 中可 resume）：`sess_09386566-554e-4b2d-a80b-0784b740d0f8`（多轮记忆：391→782→2346→11730）。
- 协议客户端最小实现要点：spawn app-server → 逐行 JSON 解析 → 自动应答两类服务器回调 → create/setModel/send/messages 封装（§4.3 的 1-6 步即伪代码）。

## 8. 未确认 / 未验证事项（如实声明）

1. `session/subscribe` 完整参数 schema（transport 枚举值已知，但传 `desktop-continuous` 仍被 zod 拒绝，未继续摸）。
2. app-server 多进程并发官方语义、会话跨进程互斥（仅实测「能并存」，未做压力/一致性验证）。
3. `provider/*` 方法的参数 schema（refreshRegistry/testModelConnectivity 未调用）。
4. 插件 `agents` 字段是否可执行（官方两文档矛盾，§2.1；未做安装实验验证）。
5. `userConfig` 的模板变量全套展开行为（`${user_config.*}` 等，来自 07 报告引用的 android-emulator，本次未复测该插件）。
6. `--output-format stream-json` 的逐事件格式（只实测了 json）。
7. 无头新会话模型回落是否可被用户级 `defaultModelSelection` 永久修复（该键在 --prompt 路径实测未生效；可能需要桌面端「设为默认模型」UI 写入，未试）。
8. 临时文件纪律：所有探针脚本与隔离 provider 配置副本已删除（TEMP 清理实测 `ls | grep zc_` 为空）；.scratch 目录保留为联调工作区，内无文件。

---

## 9. v0.2.0 增补事实（P1–P5，2026-11-09 FEASIBILITY-V0.2 实测回填）

> 来源：`docs/FEASIBILITY-V0.2.md`（E1-E4 实验 + §4 平台事实表），证据根目录 `deepseek-crosschat/evidence/10-v020/feasibility/`。本节为**增补**，不改动上文 §4.3 的原始实测记录；与旧记录冲突处以下列 P1-P5 为准（本机 build 0.17.1，2026-11-09）。

| # | 事实 | 对旧记录的修正/细化 | 证据（FEASIBILITY 内） |
|---|---|---|---|
| P1 | `session/create` **结果内联** `settings.model.available[].ref` 全量模型表（本机 52 个）；35s 观察窗内无 `state.updated` 事件 | §4.3-2 / §4.6-1 的「运行时枚举 state.updated 的 model.available」方法**不可依赖**，降级为兜底；产品化实现取 create 结果深扫描 `{providerId, modelId}`（`plugin/src/engine/appserver.ts` absorbModels） | `_logs/raw-probe.log` |
| P2 | `finish=completed` 的 timeline 事件消息**无文本 parts**；按 finish 计数判定回合完成会把完成判早、真实回合被 app-server 退出腰斩 | §4.6-4 的「过滤 timeline_event」细化为可执行判据：assistant ∧ finish∈{completed,stop} ∧ **≥1 个 text part**（baseline 与 done 两处都要过滤；`plugin/src/engine/provision.ts`） | `_logs/ws-wake-bootstrap.log`、`_logs/b-register-resume.raw.json` |
| P3 | WMI（`Win32_Process Create`）拉起的进程继承 WmiPrvSE 的 **SYSTEM 环境**；zcode CLI 缺用户 env 时报「未找到 CLI ZCode Built-in Provider Config」无法启动回合 | 新坑位；WMI 逃逸路径（v0.2 预设计备选，未进插件代码）必须显式落盘/回读用户 env | `ws-wake/.crosschat/logs/wake-b-1794168533287.json` 尾行 |
| P4 | 会话持久化时机：`session/send` accept 后 **≤3s** 即落库（早于首轮回合完成）；app-server 硬杀后仍在 | §4.5 持久化载体的时机细化——引擎可在派发回合同步建员、供给完成即 kill keeper（`plugin/src/engine/provision.ts` finally） | `_logs/e4-dm-create.json` 的 `db.afterSend3s/afterTurn/afterKill` |
| P5 | CLI 单发回合进程退出时的清杀**沿活父链传播**：helper 孤儿与 WMI 子进程存活、MCP server（活父链上）的 detached 子进程被杀；不存在禁止 breakaway 的作业对象（E1-direct/E1-breakaway/E2-wmi/E3a 四组对照） | V9「作业对象清杀」论被修正；v0.2 的唤醒经立即退出的 node 跳板孤儿化（`dist/mcp/wake-helper.mjs`，W1）即避开活父链 | `_logs/e1-heartbeat-direct.log`、`e3a-turn-output.raw.json` 等 |

增补的坑位清单（接 §4.6 编号）：

8. 动态成员供给（xc_member_add）依赖 XC_ZCODE_EXE/XC_ZCODE_CJS 拉起瞬态 app-server keeper：create 过程必须应答 `session/requestRuntimePreferences`（§4.6-2 同坑）；模型缺失/未登录时 P1 主路径枚举为空，须显式配置 member_model。
9. `session/resume` 可在**全新 app-server 进程**里恢复 db 中的既有会话并续聊（wake-chain-run.mjs:105 实测，幂等重供给路径依赖此点）；跨进程模型选择随会话持久化（§4.5 `session_entry.runtime/model_selection`）。
