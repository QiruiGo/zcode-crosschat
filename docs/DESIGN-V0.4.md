# DESIGN-V0.4：发布工程设计（陌生人三步装通）

- 日期：2026-11-10；作者：发布工程设计师（动态工作流子代理）
- 修订 v2（2026-11-10 复核轮）：**F1** 校验和按资产原名校验（S1/S4/RELEASING §6：`curl -L -o z.tgz` 改名后 `sha256sum -c` 必 FAILED open or read，复核方 TEMP 实测复现）；**F2** zcode-locate 增加 `ZcodeProbe` 注入缝（否则测试只能跑真 PowerShell，全败场景在本机不可构造）；**F3** S2c 断言取材点修正（误配置救回断言 doctor attempts + engine.jsonl，guidance 断言归单测）；**F4** env 判定先于缓存返回（§2.7 不变式落到代码序）；**F5** 快速开始硬性要求内联可执行调用形态、UI 路径措辞降级「以桌面实际界面为准」；**F6** S2b 钉住 member_model；**F7** commands:1 兜底措辞带入大纲；**F8** U1 强化（执行期 ≥3 窗重试）。小项：pack 版本断言改读 stage 树；win32 下 tar 可能解析为 System32 bsdtar（与 GNU tar 对本文用法等价，已记录）。
- 范围：把 v0.3.0 功能完整的插件变成「陌生用户从 GitHub 直接下载安装」的可分发产品
- **范围红线（用户澄清 2026-11-10）**：上插件市场、渠道调研、CI、多 OS 实测**均不在本版范围**；README 如实标注「仅 Windows 实测」即可
- 硬验收标准：规划方定死六条（见 §5），全部达成才算通过

## 输入基线（本设计的全部依据）

| 输入 | 位置 | 用途 |
|---|---|---|
| 分发侦察报告 | 仓内 `docs/RELEASE-RECON.md`（§0-§5）+ 证据 `deepseek-crosschat/evidence/14-release/recon/`（01 网络 / 02 物化 / 03 探测 / 04 沙箱） | 获取路径、install 物化铁律、预构建包、探测顺序的全部实测事实 |
| 安装痛点审计 | `deepseek-crosschat/evidence/14-release/pain-audit.md`（P1-P12） | README 重写与零配置改造的问题清单 |
| v0.3.0 验收报告 | `deepseek-crosschat/reports/12-v030验收.md`（七条硬标准全过） | 回归基线与演示形态 |
| 平台事实基线 | 仓内 `docs/PLATFORM.md`（§2.3 安装机制、§4.1 CLI 不在 PATH、§4.2 模型回落坑） | 调用方式与配置语义 |
| 现状代码 | `plugin/.zcode-plugin/plugin.json`、`plugin/src/engine/{resume-cli,appserver,wake,provision}.ts`、`plugin/src/mcp/server.ts`、`plugin/package.json` | 消费点与版本位置 |

本设计环节实跑核对（本会话执行，非转述）：`git log --oneline -5` → HEAD=`f951549`（= tag `v0.3.0`），`git status` 仅 `docs/RELEASE-RECON.md` 未提交；`git tag -l` → v0.1.0/v0.2.0/v0.3.0（**Release 为零**，RELEASE-RECON.md:32）；`gh --version` → 2.103.3，`gh auth status` → 已登录 QiruiGo（scopes 含 `repo`）；`which tar && tar --version` → `/usr/bin/tar`，GNU tar 1.35。其余网络/release 动作属验收环节，本环节未跑（§7 如实声明）。

---

## 0. 结论速览

| # | 决策 | 定案 | 依据 |
|---|---|---|---|
| D1 | 产物形态 | `zcode-crosschat-<ver>-prebuilt-slim.tar.gz`（整仓 + `plugin/dist` + prune 后 `plugin/node_modules`，无 `.git`）+ 同名 `.sha256` | RELEASE-RECON.md:74（§2.3 定论）；slim 4.4MB 实测全链路通（recon/02 §2.3：cfg-rel 复验 `cache dist: YES, nm: YES`，md5 与构建产物一致） |
| D2 | 主路径 | **Release 资产下载**（唯一「零构建 ≤3 步」路径） | RELEASE-RECON.md:17/74 |
| D3 | 兜底与开发者路径 | codeload 源码 tgz 与 git clone 保留，**必须先 `npm install && npm run build` 再 add**（顺序红线写入 README） | recon/02:46（「无 dist 源=全程绿灯的静默坏插件」）；RELEASE-RECON.md:75 |
| D4 | 版本 | **v0.4.0**；五处同步（plugin.json / marketplace.json / package.json / package-lock 两处 / SERVER_VERSION） | IMPLEMENTATION.md §9.4（v0.3 package-lock 漏更教训）；`plugin/src/mcp/server.ts:35` |
| D5 | 零必填配置 | 新增 `zcode-locate.ts` 自动探测（env→execPath→进程表→父链→注册表→常见路径），**只用于内存中的 spawn 决策，不写 user_config**；失败给明确指引 + 新增只读工具 `xc_doctor` | RELEASE-RECON.md §3.2 探测顺序与降级红线；硬标准 2「探测失败给指引而非静默不可用」 |
| D6 | 发布通道 | `gh release create v0.4.0 --target <SHA>`（正式非 draft）+ `gh release upload`；改资产用 `--clobber`，**禁用 `gh release delete`** | RELEASE-RECON.md:15（SHA 必须、draft 匿名 404、delete 连带删 tag 三条实测） |
| D7 | 市场名 | `dev-zcode-crosschat` **不改名** | pain-audit P10（pain-audit.md:132）：改市场名=换插件身份，老用户 cache/安装记录断裂；不阻断本版目标 |
| D8 | 硬标准 1 的适用面解读 | ≤3 步零构建主张**限定在 Release 主路径**；clone/源码 tgz 如实保留构建两命令（开发者路径） | recon/02:10-11 铁律：install 是纯目录拷贝，源码形态不构建必坏；RELEASE-RECON.md:75 定论与标准 3「至少一条全程实测通过」一致 |

---

## 1. 分发策略定型（任务 1）

### 1.1 产物形态与命名

资产名：**`zcode-crosschat-0.4.0-prebuilt-slim.tar.gz`**（每版一个，版本进文件名）+ **`zcode-crosschat-0.4.0-prebuilt-slim.tar.gz.sha256`**。

- 包内容 = tag 树整仓（`marketplace.json` + `plugin/` 全部跟踪文件）+ `plugin/dist/`（5 产物，`scripts/build.mjs` 入口表）+ prune 后的 `plugin/node_modules/`（`npm prune --omit=dev`，101M→24M、整包 28,086,315B→4,401,050B，recon/02 §2.3 实测；prune 后 `dist/mcp/server.mjs` 用系统 node import 冒测通过）。
- 排除 `.git`（worktree 导出天然无）。顶层目录名 = `zcode-crosschat-0.4.0/`（解包即市场根，`marketplace.json` 在其下）。
- 不发 zip、不装安装器、不做 npm 包（平台 source kind 不支持 npm，PLATFORM.md:95）。

### 1.2 获取路径矩阵

| 路径 | 陌生人所见 | 零构建？ | 实测依据 | README 处理 |
|---|---|---|---|---|
| **A. Release 资产下载**（主推） | 下载→解包→add→install→list | ✅ | 预构建 tgz 解包→add→install 直接可用（recon/02 cfg-prebuilt 转写：`Installed plugin zcode-crosschat@dev-zcode-crosschat (0.3.0) [enabled]`，`cache dist: YES, cache nm: YES`）；认证下载 `gh release download` 全链路通（RELEASE-RECON.md:30）；**published 资产匿名下载尚无成功样本**（github.com 阻断时段，RELEASE-RECON.md:106）——§5-S3 验收必须补上真实样本 | 快速开始唯一主路径 |
| B. git clone https | clone→**npm install && npm run build**→add→install→list | ❌ | clone exit=0 间歇可用（RELEASE-RECON.md:28）；干净 clone 无 dist 无 node_modules（.gitignore `node_modules/` `dist/` 两行）；不构建=静默坏插件（recon/02:46） | 开发者路径，构建两命令+顺序红线 |
| C. codeload 源码 tgz（兜底） | 同 B（curl 替代 clone） | ❌ | 3/3 次 http=200 / 535KB / 1.1s，最稳通道（RELEASE-RECON.md:29、§1.2）；`tar -tzf` 内容完整（pain-audit.md:55-57） | 网络受限兜底，同 B 红线 |
| D. `plugins marketplace add QiruiGo/zcode-crosschat`（github 形态） | 一条命令，zcode 内部 clone | ❌ | exit=0（RELEASE-RECON.md:47）；受同一「无 dist」铁律约束（recon/02:14 cfg-gh 行） | 进阶用法一笔带过，不进快速开始 |

网络受限提示（recon 定论，RELEASE-RECON.md:39）：README 写明市场克隆只认 `ZCODE_HTTP_PROXY`（PLATFORM.md:105）。

### 1.3 版本号定版

**v0.4.0**（tag `v0.4.0`）。语义：功能面与 v0.3.0 持平（无新增协作能力），增量=分发工程（预构建产物、零配置探测、doctor、README 重写），按语义化版本取次版本号。五处同步（冻结清单见 §3.2）：

1. `plugin/.zcode-plugin/plugin.json` `version`（现 0.3.0，plugin.json:3）
2. `marketplace.json` `plugins[0].version`（现 0.3.0，marketplace.json:8）
3. `plugin/package.json` `version`（现 0.3.0，package.json:3）
4. `plugin/package-lock.json` 根 `version` 与 `packages[""].version`（实测在第 3、9 行两处）
5. `plugin/src/mcp/server.ts` `SERVER_VERSION`（现 `"0.3.0"`，server.ts:35）

版本必须递增否则宿主不重新物化（FEASIBILITY-V0.3 §6.1，IMPLEMENTATION.md §9.4 引）；v0.2 曾漏 lock 根版本（IMPLEMENTATION.md §9.4），本版打包脚本对此做机器断言（§3.3 步骤 1）。

### 1.4 构建-打包序列（实测序列为准，纠正侦察报告建议行）

RELEASE-RECON.md:74 建议行写的是「`npm ci --omit=dev && npm run build` 后 tar」——**该顺序不可行**：`esbuild` 在 devDependencies（plugin/package.json:18），`--omit=dev` 后无构建工具链。侦察期**实际执行的、且经 cfg-rel 全链路复验的序列**（recon/02 §2.3 转写）是：

```
npm ci（完整依赖）→ npm run build（产出 dist 5 产物）→ npm prune --omit=dev → tar czf
```

打包脚本（§3.3）按实测序列实现，并在 import 冒测（`IMPORT_OK` 口径，recon/02:57）与五处版本断言上加机器护栏。

### 1.5 硬标准 1 的适用面解读（显式声明，避免验收歧义）

硬标准 1 原文：「从 GitHub 远程获取仓库（真网络下载：git clone https 或 Release 包，非本地路径）后，按新 README ≤3 步装通（plugins list 显示 enabled），全程不需要 npm install/npm run build」。本设计将其解读为：

