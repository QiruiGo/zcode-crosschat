/**
 * v0.5.2 红队二番战：peer 轴 5 项缺陷的防回归单测（红队二番战 peer 类别）。
 *
 * 逐项对应（修复前全部按红队原始复现步骤复现出缺陷，复现输出见各 it 的注释）：
 *
 * 1. **幂等注册**（peer-1）：同 name+sid 的活会话第二次注册被 `name_taken` 硬拒，
 *    自己的花名再也认领不回来。修复：占用者就是本进程时幂等重认领；
 *    占用者是别的**活**会话时仍然 `name_taken`（反向锁定，别把防护删没）。
 * 2. **xc_peer_review「免注册」假标**（peer-2）：README 标免注册，实现硬拒
 *    `not_registered`。修复走「如实改文档」——未注册会话不可能有暂存件（接收路径
 *    无注册记录即 `receiver-not-registered` 丢弃），注册后即可审阅。本文件锁定
 *    实现行为，文档侧（README L195 / DESIGN-V0.3 §8.1 / 工具描述）同步改写。
 * 3. **保留名 + self-send 缺防护**（peer-3）：`lead`/`default` 可注册可改名；
 *    可向自己发消息——accept 档回执 delivered 且真的入自己的队（下一回合注入自己），
 *    hold/自动档回执 held 后躺在自己隔离区、`xc_peer_inbox` 永远看不到
 *    （红队原话「回执 delivered 但永不入队」）。修复：与队内轴同表同码
 *    （`name_reserved` / `cannot_send_self`）。
 * 4. **CONC-1 改名通知线性恶化**：旧实现逐个 `await sendPeerFrame`（默认 10s 超时），
 *    N 个慢/不回应 peer 让 `xc_peer_rename` 耗时 N×10s（红队实测 N=6 超 60s）。
 *    修复：并行扇出，总耗时≈单次超时。
 * 5. **死会话花名静默替换**（peer-5）：死记录被惰性清扫后花名被接管，既无审计事件，
 *    `xc_peers` 也看不出地址换过人。修复：审计 `peer-name-reclaimed`（带上任身份）
 *    + 记录 `reclaimedFrom` + 行文本「接管自已离会会话 <ref>」标记。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPeerRows } from "../core/peeraddr.js";
import { writePeerBaseRecord, localPidDomain, peerAuditLogFile } from "../core/peerdir.js";
import { peerQueueDepth } from "../core/peermsg.js";
import {
  writePeerKeyFile,
  writePeerRecord,
  type PeerRecord,
} from "../core/peerregistry.js";
import { stopPeerEndpoint } from "../transport/pipe.js";
import { createDefaultPeerServices } from "./peer-services.js";
import { ToolError } from "./protocol.js";
import { acquireFileLock, LockBusyError } from "../core/lock.js";
import { peerRegistryLockName, scanPeers } from "../core/peerregistry.js";
import type { ToolDeps } from "./core.js";

let root = "";
let workspace = "";
let stateRoot = "";
let deps: ToolDeps;
let servers: Server[] = [];
let children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xc-peerint2-"));
  // v0.5.3（a8）：给本文件用到的 sid 落钩子基记录（新锚定闸要求）。
  await writePeerBaseRecord(root, { sessionId: "sess-alice", cwd: workspace, source: "startup", startedAt: Date.now(), lastSeen: Date.now() });
  // v0.5.3（a8）：给本文件用到的 sid 落钩子基记录（新锚定闸要求）。
  await writePeerBaseRecord(root, { sessionId: "sess-sender", cwd: workspace, source: "startup", startedAt: Date.now(), lastSeen: Date.now() });
  workspace = await mkdtemp(join(tmpdir(), "xc-peerint2-ws-"));
  stateRoot = join(workspace, ".crosschat");
  servers = [];
  children = [];
  deps = {
    stateRoot,
    workspace,
    env: { XC_MESSAGING_DIR: root } as NodeJS.ProcessEnv,
  };
});

afterEach(async () => {
  await stopPeerEndpoint();
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  for (const child of children) child.kill();
  children = [];
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** 起一个假 peer 端点：auth 放行；`control` 帧延迟 delayMs 后回一帧（0 = 立即回）。 */
async function startFakePeerEndpoint(delayMs = 0): Promise<string> {
  const socketPath = `\\\\.\\pipe\\LOCAL\\xcc-r2-${Math.random().toString(16).slice(2)}`;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const frame = JSON.parse(line) as { type?: string; msgId?: string };
          if (frame.type === "auth") {
            socket.write(`${JSON.stringify({ type: "auth", ok: true })}\n`);
          } else if (frame.type === "msg") {
            socket.write(`${JSON.stringify({ type: "status", msgId: frame.msgId, state: "delivered" })}\n`);
          } else if (frame.type === "control") {
            const reply = `${JSON.stringify({ type: "status", msgId: "-", state: "delivered" })}\n`;
            if (delayMs <= 0) socket.write(reply);
            else setTimeout(() => socket.write(reply), delayMs);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  servers.push(server);
  return socketPath;
}

/** 起一个活着但什么也不干的子进程——它的 pid 用来当「另一个 peer」的 pid。 */
async function startSleeper(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  child.unref();
  children.push(child);
  return child.pid!;
}

function peerRecord(pid: number, name: string, sessionId: string, socketPath: string): PeerRecord {
  return {
    pid,
    sessionId,
    messagingSocketPath: socketPath,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: Date.now(),
    lastSeen: Date.now(),
  };
}

/** 注册一个「别的活会话」peer（真管道端点 + 令牌发布），返回它的 socket 路径。 */
async function registerOtherPeer(name: string, sessionId: string): Promise<string> {
  const pid = await startSleeper();
  const socketPath = await startFakePeerEndpoint();
  await writePeerRecord(root, peerRecord(pid, name, sessionId, socketPath));
  await writePeerKeyFile(root, pid, socketPath, {
    peerToken: "d".repeat(32),
    pidDomain: localPidDomain(),
  });
  return socketPath;
}

/** 读审计日志并展开成事件对象（logPeerEvent 的落盘形状是 {event:{…}, ts}）。 */
async function auditEvents(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(peerAuditLogFile(root), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed = JSON.parse(line) as { event?: unknown };
      return (parsed.event ?? {}) as Record<string, unknown>;
    });
}

