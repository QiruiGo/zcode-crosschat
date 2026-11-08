# FEASIBILITY-V0.2 —— v0.2.0 两条补齐路径的可行性实测报告

- 实验人：可行性侦察员（动态工作流子代理）
- 日期：2026-11-09
- 任务：实测 ① V9 修复路径（唤醒/成员回合脱离派发方进程树）、② 动态成员路径（程序化建会话+设模型+首轮 prompt 自动开工），在临时目录做实验，不动正式仓
- 证据根目录：`D:\tools\deepseek-crosschat\evidence\10-v020\feasibility\`（执行序列与全部原始输出见其 `runbook.md`；下文「证据」列均相对该目录）
- 实验环境：Windows 11 + Git Bash；zcode CLI 0.17.1（`E:\ZCode\ZCode.exe` + `E:\ZCode\resources\glm\zcode.cjs`）；插件 `zcode-crosschat@dev-zcode-crosschat 0.1.0`（已启用）；模型 glm-5.3-flash（opencode provider，reasoningLevel max）
- 纪律声明：全部结论来自本次实验实际执行（命令+输出在证据目录可复核）；查证不了的地方在 §6 明示「未确认」。实验期间 `~/.zcode/cli/config.json` 的改动已逐字节复原（`_logs/config.json.bak-feas-v020` 比对 `config restored exactly: True`）。

---

## 0. 结论速览

| 路径 | 判定 | 一句话结论 |
|---|---|---|
| ① V9 修复 | **可行，两条修复路径均端到端验证通过** | 推荐主路径「helper 孤儿化」（引擎 spawn 改经一个立即退出的中间进程，零新增依赖）；备选「WMI 逃逸」（已验证，但有 SYSTEM 环境坑需按 §2.4 处理）；真实引擎的 V9 已复现并据此对照 |
| ② 动态成员 | **可行，全链（建会话→设模型→首轮自注册→派发→唤醒→自动开工→回执核验）一次跑通** | app-server 协议支持程序化建会话；setModel 生效有实据；首轮 send 后 ≤3s 会话即持久化（硬杀 app-server 不丢）——引擎可在派发回合内同步动态建员 |

对 v0.1.0 被打回的三点缺陷（09 报告背景）：wake 自动开工受限（V9）→ 本报告给出两条实测修复路径；无动态成员 → E4 全链打通；队长-队员调度（派发/认领/回执）v0.1.0 已有，本次实验在其上原样复用（同一套 `xc_dispatch/xc_claim/xc_report` 协议）。

---

## 1. 机制实验（E1/E2/E3a）：V9 的机理被修正，「作业对象清杀」论被实验否定

### 1.1 E1/E2：两种 spawn 形态在 CLI 单发回合内的存活对照

方法：让会话 A 的 CLI 单发回合（`--resume sess_91f99771… --prompt …`）经模型 Bash 工具执行 `_scripts/spawn-child.mjs`，在**回合进程树内**以三种方式拉起心跳子进程（每 500ms 落盘一拍），记录 CLI 退出时刻 t1，观察子进程是否死在 t1 附近：

| 实验 | spawn 形态 | 结果（证据） |
|---|---|---|
| E1-direct | `spawn({detached:true, stdio:"ignore", windowsHide:true})+unref`，即 `plugin/src/engine/resume-cli.ts:108-114` spawnResume 的同形态，spawner 立即退出 | **存活**：心跳最后一拍在 t1（1794167867332）之后 40.7s，4 分钟后 `Get-Process` 仍在（pid 26724）。`_logs/e1-heartbeat-direct.log`、`_logs/e1-turn-output.raw.json` |
| E1-breakaway | `CreateProcessW` 加 `CREATE_BREAKAWAY_FROM_JOB` 标志 | **成功返回 `OK:16516`**（未报 ERROR_ACCESS_DENIED）→ 派发方进程树上**不存在禁止 breakaway 的 Windows 作业对象**；该子进程同样存活。09 报告 §4.3 的「疑似 Windows 作业对象清杀」假说被本实验否定 |
| E2-wmi | `Invoke-CimMethod Win32_Process Create`（父进程=WmiPrvSE，彻底出树） | **存活**：最后一拍在 t1（1794168148020）之后 40.2s（pid 16652）。`_logs/e2-heartbeat-wmi.log` |

（job 探针 `IsProcessInJob(NULL)` 对所有进程都返回 true，系 Windows 作业嵌套的普遍现象，无法区分「派发方作业」与「无关作业」，仅作弱诊断记录在 spawn 输出 JSON 中；判定一律以存活实验为准。）

### 1.2 E3a：真实引擎复现 V9（对照组，与 E1 同环境同时段）

- 开启引擎 wake（`python -I _scripts/set-wake-config.py enable`，即 09 报告 §4.1 的 `plugins.options` 写法），A 用 CLI 单发回合 `xc_dispatch` 派发 t1（71×53→result-e3a.txt，验收 3763）。
- 引擎真实走 `attemptWake`（`plugin/src/engine/wake.ts:307-406`）→ spawnResume 从 **MCP server 进程**（CLI 的常驻子进程）拉起唤醒子进程 pid 7940，spawn 时刻 1794168267262；**CLI 在 spawn 后 7.6s 退出**（t1=1794168274879）。
- 结果（80s 观察窗）：唤醒日志 `wake-b-1794168267262.json` **始终 0 字节**；engine.jsonl 显示 `hook-session-start`、`hook-prompt-submit-unread`、`hook-stop-probe` 都已触发（子进程确实启动并跑过钩子）；`Get-Process -Id 7940` → **DEAD**；t1 卡 `pending`（history 仅 created）。与 09 报告 §4.3 的签名完全一致。证据：`_logs/e3a-turn-output.raw.json`、`ws-wake/.crosschat/logs/engine.jsonl`。

### 1.3 机理结论（推断，非解剖；两种修复不依赖机理认定）

三组对照（E1-direct 孤儿存活 / E3a MCP-server 之子死亡 / E1-breakaway 无禁逃作业对象）共同指向：**清杀只够到「父链仍然存活」的后代**——CLI 退出时的清理沿活父链向下杀（MCP server 活到 CLI 退出，故其 detached 孙子被找到；而先退出的 helper 留下的孤儿链断了，杀不到）。真正的作业对象清杀论与 E1 矛盾。**此机理为高置信推断，未做内核级解剖**；但 §2 的两条修复路径的有效性不依赖机理认定——它们都已被端到端实验直接验证。

---

## 2. 修复路径①（V9）：两条实测通过的路

### 2.1 路径 A（推荐主路径）：helper 孤儿化——引擎 spawn 改经「立即退出的中间进程」

实验（E3b，同 E3a 环境但引擎 wake 关闭、由引擎代理脚本 `_scripts/wake-via-escape.mjs --mode direct` 承担 spawn）：

- A 的 CLI 单发回合：`xc_register` → `xc_dispatch`（t2：64×37→result-e3b.txt，验收 2368，`delivered=mailbox`）→ Bash 执行代理脚本。
- 代理在**回合内**生成 wake nonce（`registry.ts newWakeNonce` 同格式）、按 `buildWakePrompt`（`wake.ts:208-232`）同构组装 1025 字符唤醒 prompt，以 spawnResume 同形态 detached 拉起 ZCode.exe 唤醒回合（pid 14596）后**立即退出**（孤儿化）；CLI 在 spawn 后 5.7s 退出（t1=1794168427762）。
- 结果：t+40s 唤醒日志 1168 字节；**t2 status=completed**（created→claimed→in_progress→completed），`result-e3b.txt`=2368，sha256 与 evidence 一致；回执落 a 邮箱。
- **加分证据（pull 兜底）**：该唤醒回合顺带把 E3a 遗留在 b 邮箱的 t1 也消费完成了（t1=3763 ✔）——引擎 wake 死了消息也不丢，邮箱真源+下次唤醒自动补做，与 DESIGN §2.1「邮箱为真、唤醒为优化」一致。
- 收口：A 的 pull 回合核对 4 条回执原话「收件箱 4 条回执（t1–t4 均为 completed…）4/4 通过」（`_logs/e3-final-pull-response.txt`）。

**v0.2 集成设计**（改动集中在 `plugin/src/engine/resume-cli.ts`，wake.ts 编排不动）：

```
spawnResume(opts) 现形态：MCP server 直接 spawn ZCode.exe（resume-cli.ts:108-114）      ← E3a 证明会被清杀
spawnResume 新形态：MCP server spawn node helper（命令行传 sid/prompt/cwd/logFile，args 数组不经 shell）
                    → helper 复用现有 spawn 逻辑拉起 ZCode.exe（detached+unref）→ helper 立即退出