- **「远程获取」= 获取行为必须真实走网络**（clone 或 Release 下载均可，排除本地路径作弊）；
- **「≤3 步零构建」= README 主推路径（Release 资产）必须满足**——这是平台物化铁律下唯一可能的形态：install 是纯目录拷贝、不跑 npm install 不跑 build（recon/02:10-11 五 case 铁律），源码形态不预构建必然是「全程绿灯的静默坏插件」（recon/02:46）；
- clone / codeload 源码 tgz 作为开发者/兜底路径如实保留构建两命令（标准 3 明文允许「至少一条全程实测通过」；RELEASE-RECON.md:75 定论同此）。

若规划方要求两条路径都零构建，备选方案是把预构建产物提交进 git（或维护 release 分支）——代价是每版 ~10MB 生成物入库 + `.bin` 平台差异风险，且侦察未实测该形态，本版不取。

---

## 2. 零必填配置改造（任务 2）

### 2.1 现状与消费点

`zcode_exe`/`zcode_cjs` 是 lead-成员团队自动开工的 3 必填中的两项（pull 与 peer 均 0 必填，pain-audit.md §4 表实测属实）。现有消费链：

| 消费点 | 位置 | 现行为 |
|---|---|---|
| manifest env 注入 | `plugin/.zcode-plugin/plugin.json:25-26` | `${user_config.zcode_exe}` → `XC_ZCODE_EXE`（cjs 同理） |
| 唤醒配置读取 | `plugin/src/engine/resume-cli.ts:75-82`（`wakeSpawnConfigFromEnv`）+ `plugin/src/engine/wake.ts:481` | env 空 → 空串 |
| 唤醒拒绝 | `resume-cli.ts:138-143` | 同步抛「请在插件设置中填写本机 zcode 路径」→ attemptWake 降级 mailbox（**用户视角近乎静默**） |
| 供给配置读取 | `plugin/src/engine/appserver.ts:38-46`（`appServerConfigFromEnv`）+ `plugin/src/engine/provision.ts`（`AppServerKeeper.start`） | 同上 |
| 供给拒绝 | `appserver.ts:141-147` | 同步抛错 → `member_provision_failed` |
| 模型缺省 | `provision.ts:223`（`spec.model ?? XC_MEMBER_MODEL`）→ `pickModel`（provision.ts:141-167） | 留空=枚举表第一个（P1 主路径，PLATFORM.md:271）；第一个可能是失效 key（PLATFORM.md:153 的 providerOrder[0] 坑） |

痛点：探测事实已具备（RELEASE-RECON §3.1）但无实现；`zcode_exe` 无示例值无查找指引（pain-audit P3，pain-audit.md:125）；探测失败无指引（硬标准 2 禁止静默）。

### 2.2 探测顺序（每步的实测依据）

沿用 RELEASE-RECON.md §3.2 的七步顺序，逐步对应实测事实：

| 步 | 手段 | 实测依据（RELEASE-RECON §3.1 / recon/03） |
|---|---|---|
| ① | env `XC_ZCODE_EXE`/`XC_ZCODE_CJS` 非空且文件存在 → 直接用 | 用户显式配置最优先（现行为不变） |
| ② | `process.execPath` basename==ZCode.exe → 候选 | exe+cjs 运行形态下 execPath 即主程序（zcode doctor 实测 `process: <安装目录>\ZCode.exe`）；本插件 manifest 为 command:"node"，此步通常不命中，但对齐宿主形态变化零成本 |
| ③ | 进程表枚举 `ZCode.exe` 的 ExecutablePath（PowerShell `Get-CimInstance Win32_Process`） | 活进程=必装，覆盖任意盘符；MCP 进程跑在系统 node 下但宿主 ZCode.exe 必在场 |
| ④ | 父链 1 跳：`process.ppid` → WMI 查 ExecutablePath | MCP/hook 进程 parent=ZCode.exe **恰好 1 跳**（Win32_Process 实拍） |
| ⑤ | 注册表 HKCU + HKLM + HKLM\WOW6432Node `...\Uninstall\*`，DisplayName~ZCode → UninstallString 反推安装根 | InstallLocation 为空，只能反推（实测 `UninstallString="<安装目录>\Uninstall ZCode.exe" /currentuser`） |
| ⑥ | 常见路径兜底：`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`、`%ProgramFiles%\ZCode\ZCode.exe`、`%ProgramFiles(x86)%\ZCode\ZCode.exe` | 样本机装自定义盘证明默认路径不可靠，但标准安装形态仍值得兜底 |
| ⑦ | cjs 推导（对 ②-⑥ 每个 exe 候选执行）：`<exe_dir>\resources\glm\zcode.cjs` 优先 → glob `<exe_dir>\resources\*\zcode.cjs` | cjs 与 exe 同根推导成立（单机样本）；`glm` 段稳定性未确认 → glob 兜底 |
| ⑧ | 全败 → 空配置 + 明确指引（错误文案/`xc_doctor`/README），维持手填 | 硬标准 2「探测失败时给出明确指引」 |

设计决策：保持侦察报告的 ③④ 先后（进程表先于父链）不变；多 ZCode 安装的机器上进程表可能命中另一安装根，缓解=候选必须配对出 cjs 才算命中 + env 永远可覆盖。探测用 `spawnSync` + PowerShell（每步超时 4s，windowsHide）；**非 Windows 直接跳过 ②-⑥**（探测仅按 Windows 实测实现，与范围红线一致）。

### 2.3 新模块 `plugin/src/engine/zcode-locate.ts`（全文）

```ts
/**
 * v0.4 零必填配置 —— zcode_exe / zcode_cjs 自动探测（DESIGN-V0.4.md §2）。
 *
 * 探测事实基线（docs/RELEASE-RECON.md §3.1；证据 recon/03-进程与exe探测事实.md）：
 *  F1 manifest command:"node" 的 MCP/hook 进程跑在系统 node.exe 下，parent=ZCode.exe 恰好 1 跳；
 *  F2 exe+cjs 运行形态下 process.execPath 即 ZCode.exe（zcode doctor 实测）；
 *  F3 插件进程 env 无 exe 路径线索（probe 84 键过滤集实测）；
 *  F4 注册表 Uninstall 项 InstallLocation 为空，只能从 UninstallString 反推安装根；
 *  F5 cjs 由 exe 同根推导：<exe_dir>\resources\glm\zcode.cjs；glm 段稳定性未确认 → glob 兜底；
 *  F6 硬编码默认路径不可靠（样本机装自定义盘，where zcode 无 shim）。
 *
 * 降级红线（RELEASE-RECON §3.2）：本模块结果只在内存中参与本次 spawn 决策，
 * 绝不写回宿主 user_config/options（v0.2 §2.4 options 事故敏感区）。
 * 每次定位结果由调用方落审计（engine.jsonl zcode-locate 行）并可经 xc_doctor 查看。
 *
 * 同步性：探测用 spawnSync（PowerShell 只读进程表/注册表），单步超时 4s，windowsHide；
 * 只在推送唤醒（attemptWake）与成员供给（provisionMember）路径调用——pull 协作与
 * peer 消息零成本不受影响。成功结果进程内缓存；失败不缓存（机器状态可变，探测成本低）。
 * 注入缝（复核轮 F2）：探测步以 ZcodeProbe 类型参数注入（默认真 PowerShell），
 * 测试用假 probe 模拟全败/命中顺序——本机 ZCode 在装，真全败不可构造。
 * 不变式（复核轮 F4）：env 判定先于缓存返回，env 命中不读不写缓存——
 * 「env 永远可覆盖探测结果」不依赖调用时序。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ZcodePair {
  /** ZCode.exe 绝对路径。 */
  exe: string;
  /** 与 exe 同根的 CLI 入口脚本绝对路径（resources\<variant>\zcode.cjs）。 */
  cjs: string;
}

export type LocateSource =
  | "user_config" | "exec_path" | "process_table" | "parent_process"
  | "registry" | "common_paths" | "";

/** 单步探测留痕（xc_doctor 与失败指引共用）。 */
export interface LocateAttempt {
  step: string;
  hit: boolean;
  detail: string;
}

export interface LocateOutcome {
  found: boolean;
  source: LocateSource;
  pair: ZcodePair | null;
  attempts: LocateAttempt[];
  /** found=false 时的用户指引（工具回执 / doctor / 错误文案共用一份）。 */
  guidance: string;
}

/** 探测失败时的统一指引（DESIGN-V0.4 §2.7：明确指引而非静默不可用）。 */
export const LOCATE_GUIDANCE =
  "未找到本机 zcode 可执行文件（自动探测未命中），推送唤醒与成员供给暂不可用；" +
  "两会话 pull 协作不受任何影响。任选其一修复：" +
  "① zcode 桌面端 → 设置 → 插件 → zcode-crosschat → 插件设置，填写 zcode_exe" +
  "（zcode 安装目录下的 ZCode.exe）与 zcode_cjs（同目录 resources\\<variant>\\zcode.cjs）；" +
  "② 在会话里运行 xc_doctor 查看已尝试的探测线索。";

const PROBE_TIMEOUT_MS = 4000;

/** 探测函数类型：单步只读探测的注入缝（测试用假 probe 模拟全败/命中顺序，§5-S2c-②）。 */
export type ZcodeProbe = (script: string) => string;

/** 默认实现：spawnSync PowerShell（进程表/注册表；失败/超时一律返回空串）。 */
function psProbe(script: string): string {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true,
  });
  return (r.status === 0 && typeof r.stdout === "string" ? r.stdout : "").trim();
}

/** F5：由 exe 目录推导 cjs 候选（glm 段优先，其余 resources 子目录按名排序 glob 兜底）。 */
export function deriveCjsCandidates(exeDir: string): string[] {
  const resDir = join(exeDir, "resources");
  if (!existsSync(resDir)) return [];
  try {
    return readdirSync(resDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => (a === "glm" ? -1 : b === "glm" ? 1 : a.localeCompare(b)))
      .map((d) => join(resDir, d, "zcode.cjs"))
      .filter((c) => existsSync(c));
  } catch {
    return [];
  }
}

/** exe 候选 → (exe, cjs) 配对；配不到 cjs 视为未命中（spawn 需要成对，F5）。 */
export function pairFromExe(exe: string): ZcodePair | null {
  if (exe.trim() === "" || !existsSync(exe)) return null;
  const cjs = deriveCjsCandidates(dirname(exe))[0];
  return cjs ? { exe, cjs } : null;
}

/** F4：UninstallString（如 `"<安装目录>\Uninstall ZCode.exe" /currentuser`）→ 安装根。 */
function installRootFromUninstallString(uninstallString: string): string {
  const m = /^\s*"([^"]+)"/.exec(uninstallString) ?? /^\s*(\S+)/.exec(uninstallString);
  return m ? dirname(m[1]!) : "";
}

let cache: LocateOutcome | null = null;
/** 测试注入点：清空成功缓存。 */
export function resetLocateCache(): void { cache = null; }

/** 主入口：env 判定最先（不变式「env 永远可覆盖探测结果」，§2.7）→ 缓存 → 按序探测；
 * probe 参数为测试注入缝；只缓存自动探测的成功结果。 */
export function locateZcodePair(
  env: NodeJS.ProcessEnv = process.env,
  probe: ZcodeProbe = psProbe,
): LocateOutcome {
  const attempts: LocateAttempt[] = [];
  const finish = (found: boolean, source: LocateSource, pair: ZcodePair | null): LocateOutcome => {
    const outcome: LocateOutcome = { found, source, pair, attempts, guidance: found ? "" : LOCATE_GUIDANCE };
    if (found) cache = outcome;
    return outcome;
  };

  // ① env（userConfig 经 plugin.json env 注入；探测事实基线 F3：缺省场景确实为空）。
  //    判定先于缓存（复核轮 F4）：env 命中直接返回——不读缓存、不写缓存，
  //    不同 env 参数的调用（生产进程内 env 恒定；测试/doctor 传不同 env）互不污染。
  const exeEnv = (env["XC_ZCODE_EXE"] ?? "").trim();
  const cjsEnv = (env["XC_ZCODE_CJS"] ?? "").trim();
  if (exeEnv !== "" && cjsEnv !== "") {
    if (existsSync(exeEnv) && existsSync(cjsEnv)) {
      attempts.push({ step: "env", hit: true, detail: "XC_ZCODE_EXE/XC_ZCODE_CJS 已配置且文件存在" });
      return { found: true, source: "user_config", pair: { exe: exeEnv, cjs: cjsEnv }, attempts, guidance: "" };
    }
    attempts.push({
      step: "env", hit: false,
      detail: `已配置但文件不存在（继续自动探测）: exe=${exeEnv} cjs=${cjsEnv}`,
    });
  } else {
    attempts.push({
      step: "env", hit: false,
      detail: `未配置（exe=${exeEnv === "" ? "empty" : "set"} cjs=${cjsEnv === "" ? "empty" : "set"}）`,
    });
  }

  // 自动探测成功缓存（env 已在上面分流；命中缓存时并入本次 attempts，doctor 展示的留痕仍是本次调用链）。
  if (cache) return { ...cache, attempts };

  if (process.platform !== "win32") {
    attempts.push({
      step: "platform", hit: false,
      detail: "非 Windows：自动探测按 Windows 实测实现（RELEASE-RECON §3），请按指引手填",
    });
    return finish(false, "", null);
  }

  // ② 本进程 execPath（F2）
  const execPath = process.execPath;
  if (basename(execPath).toLowerCase() === "zcode.exe") {
    const pair = pairFromExe(execPath);
    attempts.push({ step: "exec_path", hit: pair !== null, detail: execPath });
    if (pair) return finish(true, "exec_path", pair);
  } else {
    attempts.push({ step: "exec_path", hit: false, detail: `process.execPath 非 ZCode.exe: ${execPath}` });
  }

  // ③ 进程表枚举（活进程=必装，覆盖任意盘符）
  const tableRaw = probe(
    "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Select-Object -ExpandProperty ExecutablePath",
  );
  const tablePaths = tableRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (const exe of tablePaths) {
    const pair = pairFromExe(exe);
    if (pair) {
      attempts.push({ step: "process_table", hit: true, detail: exe });
      return finish(true, "process_table", pair);
    }
  }
  attempts.push({
    step: "process_table", hit: false,
    detail: tablePaths.length === 0 ? "未发现 ZCode.exe 活进程" : `发现 ${tablePaths.length} 个 ZCode.exe 但都配不到 zcode.cjs`,
  });

  // ④ 父链 1 跳（F1）
  const ppid = process.ppid;
  if (Number.isFinite(ppid) && ppid > 0) {
    const parent = probe(
      `Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" | Select-Object -ExpandProperty ExecutablePath`,
    );
    if (parent !== "" && basename(parent).toLowerCase() === "zcode.exe") {
      const pair = pairFromExe(parent);
      attempts.push({ step: "parent_process", hit: pair !== null, detail: `ppid=${ppid} → ${parent}` });
      if (pair) return finish(true, "parent_process", pair);
    }
    attempts.push({ step: "parent_process", hit: false, detail: `ppid=${ppid} → ${parent || "不可得"}` });
  }

  // ⑤ 注册表反推（F4）
  const uninstallRaw = probe(
    "Get-ItemProperty @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') " +
    "-ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*ZCode*' } | " +
    "Select-Object -ExpandProperty UninstallString",
  );
  for (const line of uninstallRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")) {
    const root = installRootFromUninstallString(line);
    const pair = pairFromExe(join(root, "ZCode.exe"));
    if (pair) {
      attempts.push({ step: "registry", hit: true, detail: `${line} → ${root}` });
      return finish(true, "registry", pair);
    }
  }
  attempts.push({ step: "registry", hit: false, detail: "Uninstall 项未反推出可用安装根" });

  // ⑥ 常见路径兜底（F6）
  for (const exe of [
    join(env["LOCALAPPDATA"] ?? "", "Programs", "ZCode", "ZCode.exe"),
    join(env["ProgramFiles"] ?? "", "ZCode", "ZCode.exe"),
    join(env["ProgramFiles(x86)"] ?? "", "ZCode", "ZCode.exe"),
  ]) {
    const pair = pairFromExe(exe);
    if (pair) {
      attempts.push({ step: "common_paths", hit: true, detail: exe });
      return finish(true, "common_paths", pair);
    }
  }
  attempts.push({ step: "common_paths", hit: false, detail: "默认安装路径未命中" });

  return finish(false, "", null);
}

