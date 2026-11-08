/**
 * bootstrap-sessions.mjs —— 通过 zcode app-server 创建两个独立会话、setModel、
 * 并以首轮消息完成 crosschat 身份注册（首轮落盘持久化：实测只 create 不 send 的会话
 * 不会写入 db.sqlite，2026-11-09 验证环节）。
 *
 * 依据 docs/PLATFORM.md §4.3 实测协议：
 *  - 行分隔 JSON（非 JSON-RPC 信封），无握手；
 *  - session/create 过程中必须应答回调 session/requestRuntimePreferences（15s 超时坑），
 *    可能还有 interaction/requestOfficialMcpAuthHeaders（回 {} 被接受）；
 *  - session/setModel 必须带 options.reasoningLevel；providerId 用运行时枚举（V6）；
 *  - session/send 参数是 content；助手文本在 session/messages 的 parts(type=text)。
 *
 * 用法：node bootstrap-sessions.mjs --workspace <path> --exe <zcode可执行文件> --cjs <CLI入口脚本>
 *       [--count 2] [--prefer-model <modelId>] [--turn-timeout-ms 300000]
 * 输出：stdout 最后一行 JSON
 *   {"sessions":[{"name","sessionId","model","register":{"response","error"}},...]}
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const WORKSPACE = opt("--workspace", "");
const COUNT = Number(opt("--count", "2"));
// 本机 zcode 安装路径因机器而异：必须显式提供，脚本不内置任何默认值。
const ZCODE_EXE = opt("--exe", "");
const ZCODE_CJS = opt("--cjs", "");
const PREFER_MODEL = opt("--prefer-model", "");
const TURN_TIMEOUT_MS = Number(opt("--turn-timeout-ms", "300000"));

for (const [flag, value, hint] of [
  ["--workspace", WORKSPACE, "演示工作区目录"],
  ["--exe", ZCODE_EXE, "本机 zcode 可执行文件路径"],
  ["--cjs", ZCODE_CJS, "配套的 CLI 入口脚本路径"],
]) {
  if (!value) {
    console.error(`缺少必填参数 ${flag}（${hint}）。`);
    process.exit(2);
  }
}

const child = spawn(ZCODE_EXE, [ZCODE_CJS, "app-server"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.on("error", (e) => { console.error("spawn failed:", e.message); process.exit(1); });
child.stderr.on("data", (d) => process.stderr.write(`[app-server] ${d}`));

let buf = "";
const pending = new Map();
let nextId = 1;
let modelAvailable = [];

function replyCallback(id, result) {
  child.stdin.write(JSON.stringify({ id, result }) + "\n");
}
function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timeout: ${method} (id=${id})`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
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

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`app-server error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      if (msg.method === "session/requestRuntimePreferences") {
        replyCallback(msg.id, { nativeSearchEnhancementsEnabled: false });
      } else if (msg.method === "interaction/requestOfficialMcpAuthHeaders") {
        replyCallback(msg.id, {});
      } else if (msg.method === "state.updated" && msg.params) {
        collectModels(msg.params, modelAvailable);
      }
    }
  }
});

function pickModel() {
  // 候选优先级：--prefer-model 精确匹配（可选）→ 运行时枚举到的第一个可用模型。
  const prefer = (pred) => modelAvailable.find(pred);
  const chosen =
    (PREFER_MODEL && prefer((m) => m.modelId === PREFER_MODEL)) ?? modelAvailable[0];
  if (!chosen)
    throw new Error(
      "未能从 state.updated 枚举到任何可用模型：请确认 app-server 已登录且存在可用 provider，" +
        "或用 --prefer-model <modelId> 显式指定。",
    );
  const levels = chosen.node?.reasoning?.levels;
  const level = Array.isArray(levels) && levels.length ? levels[levels.length - 1] : "max";
  return { providerId: chosen.providerId, modelId: chosen.modelId, options: { reasoningLevel: level } };
}

/** 读会话消息并提取助手文本（finish=completed|stop 都接受，PLATFORM §4.3-5）。 */
async function readAssistantTexts(sid) {
  const res = await rpc("session/messages", { sessionId: sid });
  const out = [];
  for (const m of res?.messages ?? []) {
    const role = m?.info?.role;
    const finish = m?.info?.finish;
    if (role !== "assistant") continue;
    const text = (m?.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    out.push({ finish, text });
  }
  return out;
}

/** 发一轮并等助手消息完成；返回最后一轮助手文本。 */
async function sendTurn(sid, content) {
  const baseline = (await readAssistantTexts(sid))
    .filter((m) => m.finish === "completed" || m.finish === "stop").length;
  await rpc("session/send", { sessionId: sid, content }, 30000);
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`turn timeout after ${TURN_TIMEOUT_MS} ms for session ${sid}`);
    await new Promise((r) => setTimeout(r, 4000));
    const msgs = await readAssistantTexts(sid);
    const done = msgs.filter((m) => m.finish === "completed" || m.finish === "stop");
    if (done.length > baseline) return done[done.length - 1].text;
  }
}

async function createOne(name) {
  const params = {
    workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE },
    mode: "yolo",
    titleGenerationEnabled: false,
  };
  const proj = await rpc("session/create", params);
  const sid =
    proj?.session?.sessionId ??
    proj?.sessionId ??
    proj?.projection?.sessionId;
  if (!sid || sid === "unknown")
    throw new Error(`session/create: no sessionId in ${JSON.stringify(proj).slice(0, 400)}`);
  await new Promise((r) => setTimeout(r, 800)); // 等 state.updated 带来 model.available
  const model = pickModel();
  await rpc("session/setModel", { sessionId: sid, model });
  return { name, sessionId: sid, model };
}

try {
  const sessions = [];
  for (let i = 0; i < COUNT; i++) {
    const name = String.fromCharCode(97 + i); // a, b, ...
    const rec = await createOne(name);
    // 首轮=注册（hook 锚定路径；若失败本轮响应会给出错误码，验证环节再用 wakeToken 兜底）。
    const prompt =
      `你是跨会话协作会话 "${name}"。请调用 xc_register 工具绑定身份：name 填 "${name}"，` +
      `sessionId 填 "${rec.sessionId}"。注册成功后，原样报告返回的 sessionKey、via 与 roster（花名册）成员 key 列表。` +
      `如果返回结构化错误（如 session_not_anchored / name_taken），只回复错误码与说明，最多重试一次。不要做其他任何事。`;
    let response = null;
    let registerError = null;
    try {
      response = await sendTurn(rec.sessionId, prompt);
    } catch (e) {
      registerError = String(e.message ?? e).slice(0, 300);
    }
    sessions.push({ ...rec, register: { response, error: registerError } });
  }
  console.log(JSON.stringify({ sessions, modelAvailableCount: modelAvailable.length }));
} finally {
  await new Promise((r) => setTimeout(r, 1200));
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
