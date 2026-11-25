/**
 * v0.10.0 组 D（R7）定向单测——core/capacity.ts 的**无头进程树记账**（memberTrees）。
 *
 * 锁死契约（需求书 R7 验收口径前两条 + D3 行为改动）：
 * 1. sample.json 可见每棵无头进程树字节（按唤醒生命周期账本 pid 找进程及子孙，
 *    汇总工作集）——memberTreesFromLedger 纯函数逐条对拍；
 * 2. 与任务管理器实测偏差可解释：只汇总采样集内根 + 子孙（ppid 图 BFS），根不在
 *    采样集的账不计（不虚报 0 字节的树）；
 * 3. 只记账不清理：memberTrees 不参与 judgeCapacity 任何判定（红样本判据不变）；
 * 4. 采样失败时字段缺席并如实标注：CIM 失败 → degraded（进程类整体不可信，无
 *    memberTrees）；账本读取意外 → memberTreesError 带原因，主字段不受影响；
 * 5. 文本面列出占用最大的前 MEMBER_TREES_TOP_N 棵；formatCapacityLines 在无
 *    memberTrees 时行数逐字不变（旧契约回归）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_TREES_TOP_N,
  capacityCacheFile,
  formatCapacityLines,
  judgeCapacity,
  memberTreesFromLedger,
  readWakeTreeLedger,
  sampleCapacity,
  takeFreshSample,
  type CapacitySample,
  type ProcRow,
  type WakeTreeLedgerEntry,
} from "./capacity.js";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function row(pid: number, ppid: number, wsBytes: number, commandLine = "ZCode.exe"): ProcRow {
  return { pid, ppid, name: "ZCode.exe", commandLine, wsBytes };
}

function sample(overrides: Partial<CapacitySample> = {}): CapacitySample {
  return {
    sampledAt: 1000,
    totalBytes: 32 * GB,
    freeBytes: 16 * GB,
    watermark: 0.5,
    steadyTreeBytes: Math.round(3.3 * GB),
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// memberTreesFromLedger（纯函数）
// ---------------------------------------------------------------------------

describe("v0.10.0 组 D / R7：memberTreesFromLedger（根 + 子孙汇总）", () => {
  const now = 10_000_000;

  it("根 + 全部子孙的工作集合计（ppid 图 BFS，跨层）", () => {
    const rows = [
      row(10, 1, 400 * MB), // 唤醒子（账本 pid）
      row(11, 10, 200 * MB), // 子的子
      row(12, 11, 100 * MB),
      row(99, 1, 5 * GB), // 别人的常驻主进程：不在树内
    ];
    const entries: WakeTreeLedgerEntry[] = [{ member: "wk", rootPid: 10, lastTs: now - 5 * 60_000 }];
    const trees = memberTreesFromLedger(rows, entries, now);
    expect(trees).toEqual([
      { member: "wk", rootPid: 10, bytes: 700 * MB, idleMin: 5 },
    ]);
  });

  it("idleMin = 距账本最近一行的分钟数（向下取整；坏时钟不取负）", () => {
    const rows = [row(10, 1, 1 * MB)];
    const trees = memberTreesFromLedger(
      rows,
      [{ member: "wk", rootPid: 10, lastTs: now - 90_000 }],
      now,
    );
    expect(trees[0]!.idleMin).toBe(1);
    const future = memberTreesFromLedger(rows, [{ member: "wk", rootPid: 10, lastTs: now + 60_000 }], now);
    expect(future[0]!.idleMin).toBe(0);
  });

  it("根 pid 不在采样集（进程已亡/非 ZCode 宿主）⇒ 该树不计（不虚报 0 字节）", () => {
    const rows = [row(11, 10, 200 * MB)]; // 只剩子孙，根 10 已不在
    const entries: WakeTreeLedgerEntry[] = [{ member: "wk", rootPid: 10, lastTs: now }];
    expect(memberTreesFromLedger(rows, entries, now)).toEqual([]);
  });

  it("多棵树按字节降序（占用最大的在前）", () => {
    const rows = [row(10, 1, 100 * MB), row(20, 1, 900 * MB)];
    const entries: WakeTreeLedgerEntry[] = [
      { member: "small", rootPid: 10, lastTs: now },
      { member: "big", rootPid: 20, lastTs: now },
    ];
    expect(memberTreesFromLedger(rows, entries, now).map((t) => t.member)).toEqual(["big", "small"]);
  });

  it("ppid 自环不死循环（防御）", () => {
    const rows = [row(10, 10, 50 * MB)];
    const trees = memberTreesFromLedger(rows, [{ member: "wk", rootPid: 10, lastTs: now }], now);
    expect(trees).toEqual([{ member: "wk", rootPid: 10, bytes: 50 * MB, idleMin: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// readWakeTreeLedger（账本提炼）
// ---------------------------------------------------------------------------

describe("v0.10.0 组 D / R7：readWakeTreeLedger（生命周期账 → 候选树）", () => {
  it("带启动确认 pid 且无 exit 行 ⇒ 候选树（member/lastTs 取账内真值）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-ledger-"));
    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(
        join(root, "logs", "wake-lifecycle-wk-111.jsonl"),
        [
          JSON.stringify({ ts: 111, event: "wake-child-start", sid: "s1", to: "wk", scene: "dispatch" }),
          JSON.stringify({ ts: 113, event: "wake-child-start-confirmed", to: "wk", pid: 4242 }),
        ].join("\n") + "\n",
        "utf8",
      );
      const entries = await readWakeTreeLedger(root);
      expect(entries).toEqual([{ member: "wk", rootPid: 4242, lastTs: 113 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("有 wake-child-exit 行 ⇒ 不计（引擎已观察到唤醒子消失）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-ledger-"));
    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(
        join(root, "logs", "wake-lifecycle-wk-222.jsonl"),
        [
          JSON.stringify({ ts: 222, event: "wake-child-start", to: "wk" }),
          JSON.stringify({ ts: 223, event: "wake-child-start-confirmed", to: "wk", pid: 4242 }),
          JSON.stringify({ ts: 900, event: "wake-child-exit", pid: 4242, durationMs: 1 }),
        ].join("\n") + "\n",
        "utf8",
      );
      expect(await readWakeTreeLedger(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("无启动确认 pid（unconfirmed）⇒ 不计（找不到根进程，不猜）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-ledger-"));
    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(
        join(root, "logs", "wake-lifecycle-wk-333.jsonl"),
        JSON.stringify({ ts: 333, event: "wake-child-start-unconfirmed", to: "wk" }) + "\n",
        "utf8",
      );
      expect(await readWakeTreeLedger(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs 目录缺失 ⇒ 上抛（调用方转成 memberTreesError，不让采样整体失败）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-ledger-"));
    try {
      await expect(readWakeTreeLedger(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// takeFreshSample / sampleCapacity 接线 + 文本面
// ---------------------------------------------------------------------------

describe("v0.10.0 组 D / R7：采样接线与文本面", () => {
  it("只记账不清理：memberTrees 不改变红/绿判定（verdict 与无它时一致）", () => {
    const base = sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 900 * MB });
    const withTrees = sample({
      headlessTurnCount: 1,
      headlessTurnMaxRssBytes: 900 * MB,
      memberTrees: [{ member: "wk", rootPid: 10, bytes: 1.6 * GB, idleMin: 3 }],
    });
    expect(judgeCapacity(withTrees, {})).toEqual(judgeCapacity(base, {}));
  });

  it("文本面：列出占用最大的前 MEMBER_TREES_TOP_N 棵（含成员/字节/pid/idle）", () => {
    const trees = Array.from({ length: 5 }, (_, i) => ({
      member: `m${i}`,
      rootPid: 100 + i,
      bytes: (i + 1) * 100 * MB,
      idleMin: i,
    }));
    const lines = formatCapacityLines(sample({ memberTrees: trees }), judgeCapacity(sample({ memberTrees: trees }), {}));
    const treeLine = lines.find((l) => l.startsWith("  - 回合树 Top"));
    expect(treeLine).toBeDefined();
    expect(treeLine).toContain(`Top${MEMBER_TREES_TOP_N}`);
    expect(treeLine).toContain("m4=500.0MB(pid 104, idle 4min)"); // 最大者在列
    expect(treeLine).toContain("等 5 棵");
    expect(treeLine).toContain("只记账不清理");
    // 绿样本仍不追加 compress-advice（C9 契约不回归）
    expect(lines.some((l) => l.startsWith("compress-advice:"))).toBe(false);
  });

  it("旧样本（无 memberTrees）⇒ formatCapacityLines 行数逐字不变", () => {
    const s = sample();
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes("回合树"))).toBe(false);
  });

  it("账本不可读（无 logs 目录）⇒ memberTrees 缺席 + memberTreesError 标注，主字段照常", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-fresh-"));
    try {
      const s = await takeFreshSample(Date.now(), root);
      expect(s.memberTrees).toBeUndefined();
      if (s.degraded === null) {
        // CIM 可用：缺席必须带原因（memberTreesError）——不静默缺席
        expect(typeof s.memberTreesError).toBe("string");
      } else {
        // CIM 不可用（非 Windows/无 powershell）：进程类整体降级，memberTrees 自然缺席
        expect(s.degraded).toBe("cim-unavailable");
      }
      // 主字段不受影响：设备水位始终在场
      expect(s.totalBytes).toBeGreaterThan(0);
      expect(s.watermark).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("不传 stateRoot（旧调用点/测试缝）⇒ 无 memberTrees 也无 Error（行为逐字节不变）", async () => {
    const s = await takeFreshSample(Date.now());
    expect(s.memberTrees).toBeUndefined();
    expect(s.memberTreesError).toBeUndefined();
  });

  it("sampleCapacity 从 cacheFile 反解 stateRoot：账本可读时 memberTrees 进样本", async () => {
    const root = await mkdtemp(join(tmpdir(), "xc-v0100d-cap-"));
    try {
      const stateRoot = join(root, ".crosschat");
      await mkdir(join(stateRoot, "logs"), { recursive: true });
      await writeFile(
        join(stateRoot, "logs", "wake-lifecycle-wk-777.jsonl"),
        JSON.stringify({ ts: Date.now(), event: "wake-child-start-confirmed", to: "wk", pid: process.pid }) + "\n",
        "utf8",
      );
      // 缓存窗关掉（XC_MEM_SAMPLE_MIN_MS=0）保证真采样走账本读取路径。
      const s = await sampleCapacity({ XC_MEM_SAMPLE_MIN_MS: "0" }, capacityCacheFile(stateRoot), Date.now());
      if (s.degraded === null) {
        // 根 pid = 本 node 进程：不在 ZCode.exe 采样集里 → 不计树，但字段在场（空数组）。
        expect(s.memberTrees).toEqual([]);
        expect(s.memberTreesError).toBeUndefined();
      } else {
        // CIM 不可用（非 Windows/无 powershell）：进程类字段整体缺席，降级标注
        expect(s.degraded).toBe("cim-unavailable");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
