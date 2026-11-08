/**
 * wake-chain-run.mjs —— 以常驻 app-server 持有派发方会话 A，驱动一次「引擎自动唤醒链」：
 *   A(keeper 持有) xc_dispatch t3 → 引擎 spawn --resume B（wake）→ B 认领/执行/报告
 *   → 引擎 spawn --resume A → A 查收回执并核验 → wake-a 日志出现 A 的最终回应。
 *
 * 背景（2026-11-09 验证环节实测）：派发者为 CLI 单发回合时，其退出会连带终止 MCP server
 * 经 spawnResume 发出的 detached 唤醒子进程（疑似 CLI 回合进程的作业对象/树清杀）；
 * 本脚本改由常驻 app-server 进程持有派发方，验证唤醒链在此形态下是否完整成立。
 *
 * 用法：node wake-chain-run.mjs --dispatcher-sid sess_... --task "63*84" --expect 5292
 * 输出：stdout 末行 JSON {dispatchResponse, t3Status, wakeALog, wakeAResponse}
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const BS = String.fromCharCode(92);
const WORKSPACE = opt("--workspace", "D:" + BS + "tools" + BS + "zcode-crosschat" + BS + ".scratch");
const DISPATCHER_SID = opt("--dispatcher-sid", "");
const TASK_TEXT = opt("--task", "计算 63 乘以 84");
const EXPECT = opt("--expect", "5292");
const RESULT_FILE = opt("--result-file", "result-auto2.txt");
const TIMEOUT_MS = Number(opt("--timeout-ms", "600000"));
const STATE_ROOT = join(WORKSPACE, ".crosschat");
const TEAM_JSON = join(STATE_ROOT, "teams", "default", "team.json");
const WAKE_LOG_DIR = join(STATE_ROOT, "logs");

const child = spawn("E:" + BS + "ZCode" + BS + "ZCode.exe", [
  "E:" + BS + "ZCode" + BS + "resources" + BS + "glm" + BS + "zcode.cjs", "app-server",
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[app-server] ${d}`));

let buf = "";
const pending = new Map();
let nextId = 1;
function replyCallback(id, result) { child.stdin.write(JSON.stringify({ id, result }) + "\n"); }
function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    } else if (msg.method) {
      if (msg.method === "session/requestRuntimePreferences") replyCallback(msg.id, { nativeSearchEnhancementsEnabled: false });
      else if (msg.method === "interaction/requestOfficialMcpAuthHeaders") replyCallback(msg.id, {});
    }
  }
});

async function assistantTexts(sid) {
  const res = await rpc("session/messages", { sessionId: sid });
  return (res?.messages ?? [])
    .filter((m) => m?.info?.role === "assistant" && (m?.info?.finish === "completed" || m?.info?.finish === "stop"))
    .map((m) => (m?.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n"));
}
async function sendTurn(sid, content) {
  const base = (await assistantTexts(sid)).length;
  await rpc("session/send", { sessionId: sid, content }, 30000);
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error("turn timeout");
    await new Promise((r) => setTimeout(r, 4000));
    const done = await assistantTexts(sid);
    if (done.length > base) return done[done.length - 1];
  }
}
function taskStatus(taskId) {
  try {
    const team = JSON.parse(readFileSync(TEAM_JSON, "utf8"));
    const t = (team.tasks ?? []).find((x) => x.id === taskId);
    return t ? t.status : "missing";
  } catch { return "unreadable"; }
}
function latestWakeLogFor(key, sinceMs) {
  try {
    const files = readdirSync(WAKE_LOG_DIR).filter((f) => f.startsWith(`wake-${key}-`) && f.endsWith(".json"));
    const fresh = files
      .map((f) => ({ f, ts: Number(f.slice(`wake-${key}-`.length, -".json".length)) }))
      .filter((x) => x.ts >= sinceMs - 500)
      .sort((a, b) => b.ts - a.ts);
    return fresh.length ? join(WAKE_LOG_DIR, fresh[0].f) : undefined;
  } catch { return undefined; }
}

const started = Date.now();
const out = {};
try {
  await rpc("session/resume", { sessionId: DISPATCHER_SID, workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE } });
  const prompt =
    `你是跨会话协作会话 a（sessionId=${DISPATCHER_SID}）。本连接是新的：先调用 xc_register 绑定身份` +
    `（name 填 a，sessionId 填 ${DISPATCHER_SID}）。绑定后调用 xc_dispatch 给 b 派发新任务：${TASK_TEXT}，` +
    `把结果只写数字到工作区根目录 ${RESULT_FILE}；验收标准=文件存在且内容为 ${EXPECT}。` +
    `最后报告 taskId 与 delivered 状态。不要做其他事。`;
  out.dispatchResponse = await sendTurn(DISPATCHER_SID, prompt);
  const dispatchDone = Date.now();
  out.dispatchAt = dispatchDone;

  // 轮询 t3 终态 + wake-a 日志出现内容
  const taskId = (out.dispatchResponse.match(/t\d+/) || ["t?"])[0];
  out.taskId = taskId;
  const deadline = started + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) { out.timeout = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
    out.t3Status = taskStatus(taskId);
    const wakeALog = latestWakeLogFor("a", dispatchDone);
    if (wakeALog) {
      out.wakeALog = wakeALog;
      const raw = existsSync(wakeALog) ? readFileSync(wakeALog, "utf8") : "";
      if (raw.trim().length > 0) {
        const s = raw.indexOf("{");
        try { out.wakeAResponse = JSON.parse(raw.slice(s)).response; } catch { out.wakeAResponse = raw.slice(0, 400); }
        break;
      }
    }
    if (out.t3Status === "failed") break;
  }
} finally {
  console.log(JSON.stringify(out, null, 2));
  await new Promise((r) => setTimeout(r, 800));
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}
