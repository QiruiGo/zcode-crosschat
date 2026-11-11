# FEASIBILITY-V0.3 —— 跨会话消息轴（传输层 + peer 注册表）可行性实测报告

- 实验人：传输侦察员（动态工作流子代理）
- 日期：2026-11-09
- 任务：实测 ① 传输层（插件 MCP server 内起 Windows 命名管道 / localhost TCP server，客户端投递端到端、失败模式与文件退化路径）、② peer 注册表（钩子写 peer 文件 + server 侧扫描发现、活跃判定与过期清理）
- 证据根目录：`<证据仓>\evidence\12-v030\feasibility\`（脚本 `_scripts/`、结构化结果 `_logs/`、现场 `_run/`；下文「证据」列均相对该目录）
- 配套规格：`docs/SPEC-V0.3.md`（规格精读员产出，R-1…R-30）。**本文只给实测事实**，并在 §7 逐条标注对 SPEC 条目的回填/修正/风险提示。
- 机制标尺：`reports/11-cc逆向.md` §3.b（跨会话 UDS/命名管道、token 鉴权、pid 注册表、名字即地址、`crossSessionInbound` 三态）
- 实验环境：Windows 11 + Git Bash；node v24.22.1（`C:\Program Files\nodejs\node`）；zcode CLI 0.17.1（`<安装目录>\ZCode.exe` + `<安装目录>\resources\glm\zcode.cjs`）；桌面宿主进程 pid 15560
- 纪律声明：全部结论来自本次实验实际执行（命令/脚本与原始输出在证据目录可复核）；未执行/未确认项在 §8 明示。实验期间安装的探针插件 `zcx-probe@zcx-probe-market` 属**实验件**，处置见 §6.4。

---

## 0. 结论速览

| 能力轴 | 判定 | 一句话结论 |
|---|---|---|
| **传输层（命名管道）** | **可行，端到端跑通** | 插件 MCP server（node 常驻进程）内 `net.createServer().listen('\\\\.\\pipe\\LOCAL\\…')` 可用；连接 3ms、100 次往返平均 0.1ms；token 鉴权、重复绑定冲突、目标消失均给出可判别错误码 |
| **传输层（localhost TCP）** | **可行但次选** | 同样跑通（RTT 0.08ms），但多一个端口分配/占用维度且跨用户可达面更大；CC 同款是命名管道，**建议以管道为主、TCP 不作默认** |
| **端到端跨会话消息** | **可行，全链 9/9 通过** | 两个模拟会话（各带真 MCP SDK stdio server + 命名管道）完成：钩子写 peer 基记录 → stdio 注册 → ListAgents 列出 → 按名字管道投递 → 对端收件+宿主 notification → 复活排空退化消息 → 抢名拒绝 → shutdown 帧 |
| **入站三态** | **可行** | accept/hold/refuse 三态在管道上逐一验证：hold 落 held 文件且不进投递面、refuse 不落任何队列并回执 `refused`、accept 直投 |
| **peer 注册表 + 钩子** | **可行，但绑定路径必须换** | 钩子能可靠写 peer 基记录；但**钩子「扫未认领 server 反向关联本会话」不可用**（5 轮复现 1 轮交叉绑定，机制依赖 readdir 序）→ 绑定必须走本会话自己的 stdio MCP 连接 |
| **活跃判定 / 过期清理** | **可行，判定矩阵实测成立** | `pid 存活 ∧ lastSeen 新鲜` = active；`¬pid 存活` 或 `lastSeen 陈旧` = 清理。两个扫描器并发清同一批互不报错；心跳恢复即复活 |
| **文件收件箱退化路径** | **可行且必要** | 对端缺席（`ENOENT`）→ 退化为 JSONL 收件箱；5 进程 ×10 条并发追加 **51/51 行零损坏**；排空用 rename 换出（并发追加不丢） |
| **平台硬约束（实测）** | **MCP server 进程拿不到 sessionId** | 净化父 env 的决定性对照：钩子进程有 `CLAUDE_SESSION_ID`，**MCP server 进程没有**（只有 `ZCODE_PROJECT_DIR`/`ZCODE_PLUGIN_*`）→ 跨会话注册表的「本会话身份」必须由钩子写入的基记录 + 模型显式参数提供 |
| **生命周期硬约束（实测）** | **必须自建 EOF 纪律** | MCP SDK 的 `StdioServerTransport` **不监听 stdin `end`** → v0.2 的 `transport.onclose → exit(0)` 在加了 net server 后**不再触发**，进程会永久变孤儿 |

---

## 1. 传输层：命名管道（T1）

### 1.1 实验形态

服务端 = 一个 node 常驻进程，在其中 `net.createServer()` 监听 Windows 命名管道，同时保持 stdin 读取（模拟插件 MCP server 的 stdio 协议流共存）。客户端 = 另一个 node 进程，走 NDJSON 帧协议。

- 脚本：`_scripts/t1-server.mjs`、`_scripts/t1-client.mjs`、`_scripts/t1-pipe.mjs`
- 结果：`_logs/t1-pipe-result.json`
- 管道名构型照 CC：`\\.\pipe\LOCAL\cc-msg-<32hex>`（`reports/11-cc逆向.md` §3.b，bundle 偏移 `@36108779` 的 `Xsa()`）；本实验用 `zcx-t1-<32hex>`

### 1.2 实测结果

| 场景 | 命令 | 实测输出（摘） |
|---|---|---|
| A 绑定 + 客户端投递 | `node _scripts/t1-pipe.mjs` | `bind.pipeName="\\\\.\\pipe\\LOCAL\\zcx-t1-77eea230…"`、`connectMs=3` |
| A 服务端主动推送 | 同上 | `pushReceived: true`（管道支持服务端→客户端非请求推送） |
| A 100 次往返延迟 | 同上 | `rtt.count=100 avgMs=0.1 minMs=0 maxMs=1` |
| A stdio 协议流共存 | 同上 | 客户端连接期间服务端仍读到 `{"jsonrpc":"2.0","method":"ping"}`（`_run/t1/t1-a.err`：`stdio-echo` + `client-connected` 交错） |
| B 重复绑定同名管道 | 同上 | `second: {ok:false, code:"EADDRINUSE", message:"listen EADDRINUSE: address already in use \\\\.\\pipe\\zcx-t1-dup"}` |
| C 连接不存在的管道 | 同上 | `connect: "failed-as-expected", code:"ENOENT"` |
| D 鉴权（空 token / 错 token） | 同上 | 两次均 `authReply: {ok:false, err:"bad-token"}`，服务端随即断连 |
| E 显式 `LOCAL:` 变体名 | 同上 | `pipeName="\\\\.\\pipe\\LOCAL\\zcx-t1-explicit-1a1bda5cf04"` |

**结论**：命名管道在 node 上原生可用，语义与 CC 一致（名字即端点、token 鉴权、EADDRINUSE/ENOENT 可判别）。`LOCAL\` 命名空间前缀无特殊要求（两种都成功），但建议保留以对齐 CC 与避开跨会话命名冲突。

---

## 2. 传输层：localhost TCP 对照（T2）

- 脚本：`_scripts/t2-tcp.mjs`、`_scripts/t2-tcp-run.mjs`；结果：`_logs/t2-tcp-result.json`

| 场景 | 实测输出（摘） |
|---|---|
| 绑定 `127.0.0.1:0` | `{ok:true, host:"127.0.0.1", port:50479}`（临时端口，避免占用冲突） |
| 客户端投递 | `connectMs=4`，100 次 RTT `avgMs=0.08 maxMs=1` |
| 鉴权失败 | `authReply: {ok:false, err:"bad-token"}` |
| 连接无监听端口 | `code:"ECONNREFUSED"` |

**与命名管道的差异**（实测）：
1. 错误码不同：管道目标不存在 = `ENOENT`，TCP = `ECONNREFUSED`（两者都可判别，映射表需分别写）。
2. TCP 多一个「端口」维度：端口回收/占用/防火墙是额外失败面；管道名是唯一冲突维度（`EADDRINUSE` 已验证可判别）。
3. TCP 监听面默认 `127.0.0.1` 时仅本机可达；命名管道 `LOCAL\` 命名空间同样是本机语义，但**无端口**。

**建议**：默认用命名管道（与 CC 同构、失败面更小），TCP 不作默认路径。

---

## 3. 生命周期耦合（T3）—— 本环节最重要的实测

### 3.1 三组实验

- 脚本：`_scripts/lifecycle-child.mjs`、`_scripts/host-sim.mjs`、`_scripts/t3-lifecycle.mjs`、`_scripts/t3-diag.mjs`
- 结果：`_logs/t3-lifecycle-result.json`

| 组 | 形态 | 实测 |
|---|---|---|
| S1 | 宿主正常关停（关子进程 stdin = 宿主关闭 MCP stdio） | 子进程 `childExit:{code:0}`、`childExitLatencyMs:10`；已连客户端 `clientCloseEventObserved:true`、**8ms 内收到 close**；管道随后 `probePipe → ENOENT` |
| S2 | 宿主被 `taskkill /F` 硬杀 | 管道立即 `ENOENT`；子进程 stdin-EOF 标记**未写出** |
| S3 | 子进程 stdin EOF 后**不退出**（无退出纪律） | 宿主关停后管道仍 `reachable`、`orphanPidAlive: true`（孤儿确认）→ 实验内 `taskkill /F` 清理 |
| S4 | `process.kill(pid, 0)` 探测原语 | 活 pid → `true`；死 pid → `ESRCH` |

### 3.2 S2 机制归因（专项诊断 `_scripts/t3-diag.mjs`）

S2 里子进程 stdin-EOF 标记没写出来，究竟是「被级联清杀」还是「自行退出」？专项实验（中间进程 M 持有子进程 C，M 被 `taskkill /F`）：

```
middle: {middlePid: 3612, childPid: 28620, bind:{ok:true, pipeName:"\\\\.\\pipe\\LOCAL\\zcx-diag-…"}}
childDiedAfterMs: 432      ← 432ms 内死亡
childAliveProbe: "ESRCH"
pipeAfterMiddleKill: "ENOENT"
childStdinEvents: "no-marker"   ← 连写 marker 的机会都没有 → 不是「读到 EOF 后自行退出」
```

**结论**：宿主硬杀时子进程被**级联清杀**（沿活父链传播，与 `docs/PLATFORM.md` §9 P5 的既有实测一致），而非自行退出。这对 v0.3 有利：**不会因为宿主被杀而留下管道孤儿**。

### 3.3 ⚠ 硬约束：MCP SDK 的 stdio transport 不监听 stdin EOF

`plugin/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js` 实读全文：`start()` 只挂 `this._stdin.on('data', this._ondata)` 与 `this._stdin.on('error', this._onerror)`；`close()` 由显式调用触发。**没有 `'end'` 监听器**。

后果实测（`_logs/t5-e2e-result.json` 首轮运行 `e6_fileDegradation.bExit`）：

```
bExit: { error: "B: server did not exit within 4000ms after host stdin close …" }
bPidAliveAfterStop: true
```

即：v0.2 的 `transport.onclose = () => process.exit(0)`（`plugin/src/mcp/server.ts:44`）在 v0.3 里**不再可靠**——一旦 MCP server 内持有 net server（管道监听），stdin EOF 时事件循环被 server 撑着，进程**永不退出**，且管道继续对外可连接（= 僵尸端点 + 名字被死进程占用）。

修复（已实测有效）：自己挂 EOF 纪律。修复后同一场景：

```
bExit: { code: 0 }        // exit code 0
bPidAliveAfterStop: "ESRCH"
```

修复后的 server stderr：`[probe-server] stdin EOF → exit(0)`。

**v0.3 硬要求**：MCP server 必须显式 `process.stdin.once('end', …)` / `once('close', …)` → 清理注册表记录 + 关闭管道 + `exit(0)`；**不能只依赖 SDK 的 `transport.onclose`**。

---

## 4. 文件收件箱退化路径（T4）

- 脚本：`_scripts/t4-inbox.mjs`；结果：`_logs/t4-inbox-result.json`

| 组 | 实测 |
|---|---|
| F1 对端缺席 | connect → `ENOENT` → 退化为 JSONL 写入，`file: true`（文件生成） |
| F2 并发追加 | 5 进程 × 10 条同写一个 inbox → `linesTotal:51 parsedOk:51 tornLines:0 uniqueIds:51`（F1 那 1 条 + F2 的 50 条，**零撕裂**） |
| F3 迟到收件 | 排空（rename 换出）期间并发追加的消息**未丢失**：`firstDrainCount:51` + `raceMsgInFirst:true` + `secondDrainCount:2` → `totalConsumed:53`；排空后原文件不存在（`drainedFilesCleaned:true`） |
| F4 半行容错 | 半行 JSON 被跳过并记 `malformed[{lineNo:2}]`，正常行 `good-1` 仍读出 |

**F4 的一条真实语义**：半行若跨越两次排空（第一次排空把半行留在被换出的文件里，第二次只拿到后半截），后半截仍是 malformed（`afterComplete.ok:[] malformed:[{lineNo:1}]`）。**结论**：退化路径的「半行可恢复」只在「同一文件内补全」时成立；排空换出语义下，排空中途的半行会被留在旧文件里。产线应把半行当作**保留在原文件**处理（v0.2 `jsonl.ts` 的「半行尾先截断再追加」契约在追加侧成立，但排空侧需另行处理）。

---

## 5. peer 注册表与端到端消息（T5 + R2 + 专项）

### 5.1 职责分工（实测确定）

钩子侧（M4 形态）职责 = **写 peer 基记录**（`peers/sessions/<sessionId>.json`）+ 注入身份上下文；
**绑定动作**必须走本会话自己的 stdio MCP 连接（`xc_register` 形态）。

依据：`_scripts/e2e/hook-crossbind.mjs` 专项复现「钩子扫未认领 server 反向关联」——**5 轮中 1 轮交叉绑定**（`_logs/hook-crossbind-result.json`）：

```
trial 2: hookA_boundServerPid=919905  expectedA=963250
         hookB_boundServerPid=963250  expectedB=919905
         crossed: true
