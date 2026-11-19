/**
 * v0.9.1 打回第 1 轮（V091-01 / V091-02，voiceOwner 伪造/越权盖章面）定向单测。
 *
 * 裁决复现（adv-1 TC-1/TC-2，合并方已核验）：wake nonce 真值明文落进同状态根共享
 * 日志（engine.jsonl 的 wake/wake-child 行 + wake-lifecycle start 头行）→ 同工作区
 * 会话收割 nonce → wakeToken 路径无 sid 活性闸 → 以受害者 (name,sid) 绑定成功并
 * 继承 voiceOwner → 盖章面第一道拒绝线被绕过 → 自产正文盖成 origin=user；
 * 且 nonce 被抢先消费后合法无头回合被 "already used" 踢掉（消息误判 limbo）。
 *
 * 本文件锚点（逐条对应修复）：
 *  R1 nonce 真值不落共享日志：engine.jsonl 全文与 lifecycle 全文都不含真值；
 *     wake/wake-child/wake-skipped{inflightNonce} 行只记 wakeNonceDigest 摘要；
 *  R2 wakeToken 路径活会话跨 sid 冒名闸：本进程是别的 sid 的 peer 活注册会话时
 *     拒绝消费令牌（**且拒时不消费 nonce**——合法无头回合仍可用）；合法无头回合
 *     （无 peer 活记录）照常继承 voiceOwner（G-11 不回退）；
 *  R3 端到端：rogue（活会话形态）收割 nonce 后连绑定都被拒 → 无 voiceOwner →
 *     盖章面照旧 session-id-held-elsewhere；对照组（无证明）不变。
 *
 * 磁盘类测试用系统 TEMP 下的临时 stateRoot/peerRoot + 真实 M1 读写；pid 活性用
 * 真 sleeper 进程（peer active 判据要吃真 pid）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMailbox, createMessage, readMailbox } from "../core/mailbox";
import { newTeamState, writeTeam } from "../core/teamstate";
import { writeSession } from "../core/registry";
import { localPidDomain } from "../core/peerdir";
import { writePeerRecord, type PeerRecord } from "../core/peerregistry";
import { verifyUservoiceStampAuthority } from "../core/uservoice";
import { xcRegister, identityStore } from "../mcp/identity";
import type { TeamMember } from "../core/types";
import type { SpawnResumeOptions, SpawnResumeResult } from "./resume-cli";
import { attemptWake, wakeNonceDigest, type WakeRequest } from "./wake";

const dirs: string[] = [];
let root: string;
let peerRoot: string;
const sleepers: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xc-wake-v091-r1-"));
  peerRoot = mkdtempSync(join(tmpdir(), "xc-wake-v091-r1-peers-"));
  dirs.push(root, peerRoot);
});

afterAll(() => {
  for (const child of sleepers) child.kill();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

function readEngineEvents(): Array<Record<string, unknown>> {
  const file = join(root, "logs", "engine.jsonl");
  if (!fileExists(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fileExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 全部共享日志原文（engine.jsonl + lifecycle 账）——断言 nonce 真值不出现用。 */
function sharedLogsRaw(): string {
  const dir = join(root, "logs");
  if (!fileExists(dir)) return "";
  let raw = "";
  for (const entry of readdirSync(dir)) {
    try {
      raw += readFileSync(join(dir, entry), "utf8");
    } catch {
      /* 目录等 */
    }
  }
  return raw;
}

async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

/** 给指定 pid 落一条 peer 活记录（pid 必须真活；lastSeen 置现在=active）。 */
async function seedActivePeer(pid: number, sessionId: string, name: string): Promise<void> {
  const record: PeerRecord = {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xc-r1-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
  await writePeerRecord(peerRoot, record);
}

function baseReq(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    stateRoot: root,
    teamId: "default",
    toAgentKey: "b",
    toSessionId: "sess_b",
    workspace: "D:\\ws",
    reason: "message",
    receiptIds: ["m1"],
    ticket: "重踢：BD869",
    env: { XC_WAKE_ENABLED: "true" },
    cfg: { zcodeExe: "Z.exe", zcodeCjs: "z.cjs" },
    limboTimeoutMs: 3_600_000,
    wakeSlowMs: 3_600_000,
    lifecyclePollMs: 3_600_000,
    lifecycleWindowMs: 1_000,
    ...overrides,
  };
}

async function seedTeam(): Promise<void> {
  const team = newTeamState({ teamId: "default", founderKey: "a", now: 1 });
  const member: TeamMember = { key: "b", sessionId: "sess_b", role: "worker", joinedAt: 1, lastSeen: 1 };
  team.members.push(member);
  await writeTeam(root, team);
}

