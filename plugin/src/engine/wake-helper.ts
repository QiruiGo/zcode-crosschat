/**
 * wake-helper —— V9 修复（FEASIBILITY §2.1 路径 A「helper 孤儿化」，E3b 实测）的中间跳板。
 * 链路：MCP server ──spawn node──▶ 本进程 ──detached+unref spawn──▶ ZCode.exe 无头 --resume 回合
 *       本进程立即退出 → 唤醒子进程成为孤儿 → 派发方 CLI/app-server 退出的沿活父链清杀（P5）杀不到它。
 * 协议：argv 参数数组（不经 shell，resume-cli.ts 同纪律）；stdout 单行 JSON；
 *       退出码 0=已拉起；2=参数缺失；1=spawn 失败（调用方降级 mailbox，消息不丢）。
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : "";
}

function fail(code: number, payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ ok: false, ...payload }) + "\n");
  process.exit(code);
}

const exe = arg("--exe");
const cjs = arg("--cjs");
const sessionId = arg("--sid");
const prompt = arg("--prompt");
const cwd = arg("--cwd");
const logFile = arg("--log");

if (exe.trim() === "" || cjs.trim() === "" || sessionId.trim() === "" || prompt.trim() === ""
  || cwd.trim() === "" || logFile.trim() === "") {
  fail(2, { error: "missing-args" });
}

const fd = openSync(logFile, "a");
try {
  const child = spawn(exe, [cjs, "--resume", sessionId, "--prompt", prompt, "--cwd", cwd, "--output-format", "json"], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  const pid = child.pid;
  closeSync(fd); // 子进程持有继承句柄，父进程句柄即刻关闭（resume-cli.ts:138-141 同纪律）
  if (pid === undefined) fail(1, { error: "child pid undefined" });
  process.stdout.write(JSON.stringify({ ok: true, pid }) + "\n");
  process.exit(0);
} catch (err) {
  closeSync(fd);
  fail(1, { error: String(err instanceof Error ? err.message : err) });
}