```

即两个会话并发启动时，先到的钩子可能抢走别家的 server，**alice 的消息会投进 bob 的进程**。机制上依赖 readdir 序，不可靠。

### 5.2 端到端全链（`_logs/t5-e2e-result.json`，9/9 通过）

形态：两个宿主各起一个**真 MCP SDK stdio server**（`@modelcontextprotocol/sdk` 0.x，插件 node_modules 复用），server 进程内持命名管道 server；钩子用 `hook-sim.mjs` 模拟（stdin 载荷 `{session_id, cwd, name}`，输出严格单键 `{"additionalContext": …}`，恒 exit 0）。

| 步 | 实测 |
|---|---|
| E1 双 server | `peerCount:2`，注册表两条记录 |
| E2 钩子写基记录 + stdio 注册 | `hookBaseRecordWritten:true`；`regA={ok:true,sessionKey:"xc:alice"}` `regB={ok:true,sessionKey:"xc:bob"}`；**`pairingCorrect:true`**（sessionId↔pid 正确成对，无交叉） |
| E3 ListAgents 模拟 | 列出 `{name:"bob",kind:"local-session",sessionId:"sess_bbb"}` 与 alice 行（名字即地址） |
| E4 名字寻址投递 | 回执 `via:"pipe"`、`reply:{delivered:true,channel:"pipe"}`；对端 inbox 收到 `{from:"alice",text:"hello from alice",channel:"pipe"}`；**宿主进程收到 MCP notification**：`{event:"inbound-message",from:"alice",mode:"accept"}` |
| E5 入站三态 | hold → 回执 `held:true`、`heldCount:1`、**不进投递面**（`inMessages:false`）；refuse → 回执 `refused:true`、**不落任何队列**（`notStored:true`）；切回 accept → `delivered:true`、`inMessages:true` |
| E6 对端宿主关停 | server `exit code 0`、pid `ESRCH`；发送方自动退化为 `via:"file"`（`note:"pipe unreachable, dropped to file inbox"`） |
| E7 对端复活 | 新 server + 钩子基记录 + stdio 注册 → `sessionKey:"xc:bob"`；**排到离线期的退化消息** `[{msgId:"alice-…-file",text:"offline drop"}]` |
| E8 重名保护 | alice 抢注 bob → `{error:"name_taken", holder:{pid:…, sessionId:"sess_bbb"}}` |
| E9 shutdown 帧 | 回执 `{ok:true}`、注册表 `stopping:true`；此后 `xc_peer_send` 不再走管道（退化为 file） |

### 5.3 活跃判定与过期清理（R2）

- 脚本：`_scripts/r2-expiry.mjs`；结果：`_logs/r2-expiry-result.json`（TTL=3s，心跳 500ms）

| 轮 | 实测 |
|---|---|
| 初始 | `active:[heart,stall]`；`cleaned:[deadold(pid-dead), deadpid(pid-dead)]` |
| 超 TTL 后 | `active:[heart]`；`cleaned:[stall(why:"lastSeen-stale")]`；`heartStillAliveAfterClean:true` |
| 并发清理（两扫描器同批） | scanner1 清 3 条、scanner2 清 0 条，**双方 `errors:[]`**（ENOENT 容忍生效） |
| 复活 | 心跳停止超 TTL → 被清；重启心跳 → 文件重建 → `afterReviveActive:["heart"]`、`revived:true` |

**判定矩阵**：`pid 存活 ∧ lastSeen 新鲜` = active（可寻址）；`¬pid 存活` → 清（pid-dead）；`pid 存活 ∧ lastSeen 陈旧` → 清（lastSeen-stale）。

### 5.4 两条必须写进产线的实现纪律（实测踩到）

1. **注册表文件必须原子写**。非原子 `writeFileSync` 覆写会被并发读者读到半截 JSON（T5 v1 运行中 `aStamped:{}` = 读到 undefined）。用 tmp+rename 后仍实测到 **`EPERM: rename … 16368.json.tmp-… -> … 16368.json`**（Windows 上目标文件正被读者占用）→ 产线必须复用 v0.2 `core/atomic.ts` 的 **EPERM/EBUSY/EEXIST 重试 + 降级直写**（`docs/IMPLEMENTATION.md` §2 M1 表已列该能力），心跳写失败不得崩进程。
   - 附带证据：R2 轮次里 `heart` 进程因一次 rename EPERM 未捕获而**直接崩溃**（scanner1 把它判成 `pid-dead` 清理）——证明「写失败不崩」是硬要求。
2. **名字占用判定必须带 pid 存活过滤**。T5 首轮 E7 失败原因：死掉的 bob 记录仍在注册表，新 bob 注册被判 `name_taken` 而无法复活。修复 = 冲突检查时先 `process.kill(pid, 0)` 过滤死持有者（§5.2 E7/E8 通过）。

---

## 6. 真实 zcode 平台事实（探针实测）

### 6.1 探针装置

临时插件 `zcx-probe@zcx-probe-market`（版本 0.1.0 → 0.1.1），MCP server 与两个钩子都只做「dump 进程事实到 D 盘证据目录」+ 最小协议应答。

安装/物化命令与输出：

```bash
ELECTRON_RUN_AS_NODE=1 <安装目录>/ZCode.exe <安装目录>/resources/<variant>/zcode.cjs plugins validate "…\probe-market\zcx-probe"
# → Plugin manifest is valid: …\probe-market\zcx-probe

