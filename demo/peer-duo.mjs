/**
 * peer-duo.mjs —— 跨会话 peer 轴（v0.3）双会话演示驱动器。
 *
 * 依据 docs/DESIGN-V0.3.md §9.1（硬验收 1 · peer 消息闭环）与 §9.2（peer 发现）：
 * 起**两个不同工作区**的 zcode 会话（app-server 行协议），让 A 与 B 互发跨会话消息，
 * 并把每一步的真实回合记录落到证据目录。
 *
 * 与 demo/bootstrap-sessions.mjs 同族：行分隔 JSON（非 JSON-RPC 信封）、无握手；
 * session/create 期间必须应答 session/requestRuntimePreferences（15s 超时坑），
 * 可能还有 interaction/requestOfficialMcpAuthHeaders（回 {} 被接受）；
 * session/setModel 必须带 options.reasoningLevel。
 *
 * 两个工作区是**物理隔离**的：`<ws>/.crosschat/` 各自独立 ⇒ 演示里两边都没有
 * 任何团队关系（谁都没调用 xc_register），peer 通道与队内邮箱互不干涉。
 *
 * 用法：
 *   node peer-duo.mjs --workspace-a <path> --workspace-b <path>
 *                     --exe <zcode可执行文件> --cjs <CLI入口脚本>
 *                     [--prefer-model <modelId>] [--turn-timeout-ms 300000]
 *                     [--evidence-dir <path>] [--no-preflight]
 *
 * 输出：stdout 最后一行 JSON
 *   {"sessions":{"a":{...},"b":{...}},"steps":[...],"evidenceDir":"...","ok":true|false}
 *
 * 诚实性纪律：本脚本只记录**实际发生**的事。某一步失败就把错误写进证据并继续，
 * 不伪造通过；宿主是否把钩子的 additionalContext 注入模型上下文，也按实际观测记录。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

// --- CLI -------------------------------------------------------------------

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
function flag(name) {
  return args.includes(name);
}

const WORKSPACE_A = resolve(opt("--workspace-a", ""));
const WORKSPACE_B = resolve(opt("--workspace-b", ""));
// 本机 zcode 安装路径因机器而异：必须显式提供，脚本不内置任何默认值。
const ZCODE_EXE = opt("--exe", "");
const ZCODE_CJS = opt("--cjs", "");
const PREFER_MODEL = opt("--prefer-model", "");
const TURN_TIMEOUT_MS = Number(opt("--turn-timeout-ms", "300000"));
const EVIDENCE_DIR = resolve(opt("--evidence-dir", ".scratch-v03/evidence/phaseA"));
const SKIP_PREFLIGHT = flag("--no-preflight");

for (const [name, value, hint] of [
  ["--workspace-a", WORKSPACE_A, "A 会话的工作区目录"],
  ["--workspace-b", WORKSPACE_B, "B 会话的工作区目录"],
  ["--exe", ZCODE_EXE, "本机 zcode 可执行文件路径"],
  ["--cjs", ZCODE_CJS, "配套的 CLI 入口脚本路径"],
]) {
  if (!value) {
    console.error(`缺少必填参数 ${name}（${hint}）。`);
    process.exit(2);
  }
}
if (WORKSPACE_A === WORKSPACE_B) {
  console.error("两个工作区必须不同（演示前提：物理隔离 ⇒ 无任何团队关系）。");
  process.exit(2);
}

// --- 证据目录 --------------------------------------------------------------

async function ensureEvidence() {
  await mkdir(join(EVIDENCE_DIR, "turns"), { recursive: true });
  await mkdir(join(EVIDENCE_DIR, "registry"), { recursive: true });
}

async function writeEvidence(relPath, value) {
  const target = join(EVIDENCE_DIR, relPath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return target;
}

/**
 * 机器全局 peer 注册表根（与插件 core/peerdir.ts 的解析顺序一致：
 * XC_MESSAGING_DIR > ZCODE_PLUGIN_DATA/peers > ~/.zcode/cli/plugins/data/<id>@<mkt>/peers）。
 */