// ─────────────────────────── peer-1：幂等注册 ───────────────────────────

describe("peer-1 修复：同 name+sid 的活会话重复注册是幂等重认领", () => {
  it("第二次用同一花名+同一 sessionId 注册成功（修复前：name_taken 硬拒）", async () => {
    const services = createDefaultPeerServices(deps);
    const first = await services.register({ name: "alice", sessionId: "sess-alice" });
    expect(first.name).toBe("alice");

    // 修复前此处抛 name_taken：活会话重新注册自己的花名永远失败。
    const second = await services.register({ name: "alice", sessionId: "sess-alice" });
    expect(second.name).toBe("alice");
    expect(second.sessionId).toBe("sess-alice");
    expect(second.pid).toBe(first.pid);

    // 重认领后注册表里仍是本进程这一条记录，名字未变、可寻址。
    const selfRows = await services.list("self");
    expect(selfRows.map((row) => row.name)).toEqual(["alice"]);
  });

  it("重认领后端点照常工作：发给别的活会话仍能 delivered", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await registerOtherPeer("bob", "sess-bob");

    const result = await services.send({ to: "bob", message: "重注册之后还能发信" });
    expect(result.receipt).toBe("delivered");
  });

  it("花名被别的活会话占用时仍然 name_taken（反向锁定：不许删掉防护）", async () => {
    const services = createDefaultPeerServices(deps);
    await registerOtherPeer("bob", "sess-bob");

    const taken = await services
      .register({ name: "bob", sessionId: "sess-alice" })
      .catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(ToolError);
    expect((taken as ToolError).payload).toMatchObject({ error: "name_taken", name: "bob" });
  });

  it("同名重认领保留既有 formerNames（别名不因一次重复注册蒸发）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await services.rename("alice-2"); // formerNames = [alice]
    await services.register({ name: "alice-2", sessionId: "sess-alice" }); // 幂等重认领当前名

    const rows = await services.list("self");
    expect(rows[0]?.name).toBe("alice-2");
    // 修复伴生防线：重注册沿用旧记录的 formerNames，alice 仍可寻址。
    expect(rows[0]?.sessionId).toBe("sess-alice");
    const aliasHit = await services.send({ to: "alice", message: "别名还在" }).catch((e: unknown) => e);
    // 发给自己的别名 → cannot_send_self（能解析到别名 = 别名仍可寻址）。
    expect((aliasHit as ToolError).payload).toMatchObject({ error: "cannot_send_self" });
  });

  it("换名重注册把旧名送进 formerNames（与 rename 同语义，旧名不静默消失）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await services.register({ name: "trixie", sessionId: "sess-alice" }); // 换名重注册

    const rows = await services.list("self");
    expect(rows.map((row) => row.name)).toEqual(["trixie", "alice"]); // 当前行 + 别名行
    expect(rows[1]?.former).toBe(true);
    // alice 仍解析到本会话（而非 not-found）——只是不能发给自己。
    const aliasHit = await services.send({ to: "alice", message: "旧名" }).catch((e: unknown) => e);
    expect((aliasHit as ToolError).payload).toMatchObject({ error: "cannot_send_self" });
  });
});

