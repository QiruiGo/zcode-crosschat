# DEMO：zcode-crosschat 演示说明

## 第一部分：v0.2.0 团队协作演示（lead-成员·自动开工·动态成员）

- 日期：2026-11-09
- 插件：`zcode-crosschat` v0.2.0（设计见 [DESIGN-V0.2.md](DESIGN-V0.2.md)）
- 演示内容：**一条指令**驱动 lead 会话完成「立队 → 程序化创建 3 个新成员 → 派发 3 个并行任务 → 成员零人工开工 → 回执 → lead 独立核对并汇总」——Claude Code Agent Teams 的跨对话协作模式在 zcode 上的等价复现。
- 验收报告：`deepseek-crosschat/reports/10-v020验收.md`（证据根 `evidence/10-v020/acceptance/`）。

### 演示流程（一次真实运行的还原）

```text
（人工）配置插件设置：wake_enabled=true + 本机 zcode_exe/zcode_cjs 路径 + member_model
（人工）启动 keeper 引导脚本（deepseek-crosschat/evidence/10-v020/acceptance/_scripts/keeper-lead.mjs）
        —— 它经 app-server 建一个引导用 lead 会话，并程序化发送唯一人工指令：
        「把 1 到 10 的平方拆成三个子任务，交给三个新成员并行完成……」
        此后 keeper 导出 lead 回合记录并退出——演示的"人工输入"到此为止。

（自动）lead 一个回合内：xc_team_init 立队 → xc_member_add×3（引擎经 app-server
        程序化建会话+设模型+欢迎回合自动注册，零人工开窗口）→ xc_dispatch×3（delivered=wake）
（自动）keeper 已退出；成员被"孤儿化唤醒"（wake-helper 跳板，派发方退出不影响）：
        各自一个无人回合完成 注册→认领→写文件→汇报→空闲通知
（自动）回执唤醒 lead（属主缺席形态）：lead 读回执 → 独立读取三个 result-m*.txt
        核对行数与数值 → 输出最终汇总报告（含每个任务的成员、结果与 sha256 证据）
```

### 关键证据（验收实测，2026-11-09）

- 3 成员并行执行窗口两两重叠（13.7s / 17.3s / 21.8s）；3 任务 evidence sha256 验收员独立复算全部一致；
- owner-absence 审计：全程 0 次对活属主/供给中成员的唤醒；5 组 wake 全部经 wake-helper 孤儿化跳板（wake/wake-child 成对）；
- CLI 单发派发方退出后 19.25s 成员仍全自动完成任务（v0.1.0 的 V9 清杀问题已修复）；
- pull 邮箱闭环（v0.1.0 形态）回归通过且 0 条 wake 行；v0.1.0 真源数据在新版本下照常读写；
- 控制与安全：xc_status v2 全景、xc_cancel（任务→cancelled）、xc_member_stop（成员→removed 且重注册被硬拒）、未知协议帧拒收+审计、入站 hold/refuse、冒名注册被 name_taken 拒绝。

---

## 第二部分：v0.1.0 两会话闭环演示（pull 形态，原样保留）

- 日期：2026-11-09
- 插件：`zcode-crosschat` v0.1.0（本仓 `plugin/`，设计见 [DESIGN.md](DESIGN.md)，实现见 [IMPLEMENTATION.md](IMPLEMENTATION.md)）
- 演示内容：两个**互相独立**的 zcode 会话 A、B，A 通过插件机制向 B 派发可检验小任务，B 执行，结果/状态回传 A——「派发 → 执行 → 回传」闭环真实成立。
- 本文不含本机敏感信息；路径以 `<workspace>`（演示工作区）代指。

### 1. 演示形态（对应 DESIGN §3 的选择）

**全独立对等会话 + 文件邮箱真源**：

- A、B 是两个互不归属的顶层 zcode 会话（无父子关系、生命周期互不绑定、上下文互不渗透），仅共享同一 `<workspace>/.crosschat/` 磁盘真源与同一插件安装。
- 每个会话各有自己的插件 MCP server 进程；身份绑定在 stdio 连接上（`xc_register`），跨进程并发由 lockfile 仲裁。
- 任务状态机（六态 + attempt 令牌）、邮箱（JSONL）、审计日志全部落盘，人可随时查看（验收标准 2、3）。

### 2. 一次性准备

```bash
# 1) 构建与校验（node ≥ 22）
cd <repo>/plugin && npm install && npm run build && npm test
zcode plugins validate "<repo>/plugin"     # → Plugin manifest is valid

# 2) 安装（本地目录市场；CLI 语法实测可用）
zcode plugins marketplace add "<repo>"     # → Added marketplace <marketplace-name> (1 plugins)
zcode plugins install zcode-crosschat@<marketplace-name>
zcode plugins list                          # → zcode-crosschat@… [enabled] skills:1 commands:4 hooks:3 mcp:…

# 3) 准备两个会话（本演示用 app-server 建 + setModel，保证模型选择持久化；
#    也可以直接用桌面端两个普通会话）
node demo/bootstrap-sessions.mjs --workspace <workspace>   # 建会话 a、b 并完成 xc_register
```

首轮注册也可以在任意会话里手动说一句「调用 xc_register，name 填 a，sessionId 填 <你的 sid>」完成（sessionId 由 SessionStart 钩子注入上下文）。