export interface ResolvedSpawnConfig {
  zcodeExe: string;
  zcodeCjs: string;
  outcome: LocateOutcome;
}

/**
 * spawn 配置解析的唯一入口（wake.ts / provision.ts 调用）：
 * env 已配置且文件存在 → 原样使用（现行为不变，最快路径，不触发任何子进程探测）；
 * 否则自动探测兜底（含「已配置但文件不存在」的回落）。返回 outcome 供审计与指引。
 */
export function resolveZcodeSpawnConfig(
  env: NodeJS.ProcessEnv = process.env,
  probe: ZcodeProbe = psProbe,
): ResolvedSpawnConfig {
  const outcome = locateZcodePair(env, probe);
  const pair = outcome.found && outcome.pair ? outcome.pair : { exe: "", cjs: "" };
  return { zcodeExe: pair.exe, zcodeCjs: pair.cjs, outcome };
}
```

实现期自由度（不改变契约）：若实测失败场景的重复探测延迟影响派发体验，可加「负结果 60s TTL 缓存」；`WakeSpawnConfig`（resume-cli.ts:41-46）与 `AppServerSpawnConfig`（appserver.ts:29-34）结构相同，`resolveZcodeSpawnConfig` 返回值对两者结构兼容，两消费文件不互相 import。

### 2.4 消费点接线（增量 hunk，其余逐字节不动）

**wake.ts**（`plugin/src/engine/wake.ts`）：

```ts
// import 行（现 :66）改为：
import { spawnResume, type WakeSpawnConfig } from "./resume-cli";
import { resolveZcodeSpawnConfig } from "./zcode-locate";