ELECTRON_RUN_AS_NODE=1 … zcode.cjs plugins marketplace add "…\probe-market"
# → Added marketplace zcx-probe-market (1 plugins)

ELECTRON_RUN_AS_NODE=1 … zcode.cjs plugins install zcx-probe@zcx-probe-market
# → Installed plugin zcx-probe@zcx-probe-market (0.1.0) [enabled]
```

改源码后**必须递增版本号**才重新物化（`plugins update` 输出 `Updated plugin zcx-probe@zcx-probe-market from 0.1.0 to 0.1.1. Restart zcode to apply.`）；同版本号 `plugins update` 报 `already up to date`（与 `reports/10-v020验收.md` §2.2 的物化规则一致）。

### 6.2 关键事实一：MCP server 进程**拿不到 sessionId**

证据：`_logs/zcode-probe/hook-start-11220.json` 与 `mcp-9104.json`（后者是**净化父 env** 的 app-server 会话，排除继承污染）。

| 载体 | `CLAUDE_SESSION_ID` | `ZCODE_SESSION_ID` | `ZCODE_PROJECT_DIR` | cwd | ppid |
|---|---|---|---|---|---|
| **钩子进程** | ✅ `sess_6b92eb10-4070-4a01-a4de-6d0405d87b10` | ✅ 同值 | ✅ `<本机工作区>` | `<本机工作区>` | 15560（桌面宿主） |
| **MCP server 进程** | ❌ **无** | ❌ **无** | ✅ 有 | = 会话工作区 | 15560 / app-server pid |

净化对照的判据：驱动脚本 spawn app-server 前显式删除父进程的 `CLAUDE_SESSION_ID/ZCODE_SESSION_ID/CLAUDE_PROJECT_DIR/ZCODE_PROJECT_DIR/CLAUDE_PLUGIN_ROOT/…`（`_scripts/zcode-probe-run.mjs` 的 `STRIP` 列表），子进程里仍出现的同类变量必然是 zcode 注入 —— 结果：**只有钩子有，MCP server 没有**。

补充：钩子 env 与 **stdin 载荷**双通道都带会话身份（载荷实测含 `sessionId`/`session_id`/`transcript_path`/`permission_mode`/`source`/`traceId`/`hook_event_name`），钩子还有 `CLAUDE_CODE_SESSION_ID`、`ZCODE_PLUGIN_NAME`、`ZCODE_OFFICIAL_ENDPOINT` 等键（`_logs/zcode-probe/hook-start-11220.json` 的 `allEnvKeys`）。

**含义**：v0.3 的跨会话注册表里「本会话是谁」不能从 MCP server 进程环境直接读到；必须由**钩子写基记录**（MCP server 启动时读该目录，找本会话的记录）或由**模型显式传参**（v0.2 `xc_register` 已走此路：`plugin/src/mcp/identity.ts:134` 收 `sessionId` 参数，`:176-179` 用 hook 落盘记录 + wakeToken 双重核对）。这与 SPEC-V0.3 §0.3 假设的「MCP server 进程即会话端点」不冲突，但**身份来源必须在 SPEC 中显式定案**。

### 6.3 关键事实二：插件钩子的清单形状是嵌套的

`hooks.json` 必须写成 `{"hooks":{"SessionStart":[{"hooks":[{...}]}]}}`（数组项内再套一层 `hooks` 数组）。**扁平写法**（`SessionStart: [{type,command,args}]`）不生效：探针首版扁平写法下 `plugins list` 显示 `hooks: 0` 且探针钩子从不触发；改成嵌套形状并递增版本重装后，桌面会话真实触发（`_logs/zcode-probe/timeline.log`）：

```
2026-11-09T12:38:27.224Z mcp-server pid=13668 ppid=15560 cwd=<本机工作区>
2026-11-09T12:38:28.479Z hook-SessionStart pid=11220 ppid=15560
2026-11-09T12:40:15.503Z hook-SessionStart pid=28240 ppid=15560
2026-11-09T12:40:47.768Z hook-Stop pid=14848 ppid=15560
```

v0.2 正式插件用的正是嵌套形状（`plugin/hooks/hooks.json`），可直接照抄。

### 6.4 探针插件处置

`zcx-probe@zcx-probe-market` 是实验件，仍在用户插件目录中。**处置建议**：`plugins uninstall zcx-probe` + `plugins marketplace remove zcx-probe-market`（本环节**未执行卸载**，避免误删用户环境的其他市场；命令形态与 `plugins marketplace add` 同族）。清理后需 `plugins list` 复核。

---

## 7. 对 SPEC-V0.3.md 的回填与风险提示

| SPEC 条目 | 实测回填 |
|---|---|
| R-1 注册表位置（机器全局，插件 data 目录） | 实测未直接验证「跨工作区可见」——本轮两个会话同工作区。**跨工作区可见性未确认**（需跨 ws 实验）。另注：注册表放在**会被多个会话并发读写**的目录 ⇒ §5.4 的原子写 + EPERM 重试是硬要求 |
| R-3 生命周期（注册时机 = 监听成功后；退出钩子删 pid 文件） | 实测补强：① 注册文件写入必须原子（§5.4-1）；② **退出清理不能只依赖 SDK `transport.onclose`**（§3.3），必须自建 stdin EOF 纪律 |
| R-4 活性判定（进程存在 + procStart 匹配） | 实测：Windows 上 `process.kill(pid,0)` 可用（活→`true`，死→`ESRCH`，§3.1 S4）；**procStart 匹配未实测**（未确认）；本轮用 `lastSeen` 新鲜度作第二判据（§5.3） |
| R-6 key 文件（令牌发布） | 本轮未实现独立 key 文件，令牌随注册记录分发（实验形态）。**key 文件形态未实测** |
| R-7 名字即地址 / ListAgents | 实测成立（§5.2 E3/E4） |
| R-12 注册名冲突先到者为准 | 实测成立且**必须带死持有者过滤**（§5.4-2），否则死 peer 永久占名 |
| R-18…R-22 入站三态 | 实测成立（§5.2 E5）：hold 落独立文件且不进投递面、refuse 不落队列并回执 `refused`、accept 直投 |
| R-26 默认端点 `\\.\pipe\LOCAL\xcc-msg-<32hex>` | 实测成立（§1.2）；建议前缀与 CC 的 `cc-msg-` 区分（SPEC 已用 `xcc-msg-`，赞同） |
| R-29 鉴权（首帧 auth，Windows 默认 true） | 实测成立（§1.2 D 组、§2） |
| R-30 行协议限额 | 未实测（未构造超限行）——**未确认** |
| §0.3「端点归属 = 插件 MCP server 进程」 | 实测确认 MCP server 常驻且是会话级进程（§6.2：cwd = 会话工作区，ppid = 桌面宿主）。但**身份（sessionId/name）必须另找来源**（§6.2）——建议 SPEC 增补一条「会话身份锚定路径」 |
| 新增建议条目 | **R-31（MCP server 侧）**：「stdio EOF 纪律」——插件 MCP server 必须监听 `process.stdin` 的 `end`/`close` 并自行退出；理由：MCP SDK 不监听 EOF（§3.3 实测源码 + 行为） |
| 新增建议条目 | **R-32（注册表写入）**：注册表文件原子写 + 写失败不崩进程；Windows rename 遇占用会 EPERM（§5.4-1 实测） |

---

## 8. 未确认 / 未执行（如实声明）

1. **跨工作区可见性未实测**：本轮两个会话都在同一工作区 `…/_run/e2e/ws`。SPEC R-1 的「机器全局注册表 ⇒ 任意工作区会话互见」未验证。
2. **`procStart` 匹配未实测**：SPEC R-4 的第二判据（进程创建时间比对，防 pid 复用）本轮只用 `pid 存活 ∧ lastSeen 新鲜` 近似。
3. **key 文件（令牌发布）形态未实测**：本轮令牌随注册记录分发，未实现独立 `sessions/<pid>.<sha256>.key`。
4. **行协议限额未实测**：未构造 >1 MiB 行、>30s 首帧（SPEC R-30）。
5. **R-24 异步 `status` 帧补送未实测**：本轮回执是同步的（管道请求-应答）。
6. **令牌桶限速 / msgId 去重 / 环路守卫未实测**（SPEC R-23 的入队闸三项）。
7. **真实 zcode 双会话互发未做**：本轮真实宿主只验证了「探针 MCP server + 钩子被真实拉起并拿到正确的 env/pid/cwd」；跨会话消息本身是在**模拟宿主**（node 驱动 MCP SDK stdio）上端到端跑通的。两个真实 zcode 桌面会话互发未执行（需桌面 UI 双会话，且当前实验插件不实现生产传输层）。
8. **插件卸载未执行**（§6.4），探针插件仍在用户插件目录。
9. **`session/…` app-server 侧新建会话与桌面会话的进程模型差异**未深究：app-server 会话的 MCP server 的 ppid = app-server 进程（`mcp-9104.json` ppid 28072），桌面会话的 ppid = 桌面宿主（15560）。「清杀沿活父链传播」在两种形态下行为是否一致，**未确认**（PLATFORM P5 结论来自 CLI 单发形态）。
10. **`LOCAL\` 命名空间的跨用户可见性未测**：本轮全部在同一用户下运行。

---

## 9. 复现索引

| 实验 | 脚本 | 结果文件 |
|---|---|---|
| T1 命名管道（A/B/C/D/E 组） | `_scripts/t1-pipe.mjs`（+`t1-server.mjs`/`t1-client.mjs`） | `_logs/t1-pipe-result.json` |
| T2 TCP 对照 | `_scripts/t2-tcp-run.mjs`（+`t2-tcp.mjs`） | `_logs/t2-tcp-result.json` |
| T3 生命周期（S1–S4） | `_scripts/t3-lifecycle.mjs`（+`lifecycle-child.mjs`/`host-sim.mjs`） | `_logs/t3-lifecycle-result.json` |
| T3 机制诊断（S2 归因） | `_scripts/t3-diag.mjs` | 终端输出（§3.2） |
| T4 文件收件箱（F1–F4） | `_scripts/t4-inbox.mjs` | `_logs/t4-inbox-result.json` |
| T5 端到端（E1–E9） | `_scripts/e2e/e2e-run.mjs`（+`probe-server.mjs`/`hook-sim.mjs`/`host-driver.mjs`） | `_logs/t5-e2e-result.json` |
| 钩子交叉绑定专项 | `_scripts/e2e/hook-crossbind.mjs` | `_logs/hook-crossbind-result.json` |
| R2 活跃/过期 | `_scripts/r2-expiry.mjs` | `_logs/r2-expiry-result.json` |
| 真实 zcode 探针 | `_scripts/zcode-probe-run.mjs` + `probe-market/` | `_logs/zcode-probe-run.json`、`_logs/zcode-probe/*.json` |

公共库：`_scripts/lib.mjs`（NDJSON 帧、管道连接+token 鉴权、注册表读写、收件箱追加/排空）。