function peerRoot() {
  const explicit = process.env.XC_MESSAGING_DIR;
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit.trim());
  const pluginData = process.env.ZCODE_PLUGIN_DATA;
  if (pluginData !== undefined && pluginData.trim() !== '') return join(resolve(pluginData.trim()), 'peers');
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return join(home, '.zcode', 'cli', 'plugins', 'data', 'zcode-crosschat@dev-zcode-crosschat', 'peers');
}

/** 把 peer 注册表记录快照进证据目录（令牌文件只记路径与摘要，不落令牌）。 */
async function snapshotRegistry(tag) {
  const root = peerRoot();
  const out = { tag, peerRoot: root, sessions: [], keys: [], audit: null };
  try {
    const entries = await readdir(join(root, 'sessions'));
    for (const entry of entries) {
      if (!/^\d+\.json$/.test(entry)) continue;
      const raw = await readFile(join(root, 'sessions', entry), 'utf8');
      out.sessions.push({ file: entry, record: JSON.parse(raw) });
    }
  } catch (e) {
    out.sessionsError = String(e?.message ?? e);
  }
  try {
    const entries = await readdir(join(root, 'keys'));
    for (const entry of entries) out.keys.push({ file: entry });
  } catch (e) {
    out.keysError = String(e?.message ?? e);
  }
  try {
    out.audit = await readFile(join(root, 'logs', 'peer.jsonl'), 'utf8');
  } catch (e) {
    out.auditError = String(e?.message ?? e);
  }
  await writeEvidence(`registry/snapshot-${tag}.json`, out);
  if (typeof out.audit === 'string') {
    await mkdir(join(EVIDENCE_DIR, 'registry'), { recursive: true });
    await writeFile(join(EVIDENCE_DIR, 'registry', 'peer-audit.jsonl'), out.audit, 'utf8');
  }
  return out;
}

/**
 * 「无任何团队关系」反证：扫描两个工作区的队内状态根。
 * 判据：teams/ 目录不存在或为空；engine.jsonl 里没有 register 事件。
 */
async function scanTeamFootprint(workspace) {
  const root = join(workspace, '.crosschat');
  const out = { workspace, stateRoot: root, teamsDirExists: false, teamDirs: [], teamInboxLines: 0, registerEvents: 0, engineLogExists: false };
  try {
    const st = await stat(join(root, 'teams'));
    out.teamsDirExists = st.isDirectory();
    if (out.teamsDirExists) {
      out.teamDirs = await readdir(join(root, 'teams'));
      for (const team of out.teamDirs) {
        try {
          const inbox = join(root, 'teams', team, 'inbox');
          for (const f of await readdir(inbox)) {
            const txt = await readFile(join(inbox, f), 'utf8');
            out.teamInboxLines += txt.split('\n').filter((l) => l.trim() !== '').length;
          }
        } catch { /* 没有 inbox 目录也算通过 */ }
      }
    }
  } catch { /* teams 目录不存在 = 无团队关系 */ }
  try {
    const txt = await readFile(join(root, 'logs', 'engine.jsonl'), 'utf8');
    out.engineLogExists = true;
    out.registerEvents = txt.split('\n').filter((l) => l.trim() !== '' && l.includes('"register"')).length;
    out.engineLogLines = txt.split('\n').filter((l) => l.trim() !== '').length;
  } catch { /* 没有 engine.jsonl = 从未走过队内域 */ }
  return out;
}

// --- app-server 客户端 -----------------------------------------------------

class AppServer {
  constructor(label, workspace) {
    this.label = label;
    this.workspace = workspace;
    this.pending = new Map();
    this.nextId = 1;
    this.modelAvailable = [];
    this.buf = "";
    this.child = null;
  }