// attemptWake 内（现 :480-482）：
  let pid: number | undefined;
  // v0.4（DESIGN-V0.4 §2.4）：spawn 配置解析改为「env → 自动探测」，结果落审计。
  const resolvedCfg = req.cfg ?? resolveZcodeSpawnConfig(req.env);
  await logEngineEvent(stateRoot, {
    event: "zcode-locate", source: resolvedCfg.outcome.source, found: resolvedCfg.outcome.found,
    exe: resolvedCfg.zcodeExe, cjs: resolvedCfg.zcodeCjs, to: toKey, scene: req.reason,
  });
  try {
    const spawned = (req.spawn ?? spawnResume)({
      cfg: req.cfg ?? { zcodeExe: resolvedCfg.zcodeExe, zcodeCjs: resolvedCfg.zcodeCjs },
```

（`await logEngineEvent` 与 wake.ts 既有审计行同形态，如 :471 的 wake-failed 行；`req.cfg` 测试注入优先级不变。）

**resume-cli.ts**（`plugin/src/engine/resume-cli.ts:138-143`，只改报错文案）：

```ts
  if (cfg.zcodeExe.trim() === "" || cfg.zcodeCjs.trim() === "") {
    // 未配置且自动探测未命中：同步抛错，调用方（wake.ts attemptWake）据此降级 mailbox。
    // v0.4（DESIGN-V0.4 §2.4）：文案给出明确指引（硬标准 2：不静默）。
    throw new Error(
      "spawnResume: zcode_exe / zcode_cjs 未配置且自动探测未命中——推送唤醒不可用（两会话 pull 协作不受影响）。" +
      "修复：zcode 桌面端 → 设置 → 插件 → zcode-crosschat → 插件设置，填写 zcode_exe（zcode 安装目录下的 ZCode.exe）" +
      "与 zcode_cjs（同目录 resources\\<variant>\\zcode.cjs）；或在本会话运行 xc_doctor 查看探测尝试线索。",
    );
  }
```

**appserver.ts**（`plugin/src/engine/appserver.ts:141-147`，同款文案）：

```ts
    if (cfg.zcodeExe.trim() === "" || cfg.zcodeCjs.trim() === "") {
      // v0.4：同 resume-cli 的指引文案（成员供给路径，硬标准 2）。
      throw new Error(
        "app-server: zcode_exe / zcode_cjs 未配置且自动探测未命中——成员供给不可用（两会话 pull 协作不受影响）。" +
        "修复：插件设置填写 zcode_exe / zcode_cjs，或运行 xc_doctor 查看探测尝试线索。",
      );
    }
```

**provision.ts**（`plugin/src/engine/provision.ts`）：

```ts
// provisionMember 内（现 :230 附近的 AppServerKeeper.start 调用处）：
  const spawnCfg = resolveZcodeSpawnConfig(deps.env);   // v0.4：env → 自动探测
  let keeper: AppServerKeeper;
  try {
    keeper = AppServerKeeper.start({ cfg: spawnCfg, env: deps.env, callbacks: { /* 原样 */ } });
  } catch (err) {
    // v0.4：失败回执附探测指引（硬标准 2）——member_provision_failed 不再只有一句「未配置」。
    throw new ProvisionError("spawn", `${String((err as Error)?.message ?? err)} ${spawnCfg.outcome.guidance}`);
  }
```

（`AppServerKeeper.start` 的 `cfg` 参数类型 `AppServerSpawnConfig` 与 `ResolvedSpawnConfig` 结构兼容；`callbacks` 与其余参数原样保留。）

### 2.5 观测面：只读工具 `xc_doctor`（新文件全文）

目的：探测成败从「隐没在错误文案」变成可主动查看的面（硬标准 2 的验收抓手，§5-S2）。免注册（与 `xc_status` 同口径，tools.ts:10「仅 xc_status 豁免」——doctor 不读身份、不碰磁盘真源，天然免注册）；注册 API 与 `tools.ts:803-808` 的 `server.tool(name, description, Shape, handler)` 同形。

`plugin/src/mcp/doctor-tool.ts`（全文）：

```ts
/**
 * v0.4：xc_doctor —— 只读体检（免注册，DESIGN-V0.4 §2.5）。
 * 把「探测成功与否、用了哪个 exe/cjs、失败时填什么」变成可主动查看的面。
 * 纯只读：除 zcode-locate 的只读探测（进程表/注册表，单步 4s 超时）外不触碰任何状态，
 * 不写 user_config、不写磁盘真源。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateZcodePair, type LocateAttempt } from "../engine/zcode-locate";

export interface DoctorReport {
  plugin: { name: string; version: string };
  runtime: { node: string; execPath: string; platform: string; cwd: string };
  spawnPaths: {
    zcode_exe_env_set: boolean;
    zcode_cjs_env_set: boolean;
    member_model_env_value: string;
    locate: { found: boolean; source: string; exe: string; cjs: string; attempts: LocateAttempt[] };
  };
  guidance: string;
}

export function buildDoctorReport(input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): DoctorReport {
  const exeSet = (input.env["XC_ZCODE_EXE"] ?? "").trim() !== "";
  const cjsSet = (input.env["XC_ZCODE_CJS"] ?? "").trim() !== "";
  const outcome = locateZcodePair(input.env);   // 成功结果在 zcode-locate 内缓存，重复调用零探测成本
  return {
    plugin: { name: "zcode-crosschat", version: input.version },
    runtime: {
      node: process.version, execPath: process.execPath,
      platform: process.platform, cwd: input.cwd,
    },
    spawnPaths: {
      zcode_exe_env_set: exeSet,
      zcode_cjs_env_set: cjsSet,
      member_model_env_value: (input.env["XC_MEMBER_MODEL"] ?? "").trim(),
      locate: {
        found: outcome.found, source: outcome.source,
        exe: outcome.pair?.exe ?? "", cjs: outcome.pair?.cjs ?? "",
        attempts: outcome.attempts,
      },
    },
    guidance: outcome.guidance,
  };
}

/** 注册（server.ts 调用；与 tools.ts 的 server.tool 形态一致，空参数 shape）。 */
export function registerDoctorTool(server: McpServer, input: {
  version: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): void {
  server.tool(
    "xc_doctor",
    "Read-only self check: plugin version, runtime, auto-detected zcode_exe/zcode_cjs paths and probe attempts. Does not require registration.",
    {},
    async () => {
      const report = buildDoctorReport(input);
      const lines = [
        `zcode-crosschat ${report.plugin.version}`,
        `runtime: node ${report.runtime.node} @ ${report.runtime.execPath} (${report.runtime.platform})`,
        `zcode_exe/zcode_cjs: env(set=${report.spawnPaths.zcode_exe_env_set}/${report.spawnPaths.zcode_cjs_env_set})` +
          ` locate(found=${report.spawnPaths.locate.found}, source=${report.spawnPaths.locate.source || "-"})`,
        `exe: ${report.spawnPaths.locate.exe || "(未定)"}`,
        `cjs: ${report.spawnPaths.locate.cjs || "(未定)"}`,
        `member_model(XC_MEMBER_MODEL): ${report.spawnPaths.member_model_env_value || "(空=枚举表自动选第一个)"}`,
        ...report.spawnPaths.locate.attempts.map((a) => `- [${a.hit ? "命中" : "未中"}] ${a.step}: ${a.detail}`),
        ...(report.guidance !== "" ? [`指引: ${report.guidance}`] : []),
      ];
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify(report) },
        ],
      };
    },
  );
}
```

工具数 20→21，README 工具表同步加一行（R4）。

### 2.6 member_model 默认值处理（任务 2 的第三项）

保持「留空=app-server 枚举表第一个」的产品行为不变（P1 实测的枚举主路径，provision.ts:223 → pickModel），做四件低风险增强：

1. **失败指引**（provision.ts:149 的空枚举文案已具备）——扩展到「模型回合失败」：建员失败的 `ProvisionError` message 追加「本次尝试模型 `<modelId>`（provider `<providerId>`）；若该模型不可用，请在插件设置 member_model 显式指定，可用模型见建员结果/xc_doctor 提示」。
2. **plugin.json 描述修正**（§6.2 全文）：member_model 描述明示「留空=自动选第一个，它可能是当前账号不可用的模型」，去掉「需翻内部文档才能理解」的表述（pain-audit P3 同根因）。
3. **xc_doctor 暴露** `member_model_env_value` 与留空语义（§2.5 已含）。
4. **实现期验证点 V-M1**（有证据才做，不预支）：`session/list` 若能给出既有会话的模型 ref（PLATFORM.md:163 方法面在列，载荷未取证），则把「lead 会话当前模型」作为 member_model 留空时的**次选**缺省（lead 能正常对话即证明该模型可用）——实现者先以最小 probe 验证载荷，证据落 evidence；验证不过就维持枚举第一个并如实记录。

### 2.7 降级红线与安全论证

- **不写 user_config**：探测结果只在内存中参与本次 spawn 决策；宿主 `plugins.options`、`installed_plugins.json`、cache 均零写入。v0.2 §2.4 的 options 事故（uninstall --force 清空 options）与 recon 的保守建议（RELEASE-RECON.md:100）都只约束「持久化写入」，不约束只读解析——本设计满足两者。验收断言见 §5-S2（pull 冒烟前后 config.json 对照）。
- **误探测的可见性**：每次定位落 `engine.jsonl {event:"zcode-locate", source, exe, cjs}`；`xc_doctor` 随时可查；env 永远可覆盖探测结果（用户填错探测对，用户填对以用户为准）。该不变式在代码序上强制（复核轮 F4）：`locateZcodePair` 的 env 判定**先于**缓存返回，env 命中不读也不写缓存——即使进程内已有探测成功缓存，合法 env 仍立即生效，测试/doctor 传不同 env 不会命中陈旧缓存。
- **行为兼容**：env 已配置且文件存在时走最快路径（零子进程），现行为逐字节不变；探测只在 wake/member 路径触发，pull 与 peer 零感知。

---

## 3. Release 流程（任务 3）

### 3.1 总序

```
前置自检 → 版本冻结（五处+lock）→ commit + tag v0.4.0 → node scripts/pack-release.mjs v0.4.0
→ 本地装包验证 → push（main + tag）→ gh release create --target <SHA> → gh release upload
→ 发布后匿名校验（下载+校验和+隔离安装）→ 六条硬标准验收（§5）
```

可执行 runbook 落仓内 `docs/RELEASING.md`（全文 §3.5）。红线（全部为侦察实测）：

1. `gh release create --target` **必须传 commit SHA**，tag 名报 422（RELEASE-RECON.md:15）；
2. **禁用 `gh release delete`**——会连带删除远程 tag（RELEASE-RECON.md:111 实测 recon-draft-test 连 tag 消失）；改资产只走 `gh release upload --clobber`；
3. draft 资产对匿名 404（RELEASE-RECON.md:106）→ **直接创建正式 release**（不 draft）；`gh release edit --draft=false` 未实测，不走；
4. push 直连失败：单命令借代理 `git -c http.proxy=http://127.0.0.1:7897 push origin main v0.4.0`，**禁写全局 git 配置**（全局纪律；结束时 `git config --global --get http.proxy` 复查）；
5. 产物目录用 `<repo>/.scratch-release/`（`.gitignore` 的 `.scratch-*/` 模式已覆盖，实测 .gitignore 该行在位），产物不入库。

### 3.2 版本冻结清单（R3 唯一写入窗口）

| # | 文件 | 位置 | 改为 |
|---|---|---|---|
| 1 | `plugin/.zcode-plugin/plugin.json` | `version` | `0.4.0` |
| 2 | `marketplace.json` | `plugins[0].version` | `0.4.0` |
| 3 | `plugin/package.json` | `version` | `0.4.0` |
| 4 | `plugin/package-lock.json` | 根 `version`（第 3 行）+ `packages[""].version`（第 9 行） | `0.4.0` |
| 5 | `plugin/src/mcp/server.ts` | `SERVER_VERSION`（:35） | `"0.4.0"` |

### 3.3 打包脚本 `scripts/pack-release.mjs`（全文，新文件）

```js
#!/usr/bin/env node
/**
 * v0.4 发布打包（DESIGN-V0.4 §3.3）：从 tag 树产出预构建 slim tgz + SHA256。
 *
 * 用法（仓库根运行）：node scripts/pack-release.mjs v0.4.0 [--keep-stage]
 *
 * 序列（与 recon/02 §2.3 实测序列一致：build 依赖 devDependencies 的 esbuild，
 * 必须完整 ci → build → prune --omit=dev，不能先 ci --omit=dev）：
 *   git worktree 导出 tag 树（产物=tag 树，不受工作区脏文件影响）
 *   → npm ci → npm run build → npm prune --omit=dev
 *   → dist import 冒测（recon/02 §2.3 的 IMPORT_OK 口径）
 *   → tar czf（顶层目录 zcode-crosschat-<ver>/，天然无 .git）
 *   → SHA256（<资产>.sha256 内容 `<hex>  <文件名>`，sha256sum -c 兼容）
 *
 * 产物：<仓库>/.scratch-release/（.gitignore 的 .scratch-*/ 已覆盖，不入库）。
 * 本脚本零网络操作；push 与 gh release 由 docs/RELEASING.md 执行。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keepStage = args.includes("--keep-stage");
const tag = args.find((a) => !a.startsWith("--"));
const outDir = join(repoRoot, ".scratch-release");

function run(cmd, cmdArgs, opts = {}) {
  // shell:true 用于解析 Windows 的 npm.cmd；本仓路径不含空格（<仓库路径>）。
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) {
    console.error(`pack-release: 命令失败（exit=${r.status}）: ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}
function check(cond, msg) {
  if (!cond) {
    console.error(`pack-release: ${msg}`);
    process.exit(1);
  }
}

// 0. 参数与 tag 校验
check(tag && /^v\d+\.\d+\.\d+$/.test(tag), "用法: node scripts/pack-release.mjs v<x.y.z> [--keep-stage]");
const ver = tag.slice(1);
const gitRev = spawnSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8", cwd: repoRoot });
check(gitRev.status === 0, `tag ${tag} 不存在（先完成版本冻结与 git tag，见 docs/RELEASING.md）`);
const releaseSha = gitRev.stdout.trim();
console.log(`pack-release: tag=${tag} commit=${releaseSha}`);

// 1. worktree 导出 tag 树（目录名 = 资产顶层目录名；产物=tag 树，断言也读这份树——复核轮小项：
//    此前版本断言读 repoRoot 工作区，RELEASING 先 commit 后打包故两树一致，但读 stage 断言「所测即所包」更稳）
const stage = join(outDir, `zcode-crosschat-${ver}`);
rmSync(stage, { recursive: true, force: true });
run("git", ["worktree", "add", "--detach", stage, tag], { cwd: repoRoot });

// 2. 版本一致性断言（§3.2 冻结清单的机器护栏；读 stage，不打工作区）
const manifest = JSON.parse(readFileSync(join(stage, "plugin/.zcode-plugin/plugin.json"), "utf8"));
const market = JSON.parse(readFileSync(join(stage, "marketplace.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(stage, "plugin/package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(stage, "plugin/package-lock.json"), "utf8"));
for (const [where, got] of [
  ["plugin/.zcode-plugin/plugin.json", manifest.version],
  ["marketplace.json", market.plugins[0]?.version],
  ["plugin/package.json", pkg.version],
  ["plugin/package-lock.json(root)", lock.version],
  ["plugin/package-lock.json(packages\"\")", lock.packages?.[""]?.version],
]) check(got === ver, `版本冻结不一致: ${where}=${got} ≠ ${ver}`);
check(
  readFileSync(join(stage, "plugin/src/mcp/server.ts"), "utf8").includes(`const SERVER_VERSION = "${ver}";`),
  "server.ts SERVER_VERSION 与版本不符",
);

// 3. 构建（实测序列，见文件头）
run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(stage, "plugin") });
run("npm", ["run", "build"], { cwd: join(stage, "plugin") });
run("npm", ["prune", "--omit=dev"], { cwd: join(stage, "plugin") });

