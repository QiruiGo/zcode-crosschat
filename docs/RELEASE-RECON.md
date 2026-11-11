# RELEASE-RECON：分发机制实测报告（发布工程·侦察环节）

- 日期：2026-11-10；执行：分发侦察员（动态工作流子代理）
- 范围：为「陌生人三步装通」实测分发机制；**临时隔离沙箱实验，未动正式仓代码**（仅新增本文件）
- 方法与证据根：`deepseek-crosschat/evidence/14-release/recon/`（01-网络获取路径.md、02-市场形态与dist行为.md、03-进程与exe探测事实.md、04-沙箱与复现说明.md + r14/ 沙箱实物）
- 环境基线：Windows 11 + Git Bash；zcode 0.17.1（`<安装目录>\ZCode.exe` + `<安装目录>\resources\glm\zcode.cjs`，ZCode 3.17.2 装于 E 盘非默认路径）；gh 2.103.3 已登录；主网无代理

---

## 0. 结论速览

| # | 问题 | 实测结论 |
|---|---|---|
| 1 | 陌生用户能否拿到仓库？ | **三条路径全部可行但可靠性分层**：codeload 源码 tgz 最稳（3/3 次 200）；git clone 直连间歇可用（本次通）；github.com 443（Release 资产下载）间歇阻断（2 次连接超时，同刻 codeload 200） |
| 2 | Release 资产怎么发、怎么下？ | draft 资产对匿名 404（须 publish）；`gh release download` 全链路实测通；`--target` 必须传 SHA（tag 名 422）；**`gh release delete` 会连带删除 tag** |
| 3 | install 对 dist 的真实需求？ | **install 是纯目录拷贝：不跑 npm install、不跑 build**。源码形态（clone/源码 tgz/github 形态）不先构建 → install/validate 全绿但插件静默坏（无 dist/mcp/server.mjs） |
| 4 | 预构建 tgz 能否直接用？ | **能**。dist+node_modules 打进 tgz → 解包 → `marketplace add` → `install` → cache 完整、md5 与构建产物一致。prune --omit=dev 后整包仅 4.4MB（全量 28MB） |
| 5 | zcode_exe/zcode_cjs 能自动探测吗？ | **能，有可靠顺序**（§3.4）：env → 进程表 → 父链 1 跳 → 注册表反推 → 常见路径；cjs 由 exe 目录推导（`resources\glm\zcode.cjs`）。hook/MCP 进程 env **无** exe 线索（probe 实测） |

---

## 1. 获取路径与市场源形态（对应任务 1）

### 1.1 三条远程路径实测

| 路径 | 命令 | 实测 |
|---|---|---|
| A. git clone | `git clone https://github.com/QiruiGo/zcode-crosschat` | exit=0（00:55）；全局经验：git 协议间歇被重置 |
| B. codeload tgz | `curl -L https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/tags/v0.3.0` | 200 / 535,387 B / 1.1s（两次全通）；**无 dist 无 node_modules** |
| C. Release 资产 | `gh release create <tag> --draft --target <SHA>` + `gh release upload` + `gh release download` | 创建/上传/下载全通（预演后已删）；draft 匿名 404；published 资产匿名下载未获成功样本（github.com 阻断时段，见 §1.2） |

现状：仓库 tags v0.1.0/v0.2.0/v0.3.0，**Release 为零**。

### 1.2 网络可靠性（本机样本，直接影响 strangers）

- github.com 443：00:55 通（clone）；01:06 通（draft 404 响应）；01:08/01:10 资产连接超时 21s×2；01:12 push 失败 —— **间歇阻断**。
- codeload.github.com：同刻 200/1.0s —— **独立域名且稳定**，是天然兜底通道。
- api.github.com：全程通（认证/匿名）。
- 对发布 README 的要求：主推 Release 资产，**必须**同时给出 codeload 源码 tgz 兜底；提示网络受限用户可设 `ZCODE_HTTP_PROXY`（插件平台市场克隆只认它，docs/PLATFORM.md §2.3「代理坑」）。

### 1.3 `marketplace add` 对两种"远程获取后"形态的可用性