### 3. 闭环演示（pull 路径，默认配置即可复现）

### 3.1 A 派发（会话 A 中）

> `/xc-dispatch b 计算 17*23，把结果只写数字到 result-a2b.txt`

或自然语言：让 A 调 `xc_dispatch(to:"b", title:…, prompt:…, acceptance:"文件存在且内容为 391")`。

返回：`taskId: t1, delivered: mailbox`（wake 未开启时的预期值）。磁盘立即可见：

```
<workspace>/.crosschat/teams/default/team.json     # t1: pending
<workspace>/.crosschat/teams/default/inbox/b.jsonl # 1 条任务分派消息
<workspace>/.crosschat/logs/engine.jsonl           # register / dispatch 行（delivered=mailbox）
```

### 3.2 B 执行（会话 B 中说一句「继续」即可）

UserPromptSubmit 钩子会注入「你有 N 条未读」；B 的执行链（全程工具硬校验）：

```
xc_check_inbox → xc_claim(t1)           # 返回 attemptId（能力令牌）
xc_report(in_progress)                  # 状态：claimed → in_progress
写 <workspace>/result-a2b.txt 内容 "391"
xc_report(completed, result=…, evidence=[{path, sha256, note}])
                                        # 状态：in_progress → completed；回执自动写入 a 的邮箱
```

### 3.3 A 回传核验（会话 A 中说「收结果」）

```
xc_check_inbox   # 读到 t1 完成回执（含 result + evidence + sha256）
读 result-a2b.txt # 391，与验收标准一致；sha256 与 evidence 一致
xc_status        # t1: completed（attempt 1）
```

向用户汇报：**「b 已完成 t1：391，证据文件已核验」**。回执消息 `readAt` 落盘（消费即盖章）。

### 4. 自动唤醒链（push 路径，可选进阶）

在插件设置中把 `wake_enabled` 设为 `true`（或按 §2 的配置键写入用户配置）后：

- A `xc_dispatch` 成功后引擎**自动** spawn 无头 `--resume B` 唤醒回合，B 在无人干预下完成「wakeToken 注册 → 查收 → 认领 → 执行 → 报告 → 回传唤醒 A」全链；
- 实测记录：`delivered=wake`、唤醒回合完整 JSON 输出落盘 `<workspace>/.crosschat/logs/wake-<to>-<ts>.json`、任务状态自动推进、结果文件自动产出。
- **已知边界（V9，2026-11-09 实测）**：当**派发方**是 CLI 单发回合（属主即起即退）时，该 CLI 进程退出会连带终止其进程树内的唤醒子进程（唤醒回合能启动、钩子能触发、消息能送达，但回合中途被清杀、stdout 不落盘）。常驻属主（桌面端 / app-server 持有的会话）作为派发方时唤醒链完整成立。**派发/执行/回传三环不受此影响**（邮箱为真，唤醒只是优化）；受影响的只是「B 完成后自动把 A 推醒」这一跳——A 下一回合的 pull 注入（§3.3）是保底路径。

### 5. 人在环上的可观测面（验收标准 2/3）

| 看什么 | 在哪 |
|---|---|
| 任务板（六态 + attempt 代数 + history 时间线） | `<workspace>/.crosschat/teams/default/team.json`；会话里 `/xc-status` |
| 邮箱全生命周期（readAt/deliveredAt） | `<workspace>/.crosschat/teams/default/inbox/<key>.jsonl` |
| 引擎审计（register/dispatch/claim/report/wake 每步一行） | `<workspace>/.crosschat/logs/engine.jsonl` |
| 唤醒回合原始输出 | `<workspace>/.crosschat/logs/wake-<to>-<ts>.json` |
| 状态快照 | `<workspace>/.crosschat/teams/default/snapshot.json`（xc_status 每次调用刷新） |
| 会话与消息审计 | `~/.zcode/cli/db/db.sqlite`（只读） |

### 6. 演示要点对照（验收四条）

1. **闭环真实成立**：A `xc_dispatch` → B `xc_claim`+执行+`xc_report(completed)` → A `xc_check_inbox` 核验 sha256 后汇报；任务产物（如 `result-a2b.txt`）与状态链（pending→claimed→in_progress→completed）全部落盘可查。
2. **过程人可观测**：§5 的六个观测面。
3. **状态跟踪**：六态状态机 + attempt 令牌 + team.json history；`xc_report` 带错误 attemptId 会被硬拒。
4. **形态与独立性**：全独立对等会话（DESIGN §3），无父子归属、无生命周期耦合、上下文互不渗透；共享面仅 `.crosschat/` 磁盘真源与插件安装。

### 7. 复现注意事项

- 两个会话必须共用同一 `<workspace>`（v1 边界）。
- 每条新的 MCP 连接（每次无头回合 / 每个新会话）都要先 `xc_register`；被引擎唤醒的回合 prompt 会自带 sid 与一次性 wakeToken，属正常机制。
- `xc_claim` 返回的 `attemptId` 是 `xc_report` 的唯一凭证；stale 即拒。
- 若变更类工具返回 `{"error":"busy"}`：跨进程锁 15 秒等待后仍被占，稍后重试一次。
- 不要在派发后 busy-poll；回执会唤醒你，或下一回合自动注入未读提示。