// 4. dist import 冒测（recon/02 §2.3 口径：依赖图完整即 IMPORT_OK）
const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
  `await import(${JSON.stringify(pathToFileURL(join(stage, "plugin/dist/mcp/server.mjs")).href)}); console.log("IMPORT_OK");`,
], { encoding: "utf8", timeout: 30000 });
check(probe.status === 0 && (probe.stdout ?? "").includes("IMPORT_OK"), `dist import 冒测失败: ${probe.stderr}`);

// 5. 打包（win32 下 shell:true 经 cmd 按 PATH 解析，可能命中 System32 的 bsdtar 而非 Git Bash 的
//    GNU tar 1.35——两者对本文用到的 -czf/-C 形态语义等价（复核轮记录）；如需固定实现可显式传 tar 绝对路径）
const assetName = `zcode-crosschat-${ver}-prebuilt-slim.tar.gz`;
rmSync(join(outDir, assetName), { force: true });
run("tar", ["-czf", assetName, "-C", outDir, `zcode-crosschat-${ver}`], { cwd: outDir });

// 6. SHA256（node crypto，免外部依赖；`<hex>  <文件名>` 两个空格，sha256sum -c 兼容）
const tgzPath = join(outDir, assetName);
const hash = createHash("sha256");
await new Promise((res, rej) => {
  const s = createReadStream(tgzPath);
  s.on("data", (d) => hash.update(d));
  s.on("end", res);
  s.on("error", rej);
});
const digest = hash.digest("hex");
writeFileSync(`${tgzPath}.sha256`, `${digest}  ${assetName}\n`);

// 7. 收尾：摘 worktree（保留产物；--keep-stage 保留现场排障）
if (!keepStage) run("git", ["worktree", "remove", "--force", stage], { cwd: repoRoot });

console.log("\npack-release: 完成");
console.log(`  资产:   ${tgzPath}`);
console.log(`  SHA256: ${digest}`);
console.log(`  发布 target（gh release create --target 用它）: ${releaseSha}`);
console.log("  后续步骤见 docs/RELEASING.md §5-§6");
```

### 3.4 Release 说明（notes）内容模板

`--notes-file` 正文由 R3 生成（落 `.scratch-release/notes-v0.4.0.md`，不入库），要点：

1. 一句话简介 + 「三步安装」（与 README 快速开始同文，指向 README 为权威）；
2. 资产表：文件名 / 大小 / **SHA256**（与 `.sha256` 资产一致，双载体）；
3. 验证方法：`sha256sum -c zcode-crosschat-0.4.0-prebuilt-slim.tar.gz.sha256`；
4. 限制短清单（§4.3 的五条，含「仅 Windows 实测」）；
5. 本版增量（预构建零构建安装、自动探测、xc_doctor、README 重写）。

### 3.5 `docs/RELEASING.md`（全文，新文件）

```markdown
# RELEASING：发布 runbook（DESIGN-V0.4 §3 的可执行版）

> 红线（RELEASE-RECON 实测）：① `gh release create --target` 必须传 commit SHA（tag 名 422）；
> ② 禁用 `gh release delete`（连带删远程 tag）；改资产用 `gh release upload --clobber`；
> ③ 直接创建正式 release（draft 资产对匿名 404）；
> ④ push 直连失败单命令借代理 `git -c http.proxy=http://127.0.0.1:7897 push ...`（禁写全局配置）。

## 1. 前置（全部满足才开工）
- [ ] 零配置改造（R1/R2）与 README 重写（R4）已合入 main
- [ ] `cd plugin && npm run typecheck && npm test` 全绿（v0.3 基线 36 文件/509 例不回退）
- [ ] `docs/RELEASE-RECON.md` 已提交；README 走查通过（DESIGN-V0.4 §4.5 检查单）

## 2. 版本冻结（唯一写入窗口）
1. `plugin/.zcode-plugin/plugin.json` version → 0.4.0
2. `marketplace.json` plugins[0].version → 0.4.0
3. `plugin/package.json` version → 0.4.0
4. `plugin/package-lock.json` 根 `version` 与 `packages[""].version` → 0.4.0
5. `plugin/src/mcp/server.ts` SERVER_VERSION → "0.4.0"
6. `git add -A && git commit` → `git tag v0.4.0`
   → 记录 SHA：`git rev-parse v0.4.0^{commit}`（步骤 5 要用）

## 3. 打包
    node scripts/pack-release.mjs v0.4.0
（脚本自断言五处版本一致并做 dist import 冒测；产物与 SHA256 打印在末尾）

## 4. 本地验证（上传前）
- `tar -tzf .scratch-release/zcode-crosschat-0.4.0-prebuilt-slim.tar.gz | head`
  → 顶层 `zcode-crosschat-0.4.0/`，含 `marketplace.json` 与 `plugin/dist/mcp/server.mjs`
- （可选）隔离装一次：`ZCODE_STORAGE_DIR=<临时目录> plugins marketplace add <解包目录>` → install → [enabled]

## 5. 发布
    git push origin main v0.4.0
    # 直连失败时：git -c http.proxy=http://127.0.0.1:7897 push origin main v0.4.0
    gh release create v0.4.0 --target <步骤2的SHA> --title "zcode-crosschat v0.4.0" \
      --notes-file .scratch-release/notes-v0.4.0.md
    gh release upload v0.4.0 \
      .scratch-release/zcode-crosschat-0.4.0-prebuilt-slim.tar.gz \
      .scratch-release/zcode-crosschat-0.4.0-prebuilt-slim.tar.gz.sha256

## 6. 发布后自检（输出全部记入验收证据）
    gh release view v0.4.0 --json isDraft,tagName,assets   # isDraft=false、两资产在、body 含 SHA256
    # 匿名下载（无凭证语义；保留资产原名——.sha256 内记录的是原名，改名后 -c 会 FAILED open or read，复核轮 F1 实测）：
    curl -LO <browser_download_url> && sha256sum -c *.sha256
    # 解包 → 隔离 ZCODE_STORAGE_DIR → marketplace add → install → plugins list [enabled]
```

---

## 4. README 重写大纲（任务 4，新用户视角）

> 交付物=全量重写的 `README.md`（R4 所有），目标：**≤5 分钟跟走、无内部术语、无死链、无本机信息、三问直答**（下载哪个 / 怎么装 / 怎么验证装通）。

### 4.1 节级大纲

```
# zcode-crosschat
## 这是什么                 —— 3 句话：多个独立 zcode 会话互相派任务/发消息；装好即用；无需任何必填配置
## 环境要求                 —— ① ZCode 桌面版；② Node.js ≥ 22（自测 v24；预构建包运行时也需要——宿主用系统 node 拉起 MCP/钩子）；
                               ③ git 仅「开发者路径」需要。Windows-only 实测声明放此处
## 快速开始（3 步）          —— 主路径 = Release 资产（S1 实测背书）：
  1. 下载并解包 zcode-crosschat-0.4.0-prebuilt-slim.tar.gz（Release 页；下载保留资产原名——校验和按原名录；
     网络不畅用 codeload 兜底 + ZCODE_HTTP_PROXY 提示）
  2. 安装：CLI 路径（主推，S1 实测背书）——一段可直接复制执行的完整命令块，硬性要求（复核轮 F5）：
     ① 内联 zcode 的可执行调用形态（ELECTRON_RUN_AS_NODE=1 <安装目录>\ZCode.exe
        <安装目录>\resources\<variant>\zcode.cjs plugins marketplace add <解包目录> &&
        … plugins install zcode-crosschat@dev-zcode-crosschat）——zcode 不在 PATH
        （PLATFORM.md:134；pain-audit P1 实测原样敲 EXIT=127），不得只写 <zcode 调用> 占位符；
     ② 附「如何定位安装目录」一句话指引（默认 %LOCALAPPDATA%\Programs\ZCode，注册表 Uninstall 反推）。
     或 UI 路径（插件市场→添加→添加插件市场→粘贴解包目录→安装+启用）——措辞必须为
     「以桌面实际界面为准」：UI 三连击从未被真实点击（pain-audit.md:196 明示不视为已验证），
     不得写成已验证路径（硬标准 6）
  3. 验证装通：以 CLI `plugins list` 见 `[enabled]` 且计数非零为权威；附 commands:1 vs 7 个命令文件的
     口径说明，措辞固定为「属宿主计数行为，非安装异常」（机制未查明，不得编造解释——pain-audit P7，
     复核轮 F7）；UI 插件页状态仅作辅助描述，同样「以桌面实际界面为准」
## 第一次协作：两会话闭环    —— 同工作区开两会话 /xc-work a、/xc-work b、/xc-dispatch、收回执（0 配置，≤5 分钟口径）
## 更多玩法（可选）
  - 跨会话 peer 消息（0 配置，一段示例）
  - lead-成员团队自动开工（唯一需配置的路径：wake_enabled + zcode_exe/zcode_cjs——
    「通常留空即可，插件自动探测本机安装；探测失败时 xc_doctor 会告诉你填什么」+ member_model 说明）
## 配置项参考                —— 保留现表，zcode_exe/zcode_cjs 两行改写为「留空=自动探测」语义
## 常见问题（FAQ）
  - `zcode: command not found`（P1 阻断点）：zcode CLI 不在 PATH，给出 ELECTRON_RUN_AS_NODE 调用形态与安装目录定位法
  - npm ≥11.19 的 esbuild allowScripts 警告：可忽略（实测不影响构建，pain-audit P6）
  - 装完想更新：clone/解包目录是市场源，删除将无法更新（P9）
  - GitHub 直连不畅：codeload tgz 兜底 + ZCODE_HTTP_PROXY（P12）