// ─────────────────────────── peer-2：xc_peer_review 免注册假标 ───────────────────────────

describe("peer-2 修复：审阅面的注册要求与文档一致（v0.6：README 的 xc_review 行不标免注册）", () => {
  it("README 的 xc_review 行不再标注「免注册」（文档-行为一致性回归锁；v0.6 旧名行已按收敛纪律移出主文）", async () => {
    const { readFile: read } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const readmePath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "README.md");
    const readme = await read(readmePath, "utf8");
    const row = readme.split("\n").find((line) => line.trimStart().startsWith("| `xc_review("));
    expect(row).toBeDefined();
    expect(row).not.toContain("免注册");
    // 主文不得再出现旧名行（v0.6 工具面收敛；旧名只允许在 MIGRATION 与弃用说明语境）。
    const oldRow = readme.split("\n").find((line) => line.trimStart().startsWith("| `xc_peer_review`"));
    expect(oldRow).toBeUndefined();
  });

  it("未注册调用 → not_registered 且提示先注册（未注册会话不可能有暂存件）", async () => {
    const services = createDefaultPeerServices(deps);
    const refused = await services.review({ action: "list" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    const payload = (refused as ToolError).payload as { error?: string; message?: string };
    expect(payload.error).toBe("not_registered");
    expect(payload.message).toContain("xc_identify");
  });

  it("注册后即可审阅（重启丢注册的会话：重新注册即取回隔离区）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    const listed = await services.review({ action: "list" });
    expect(listed).toEqual({ action: "list", held: [], affected: [], receipts: [] });
  });
});

// ─────────────────────────── peer-3：保留名 + self-send ───────────────────────────

describe("peer-3 修复：peer 花名拒绝队内保留名（与队内轴同表同码）", () => {
  it("xc_peer_register 拒绝 lead/default → name_reserved", async () => {
    const services = createDefaultPeerServices(deps);
    for (const reserved of ["lead", "default"]) {
      const refused = await services
        .register({ name: reserved, sessionId: `sess-${reserved}` })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ToolError);
      expect((refused as ToolError).payload).toMatchObject({ error: "name_reserved", name: reserved });
    }
  });

  it("xc_peer_rename 同样拒绝保留名（修复前：alice → default 改名成功）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const refused = await services.rename("lead").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "name_reserved", name: "lead" });

    // 名字没被改掉。
    const selfRows = await services.list("self");
    expect(selfRows.map((row) => row.name)).toEqual(["alice"]);
  });
});