| 形态 | add 方式 | 实测 |
|---|---|---|
| clone 下来的目录 | `plugins marketplace add <clone目录>`（隔离配置） | exit=0 "Added marketplace dev-zcode-crosschat (1 plugins)" |
| 解包的 Release 目录 | 同上（tgz 解包后目录） | exit=0，install 后 cache dist/nm 齐全 |
| github 形态（zcode 内部 clone） | `plugins marketplace add QiruiGo/zcode-crosschat` | exit=0（内部 clone 当时段直连可用） |

快照语义（v0.2 §2.2 复验+细化）：`add` = 对源做**拷贝时点快照**；install 只在 cache 缺失/版本变化时物化，物化仍是拷贝。**改动源目录后快照不会自动跟进**。

## 2. 安装物化对 dist 的真实需求（对应任务 2）

### 2.1 平台行为铁律（本轮最小实验实锤）

- **install 不跑 `npm install`**：干净源（无 nm）add→install 后 cache nm: NO（对照 case-clone 的 nm YES 归因为 add 时源里恰有 npm ci 产物，时序对照实验 cfg-tgz 排除歧义）。
- **install 不跑 build**：install（00:59:43）时源无 dist，cache 无 dist；即便后来源里构建出 dist，快照/-cache 均不更新。
- **无 dist ≠ 报错**：install exit=0 且 `[enabled]`；`plugins validate` 报 `Plugin manifest is valid`。坏插件零告警，直到会话加载时 MCP/hooks 路径 404。
- 平台自动物化的是**内置官方插件播种**（隔离配置里官方市场 cache 被批量填充），第三方插件无此待遇。

### 2.2 预构建包（dist 打进 tgz）直接可用

cfg-prebuilt / cfg-rel（经 gh release download 的资产）双重复验：

```
install → cache dist: YES, node_modules: YES
md5(dist/mcp/server.mjs) 619165d8… == 构建产物
validate → Plugin manifest is valid
```

瘦身实测：`npm prune --omit=dev` 101M→24M；`node --input-type=module -e "await import('…/dist/mcp/server.mjs')"` 冒测通过；整包 28,086,315 B → **4,401,050 B**。

### 2.3 发布形态定论（给发布环节）

1. **Release 资产主通道**：`zcode-crosschat-<ver>-prebuilt-slim.tar.gz` = 整仓打包（含 `marketplace.json` + `plugin/{dist,node_modules,…}`），构建序列 `npm ci --omit=dev && npm run build` 后 tar，排除 `.git`。陌生人：下载 → 解包 → `zcode plugins marketplace add <解包目录>` → `zcode plugins install zcode-crosschat@dev-zcode-crosschat` → 填 zcode_exe/zcode_cjs。
2. **兜底通道**：codeload 源码 tgz（快照小、稳定），README 必须写明该形态需要 `npm install && npm run build` **在 add 之前**完成（顺序红线）。
3. github 形态（`add QiruiGo/zcode-crosschat`）适合跟踪 main 开发版，同样受「无 dist」约束。

## 3. zcode_exe / zcode_cjs 自动探测（对应任务 3）

### 3.1 实测事实（详证见 03-进程与exe探测事实.md）

- 消费点：`plugin/.zcode-plugin/plugin.json:25-26` → env `XC_ZCODE_EXE/XC_ZCODE_CJS` → `plugin/src/engine/resume-cli.ts`（spawn `ELECTRON_RUN_AS_NODE=1 <exe> <cjs> --resume …`）。
- **MCP/hook 进程（manifest command:"node"）跑在系统 node.exe 下**（execPath≠ZCode.exe），但其 **parent 就是 ZCode.exe（1 跳）**（Win32_Process 实拍，0.3.4 cache 的 server.mjs 进程 ppid=ZCode.exe）。
- exe+cjs 运行形态下 `process.execPath` 即 ZCode.exe：`zcode doctor` 实测 `process: <安装目录>\ZCode.exe`、`node: v24.21.0`。
- 插件进程 env **没有** exe 路径线索（probe hook 84 键过滤集 + 本会话 bash 全集实测均无 `ELECTRON_RUN_AS_NODE`/`ZCODE_NODE_FALLBACK_EXEC_PATH`/路径类 ZCODE_*；node.cmd fallback shim 存在但默认场景未注入）。
- 注册表（HKCU per-user NSIS）：`DisplayName=ZCode 3.17.2`，**InstallLocation 为空**，`UninstallString="<安装目录>\Uninstall ZCode.exe" /currentuser` → 需反推安装根。
- 本机 `where zcode` 无 PATH shim；`%LOCALAPPDATA%\Programs` 无 ZCode（装在自定义盘 <安装目录>）——**硬编码默认路径不可靠**。
- cjs 与 exe 同根推导成立：`<安装根>\resources\glm\zcode.cjs`（单机样本；`glm` 段稳定性未确认，需 glob 兜底）。