## 已知限制                 —— 新用户 5 条短清单（§4.3）+ 折叠的工程细节指针（docs/ACCEPTANCE.md、docs/DESIGN-*.md）
## 文档 / License            —— 仓内文档索引（全部为仓内相对路径，零外部死链）
```

硬性写法规则：版本与资产名用 `0.4.0` 实值（发布时已定版）；**零悬空引用**（§4.2）；零内部编号（E3b/V9/V13/V15/V20/E-e/E-b/R-34/Q=100/§ 编号一律不出现，pain-audit P5 量化 pain-audit.md:188-189）；零本机信息（`qdqir`/`E:\ZCode`/`D:\tools`/`C:\Users` 不出现，README 本体现状已干净，pain-audit.md:179）；「仅 Windows 实测」保留现表述（README.md:326 在位，pain-audit.md:192 确认对新用户可理解）。

### 4.2 死链治理（pain-audit P4：12 处悬空引用）

新建 **`docs/ACCEPTANCE.md`**（仓内公开验收台账，R4 交付）：从 `deepseek-crosschat/reports/10-v020验收.md`、`12-v030验收.md` 提炼结论表（版本 / 日期 / 硬标准条目 / 判定 / 关键证据摘录），**不含本机路径、不含 evidence/ 引用**；v0.4 六条验收完成后回填。README 12 处死链全部改指：`docs/ACCEPTANCE.md`（验收主张）、`docs/DEMO.md`（演示）、`docs/IMPLEMENTATION.md`（自测命令与结果）。

### 4.3 已知限制：新用户 5 条短清单（pain-audit P5 建议）

1. **仅 Windows 实测**——其他系统未经测试（不宣称「不可用」，只如实说未测）；
2. 团队自动开工依赖本机 zcode 路径——默认自动探测，失败时 `xc_doctor`/报错会给出填写指引；pull 与 peer 消息完全不受影响；
3. 跨会话消息只在「回合边界」注入（发消息不会打断对方正在进行的回合）；
4. 只能发现「已显式注册」的会话（`xc_peer_register` 后才可被寻址）；
5. 别把敏感内容写进协作邮箱——跨会话可见的只有邮箱内容。

工程细节（WMI 备选、V9 残余竞态、P1-P5 平台事实、三缺陷修复记录等）折叠到 `docs/ACCEPTANCE.md` 与 `docs/DESIGN-*.md`，README 不再承载台账语言。

### 4.4 docs/ 内部记录处置决策

pain-audit 实测 docs/ 8 文件 49 处本机信息命中（pain-audit.md:180）。决策：**保留原文不清洗**——docs/ 是平台事实基线与设计记录（如 PLATFORM.md:7 的 `~` 定义、实测安装路径），属工程档案性质；README 与 Release notes 不引用其中的本机信息；`docs/RELEASE-RECON.md`（含 <安装目录> 等环境描述）随本版提交入库，同样按工程档案对待。此决策记录于本节，验收 S5 只对 README/demo 断言零泄漏。

### 4.5 README 走查检查单（R4 自检 + S5 验收共用）

- [ ] `grep -nE 'deepseek-crosschat|evidence/|reports/' README.md` = 0 命中
- [ ] `grep -nE 'E3b|V9|V13|V15|V20|E-e|E-b|R-34|Q=100|FEASIBILITY|§[0-9]' README.md` = 0 命中
- [ ] `grep -rlF -e 'qdqir' -e 'E:\ZCode' -e 'D:\tools' -e 'C:\Users' README.md demo/` = 0 文件命中
- [ ] 三问直答：「下载哪个」（Release 资产名）/「怎么装」（3 步）/「怎么验证」（plugins list `[enabled]`）各能在 30 秒内定位
- [ ] 快速开始 3 步在**隔离沙箱**实测可走通（§5-S1 同款）
- [ ] 「仅 Windows 实测」在位；无任何「已支持 Linux/macOS」式无证据宣称

---

## 5. 六条硬标准逐条验证方案（任务 6a）

> 执行者=验收环节（R5）；证据根 `deepseek-crosschat/evidence/15-v040/`（沿用 12-v030/14-release 编号惯例），每条一子目录，命令全程 `tee` 落盘。
> 隔离方法：`ZCODE_STORAGE_DIR=<独立目录>` 可完全隔离插件配置树（recon/04:10-14 实测；`ZCODE_HOME`/`ZCODE_DATA_BASE_DIR` 无隔离效果，不可用）。
> zcode CLI 调用统一记作 `ZC()`：`ELECTRON_RUN_AS_NODE=1 <exe> <cjs> plugins …`（exe/cjs 用本机真实路径，README FAQ 同款指引）。

### S1 零构建安装（硬标准 1）

- **环境**：干净目录 `evidence/15-v040/s1/` + 隔离 `ZCODE_STORAGE_DIR`；**真网络**获取。
- **命令序列**：
  1. `curl -LO <Release browser_download_url>`（匿名；**保留资产原名**——`.sha256` 内记录的是原名，下载改名后 `sha256sum -c` 会 `FAILED open or read`（复核轮 F1，复核方 TEMP 实测复现 EXIT=1）；失败则 `gh release download`（认证，同样保留原名）对照并记录网络窗口）
  2. `sha256sum -c zcode-crosschat-0.4.0-prebuilt-slim.tar.gz.sha256`（在资产所在目录执行）
  3. `tar -xzf zcode-crosschat-0.4.0-prebuilt-slim.tar.gz`
  4. `ZC() plugins marketplace add <解包目录>` → 期望 `Added marketplace dev-zcode-crosschat (1 plugins)`
  5. `ZC() plugins install zcode-crosschat@dev-zcode-crosschat` → 期望 `Installed ... (0.4.0) [enabled]`
  6. `ZC() plugins list | grep -A1 crosschat` → 期望 `[enabled]`、`skills/commands/hooks/mcp` 计数非零
  7. `ZC() plugins validate <cache 路径>` → `Plugin manifest is valid`
  8. `ls <cache 路径>/plugin/dist/mcp` 与 `node_modules` 在场（物化完整性，对照 recon/02 cfg-prebuilt 口径）
- **断言**：①-⑧ 全程**未出现** `npm install`/`npm run build`；步骤数（用户动作）≤3（下载解包/安装/验证）。
- **不通过情形**：published 资产匿名下载持续 404/超时 → 如实记录（含认证下载对照结果），不得以认证下载冒充匿名通道结论。

### S2 零必填配置可用（硬标准 2）

- **S2a pull 邮箱协作 0 配置**：隔离 storage + 干净工作区；两会话（app-server 驱动，`demo/bootstrap-sessions.mjs` 同族，模型 `glm-5.3-flash`）：注册（/xc-work）→ 派发（xc_dispatch）→ 对方回合 claim/写文件/report(completed+evidence) → 回执核对（sha256 独立复算 MATCH）。**前置与结束后各备份一次宿主 config.json**，断言 `plugins.options` 中 crosschat 条目逐字节不变（降级红线「不写 user_config」的直接证据）。
- **S2b 自动探测成功路径**：隔离 config 预置 `member_model="glm-5.3-flash"`（**钉住模型**——留空=枚举表第一个，本机回落坑 PLATFORM.md:153：providerOrder[0] 的 glm-5.2 key 已失效，模型回合失败会与探测失败混淆；本条只测探测，模型必须非变量。复核轮 F6）；**仍不填 `zcode_exe/zcode_cjs`**（出厂默认），直接 `xc_member_add` 建员 1 名（或触发一次 wake）→ 断言：`engine.jsonl` 出现 `{event:"zcode-locate", found:true, source≠""}` 且 ≠`user_config`；成员供给成功（或 wake 行 `delivered:"wake"`）；`xc_doctor` 回执的 `locate.found=true` 且 exe/cjs 为本机真实路径。
- **S2c 探测失败给指引 / 误配置被救回**（复核轮 F3 重构取材点）：三重取证——
  ① **误配置救回**（端到端）：把 `zcode_exe/zcode_cjs` 指向**不存在的文件** → 断言 `engine.jsonl` 出现 `{event:"zcode-locate", found:true, source≠"user_config"}`（误配置被自动探测救回，wake/member 照常工作）+ `xc_doctor` 的 attempts 首步显示「已配置但文件不存在（继续自动探测）」detail。**注意**：该 detail 只存在于 `xc_doctor` 的 attempts——wake.ts 的 zcode-locate 审计行不含 attempts；spawn 成功时 guidance 不进任何回执（在本机探测必然成功，recon/03 注册表/进程表事实）。
  ② **真全败的指引断言**（单测层）：`zcode-locate.test.ts` 以 `ZcodeProbe` 注入缝（§2.3，复核轮 F2）模拟八步全败 → 断言 `guidance === LOCATE_GUIDANCE`、attempts 全步留痕、成功缓存/resetLocateCache 行为正确、env 合法命中不读不写缓存（F4 不变式）。
  ③ **失败落盘口径**（生产路径佐证，不做端到端）：真全败时 `spawnResume` 抛错 → attemptWake 的 `wake-failed` 行带 error 落 engine.jsonl（wake.ts:473-475）→ `xc_dispatch` 回执携带 note（tools.ts:371-372 的 `sent.note` 通道）；由 ② 的单测与代码走读佐证即可——本机 ZCode 在装、真全败不可构造（与 S2c-① 的误配置场景区分：误配置会被探测救回，不是全败）。
- **断言汇总**：S2a 全程零 userConfig 写入且闭环 MATCH；S2b 探测驱动 wake/member 真实可用；S2c 失败路径无「静默不可用」（每条失败都有可读指引）。

### S3 Release 下载路径（硬标准 3）

1. `gh release view v0.4.0 --json isDraft,tagName,assets,body` → `isDraft=false`；资产=slim tgz + `.sha256` 两件；body 含 SHA256 表。
2. **匿名下载**：`curl -L -o`（无凭证）→ 成功样本 + `sha256sum -c` 通过。若网络阻断：择时重试（≥3 个时间窗）并记录；同时跑认证 `gh release download` 对照。published 匿名样本是侦察期唯一未确认项（RELEASE-RECON.md:106），**本条必须取得至少一条真实成功样本**（匿名或认证，如实标注通道）。
3. **clone 路径**：干净目录 `git clone https://github.com/QiruiGo/zcode-crosschat.git` → `cd plugin && npm install && npm run build` → `marketplace add <clone 目录>` → `install` → `plugins list [enabled]`。clone 被重置则按全局纪律单命令借代理；再失败改用 codeload tgz 兜底通道并如实记录。
4. **两条都通则都验证**（标准原文）；顺序红线负例（可选加分）：故意跳过 build 直接 add+install → cache 无 dist（复现 recon/02:46 铁律，佐证 README 红线必要）。

### S4 全新环境全链路（硬标准 4）

- **形态**：单脚本 `evidence/15-v040/s4/run.sh`，一条命令序列从头走到尾：`mkdir 全新目录` → `curl -LO` 下载 Release 资产（保留原名，同 S1/F1）→ `sha256sum -c` → 解包 → 隔离 `ZCODE_STORAGE_DIR` → `marketplace add` → `install` → `plugins list` 断言 enabled → 两会话 pull 冒烟（S2a 同款驱动器）→ 回执 sha256 MATCH → `exit 0`。
- **断言**：脚本 exit 0；全程日志 tee 落盘；脚本与日志中**不出现**本地仓库路径 `<仓库路径>`（模拟陌生用户：一切来源于远程下载物）。

### S5 新用户文档（硬标准 5）

- 静态走查：§4.5 检查单全绿（死链/内部编号/本机信息三组 grep=0 + 三问直答 + Windows-only 在位）。
- 动态走查：由未参与实现的角色只看新 README，从空目录执行快速开始（S1 命令序列 + 两会话冒烟），全程计时与卡点记录。**≤5 分钟口径如实处理**：命令面实测（下载 4.4MB + 三步，预期秒级到分钟级）+ 阅读时间不计入硬断言，README 宣称措辞为「跟着做约 5 分钟内可装通并跑起第一次协作」——实测超过则修正宣称，不虚标。

### S6 限制条款（硬标准 6）

- 对照表逐条核验：README/Release notes 的每条限制都能指到证据（Windows-only→README.md:326 在位 + pain-audit 环境；CLI 不在 PATH→PLATFORM.md:134 + pain-audit P1；探测仅 Windows→RELEASE-RECON §3；回合边界注入/发现集口径→12-v030验收 §6.3 L1/L3；敏感内容警示→README.md:330 原文保留）。
- 反向断言：**无证据的否定式宣称=0**——不得出现「Linux/macOS 不可用/不支持」类断言（无真机背书，只能写「未经测试」）；不得出现「已支持 X」而证据不在场的宣称。
- 发布 notes 与 README 的限制清单一致性：两处清单逐条相同（一处更新须同步另一处）。

---

## 6. 模块划分（任务 6b）