describe("peer-3 修复：禁止向自己发消息（cannot_send_self）", () => {
  it("to=本会话当前名 → cannot_send_self，队列与隔离区都不落（修复前：held 且永不入队）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const refused = await services
      .send({ to: "alice", message: "自言自语" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "cannot_send_self", to: "alice" });
    expect(await peerQueueDepth(root, "sess-alice")).toBe(0);
  });

  it("accept 档下 to=自己同样拒绝（修复前：delivered 且入自己的队、下一回合注入自己）", async () => {
    const services = createDefaultPeerServices({
      ...deps,
      env: { XC_MESSAGING_DIR: root, XC_CROSSCHAT_INBOUND: "accept" } as NodeJS.ProcessEnv,
    });
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const refused = await services
      .send({ to: "alice", message: "自言自语" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "cannot_send_self" });
    expect(await peerQueueDepth(root, "sess-alice")).toBe(0);
  });

  it("to=本会话的 formerNames 别名也判自发（别名行解析回来的还是自己）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await services.rename("alice-2"); // alice 进 formerNames，成为本会话的可寻址别名

    const refused = await services.send({ to: "alice", message: "跟旧名字说话" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "cannot_send_self" });
    expect(await peerQueueDepth(root, "sess-alice")).toBe(0);
  });

  it("闸门只挡自己：发给别的活会话照常 delivered（防过度拒绝）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    await registerOtherPeer("bob", "sess-bob");

    const result = await services.send({ to: "bob", message: "正常投递不受影响" });
    expect(result.receipt).toBe("delivered");
    expect(result.to).toBe("bob");
  });
});

// ─────────────────────────── CONC-1：改名通知并行扇出 ───────────────────────────

describe("CONC-1 修复：xc_peer_rename 的通知扇出是并行的", () => {
  it("N=6 个慢回应 peer：总耗时≈单次延迟，而不是 N×（修复前 N×300ms≈1.8s；不回应时 N×10s）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "sender", sessionId: "sess-sender" });
    for (let i = 0; i < 6; i += 1) {
      const pid = await startSleeper();
      const socketPath = await startFakePeerEndpoint(300);
      await writePeerRecord(root, peerRecord(pid, `peer-${i}`, `sess-p${i}`, socketPath));
      await writePeerKeyFile(root, pid, socketPath, {
        peerToken: "d".repeat(32),
        pidDomain: localPidDomain(),
      });
    }

    const startedAt = Date.now();
    const result = await services.rename("sender-2");
    const elapsed = Date.now() - startedAt;

    expect(result.name).toBe("sender-2");
    expect(result.notified.length).toBe(6);
    expect(result.notified.every((row) => row.ok)).toBe(true);
    // 串行实现：6×300ms≈1.8s；并行实现：≈300ms。阈值取 1s（串行必挂）。
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);

  it("某个 peer 不可达只写进它自己的 notified 行，不拖累其他会话", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "sender", sessionId: "sess-sender" });
    // 一个有名无钥的 peer（key 文件缺失 ⇒ invalid_target），一个正常的 peer。
    const brokenPid = await startSleeper();
    await writePeerRecord(root, peerRecord(brokenPid, "broken", "sess-broken", `\\\\.\\pipe\\LOCAL\\xcc-broken-${brokenPid}`));
    await registerOtherPeer("good", "sess-good");

    const result = await services.rename("sender-3");
    expect(result.notified.length).toBe(2);
    const broken = result.notified.find((row) => row.name === "broken");
    const good = result.notified.find((row) => row.name === "good");
    expect(broken?.ok).toBe(false);
    expect(broken?.errorClass).toBe("invalid_target");
    expect(good?.ok).toBe(true);
  }, 30_000);
});

// ─────────────────────────── peer-5：死会话花名接管留痕 ───────────────────────────

