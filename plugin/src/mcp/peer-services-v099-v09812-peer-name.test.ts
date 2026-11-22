/**
 * v0.9.9（组 H）定向测试：**V098-12（P3）peer 名解析按扫描序首个命中，可被同 sid 冒充记录劫持**。
 *
 * 缺陷形态（adv-3 i=4）：`peerNameBySessionId` 按 readdir 扫描序取首个同 sid 活跃记录——
 * 同机往 peer 注册表植一条「同 sid、异名、活 pid」的冒充记录（文件名 pid 小于真实记录即
 * 字典序先到）即可劫持「可直接复制」的显示地址：team 板面与 panel 两面同时显示冒充名，
 * 而该名在寻址面根本不可达（key 文件不可读）。
 *
 * 修法与覆盖（任务书：「权威排序（pid+startedAt+文件名多重确定性）或检测重复并拒绝」；
 * 验收：「冒充记录不再改变显示地址」）：
 *   1. 【纯函数】同 sid 多活跃记录：花名全一致 → 呈现（合法的「桌面 + 无头 --resume
 *      续跑共享 sid」形态，行为不变）；花名冲突 → **拒绝呈现**（该 sid 不出现在返回表）；
 *   2. 【确定性】聚合与扫描序无关（两种注入序结论一致）——「扫描序首个命中」的
 *      nondeterminism 本身被消除；
 *   3. 【端到端】team 板面：植入冒充记录后 peerName 从「可复制」降为「缺失」而非变成
 *      冒充名；移除后恢复；
 *   4. 【不误伤】死记录不进表（既有的「诚实缺失优于给一个发不到的名字」口径保持）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf, type ToolResult } from "./protocol.js";
import { handleOverview } from "./tools-overview.js";
import { resetPeerServicesForTests, peerNameBySessionId } from "./peer-services.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { localPidDomain } from "../core/peerdir.js";
import { writePeerRecord, type PeerRecord, type PeerScanResult } from "../core/peerregistry.js";
import type { TeamMember } from "../core/types.js";
import type { ToolDeps } from "./core.js";

let workDir: string;
let stateRoot: string;
let peerRoot: string;
let deps: ToolDeps;

const GREEN_ENV = {
  XC_MEM_WARN_WATERMARK: "0.0000001",
  XC_MEM_SESSION_LIMIT_BYTES: "999999999999",
  XC_TURN_ESTIMATE_BYTES: "1",
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-v099-h12-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = join(workDir, "peer-root");
  await mkdir(join(peerRoot, "sessions"), { recursive: true });
  deps = { stateRoot, workspace: workDir, env: { ...GREEN_ENV, XC_MESSAGING_DIR: peerRoot } };
});

afterEach(async () => {
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  const now = Date.now();
  return {
    key,
    sessionId: `sess-${key}`,
    role: "worker",
    joinedAt: now - 300_000,
    lastSeen: now - 60_000,
    state: "ready",
    identity: "engine",
    ...overrides,
  };
}

async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({
    teamId: "default",
    name: "default",
    founderKey: "lead",
    founder: member("lead"),
    now,
  });
  team.leadKey = "lead";
  team.members.push(member("alice"), member("bob"));
  await writeTeam(stateRoot, team);
}

/** 写一条**活** peer 注册记录（pid 须是活进程：本进程或其父进程）。 */
async function writeLivePeer(pid: number, sessionId: string, name: string): Promise<void> {
  const now = Date.now();
  await writePeerRecord(peerRoot, {
    pid,
    sessionId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\xcc-msg-${name}-${pid}`,
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    name,
    formerNames: [],
    startedAt: now - 60_000,
    lastSeen: now,
  });
}

function rec(pid: number, sessionId: string, name: string | undefined): PeerRecord {
  const now = Date.now();
  return {
    pid,
    sessionId,
    messagingSocketPath: "p",
    pidDomain: "d",
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    ...(name !== undefined ? { name } : {}),
    formerNames: [],
    startedAt: now,
    lastSeen: now,
  };
}

function scanOf(...active: PeerRecord[]): PeerScanResult {
  return { active, dead: [], foreign: [], skipped: 0 };
}

// ---------------------------------------------------------------------------
// 纯函数：权威聚合（歧义拒绝）
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-12：peerNameBySessionId 歧义拒绝（冒充记录不再改变显示地址）", () => {
  it("【锚点】单条活跃记录 → 呈现花名（既有行为不变）", () => {
    const out = peerNameBySessionId(scanOf(rec(100, "sess-a", "alice-pc")));
    expect(out.get("sess-a")).toBe("alice-pc");
  });

  it("【锚点】同 sid 多条活跃记录且花名一致（桌面 + 无头 --resume 续跑共享 sid 的真实形态）→ 呈现该名", () => {
    const out = peerNameBySessionId(scanOf(
      rec(100, "sess-a", "alice-pc"),
      rec(200, "sess-a", "alice-pc"),
      rec(300, "sess-b", "bob-pc"),
    ));
    expect(out.get("sess-a")).toBe("alice-pc");
    expect(out.get("sess-b")).toBe("bob-pc");
  });

  it("【验收锚点】同 sid 花名冲突（真实 + 植入冒充）→ 拒绝呈现；两种扫描序结论一致", () => {
    const real = rec(9001, "sess-a", "bravo");
    const forged = rec(1000, "sess-a", "aaa-forged"); // 字典序先到（pid 更小）
    for (const ordered of [[real, forged], [forged, real]]) {
      const out = peerNameBySessionId(scanOf(...ordered));
      expect(out.has("sess-a")).toBe(false); // 不呈现：无法判定哪条是真身
      expect(out.get("sess-a")).toBeUndefined();
      expect([...out.values()]).not.toContain("aaa-forged"); // 冒充名绝不出现在显示地址
    }
  });

  it("【边界】无名字/空名的活跃记录不参与（既有的诚实缺失口径）；scan 缺省 → 空表", () => {
    const out = peerNameBySessionId(scanOf(rec(100, "sess-a", undefined), rec(200, "sess-b", "")));
    expect([...out.keys()]).toEqual([]);
    expect(peerNameBySessionId(null).size).toBe(0);
    expect(peerNameBySessionId(undefined).size).toBe(0);
  });

  it("【边界】一个 sid 冲突不影响别的 sid 的正常呈现（降级面最小化）", () => {
    const out = peerNameBySessionId(scanOf(
      rec(9001, "sess-a", "bravo"),
      rec(1000, "sess-a", "aaa-forged"),
      rec(300, "sess-b", "bob-pc"),
    ));
    expect(out.has("sess-a")).toBe(false);
    expect(out.get("sess-b")).toBe("bob-pc");
  });
});

// ---------------------------------------------------------------------------
// 端到端：team 板面成员行（与 panel agents() 同一解析源）
// ---------------------------------------------------------------------------

describe("v0.9.9 V098-12：team 板面成员行 peerName 抗冒充（端到端）", () => {
  it("【对照】真实活跃 peer 记录 → peerName 在成员行", async () => {
    await seedTeam();
    await writeLivePeer(process.pid, "sess-alice", "alice-pc");

    const res = await handleOverview(deps, { view: "team" }, "conn-nobody");
    expect(res.isError).toBeUndefined();
    const members = (payloadOf(res) as { members: Array<{ key: string; peerName?: string }> }).members;
    const byKey = Object.fromEntries(members.map((m) => [m.key, m.peerName]));
    expect(byKey["alice"]).toBe("alice-pc");
    expect(byKey["bob"]).toBeUndefined();
  });

  it("【验收锚点】植入同 sid 异名活 pid 冒充记录 → peerName 不再变成冒充名（诚实缺失）；移除后恢复", async () => {
    await seedTeam();
    await writeLivePeer(process.pid, "sess-alice", "bravo"); // 真实记录（活 pid = 本进程）

    const before = await handleOverview(deps, { view: "team" }, "conn-nobody");
    const beforeByName = Object.fromEntries(
      (payloadOf(before) as { members: Array<{ key: string; peerName?: string }> }).members.map((m) => [m.key, m.peerName]),
    );
    expect(beforeByName["alice"]).toBe("bravo");

    // 植入：同 sid、异名、活 pid（父进程）、文件名 pid 更小（字典序先于真实记录）。
    await writeLivePeer(process.ppid, "sess-alice", "aaa-forged");

    const during = await handleOverview(deps, { view: "team" }, "conn-nobody");
    const duringByName = Object.fromEntries(
      (payloadOf(during) as { members: Array<{ key: string; peerName?: string }> }).members.map((m) => [m.key, m.peerName]),
    );
    expect(duringByName["alice"]).toBeUndefined(); // 拒绝呈现——不是冒充名
    expect(JSON.stringify(payloadOf(during))).not.toContain("aaa-forged"); // 全 payload 无冒充名

    // 移除冒充记录 → 显示地址恢复真实名（修复不把正常面永久打瞎）。
    await rm(join(peerRoot, "sessions", `${process.ppid}.json`), { force: true });
    const after = await handleOverview(deps, { view: "team" }, "conn-nobody");
    const afterByName = Object.fromEntries(
      (payloadOf(after) as { members: Array<{ key: string; peerName?: string }> }).members.map((m) => [m.key, m.peerName]),
    );
    expect(afterByName["alice"]).toBe("bravo");
  });
});