```

- helper 继承 MCP server 的用户环境（无需 env 文件）；prompt 经 args 数组透传，与现在一致（≤4000 字符远低于 32k 命令行上限）。
- 代价：每次唤醒多一个存活 <1s 的 node 进程；无新增依赖、无系统服务调用。
- 残余风险（如实声明）：若派发方回合在 helper 拉起子进程之前的毫秒级窗口内被清杀，唤醒丢失——但 attemptWake 的「spawn 同步失败→release 租约→降级 mailbox→投递租约到期可重试」编排（`wake.ts:353-389`）本就为此兜底，且邮箱消息不丢，下次唤醒/拉取补做（E3b 对 E3a 遗留 t1 的自动补做即实证）。

### 2.2 路径 B（备选/加固）：WMI 逃逸——`Win32_Process Create` 让唤醒父进程=系统 WMI 宿主

实验（E3c 失败→修复→E3c2 通过）：

- E3c（86×47 之外的 72×35→result-e3c.txt）首跑失败：唤醒子进程启动即死，日志尾行 `✗ 未找到 CLI ZCode Built-in Provider Config：E:\ZCode\resources\glm\provider\zcode-builtin.json, E:\config\provider\zcode-builtin.json`（`ws-wake/.crosschat/logs/wake-b-1794168533287.json`）。
  → **新平台事实 P3：WMI 拉起的进程继承 WmiPrvSE 的 SYSTEM 环境（无用户 env），zcode CLI 因此找不到用户 provider 配置。**
- 解法（已实现并验证）：派发方回合把完整 `process.env` 落盘（`wake-env-<to>-<ts>.json`）→ WMI 拉起 wrapper（`_scripts/wake-wrap.mjs`）读回并整体替换唤醒子进程 env。
- E3c2（t4：86×47→result-e3c2.txt，验收 4042）：代理 wmiPid=8916，spawn 后 9.8s CLI 退出；**首个 20s 轮询周期内 t3（E3c 遗留票）与 t4 全部 completed**（2520/4042），sha256 全对；唤醒回合自述「t3/t4 均已完成并回报，回执均已发送给 a」。证据：`_logs/e3c2-turn-output.raw.json`。
- 特点：父进程=WmiPrvSE（系统常驻服务宿主），**等价于系统免费提供的「常驻 spawner」**，无需自建守护进程；代价是每次一次 PowerShell/CIM 调用（~1-2s）+ env 落盘，且比路径 A 多一个环境坑要处理。

### 2.3 三种可用形态的关系（对 09 报告修复方向的收口）

| 形态 | 实验 | 适用 |
|---|---|---|
| 常驻属主 spawn（app-server keeper 持有派发方） | 09 §4.2 已证（wake-chain-run.mjs） | 派发方本身常驻的形态，天然无 V9 |
| **helper 孤儿化**（路径 A） | 本次 E3b | **推荐默认**：任何派发方形态（含 CLI 单发）通用，零依赖 |
| WMI 逃逸（路径 B） | 本次 E3c2 | 备选/加固：同通用，需处理 P3 环境坑 |
| ~~改经插件 MCP server 自身直接 spawn~~ | E3a（即 v0.1.0 现状） | **不可行**：MCP server 是派发方 CLI 的常驻子进程，恰在清杀范围内——v0.1.0 的失败形态本身 |

---

## 3. 修复路径②（动态成员）：E4 全链实测通过

### 3.1 实验链（ws-member 工作区，lead=`sess_7ba79f85…`）

1. **程序化建会话+设模型**（`_scripts/dm-create.mjs`，app-server 协议客户端，即 demo/bootstrap-sessions.mjs 的引擎化改形）：
   `session/create`（workspace/mode:yolo/titleGenerationEnabled:false）→ `session/setModel`（opencode/d1b9bdca，glm-5.3-flash，reasoningLevel max）→ **回合实际 modelId=glm-5.3-flash（`_logs/e4-dm-create.json` 的 `turn.modelId`）＝setModel 生效实据**。
   新成员 m1=`sess_91eeac57-a22b-429f-9852-91960b2d0403`。
2. **首轮 prompt 使其自动开工**：首轮 send 的 prompt 内嵌成员守则（register → check_inbox → 有任务则 claim/执行/report，无任务回 READY）——与 dsh `spawnMember` 的 `initialPrompt ?? memberWelcome(...)`（`src/dsh-agent-teams-0.1.29/lib/members.js:861-894`：程序化建员+persona+模型选择+首轮 prompt）同构。实测 m1 无人工干预完成自注册：engine.jsonl `{"event":"register","agentKey":"m1","via":"hook"}`，names.json/team.json 花名册含 m1。
3. **持久化三点探测（对 09 报告发现 A 的细化，新事实 P4）**：`db.afterSend3s=1 / afterTurn=1 / afterKill=1`——`session/send` 被 accept 后 **3 秒内**（首轮回合尚未完成时）`~/.zcode/cli/db/db.sqlite` 的 session 表已有该行，且 app-server 被 `child.kill()` 硬杀后仍在。→ **引擎在派发回合内同步建员是安全的**：send 成功即可让 app-server 随回合消亡，会话不丢（09 发现 A 的「只有 create 不落库」边界不变，但持久化时机比「回合完成」早得多）。
4. **派发→逃逸唤醒→自动开工**：A2 的 CLI 单发回合 `xc_dispatch`（to m1，t1：58×29→result-e4.txt，验收 1682，delivered=mailbox）→ 代理 `--mode wmi`（wmiPid=3320，spawn 后 8.3s CLI 退出）→ **t+20s t1=completed**（created→claimed→in_progress→completed），`result-e4.txt`=1682，唤醒回合自述 wakeToken 重注册（首次 not_registered 后按守则自动恢复）→认领→执行→回报（`_logs/e4-turn-response.txt`）。
5. **回执核验**：A2 pull 回合原话「completed（attempt 1，attemptId 893eada3）；1682；sha256 48f9e8fd…8eee 与回执 evidence 记录相符 ✅」（`_logs/e4-final-pull.raw.json`）。

### 3.2 v0.2 集成设计要点

- 引擎（MCP server 内）在派发回合同步执行「建员四步」：app-server create+setModel+首轮 send（成员守则+身份行），全部现有协议（PLATFORM §4.3），无需新平台能力；P4 保证 send 成功即持久化，不必等首轮回合完成，app-server 子进程随回合消亡无碍。
- 建员后的首个任务投递走「mailbox+逃逸唤醒」（§2 路径 A）——与 dsh「spawn 带 Welcome prompt → 队长派发 → scheduler 唤醒成员 FIFO 回合」的能力一一对应，不降效。
- 模型枚举注意 P1（§4）：`model.available` 从 `session/create` 结果的 `settings.model.available[].ref` 取，`state.updated` 不可依赖。

---

## 4. 本次新确认的平台事实（P1–P5，建议回填 PLATFORM.md/DESIGN.md）

| # | 事实 | 证据 |
|---|---|---|
| P1 | 本 build（0.17.1，2026-11-09）`session/create` 结果内联 `settings.model.available[].ref` 全量模型表（52 个）；35s 观察窗内无 `state.updated` 事件——PLATFORM §4.3-2 的「运行时枚举 state.updated」方法需更新 | `_logs/raw-probe.log`（原始事件流实录）；`_scripts/bootstrap-local.mjs` 补丁 |
| P2 | demo/bootstrap-sessions.mjs 的 sendTurn 等待逻辑有缺陷：`finish=completed` 的 timeline 事件消息（无文本 parts）会被当作回合完成提前返回，导致真实回合被 app-server 退出腰斩（B 首轮注册一度丢失，后经无头 --resume 补注册成功） | §1 runbook；`_logs/ws-wake-bootstrap.log`、`_logs/b-register-resume.raw.json` |
| P3 | WMI（Win32_Process Create）拉起的进程继承 WmiPrvSE 的 SYSTEM 环境；zcode CLI 缺用户 env 时报「未找到 CLI ZCode Built-in Provider Config」无法启动回合——WMI 路径必须显式传用户 env | `ws-wake/.crosschat/logs/wake-b-1794168533287.json` 尾行 |
| P4 | 会话持久化时机：`session/send` accept 后 ≤3s 即落库（早于首轮回合完成）；app-server 硬杀后仍在（09 发现 A 细化） | `_logs/e4-dm-create.json` 的 `db.afterSend3s/afterTurn/afterKill` |
| P5 | CLI 单发回合进程退出时的清杀只够到「父链存活」的后代：helper 孤儿与 WMI 子进程存活、MCP server 的 detached 子进程被杀；不存在禁止 breakaway 的作业对象（V9 机理修正） | §1 三组对照实验 |

---

## 5. 对 DESIGN §9 的回填建议

- **V9（CLI 单发派发方清杀唤醒子进程）**：机理修正为 P5（清杀沿活父链，非作业对象）；修复路径实测收敛为 §2.1 路径 A（推荐）+ §2.2 路径 B（备选）+ 常驻属主（已有）；「唤醒受 V9 限制」的限制在 v0.2 可解除。
- **V5（活属主并发语义）、V3（Stop 续跑键名）、V8（MCP 进程计数）**：本次未测，维持未确认（与本任务两条路径无阻塞关系）。
- **新增建议条目**：V10=WMI 子进程的 SYSTEM 环境问题及 env 落盘解法（P3）；V11=对「回合完成等待器」须过滤 timeline 事件消息（P2）；持久化时机 P4 可从「未知」改为「send 后 ≤3s（实测）」。

## 6. 局限与未确认（如实声明）

1. V9 机理（P5）是三组对照实验支撑的**高置信推断**，未做内核级（如 ETW/作业句柄枚举）解剖；两条修复路径的有效性不依赖该推断（均端到端验证）。
2. 路径 A 的毫秒级竞态窗口（派发方回合在 helper 拉起子进程前即被清杀）未构造复现；其兜底逻辑（租约重试+邮箱真源）有 E3b 对 E3a 遗留票自动补做的实证，但「竞态概率」未量化。
3. 动态成员的 `maxMembers` 上限、成员工具白名单（toolFilter 对等物：session/create 的 toolAllowlist/toolDenylist）未实测——E4 只验证了「能不能建、建了能不能自动开工」；限额与安全面属 v0.2 实现期验证点。
4. WMI 路径仅测了「spawn 唤醒回合」一种负载；未测 WMI 在受限账户/组策略禁用 WMI 的机器上的可用性。
5. 实验会话均为新建独立会话（db 中 sess_91f99771/ab5df0c6/7ba79f85/91eeac57 等），未覆盖桌面端属主在场时的唤醒（V5 边界，v0.1.0 已按约束规避）。
6. 本次实验产生的测试工作区（ws-wake/ws-member）与 db 会话行留存作证据，未清理；`_scripts/` 脚本属实验件，v0.2 实现时应按 §2.1/§3.2 的设计重写进插件源码，而非直接搬用。

## 7. 证据索引（`D:\tools\deepseek-crosschat\evidence\10-v020\feasibility\`）

- `runbook.md`：全部命令、时间戳、输出的执行序列（本文各结论的「证据」均指向其中）。
- `_scripts/`：heartbeat.mjs（心跳子进程）、spawn-child.mjs（E1/E2 三形态 spawner+job 探针）、wake-via-escape.mjs（引擎代理 spawner：nonce+prompt 组装+direct/wmi 两模式）、wake-wrap.mjs（WMI 中间跳板，env 文件回读）、dm-create.mjs（E4 动态建员驱动+持久化三点探测）、bootstrap-local.mjs（demo 补丁版）、set-wake-config.py（wake 开关切换/复原）、raw-probe.mjs（app-server 原始事件流探针）。
- `_logs/`：各回合 raw JSON（e1/e2/e3a/e3b/e3c/e3c2/e4-turn-output.raw.json、final-pull）、心跳日志（e1-heartbeat-direct/breakaway.log、e2-heartbeat-wmi.log）、dm-create 输出、bootstrap 日志、config 备份。
- `ws-wake/.crosschat/`：E3 全程磁盘真源（team.json 四任务六态 history、inbox 回执与 readAt、engine.jsonl、wake 日志含 0 字节 V9 物证与 SYSTEM-env 失败物证）。
- `ws-member/.crosschat/`：E4 全程磁盘真源（动态成员注册、任务票、回执、wake 日志）。