describe("peer-5 修复：接管死会话占用的花名必须留痕（审计 + reclaimedFrom + 行标记）", () => {
  it("注册接管死花名 → 审计 peer-name-reclaimed 带上任身份，新记录带 reclaimedFrom", async () => {
    // 死 pid 记录（pid 不存在 ⇒ pid-dead，惰性清扫会摘除它）。
    await writePeerRecord(root, peerRecord(999_999, "alice", "sess-dead", "\\\\.\\pipe\\LOCAL\\xcc-dead"));

    const services = createDefaultPeerServices(deps);
    const result = await services.register({ name: "alice", sessionId: "sess-alice" });
    expect(result.name).toBe("alice");

    const reclaimed = (await auditEvents()).find((event) => event["event"] === "peer-name-reclaimed");
    expect(reclaimed).toBeDefined();
    expect(reclaimed).toMatchObject({
      name: "alice",
      sessionId: "sess-alice",
      previous: {
        sessionId: "sess-dead",
        pid: 999_999,
        deadReason: "pid-dead",
      },
    });

    // 接管事实写进新记录：xc_peers 因此能显示「这个地址换过人」。
    const rows = await services.list("self");
    expect(rows[0]?.reclaimedFrom).toMatchObject({ sessionId: "sess-dead", pid: 999_999 });
    const text = formatPeerRows(rows).join("\n");
    expect(text).toContain("alice");
    expect(text).toContain("接管自已离会会话 ess-dea");
  });

  it("改名接管死花名同样留痕（注册与改名共用一个 claim 助手）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    // 死记录写在注册之后：注册那次扫描会顺带清扫掉此前盘上的死记录，
    // 这里要验的是「claim 时刻盘上还有死记录」这条路径。
    await writePeerRecord(root, peerRecord(999_998, "ghost", "sess-ghost", "\\\\.\\pipe\\LOCAL\\xcc-ghost"));

    const result = await services.rename("ghost");
    expect(result.name).toBe("ghost");

    const reclaimed = (await auditEvents()).find((event) => event["event"] === "peer-name-reclaimed");
    expect(reclaimed).toMatchObject({ name: "ghost", sessionId: "sess-alice" });
    const rows = await services.list("self");
    expect(rows[0]?.reclaimedFrom).toMatchObject({ sessionId: "sess-ghost", pid: 999_998 });
  });

  it("花名此前无主（没有死记录）时不产生接管痕迹", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    expect((await auditEvents()).some((event) => event["event"] === "peer-name-reclaimed")).toBe(false);
    const rows = await services.list("self");
    expect(rows[0]?.reclaimedFrom).toBeUndefined();
    expect(formatPeerRows(rows).join("\n")).not.toContain("接管自已离会会话");
  });
});

// ─────────────────────────── v0.5.3（A4 修复）：注册/改名互斥 + 拒名审计 ───────────────────────────