> 规则（继承 DESIGN-V0.3 §10）：一个文件至多属于一个模块；跨模块只允许 import；依赖方向单向无环。
> 依赖方向：**R1 ∥ R2 ∥ R4（并行）→ R3（冻结需要三者合入）→ R5（验收）**。
> 时间片共享：`server.ts` 与三个版本载体文件（plugin.json/marketplace.json/package.json+lock）由 **R3 在冻结窗口独占版本号写入**；R1/R2 的功能性改动必须在冻结前合入。R4 可与 R1/R2 并行起草，行为终态（探测文案、xc_doctor、工具数 21）在合入时接口核对（v0.3 §9.6 模式）。

### 6.1 所有权表

| 文件 | 现状 | 模块 | 改动边界 |
|---|---|---|---|
| `plugin/src/engine/zcode-locate.ts` ★ | 新 | **R1 零配置探测** | 探测与解析（全文 §2.3） |
| `plugin/src/engine/zcode-locate.test.ts` ★ | 新 | **R1** | 经 `ZcodeProbe` 注入缝（§2.3）的顺序/全败/缓存/env-优先用例（S2c-② 载体） |
| `plugin/src/engine/resume-cli.ts` ▲ | 改 | **R1** | 仅 :138-143 报错文案（§2.4 hunk），其余逐字节不动 |
| `plugin/src/engine/appserver.ts` ▲ | 改 | **R1** | 仅 :141-147 报错文案（§2.4 hunk） |
| `plugin/src/engine/wake.ts` ▲ | 改 | **R1** | :66 import + :480-482 解析与审计（§2.4 hunk） |
| `plugin/src/engine/provision.ts` ▲ | 改 | **R1** | keeper cfg 解析 + 失败文案 + V-M1 验证点（§2.4/§2.6） |
| `plugin/.zcode-plugin/plugin.json` ▲ | 改 | **R1**（描述文案）+ **R3**（版本，冻结窗） | 全文 §6.2 |
| `plugin/src/mcp/doctor-tool.ts` ★ | 新 | **R2 观测面** | xc_doctor（全文 §2.5） |
| `plugin/src/mcp/doctor-tool.test.ts` ★ | 新 | **R2** | report 构造/注册 smoke 用例 |
| `plugin/src/mcp/server.ts` ▲ | 改 | **R2**（注册）+ **R3**（SERVER_VERSION，冻结窗） | 全文 §6.2 |
| `README.md` ▲ | 全量重写 | **R4 文档** | 大纲 §4 |
| `docs/ACCEPTANCE.md` ★ | 新 | **R4** | 仓内公开验收台账（§4.2），v0.4 结论由 R5 回填 |
| `scripts/pack-release.mjs` ★ | 新 | **R3 发布工程** | 打包（全文 §3.3） |
| `docs/RELEASING.md` ★ | 新 | **R3** | runbook（全文 §3.5） |
| `docs/RELEASE-RECON.md` ▲ | 在（未提交） | **R3** | 随发布 commit 入库，原文不改 |
| `marketplace.json` ▲ | 改 | **R3** | 仅版本（全文 §6.2） |
| `plugin/package.json` ▲ | 改 | **R3** | 版本 + engines（全文 §6.2） |
| `plugin/package-lock.json` ▲ | 改 | **R3** | 两处版本（:3、:9） |
| `plugin/scripts/build.mjs` | 不改 | — | 新模块被 import 即进 bundle（esbuild 全量打包，与 v0.3 同理） |
| 其余（`src/core/**`、`src/mcp/{tools,guards,member-tools,lead-tools,protocol,render,task-edges,peer-*}.ts`、`src/transport/**`、`src/hooks/**`、`hooks/hooks.json`、`skills/**`、`commands/**`、`demo/**`、docs 其余） | 不改 | — | v0.3 已验收面零改动（回归成本最低，沿用 12-v030 §5.4 的零改动纪律） |

### 6.2 共享/关键文件全文（发布定稿形态）

**`plugin/src/mcp/server.ts`（全文；改动=import doctor + 注册一行 + SERVER_VERSION）**：

```ts
/**
 * M3 server：stdio MCP 入口（DESIGN.md §1.3、§2.8；v0.2 组装链见 DESIGN-V0.2.md §9；
 * v0.3 增量见 DESIGN-V0.3.md §2.3、§11.1；v0.4 增量见 DESIGN-V0.4.md §2.5）。
 *
 * manifest 经 mcpServers.crosschat 拉起本进程（command:"node",
 * args:["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.mjs"], cwd:"${ZCODE_PROJECT_DIR}"），
 * 因此 process.cwd() = 会话工作区，状态根 = <workspace>/.crosschat（§2.2）。
 *
 * stdio 纪律：协议独占 stdout——任何日志/报错只准写 stderr，否则握手即坏。
 *
 * 组装链：base(createToolCore) → withTaskEdges → withGuards → withPeerDrain
 * 注册：v0.1.0 七工具 + member-tools + lead-tools + security-tools
 *       + peer-tools（v0.3）+ doctor-tool（v0.4，xc_doctor，免注册只读）
 *
 * v0.3 端点纪律（FEASIBILITY-V0.3 §3.3 实测硬约束）：MCP SDK 的 StdioServerTransport
 * 不监听 stdin 'end'，一旦进程内持有 net server（管道监听），stdin EOF 时事件循环被
 * server 撑着、进程永不退出、管道继续对外可连接（僵尸端点）。故 v0.3 自建 EOF 纪律：
 * process.stdin 的 'end'/'close' 也要走优雅关闭（删注册表记录 + 关管道 + exit(0)）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolCore, registerTools, resolveDeps, type ToolCore, type ToolDeps } from "./tools.js";
import { withTaskEdges } from "./task-edges.js";
import { withGuards, registerSecurityTools } from "./guards.js";
import { registerMemberTools } from "./member-tools.js";
import { registerLeadTools } from "./lead-tools.js";
import { registerPeerTools } from "./peer-tools.js";
import { withPeerDrain } from "./peer-drain.js";
import { registerDoctorTool } from "./doctor-tool.js";
import { stopPeerEndpoint } from "../transport/pipe.js";

const SERVER_NAME = "zcode-crosschat";
const SERVER_VERSION = "0.4.0";

/** 工具核心组装链：包装顺序固定——先边沿后守卫，守卫（安全）最贴近工具入口，
 *  peer 投递排空最外层（tool-round 间隙把信封**追加为末尾 text 块 content[2]**，
 *  content[0]/content[1] 逐字节不变——DESIGN-V0.3 §7.1「面 B 的插入形态」）。 */
export function composeCore(deps: ToolDeps): ToolCore {
  const base = createToolCore(deps);
  const edges = withTaskEdges(base, deps);
  const guarded = withGuards(edges, deps);
  return withPeerDrain(guarded, deps);
}

let shuttingDown = false;

/** 优雅关闭：先摘注册表记录与管道端点，再退出。写失败/关闭失败都不得阻塞退出。 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopPeerEndpoint();
  } catch {
    /* best effort：退出纪律优先于清理结果 */
  }
  process.exit(0);
}

export async function main(): Promise<void> {
  const deps = resolveDeps(process.cwd(), process.env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const core = composeCore(deps);
  registerTools(server, deps, core);      // v0.1.0 七工具，注入包装后的 core
  registerMemberTools(server, deps);      // xc_member_add / xc_member_stop
  registerLeadTools(server, deps);        // xc_team_init / xc_idle / xc_cancel
  registerSecurityTools(server, deps);    // xc_inbound_review
  registerPeerTools(server, deps);        // v0.3：跨会话 peer 工具面
  registerDoctorTool(server, {            // v0.4：xc_doctor（只读体检，免注册）
    version: SERVER_VERSION, env: process.env, cwd: process.cwd(),
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);

  // v0.3 EOF 纪律（FEASIBILITY-V0.3 §3.3）：SDK 不监听 stdin 'end'，必须自建。
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("close", () => {
    void shutdown();
  });
}

// 只在直接执行（dist 产物被 node 运行）时启动；被测试 import 时不自启。
// ESM 下没有 require.main，用 import.meta.url 与 argv[1] 对比近似判断。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stdout 被协议占用，错误只能去 stderr。
    console.error("[zcode-crosschat] mcp server failed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
```

（本全文与 v0.3.0 实文 `plugin/src/mcp/server.ts`（96 行）的差异仅三处：`SERVER_VERSION`、doctor import、`registerDoctorTool` 注册调用及其注释；其余逐字节保留，实现时按最小 diff 执行。）

**`marketplace.json`（全文，发布形态）**：

```json
{
  "name": "dev-zcode-crosschat",
  "owner": { "name": "QiruiGo" },
  "plugins": [
    {
      "name": "zcode-crosschat",
      "source": "./plugin",
      "version": "0.4.0",
      "displayName": "ZCode CrossChat",
      "displayName_i18n": { "zh-CN": "跨会话协作" },
      "description": "Dispatch verifiable tasks between independent ZCode sessions with a file mailbox and attempt tokens.",
      "description_i18n": { "zh-CN": "在独立 zcode 会话之间派发可检验任务：文件邮箱、六态状态机、回执唤醒。" },
      "category": "developer-tools"
    }
  ]
}
```

**`plugin/package.json`（全文，发布形态；新增 engines——pain-audit P11 的最低版本声明，与 build.mjs `target:"node22"` 一致）**：

```json
{
  "name": "zcode-crosschat-plugin",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "description": "Source package for the zcode-crosschat plugin (plugin root = this directory).",
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^3.25 || ^4.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.5"
  }
}
```

**`plugin/.zcode-plugin/plugin.json`（全文，发布形态；改动=version + 三个 userConfig 描述，其余与 v0.3.0 逐字节一致）**：