### 3.2 探测顺序（建议实现）与降级

1. env `XC_ZCODE_EXE`/`XC_ZCODE_CJS`（已配置则直接用）；
2. 进程表枚举 `ZCode.exe` 的 ExecutablePath（`Get-Process ZCode | Select Path`/Win32_Process；活进程=必装，覆盖任意盘符）；
3. 父链 1 跳 ppid → ZCode.exe（hook/MCP 进程恰好 1 跳；Windows 下需 PowerShell/WMI）；
4. HKCU+HKLM(WOW6432Node) `Software\Microsoft\Windows\CurrentVersion\Uninstall\*` 按 DisplayName~`ZCode` 枚举 → UninstallString 反推安装根 → `<根>\ZCode.exe` 存在性校验；
5. 常见路径兜底：`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`、`C:\Program Files\ZCode\ZCode.exe`；
6. cjs 推导：`<exe_dir>\resources\glm\zcode.cjs` 存在性 → glob `<exe_dir>\resources\*\zcode.cjs`；
7. 全败 → 维持手填，报错文案（resume-cli.ts:141）附「已尝试的探测线索」辅助用户定位。

**降级红线**：探测结果只用于预填建议/报错提示，**不自动改写 user_config**（v0.2 §2.4 options 事故敏感区）。另本轮实测：0.17.1 的 `plugins uninstall --force` 只清目标插件自身 options（crosschat options 完好），与 v0.2 记录的"清空全部"不同——原因未确认，自动写配置仍应保守。

## 4. 未确认事项（如实声明）

| 项 | 状态 |
|---|---|
| published Release 资产的**匿名**下载成功样本 | 未取得（github.com 阻断时段，jq 对照组两次连接超时）；draft 匿名 404 已实测；认证下载已实测 |
| headless `--prompt` 会话的 SessionStart hook / MCP spawn 生命周期 | 未触发（probe2 两次实测无 dump 落盘）——hook/MCP 进程 env 全集未取得，3.1 结论基于进程枚举+现有 probe 记录 |
| `resources\glm\zcode.cjs` 在其他机器/版本的路径稳定性 | 单机样本（ZCode 3.17.2 @ <安装目录>） |
| `marketplace add` 的 url 形态（tgz URL 直装） | 未测（任务未点名；沙箱并行记录 zst-tgz 可参考） |
| `marketplace update` 的远程刷新链路（url/github 源） | 本轮仅测 version bump 本地重物化（probe2 0.1.0→0.1.1），远程刷新未测 |
| `gh release delete` 连带删 tag | 实测发生（push --delete 因网络未执行而 tag 已消失）；是 gh 行为还是 GitHub 端 draft 语义未细分 |

## 5. 证据索引

- `recon/01-网络获取路径.md` — 路径 A/B/C 命令与输出全文、网络可靠性分层
- `recon/02-市场形态与dist行为.md` — 五 case 物化对照表、命令输出、md5、瘦身数据
- `recon/03-进程与exe探测事实.md` — 进程实拍、注册表、doctor、env 事实、探测顺序
- `recon/04-沙箱与复现说明.md` — 隔离方法（`ZCODE_STORAGE_DIR`）、r14 内容索引、清理记录
- `recon/r14/` — clone 实物、源码 tgz、预构建 tgz（全量/slim）、探针插件、config 备份
- 既有事实引用：`docs/PLATFORM.md` §2.3（source kind/代理坑/cache 布局）、`docs/IMPLEMENTATION.md:360`、`reports/10-v020验收.md` §2.2/§2.4、`reports/12-v030验收.md`