describe("A4 修复（adj052 A4 攻击重放）：花名 claim→写盘临界区互斥", () => {
  it("注册表锁被持有时注册 → LockBusyError（临界区真在机器全局锁内，TOCTOU 关闭）；释放后照常成功", async () => {
    deps.env = { ...deps.env, XC_PEER_REGISTER_LOCK_WAIT_MS: "150" } as NodeJS.ProcessEnv;
    const services = createDefaultPeerServices(deps);
    const lockName = peerRegistryLockName(root);
    const held = await acquireFileLock(root, lockName); // 测试进程持锁 = 模拟另一注册者正在临界区
    try {
      const busy = await services
        .register({ name: "alice", sessionId: "sess-alice" })
        .catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(LockBusyError);
      expect((busy as LockBusyError).lock).toBe(lockName);
      // 锁未被绕过：注册表里没有写出任何记录（修复前此场景直接写盘成功）。
      const scan = await scanPeers(root);
      expect(scan.active).toHaveLength(0);
    } finally {
      await held.release();
    }
    // 锁释放后注册照常成功（busy 可重试，fail-closed 不留残迹）。
    const ok = await services.register({ name: "alice", sessionId: "sess-alice" });
    expect(ok.name).toBe("alice");
    expect((await services.list("self")).map((row) => row.name)).toEqual(["alice"]);
  });

  it("注册到别的活会话占用的花名 → name_taken + 审计 peer-name-taken-refused（带上任身份）", async () => {
    await registerOtherPeer("bob", "sess-bob");
    const services = createDefaultPeerServices(deps);
    const refused = await services
      .register({ name: "bob", sessionId: "sess-alice" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "name_taken", name: "bob" });

    const events = await auditEvents();
    const refusedEvents = events.filter((e) => e["event"] === "peer-name-taken-refused");
    expect(refusedEvents).toHaveLength(1);
    expect(refusedEvents[0]).toMatchObject({
      name: "bob",
      holders: [{ sessionId: "sess-bob" }],
    });
  });

  it("改名到别的活会话占用的花名 → name_taken + 同款拒名审计（与注册同一临界区纪律）", async () => {
    await registerOtherPeer("bob", "sess-bob");
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });

    const refused = await services.rename("bob").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).payload).toMatchObject({ error: "name_taken", name: "bob" });
    // 改名被拒后本进程记录的名字未变（没有写盘副作用）。
    expect((await services.list("self")).map((row) => row.name)).toEqual(["alice"]);
    const events = await auditEvents();
    expect(events.some((e) => e["event"] === "peer-name-taken-refused" && e["name"] === "bob")).toBe(true);
  });

  it("改名临界区也在注册表锁内：锁被持有时改名 → LockBusyError（不写盘）", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    deps.env = { ...deps.env, XC_PEER_REGISTER_LOCK_WAIT_MS: "150" } as NodeJS.ProcessEnv;
    const held = await acquireFileLock(root, peerRegistryLockName(root));
    try {
      const busy = await services.rename("trixie").catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(LockBusyError);
      // 名字未变。
      expect((await services.list("self")).map((row) => row.name)).toEqual(["alice"]);
    } finally {
      await held.release();
    }
  });
});

describe("A4 回归锁：同名多持有 = 显式歧义状态（裸名 fail-closed + 行标记）", () => {
  it("手工污染两条同名活记录（模拟历史名册）：裸名投递 ambiguous_target，xc_peers 行带 ref 标记", async () => {
    const services = createDefaultPeerServices(deps);
    await services.register({ name: "alice", sessionId: "sess-alice" });
    // 两条同名活记录（不同 sleeper pid = 两个活会话；历史版本互斥缺失的遗留形态）。
    const pid1 = await startSleeper();
    const socket1 = await startFakePeerEndpoint();
    await writePeerRecord(root, peerRecord(pid1, "dupname", "sess-dup-1", socket1));
    await writePeerKeyFile(root, pid1, socket1, { peerToken: "d".repeat(32), pidDomain: localPidDomain() });
    const pid2 = await startSleeper();
    const socket2 = await startFakePeerEndpoint();
    await writePeerRecord(root, peerRecord(pid2, "dupname", "sess-dup-2", socket2));
    await writePeerKeyFile(root, pid2, socket2, { peerToken: "d".repeat(32), pidDomain: localPidDomain() });

    // 裸名投递 fail-closed：ambiguous_target 带两个候选。
    const sent = await services.send({ to: "dupname", message: "hello whoever you are" }).catch((e: unknown) => e);
    expect(sent).toBeInstanceOf(ToolError);
    const payload = (sent as ToolError).payload as { error: string; candidates: unknown[] };
    expect(payload.error).toBe("ambiguous_target");
    expect(payload.candidates).toHaveLength(2);

    // 观测面显式歧义：同名行渲染带 [ref] 消歧后缀（ambiguousNames）。
    const rows = await services.list();
    const dupRows = rows.filter((r) => r.name === "dupname");
    expect(dupRows).toHaveLength(2);
    const lines = formatPeerRows(dupRows);
    for (const line of lines) {
      expect(line).toMatch(/\[[\w-]{8}\]/); // 歧义行的 ref 后缀（sessionId 尾 8 位，如 [ss-dup-1]）
    }
    // ref 定向投递仍可精确寻址（歧义不阻断精确路由）。
    const targeted = await services.send({ to: `dupname [${dupRows[0]!.ref}]`, message: "exact" });
    expect(targeted.receipt).toBe("delivered");
  });
});