```json
{
  "name": "zcode-crosschat",
  "version": "0.4.0",
  "description": "Agent-team collaboration for independent ZCode sessions: a lead coordinates engine-provisioned teammate sessions, members self-start via prompt protocol, and a file mailbox remains the source of truth. v0.3 adds the cross-session peer axis: a machine-global peer registry, named-pipe transport, name-as-address addressing, and accept/hold/refuse inbound policy.",
  "description_i18n": {
    "en": "Lead-teammate collaboration across independent ZCode sessions plus a cross-session peer axis: machine-global peer registry, named-pipe transport, name-as-address addressing, accept/hold/refuse inbound policy, and structured attribution envelopes on every inbound peer message.",
    "zh-CN": "跨独立 zcode 会话的队长-队员协作，外加跨会话 peer 轴：机器全局 peer 注册表、命名管道传输、名字即地址寻址、accept/hold/refuse 入站策略，以及每条外来消息都带结构化信封与归因尾注。"
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
        "XC_ZCODE_CJS": "${user_config.zcode_cjs}",
        "XC_MAX_MEMBERS": "${user_config.max_members}",
        "XC_MEMBER_MODEL": "${user_config.member_model}",
        "XC_MEMBER_PROVIDER": "${user_config.member_provider}",
        "XC_MEMBER_REASONING": "${user_config.member_reasoning}",
        "XC_MEMBER_BOOTSTRAP_TIMEOUT_MS": "${user_config.member_bootstrap_timeout_ms}",
        "XC_INBOUND_MODE": "${user_config.inbound_mode}",
        "XC_STALE_TASK_MINUTES": "${user_config.stale_task_minutes}",
        "XC_CROSSCHAT_INBOUND": "${user_config.cross_session_inbound}",
        "XC_PEER_RECEIVE": "${user_config.peer_receive}",
        "XC_HOLD_TTL_MS": "${user_config.hold_ttl_ms}",
        "XC_MESSAGING_DIR": "${user_config.messaging_dir}"
      }
    }
  },
  "userConfig": {
    "wake_enabled": {
      "type": "boolean",
      "default": false,
      "title": "推送唤醒",
      "description": "派发/回传/解除阻塞后用 zcode --resume 无头唤醒目标会话（经孤儿化跳板，派发方退出不影响唤醒；fire-and-forget，失败自动回落邮箱投递）。团队自动开工演示必须开启；默认关闭以保护正被桌面持有的会话。"
    },
    "zcode_exe": {
      "type": "file",
      "default": "",
      "title": "ZCode 可执行文件",
      "description": "推送唤醒与成员供给用的 zcode 可执行文件绝对路径。留空时插件自动探测本机 zcode 安装（Windows；探测过程可在 xc_doctor 查看），仅探测失败时才需要手填（zcode 安装目录下的 ZCode.exe）。"
    },
    "zcode_cjs": {
      "type": "file",
      "default": "",
      "title": "zcode CLI 入口脚本",
      "description": "与 zcode_exe 配套的 CLI 入口脚本绝对路径（通常为 zcode 安装目录下 resources\\<variant>\\zcode.cjs）。留空时随 zcode_exe 一并自动探测。"
    },
    "max_members": {
      "type": "number",
      "default": 8,
      "title": "成员上限",
      "description": "团队最大成员数（含 lead 之外的全部成员，removed 不计）。超限的 xc_member_add 被硬拒。对照 dsh-agent-teams maxMembers 默认 8。"
    },
    "member_model": {
      "type": "string",
      "default": "",
      "title": "成员模型",
      "description": "新建成员会话使用的模型 id（如 glm-5.3-flash）。留空时引擎从可用模型表自动选第一个——它可能是当前账号不可用的模型；若建员因模型失败，失败回执会给出可选模型与填写指引，届时再填本项即可。"
    },
    "member_provider": {
      "type": "string",
      "default": "",
      "title": "成员模型 provider",
      "description": "成员模型的 providerId（如 opencode）。留空时按枚举表自动匹配。"
    },
    "member_reasoning": {
      "type": "string",
      "default": "max",
      "title": "成员推理档位",
      "description": "成员会话的 reasoningLevel（默认 max）。"
    },
    "member_bootstrap_timeout_ms": {
      "type": "number",
      "default": 300000,
      "title": "成员供给超时",
      "description": "xc_member_add 等待成员欢迎回合完成的上限（毫秒）。超时成员标记 failed，可同名重试（幂等重供给）。"
    },
    "inbound_mode": {
      "type": "string",
      "default": "accept",
      "title": "队内入站消息策略",
      "description": "对成员间自由消息（chat 帧）的入站裁决：accept 直接入箱；hold 进 .held.jsonl 待 xc_inbound_review 处置（钩子不注入、唤醒不携带）；refuse 直接拒收并给发送者回执。协议帧（派单/回执/空闲/解除阻塞）不受此开关影响。"
    },
    "stale_task_minutes": {
      "type": "number",
      "default": 30,
      "title": "僵尸任务阈值（分钟）",
      "description": "claimed/in_progress 任务超过该分钟数无任何状态更新且成员无在途唤醒时，被引擎清扫回 pending 并向 lead 发 failed 回执。成员守则要求长任务每 10 分钟心跳一次。"
    },
    "cross_session_inbound": {
      "type": "string",
      "default": "",
      "title": "跨会话入站策略（用户层）",
      "description": "本机所有会话的跨会话（peer）入站裁决的用户层取值：accept / hold / refuse。**留空 = 未设**（出厂默认留空，刻意如此：若默认填 accept，则每个会话恒有显式 accept，mode-parity 自动档将永不可达）。与项目层（<工作区>/.crosschat/peer/inbound.json，可按 sessionId 逐会话设置）与会话层（环境变量 XC_CROSSCHAT_INBOUND）共同参与「最严胜」——三者取最严者，不存在某一层放松另一层的情况。三个显式层都未设时走 mode-parity 自动档（按双方权限档类判定）。非法取值按 hold 处理（fail-closed）。"
    },
    "peer_receive": {
      "type": "string",
      "default": "on",
      "title": "跨会话接收总开关（kill-switch）",
      "description": "设为 off 时本机所有会话一律拒收跨会话消息（等价 CC 的 receive kill-switch），压过一切显式设置与自动档，经环境变量 XC_PEER_RECEIVE 注入 MCP server 进程。空串或非 off 视为未命中（默认 on）。"
    },
    "hold_ttl_ms": {
      "type": "number",
      "default": 43200000,
      "title": "跨会话暂存期限（毫秒）",
      "description": "被 hold 的跨会话消息在等待人工放行期间的存活时长，默认 12 小时；到期回执 expired。CC 的对应数值未取证，此为 zcode 自定值。"
    },
    "messaging_dir": {
      "type": "string",
      "default": "",
      "title": "peer 注册表目录（留空=插件数据目录）",
      "description": "机器全局的跨会话 peer 注册表根目录。留空时用插件数据目录（ZCODE_PLUGIN_DATA/peers）；填绝对路径可改到别处（例如做隔离演示）。"
    }
  }
}
```

### 6.3 各模块对外接口（并行对接签名）

```ts
// R1 zcode-locate.ts（供 wake.ts / provision.ts / R2 doctor / 测试）
export interface ZcodePair { exe: string; cjs: string }
export type LocateSource = "user_config" | "exec_path" | "process_table" | "parent_process"
  | "registry" | "common_paths" | "";
export interface LocateAttempt { step: string; hit: boolean; detail: string }
export interface LocateOutcome { found: boolean; source: LocateSource; pair: ZcodePair | null;
  attempts: LocateAttempt[]; guidance: string }
export const LOCATE_GUIDANCE: string;
export function deriveCjsCandidates(exeDir: string): string[];
export function pairFromExe(exe: string): ZcodePair | null;
export type ZcodeProbe = (script: string) => string;   // 探测注入缝（复核轮 F2）
export function locateZcodePair(env?: NodeJS.ProcessEnv, probe?: ZcodeProbe): LocateOutcome;
export function resetLocateCache(): void;
export interface ResolvedSpawnConfig { zcodeExe: string; zcodeCjs: string; outcome: LocateOutcome }
export function resolveZcodeSpawnConfig(env?: NodeJS.ProcessEnv, probe?: ZcodeProbe): ResolvedSpawnConfig;

// R2 doctor-tool.ts（供 server.ts / 测试）
export interface DoctorReport { /* 见 §2.5 全文 */ }
export function buildDoctorReport(input: { version: string; env: NodeJS.ProcessEnv; cwd: string }): DoctorReport;
export function registerDoctorTool(server: McpServer, input: {
  version: string; env: NodeJS.ProcessEnv; cwd: string;
}): void;

// R3 pack-release.mjs（CLI 契约，无导出）
//   node scripts/pack-release.mjs v<x.y.z> [--keep-stage]
//   退出码 0 = 产物 + .sha256 就绪并打印 releaseSha；≠0 = 断言失败（版本不一致/构建失败/冒测失败）
```

---

## 7. 风险与未确认清单（如实声明）

| # | 项 | 状态 | 处理 |
|---|---|---|---|
| U1 | **published Release 资产的匿名下载**无成功样本（github.com 443 间歇阻断时段实测，RELEASE-RECON.md:106）；硬标准 1 的成败单点押此项——clone 路径必带构建、不满足零构建（复核轮 F8 风险声明） | 未确认 | S3 必须取得真实样本（匿名或认证，如实标注通道）；**执行期必须落实 ≥3 个时间窗重试并在验收报告附重试记录或阻断证据**，不得以认证下载冒充匿名结论 |
| U2 | `resources\glm\zcode.cjs` 的 `glm` 段在其他机器/版本稳定性 | 单机样本 | 探测已做 glob 兜底（§2.3 F5）；README 的手填指引写 `resources\<variant>\zcode.cjs` |
| U3 | 探测各步在真实宿主 MCP 进程内的时延（PowerShell 冷启动） | 未实测（本机 bash/桌面环境未测进程内时延） | 单步 4s 超时护栏 + 实现期自由度（负结果 TTL 缓存）；S2b 实测建员耗时留证 |
| U4 | `session/list` 是否暴露会话模型 ref（V-M1 的前提） | 未取证（PLATFORM.md:163 仅列方法名） | 先最小 probe 验证，有证据才实现 lead-模型缺省，否则维持现状 |
| U5 | `marketplace add` 的 url 形态（tgz URL 直装） | 未测（侦察明示，RELEASE-RECON.md:109） | 不进本版设计；README 不给该形态 |
| U6 | `gh release edit --draft=false` 的可用性 | 未实测 | 规避：直接创建正式 release（§3.1 红线 3） |
| U7 | 会话加载期坏 dist 的 404 表现（静默坏插件在会话里的症状细节） | recon 只到「MCP/hooks 404」粒度（recon/02:43） | 不影响本版（预构建+红线消除该形态）；README FAQ 不描述未实测症状 |
| U8 | 本设计未跑网络获取/gh release/两会话冒烟（属验收环节） | 本环节未执行 | §5 全部为验收期命令；本环节实跑项见「输入基线」节 |

风险预判：①github.com 阻断窗口可能拖长 S1/S3/S4 的下载步——验收脚本对下载步做 3 窗重试并全程留痕，最终以真实通道结论入报告；②`npm ci` 在打包机需访问 npm registry（与 GitHub 通道无关，本机历史可用——pain-audit §2 步骤 1 实测 4.3s/144 包）；③探测多 ZCode 安装机的歧义——见 §2.2 缓解。

## 8. 证据索引

- 仓内：`docs/RELEASE-RECON.md`（§0 速览 :12-18、§1 路径 :24-49、§2 物化铁律 :53-76、§3 探测 :80-100、§4 未确认 :102-111）；`docs/PLATFORM.md`（:95 source kinds、:105 代理坑、:134 CLI 不在 PATH、:153 模型回落坑、:163 app-server 方法面、:271 P1 枚举）；`docs/IMPLEMENTATION.md` §9.4（版本三处+lock 教训）；`plugin/src/engine/resume-cli.ts:75-82,136-146`、`appserver.ts:38-46,141-147`、`wake.ts:481`、`provision.ts:141-167,223`、`mcp/server.ts:35,62-74`、`mcp/tools.ts:803-808`（注册形态）、`scripts/build.mjs`、`package.json:12-21`、`package-lock.json:3,9`、`.gitignore`（`.scratch-*/`）
- 工作区：`deepseek-crosschat/evidence/14-release/{pain-audit.md,recon/01..04}`（P1-P12、五 case 铁律、cfg-prebuilt 转写、瘦身数据、沙箱方法）；`deepseek-crosschat/reports/12-v030验收.md`（七条基线、§5.4 零改动纪律、§9）
- 本环节实跑：`git log/status/tag`（HEAD=f951549、tag v0.3.0、仅 RELEASE-RECON.md 未提交）；`gh --version`=2.103.3、`gh auth status`=QiruiGo 已登录（repo scope）；`which tar`=GNU tar 1.35；全部源文件与证据文件的通读（路径见上）
