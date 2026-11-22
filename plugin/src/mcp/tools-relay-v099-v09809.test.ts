/**
 * v0.9.9（V098-09，P3）定向测试：**steer 键经真实写入路径落盘后，读面宽容拷贝可达**。
 *
 * 方案 §二 组 M·V098-09 给的两条修法（「删除 withSteerTolerance」或「让写入侧落
 * steer 键使其可达」，二选一）——本版选后者，理由：
 * - v0.9.8 时它是死代码（adv-1 F3/G3：无写入侧落 steer 键，J1/J2/J3 全走 interrupt 分支）；
 * - 本版组 W 的 **V098-02 修法**已让写入侧把 `steer:true` 补进邮箱行
 *   （mcp/tools-relay.ts：「组 S 落盘即生效的跨组契约」），宽容拷贝随之可达；
 * - 此时删除它反而有害：`core/types.ts` 的 normalizeMessage 白名单未含 steer
 *   （组 H 文件域），磁盘行上的 steer 键会被静默剥离——刚落盘的「显式自描述」
 *   变只写不读，J1/J2/J3/J4 与组 W 的注释同时落空。
 *
 * 收敛点（写死，随代码注释）：组 H 一旦把 steer 写进 types.ts 白名单，本宽容拷贝
 * 即成为无害的重复劳动（同值覆盖），可随之删除。
 *
 * 驱动方式：与组 S 的 tools-relay-v098-steer.test.ts 同模式（mock attemptWake），
 * 但断言落在**邮箱真源与读面**（steer 键落盘 → 读回 → 谓词/计数/边界提示三面同源）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamRelayCore } from "./tools-relay.js";
import { identityStore } from "./identity.js";
import { newTeamState, writeTeam } from "../core/teamstate.js";
import { countPendingInterrupts, countUnreadInterrupts, isInterruptOrSteer, readMailbox } from "../core/mailbox.js";

const attemptWakeMock = vi.hoisted(() => vi.fn());
vi.mock("../engine/wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/wake.js")>();
  return { ...actual, attemptWake: (...args: unknown[]) => attemptWakeMock(...args) };
});

/** steer 抢占成功的 attemptWake 回执（引擎侧真值见 wake-v098-steer.test.ts）。 */
function preemptedWake() {
  return {
    delivered: "wake" as const,
    note: "spawned: 无头 --resume 已发起（fire-and-forget，非送达确认）",
    wakeLog: "logs/wake-b-1.json",
    startConfirmed: true,
    wakeTiers: { spawnOk: "ok" as const, childAlive: "ok" as const, consumed: "pending" as const },
    steer: {
      requested: true as const,
      result: "preempted" as const,
      reason: "已终止旧回合（pid 4242，graceful，等待 12ms）并以 steer 信封续跑新回合",
      stopped: { pid: 4242, graceful: true, waitedMs: 12 },
      turn: { nonce: "wake-abcdef", startConfirmed: true },
    },
  };
}

let workDir: string;
let stateRoot: string;
let peerRoot: string;

beforeEach(() => {
  attemptWakeMock.mockReset();
  workDir = mkdtempSync(join(tmpdir(), "xc-v099-v09809-"));
  stateRoot = join(workDir, ".crosschat");
  peerRoot = mkdtempSync(join(tmpdir(), "xc-v099-v09809-peers-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(peerRoot, { recursive: true, force: true });
});

/** 建队：z（founder=lead）、b（引擎成员，steer 目标）。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: "default", founderKey: "z", now });
  team.members.push(
    { key: "z", sessionId: "sess_z", role: "peer", joinedAt: now, lastSeen: now },
    { key: "b", sessionId: "sess_b", role: "worker", joinedAt: now, lastSeen: now, identity: "engine" },
  );
  await writeTeam(stateRoot, team);
  identityStore.bind("conn-z", {
    sessionKey: "xc:default:z", teamId: "default", name: "z", agentKey: "z",
    sessionId: "sess_z", role: "peer", boundAt: now,
  });
}

function core() {
  return createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } });
}

/** 目标邮箱的磁盘真源行（未过读面归一）。 */
async function rawRows(agentKey: string): Promise<Array<Record<string, unknown>>> {
  const file = join(stateRoot, "teams", "default", "inbox", `${agentKey}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("v0.9.9 V098-09：steer 键写入侧落盘 ⇒ 读面宽容拷贝可达（不是死代码）", () => {
  it("【验收锚点】xc_relay steer:true（lead）⇒ 磁盘行带 steer:true；读面读回该键", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    await core().xc_message({ to: "b", msg: "别删生产库，先跑 dry-run", steer: true }, "conn-z");

    // ① 写入侧（组 W 的 V098-02 修法）：磁盘真源行上真的有 steer:true。
    const raw = await rawRows("b");
    expect(raw).toHaveLength(1);
    expect(raw[0]!["steer"]).toBe(true);
    expect(raw[0]!["interrupt"]).toBe(true);   // steer 恒蕴含 interrupt（S1）

    // ② 读面：normalizeMessage 白名单不含 steer（types.ts，组 H 域）——
    //    是 withSteerTolerance 把磁盘行的布尔 steer 补回读后消息（可达性证明）。
    const box = await readMailbox(stateRoot, "default", "b");
    expect(box).toHaveLength(1);
    expect((box[0] as unknown as { steer?: boolean }).steer).toBe(true);
    expect(box[0]!.interrupt).toBe(true);

    // ③ 三面共用谓词：纠错判定命中一次（不双计），工具边界提示同源计数 = 1。
    expect(isInterruptOrSteer(box[0]!)).toBe(true);
    expect(countUnreadInterrupts(box)).toBe(1);
    expect(await countPendingInterrupts(stateRoot, "default", "b")).toBe(1);
  });

  it("普通 interrupt（无 steer）⇒ 磁盘行无 steer 键、读面也不补（宽容拷贝只认布尔真值）", async () => {
    await seedTeam();
    attemptWakeMock.mockResolvedValue(preemptedWake());
    await core().xc_message({ to: "b", msg: "软中断：先看这个", interrupt: true }, "conn-z");

    const raw = await rawRows("b");
    expect(raw).toHaveLength(1);
    expect(raw[0]!["steer"]).toBeUndefined();
    const box = await readMailbox(stateRoot, "default", "b");
    expect((box[0] as unknown as { steer?: boolean }).steer).toBeUndefined();
    expect(isInterruptOrSteer(box[0]!)).toBe(true);   // 仍算纠错（interrupt 键）
  });

  it("宽容拷贝纪律：磁盘行上非布尔真的 steer（字符串）不被补回", async () => {
    await seedTeam();
    // 直接落一条 steer:"yes" 的行（模拟坏形状/旧数据）——读面不认，只认布尔真值。
    const { appendMailbox, createMessage } = await import("../core/mailbox.js");
    const bad = createMessage("z", "b", "坏形状");
    await appendMailbox(stateRoot, "default", "b", { ...bad, steer: "yes" } as typeof bad);
    const box = await readMailbox(stateRoot, "default", "b");
    expect(box).toHaveLength(1);
    expect((box[0] as unknown as { steer?: boolean }).steer).toBeUndefined();
    expect(isInterruptOrSteer(box[0]!)).toBe(false);
  });
});