async function seedSessionRecord(sessionId: string): Promise<void> {
  await writeSession(root, { sessionId, cwd: "D:\\ws", startedAt: 1, lastSeen: 1 });
}

async function seedMailbox(): Promise<string> {
  mkdirSync(join(root, "teams", "default", "inbox"), { recursive: true });
  const message = createMessage("a", "b", "重踢：BD869", { deliveryClaimedAt: Date.now() });
  await appendMailbox(root, "default", "b", message);
  return message.id;
}

function fakeSpawn(): (opts: SpawnResumeOptions) => SpawnResumeResult {
  return (opts) => ({ pid: 4242, logFile: opts.logFile });
}

// ─────────────────────── R1：nonce 真值不落共享日志（V091-01） ───────────────────────

describe("v0.9.1 打回1 V091-01：wake nonce 真值不落共享日志（只落不可反查摘要）", () => {
  it("engine.jsonl 与 lifecycle 账全文都不含 nonce 真值；wake/wake-child 行只记摘要", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({
      receiptIds: [messageId],
      spawn: (opts) => {
        opts.onHelperSpawned?.(4242); // 触发 wake-child 事件（同带 nonce 字段）
        return { pid: 4242, logFile: opts.logFile };
      },
    }));
    expect(res.delivered).toBe("wake");
    const nonce = res.nonce!;
    expect(nonce).toBeDefined();

    // 真源与 prompt 侧不变（设计如此）：registry/wake/<nonce>.json 存在
    expect(fileExists(join(root, "registry", "wake", `${nonce}.json`))).toBe(true);

    // 共享日志全文不含真值（TC-1 的收割面清零：logs/ 是被贴/被分享的高频面）
    const raw = sharedLogsRaw();
    expect(raw.includes(nonce)).toBe(false);

    // 事件行只记摘要（对账仍可做：同次唤醒各行摘要相同）
    const wake = readEngineEvents().find((e) => e["event"] === "wake")!;
    const child = readEngineEvents().find((e) => e["event"] === "wake-child")!;
    expect(wake["nonce"]).toBe(wakeNonceDigest(nonce));
    expect(wake["nonce"]).not.toBe(nonce);
    expect(child["nonce"]).toBe(wakeNonceDigest(nonce));
    // lifecycle start 头行同理
    const lifecycleDir = join(root, "logs");
    const startLines = readdirSync(lifecycleDir)
      .filter((f) => f.startsWith("wake-lifecycle-b-"))
      .flatMap((f) => readFileSync(join(lifecycleDir, f), "utf8").split("\n").filter((l) => l.trim() !== ""));
    const start = startLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l["event"] === "wake-child-start")!;
    expect(start["nonce"]).toBe(wakeNonceDigest(nonce));
  });

  it("wake-skipped 的在途令牌只记摘要（inflightNonce 不再泄露真值）", async () => {
    await seedTeam();
    await seedMailbox();
    const { createWakeNonce } = await import("../core/registry.js");
    const { token } = await createWakeNonce(root, { teamId: "default", agentKey: "b", sid: "sess_b", now: Date.now() });
    const res = await attemptWake(baseReq({ spawn: fakeSpawn() }));
    expect(res.delivered).toBe("mailbox"); // 在途 nonce 去重
    const skip = readEngineEvents().find((e) => e["event"] === "wake-skipped")!;
    expect(skip["inflightNonce"]).toBe(wakeNonceDigest(token));
    expect(sharedLogsRaw().includes(token)).toBe(false);
  });

  it("摘要函数本身不可反查（不同 nonce → 不同摘要；摘要 ≠ 真值）", () => {
    const a = wakeNonceDigest("11111111-2222-3333-4444-555555555555");
    const b = wakeNonceDigest("99999999-8888-7777-6666-555555555555");
    expect(a).not.toBe(b);
    expect(a).not.toBe("11111111-2222-3333-4444-555555555555");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ─────────────────────── R2：wakeToken 路径活会话跨 sid 冒名闸（V091-01/02） ───────────────────────

describe("v0.9.1 打回1 V091-02：wakeToken 路径拒「别的 sid 的活注册会话」消费令牌", () => {
  it("合法无头回合（无 peer 活记录）→ 照常消费 nonce 并继承 voiceOwner（G-11 不回退）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({ receiptIds: [messageId], spawn: fakeSpawn() }));
    const outcome = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-legit",
      { peerRoot },
    );
    expect(outcome.via).toBe("wake");
    expect(identityStore.get("conn-legit")?.voiceOwner).toBe("sess_b");
    // 合法回合消费成功：nonce 已 used
    const { readWakeNonce } = await import("../core/registry.js");
    expect((await readWakeNonce(root, res.nonce!))?.used).toBe(true);
  });

  it("rogue（本进程是别的 sid 的 peer 活注册会话）→ wake_token_session_mismatch，且 nonce 未被消费（合法回合可用）", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({ receiptIds: [messageId], spawn: fakeSpawn() }));

    // 攻击形态：同工作区的另一个**已注册活会话**在自己的 MCP server 进程里收割 nonce
    // 并以受害者 sid 注册——该进程自己就是 peer active 集里的活记录（sid=sess_rogue）。
    // （真实成员会话的 MCP server 即注册者；xc_identify 就在这个进程里调用。）
    await seedActivePeer(process.pid, "sess_rogue", "rogue-session");

    const error = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-rogue",
      { peerRoot },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { payload?: Record<string, unknown> }).payload?.error).toBe("wake_token_session_mismatch");
    // 拒时**不消费** nonce（TC-1 第 4 步「抢先消费踢掉合法回合」被修复的核心证据）
    const { readWakeNonce } = await import("../core/registry.js");
    expect((await readWakeNonce(root, res.nonce!))?.used).toBeUndefined();
    // 攻击者退场后（其 peer 活记录被清/自然过期），合法无头回合——真实世界里是**另一个
    // 新进程**（无任何 active 记录）——照常注册并继承 voiceOwner。同进程测试里用
    // 「清掉本进程的 rogue 活记录」等价模拟「干净新进程」。
    const { peerRecordFile } = await import("../core/peerdir.js");
    await rm(peerRecordFile(peerRoot, process.pid), { force: true });
    const legit = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-legit-2",
      { peerRoot },
    );
    expect(legit.via).toBe("wake");
    expect(identityStore.get("conn-legit-2")?.voiceOwner).toBe("sess_b");
    // 审计留痕（攻击可观测）
    expect(readEngineEvents().some((e) => e["event"] === "wake-token-session-mismatch")).toBe(true);
  });

  it("本进程活记录的 sid 与注册 sid 相同（共享 sid 续跑/双轴形态）→ 不误拒", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({ receiptIds: [messageId], spawn: fakeSpawn() }));
    // 本进程已持有**同一个** sid 的 peer 活记录（共享 sid 的无头续跑/双轴合一形态），
    // 不构成跨 sid 冒名 → 放行（G-11 生产形态的等价物）。
    await seedActivePeer(process.pid, "sess_b", "self-held");
    const outcome = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-same-sid",
      { peerRoot },
    );
    expect(outcome.via).toBe("wake");
    expect(identityStore.get("conn-same-sid")?.voiceOwner).toBe("sess_b");
  });

  it("端到端：活会话 rogue 连绑定都被拒 → 无 voiceOwner → 盖章面照旧 session-id-held-elsewhere", async () => {
    await seedTeam();
    await seedSessionRecord("sess_b");
    const messageId = await seedMailbox();
    const res = await attemptWake(baseReq({ receiptIds: [messageId], spawn: fakeSpawn() }));

    // 受害者桌面原会话活着持有 sid（G-11 生产形态；另一个进程的真活记录）
    const victimPid = await startSleeper();
    await seedActivePeer(victimPid, "sess_b", "desktop-master");
    // rogue 自己就是本进程的活会话（sid=sess_rogue ≠ sess_b）
    await seedActivePeer(process.pid, "sess_rogue", "rogue-session");

    const error = await xcRegister(
      root,
      { name: "b", sessionId: "sess_b", wakeToken: res.nonce },
      "conn-rogue-e2e",
      { peerRoot },
    ).catch((e: unknown) => e);
    expect((error as { payload?: Record<string, unknown> }).payload?.error).toBe("wake_token_session_mismatch");
    // rogue 连接没有身份（绑定前被拒）→ 拿不到任何 voiceOwner
    expect(identityStore.get("conn-rogue-e2e")).toBeUndefined();
    // 盖章面对无证明者照旧拒绝（SEC-1 第二道闸不被绕过）
    const verdict = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b");
    expect(verdict).toEqual({ ok: false, reason: "session-id-held-elsewhere" });
    // 对照组：合法无头回合（进程无 active 记录）仍能放行盖章（G-11 修复目标保持）
    // ——换一个「干净进程」语义：本测试内 rogue 记录占着 process.pid，故用直接构造的
    // 合法连接（无 peer 活记录的新连接）验证盖章面放宽本身不回退。
    const okVerdict = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b", { voiceOwner: "sess_b" });
    expect(okVerdict).toEqual({ ok: true });
    const noProof = await verifyUservoiceStampAuthority(peerRoot, root, "sess_b", {});
    expect(noProof).toEqual({ ok: false, reason: "session-id-held-elsewhere" });
  });
});