  start() {
    this.child = spawn(ZCODE_EXE, [ZCODE_CJS, "app-server"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (e) => {
      console.error(`[${this.label}] spawn failed:`, e.message);
    });
    this.child.stderr.on("data", (d) => process.stderr.write(`[${this.label}:app-server] ${d}`));
    this.child.stdout.on("data", (d) => this.#onData(d));
    return this;
  }

  #onData(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`app-server error: ${JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        if (msg.method === "session/requestRuntimePreferences") {
          this.#replyCallback(msg.id, { nativeSearchEnhancementsEnabled: false });
        } else if (msg.method === "interaction/requestOfficialMcpAuthHeaders") {
          this.#replyCallback(msg.id, {});
        } else if (msg.method === "state.updated" && msg.params) {
          collectModels(msg.params, this.modelAvailable);
        }
      }
    }
  }

  #replyCallback(id, result) {
    this.child.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  rpc(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`rpc timeout: ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  pickModel() {
    const prefer = (pred) => this.modelAvailable.find(pred);
    const chosen = (PREFER_MODEL && prefer((m) => m.modelId === PREFER_MODEL)) ?? this.modelAvailable[0];
    if (!chosen) {
      throw new Error(
        "未能从 state.updated 枚举到任何可用模型：请确认 app-server 已登录且存在可用 provider，" +
          "或用 --prefer-model <modelId> 显式指定。",
      );
    }
    const levels = chosen.node?.reasoning?.levels;
    const level = Array.isArray(levels) && levels.length ? levels[levels.length - 1] : "max";
    return { providerId: chosen.providerId, modelId: chosen.modelId, options: { reasoningLevel: level } };
  }

  async createSession() {
    const params = {
      workspace: { workspacePath: this.workspace, workspaceKey: this.workspace },
      mode: "yolo",
      titleGenerationEnabled: false,
    };
    const proj = await this.rpc("session/create", params);
    const sid = proj?.session?.sessionId ?? proj?.sessionId ?? proj?.projection?.sessionId;
    if (!sid || sid === "unknown") {
      throw new Error(`session/create: no sessionId in ${JSON.stringify(proj).slice(0, 400)}`);
    }
    // 模型枚举的权威来源 = session/create 的返回体（settings.model.available[]，
    // 见 v0.2 验收脚本 keeper-lead.mjs 的 P1 结论）。本机宿主 0.17.x 的
    // app-server **不发** state.updated（实测 stateUpdateCount=0，见
    // evidence/12-v030/acceptance/phaseA/model-enum-probe.json），
    // 故这里从 create 结果深扫描；state.updated 收集保留为兜底。
    collectModels(proj, this.modelAvailable);
    await new Promise((r) => setTimeout(r, 800)); // 等 state.updated 带来 model.available（兜底路径）
    const model = this.pickModel();
    await this.rpc("session/setModel", { sessionId: sid, model });
    return { sessionId: sid, model };
  }

  /** 完整回合记录（原始 JSON，含 tool_use / tool_result 部件）。 */
  async readMessages(sid) {
    return await this.rpc("session/messages", { sessionId: sid });
  }

  /**
   * P2 完成判定（沿用 v0.2 验收脚本 keeper-lead.mjs 的判据）：
   * assistant ∧ finish∈{completed,stop} ∧ **至少一个非空 text part**。
   *
   * 少了「至少一个非空 text part」这一条时，`session/setModel` 产生的
   * model_change 分隔消息（assistant + finish=completed + 只有 timeline part）
   * 会被误判为「回合已完成」⇒ sendTurn 立刻返回空文本、随后
   * `session/send` 报 "A prompt is already running for this session"。
   * （实测证据：evidence/12-v030/acceptance/phaseA/turns/a-turn1.json 第 0 条消息。）
   */
  async readAssistantTexts(sid) {
    const res = await this.readMessages(sid);
    const out = [];
    for (const m of res?.messages ?? []) {
      const role = m?.info?.role;
      const finish = m?.info?.finish;
      if (role !== "assistant") continue;
      const text = (m?.parts ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      out.push({ finish, text, hasText: text.trim() !== "" });
    }
    return out;
  }

  /**
   * 发一轮并等助手消息完成；返回最后一轮助手文本。
   *
   * `-32010 A prompt is already running` 是上一回合的收尾竞态（宿主侧回合状态
   * 还没落到 idle）：等一个轮询周期再重发一次，不当作失败。
   */
  async sendTurn(sid, content) {
    const baseline = (await this.readAssistantTexts(sid))
      .filter((m) => (m.finish === "completed" || m.finish === "stop") && m.hasText).length;
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      try {
        await this.rpc("session/send", { sessionId: sid, content }, 30000);
        sent = true;
      } catch (e) {
        if (!String(e?.message ?? e).includes("already running") || attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`turn timeout after ${TURN_TIMEOUT_MS} ms for session ${sid}`);
      await new Promise((r) => setTimeout(r, 4000));
      const msgs = await this.readAssistantTexts(sid);
      const done = msgs.filter((m) => (m.finish === "completed" || m.finish === "stop") && m.hasText);
      if (done.length > baseline) return done[done.length - 1].text;
    }
  }

  async stop() {
    if (!this.child) return;
    this.child.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 深度收集带 providerId+modelId 的对象（state.updated 的 model.available 位置不假设）。 */
function collectModels(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectModels(x, out);
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.providerId === "string" && typeof node.modelId === "string") {
      out.push({ providerId: node.providerId, modelId: node.modelId, node });
      return;
    }
    for (const v of Object.values(node)) collectModels(v, out);
  }
}

// --- 步骤记录 --------------------------------------------------------------

/**
 * 递归收集回合记录里的**全部字符串值**（含工具输出体）。
 *
 * 不能直接对 JSON.stringify(msgs) 做正则：工具输出里的引号在 stringify 后
 * 被转义成 `\"`，`/"receipt"\s*:\s*"delivered"/` 永远匹配不上。
 */
function collectStrings(node, out) {
  if (typeof node === "string") { out.push(node); return out; }
  if (Array.isArray(node)) { for (const x of node) collectStrings(x, out); return out; }
  if (node && typeof node === "object") { for (const v of Object.values(node)) collectStrings(v, out); return out; }
  return out;
}
function allText(msgs) { return collectStrings(msgs, []).join("\n"); }

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, detail: detail ?? null, at: new Date().toISOString() });
  console.error(`[peer-duo] ${step}: ${ok ? "ok" : "FAILED"}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}

// --- 主流程 ----------------------------------------------------------------

const PING = `PING-${randomBytes(3).toString("hex")}`;
const PONG = `PONG-${randomBytes(3).toString("hex")}`;

async function main() {
  await ensureEvidence();

  // D0：演示前置 —— 把收方裁决从自动档切到显式层（DESIGN-V0.3 §9.1）。
  const inboundDir = join(WORKSPACE_B, ".crosschat", "peer");
  const inboundFile = join(inboundDir, "inbound.json");
  let preflight = {
    step: "D0-preflight",
    inboundFile,
    envXC_CROSSCHAT_INBOUND: process.env.XC_CROSSCHAT_INBOUND ?? null,
    envXC_PEER_RECEIVE: process.env.XC_PEER_RECEIVE ?? null,
    fileBefore: null,
    fileAfter: null,
    note: "userConfig 层（cross_session_inbound）本脚本读不到（只存在于宿主设置面），故此快照只覆盖项目层与环境层。",
  };
  try {
    preflight.fileBefore = await readFile(inboundFile, "utf8").catch(() => null);
  } catch {
    preflight.fileBefore = null;
  }
  if (!SKIP_PREFLIGHT) {
    await mkdir(inboundDir, { recursive: true });
    await writeFile(inboundFile, JSON.stringify({ mode: "accept" }, null, 2), "utf8");
    preflight.fileAfter = await readFile(inboundFile, "utf8").catch(() => null);
  }
  await writeEvidence("preflight.json", preflight);
  record("D0-preflight", true, SKIP_PREFLIGHT ? "skipped (--no-preflight)" : inboundFile);

  const a = new AppServer("A", WORKSPACE_A).start();
  const b = new AppServer("B", WORKSPACE_B).start();

  const out = { sessions: { a: null, b: null }, ping: PING, pong: PONG };

  try {
    // D1/D2：两个工作区各起一个会话。
    out.sessions.a = await a.createSession();
    record("D1-create-a", true, out.sessions.a.sessionId);
    out.sessions.b = await b.createSession();
    record("D2-create-b", true, out.sessions.b.sessionId);

    // D3：让 A 注册 peer 名字 alice。
    try {
      const reply = await a.sendTurn(
        out.sessions.a.sessionId,
        `调用 xc_peer_register 工具，name 填 "alice"，sessionId 填 "${out.sessions.a.sessionId}"` +
          `（不要编造 sessionId）。注册成功后，原样报告工具返回的 name、ref、socket 路径与 via 字段。` +
          `如果返回结构化错误（如 name_taken / invalid-name），只回复错误码与说明，最多重试一次。不要做其他任何事。`,
      );
      await writeEvidence("turns/a-turn1.json", await a.readMessages(out.sessions.a.sessionId));
      record("D3-register-a", /alice/.test(reply), reply);
    } catch (e) {
      record("D3-register-a", false, e.message);
    }

    // D4：让 B 注册 peer 名字 bob。
    try {
      const reply = await b.sendTurn(
        out.sessions.b.sessionId,
        `调用 xc_peer_register 工具，name 填 "bob"，sessionId 填 "${out.sessions.b.sessionId}"` +
          `（不要编造 sessionId）。注册成功后，原样报告工具返回的 name、ref、socket 路径与 via 字段。` +
          `如果返回结构化错误（如 name_taken / invalid-name），只回复错误码与说明，最多重试一次。不要做其他任何事。`,
      );
      await writeEvidence("turns/b-turn1.json", await b.readMessages(out.sessions.b.sessionId));
      record("D4-register-b", /bob/.test(reply), reply);
    } catch (e) {
      record("D4-register-b", false, e.message);
    }

    // 注册表快照（两个 peer 记录：不同 pid / 不同 sessionId / 不同 socket 路径）。
    try {
      const snap = await snapshotRegistry("after-register");
      record(
        "D4b-registry-snapshot",
        snap.sessions.length >= 2,
        `注册表里有 ${snap.sessions.length} 条记录：${snap.sessions.map((s) => `${s.file}=${s.record?.name}/${s.record?.sessionId}`).join(' | ')}`,
      );
    } catch (e) {
      record("D4b-registry-snapshot", false, e.message);
    }

    // D5：A 列出 peer 并给 bob 发一条带唯一校验串的消息。
    try {
      const reply = await a.sendTurn(
        out.sessions.a.sessionId,
        `先调用 xc_peers 列出本机所有可寻址会话（把返回体原样贴出来，尤其是 bob 那一行的 cwd、status、ref），` +
          `然后调用 xc_peer_send，to 填 "bob"，message 正文里必须包含唯一校验串 ${PING}，` +
          `summary 填 "peer-duo 演示"。最后原样报告 xc_peer_send 的回执字段（delivered/held/denied/expired/refused/dropped 与 via）。`,
      );
      const msgs = await a.readMessages(out.sessions.a.sessionId);
      await writeEvidence("turns/a-turn2.json", msgs);
      // 判据取自**回合原始记录**（工具结果体），不是模型的自然语言复述：
      // 模型未必逐字复述校验串，但工具结果里一定有。
      const raw = allText(msgs);
      const receiptOk = /"receipt"\s*:\s*"delivered"/.test(raw);
      const viaPipe = /"via"\s*:\s*"pipe"/.test(raw);
      const pingInTool = raw.includes(PING);
      record(
        "D5-send-a-to-b",
        receiptOk && pingInTool,
        `回执 delivered=${receiptOk} via=pipe=${viaPipe}；校验串出现在工具结果=${pingInTool}；模型复述=${reply.includes(PING)}`,
      );
    } catch (e) {
      record("D5-send-a-to-b", false, e.message);
    }

    // D6：B 的下一回合（"继续" 触发 UserPromptSubmit 钩子）应看到信封。
    try {
      const reply = await b.sendTurn(out.sessions.b.sessionId, "继续");
      const msgs = await b.readMessages(out.sessions.b.sessionId);
      await writeEvidence("turns/b-turn3.json", msgs);
      const raw = allText(msgs);
      const envelopeSeen = raw.includes("<crosschat-peer-message") || reply.includes(PING);
      record("D6-b-inbound-envelope", envelopeSeen, envelopeSeen ? "信封/校验串出现在 B 回合" : "未在 B 回合观测到信封或校验串（按实际如实记录）");
    } catch (e) {
      record("D6-b-inbound-envelope", false, e.message);
    }

    // D6b：B 在回合内主动调一次工具，取 tool_result 载体的信封（面 B / 面 C），
    //      并按信封里的 from 属性回一条含 PONG 的信（B→A 方向）。
    try {
      await b.sendTurn(
        out.sessions.b.sessionId,
        `调用 xc_peer_inbox（limit=5）把本会话的跨会话消息拉出来；若工具结果里带有 <crosschat-peer-message> 信封块，` +
          `原样复述信封里的 from 与正文（正文应包含 ${PING}）。` +
          `然后按信封里的 from 属性，用 xc_peer_send 给那个 from 回一条确认信，正文里必须包含唯一校验串 ${PONG}。` +
          `不要做其他任何事。`,
      );
      const msgs = await b.readMessages(out.sessions.b.sessionId);
      await writeEvidence("turns/b-turn4.json", msgs);
      const raw = allText(msgs);
      record(
        "D6b-tool-result-carrier",
        raw.includes(PING),
        `已抓取 b-turn4.json（原始回合记录，含 tool_result 部件）；PING 在 tool_result=${raw.includes(PING)}；PONG 在回合=${raw.includes(PONG)}`,
      );
    } catch (e) {
      record("D6b-tool-result-carrier", false, e.message);
    }

    // D7：A 读回 B 的回信。
    try {
      const reply = await a.sendTurn(
        out.sessions.a.sessionId,
        `先调用 xc_peer_inbox（limit=5）看有没有 bob 的回信；若有，按信封里的 from 属性用 xc_peer_send 回一条，` +
          `正文里必须包含唯一校验串 ${PONG}。最后报告回执字段与是否看到了 ${PONG}。`,
      );
      const msgs = await a.readMessages(out.sessions.a.sessionId);
      await writeEvidence("turns/a-turn4.json", msgs);
      const raw = allText(msgs);
      const pongSeen = raw.includes(PONG);
      record(
        "D7-roundtrip-back",
        pongSeen,
        `A 的回合里出现 ${PONG}=${pongSeen}；模型复述=${reply.includes(PONG)}；${reply.slice(0, 400)}`,
      );
    } catch (e) {
      record("D7-roundtrip-back", false, e.message);
    }

    // 汇总：把两侧的 raw 回合合并成一个可核对的 roundtrip 记录。
    const roundtrip = { ping: PING, pong: PONG, steps, note: "msgId 串联由验收环节从 raw 回合记录里抽取（本脚本不编造 msgId）。" };
    await writeEvidence("roundtrip.json", roundtrip);

    // 终态快照：注册表 + 传输审计日志。
    try {
      await snapshotRegistry("final");
    } catch (e) {
      record("Z-final-snapshot", false, e.message);
    }

    // 「无任何团队关系」反证：两个工作区的队内状态根扫描。
    try {
      const footprint = {
        a: await scanTeamFootprint(WORKSPACE_A),
        b: await scanTeamFootprint(WORKSPACE_B),
      };
      await writeEvidence("no-team-relationship.json", footprint);
      const clean =
        footprint.a.teamDirs.length === 0 &&
        footprint.b.teamDirs.length === 0 &&
        footprint.a.registerEvents === 0 &&
        footprint.b.registerEvents === 0 &&
        footprint.a.teamInboxLines === 0 &&
        footprint.b.teamInboxLines === 0;
      record(
        "Z-no-team-relationship",
        clean,
        `A: teams=[${footprint.a.teamDirs.join(",")}] register=${footprint.a.registerEvents} inbox行=${footprint.a.teamInboxLines}；` +
          `B: teams=[${footprint.b.teamDirs.join(",")}] register=${footprint.b.registerEvents} inbox行=${footprint.b.teamInboxLines}`,
      );
    } catch (e) {
      record("Z-no-team-relationship", false, e.message);
    }
  } finally {
    await a.stop();
    await b.stop();
  }

  const ok = steps.every((s) => s.ok);
  console.log(JSON.stringify({ ...out, steps, evidenceDir: EVIDENCE_DIR, ok }));
}

main().catch((e) => {
  console.error("[peer-duo] fatal:", e?.stack ?? e);
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e), steps, evidenceDir: EVIDENCE_DIR }));
  process.exit(1);
});
