/**
 * v0.10.0（组 C / C1，R1 / G-27）定向测试：**协作状态根解析不再裸拼**。
 *
 * 缺陷形态（R1 / G-27）：
 * SessionStart 钩子按「会话当前工作目录」裸拼 `<cwd>/.crosschat`——会话 cd 进子目录
 * （或 cwd 本身就是 `.crosschat`）后一旦重启，就在子目录里另起一个协作根，身份/邮箱/
 * 任务板全部碎片化，且该幻影根里的 regToken 脱离主根可见范围。实证：
 * `ROOT/.crosschat/.crosschat/registry/sessions/<sid>.json`（cwd 就是 `.crosschat` 本身
 * 的会话存在约 5.5 小时）。
 *
 * 修法（C1）：从会话 cwd 开始逐级向上找**已存在**的协作根（`.crosschat/` 下含
 * registry/teams/logs 之一才算），最近的祖先优先；cwd 自身在某个 `.crosschat` 里或其
 * 子目录里时直接解析到那个 `.crosschat`（绝不产生嵌套根）；向上都找不到时保持现状
 * （裸拼）。向上查找最多 12 层、到盘符根为止。
 *
 * 本文件覆盖（全部夹具建在系统临时目录，不碰任何真实协作根）：
 * 1. 无既存根 → 保持裸拼现状（含「起点目录不存在」这一旧行为不回退的形态）；
 * 2. 任意深度子目录 → 向上命中主根（via='ancestor'）；
 * 3. 最近的祖先优先（嵌套根形态）；
 * 4. `.crosschat` 目录标记不完整（空目录）不算既存根，继续向上；
 * 5. cwd = `.crosschat` 本身 / 其子目录 → 解析到那个 `.crosschat`（via='inside-root'），
 *    不产生 `.crosschat\.crosschat`；
 * 6. 既存嵌套 `.crosschat\.crosschat` → 归并到内层，不再继续嵌套；
 * 7. 12 层上限（界内命中、界外保持裸拼）与盘符根终止（不抛错）；
 * 8. 根后建（首启窗口）→ 下次解析即被发现（「找不到」的结论不缓存）；
 * 9. resolveStateRoot（字符串出口）与带 provenance 的出口逐字段一致。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STATE_ROOT_WALK_UP_MAX_LEVELS,
  resolveStateRoot,
  resolveStateRootWithDiscovery,
} from "./paths.js";

const dirs: string[] = [];

/** 建一个空的临时目录并登记清理（每个用例独立根，互不污染）。 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 造一个「既存协作根」：<base>/.crosschat/ + registry/teams/logs 三者（全造，标记最全）。 */
function makeStateRoot(base: string): string {
  const root = join(base, ".crosschat");
  mkdirSync(join(root, "registry", "sessions"), { recursive: true });
  mkdirSync(join(root, "teams", "default"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  return root;
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理尽力而为 */
    }
  }
});

describe("v0.10.0 组 C（C1/R1/G-27）：状态根解析不再裸拼", () => {
  it("1. 无既存根（任意深度都没有）→ 保持裸拼现状", () => {
    const ws = tempDir("xc-c1-bare-");
    const sub = join(ws, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(sub);
    expect(resolution).toEqual({ root: join(sub, ".crosschat"), via: "bare", workspace: sub });
    expect(resolveStateRoot(sub)).toBe(join(sub, ".crosschat"));
  });

  it("1b. 起点目录不存在（首启前的词法路径）→ 旧行为不回退，仍裸拼", () => {
    const base = tempDir("xc-c1-missing-");
    const missing = join(base, "no-such-dir", "deeper");
    expect(existsSync(missing)).toBe(false);
    const resolution = resolveStateRootWithDiscovery(missing);
    expect(resolution.via).toBe("bare");
    expect(resolution.root).toBe(join(missing, ".crosschat"));
  });

  it("2. 任意深度子目录 → 向上命中主根（via='ancestor'，最近的祖先优先）", () => {
    const ws = tempDir("xc-c1-anc-");
    const main = makeStateRoot(ws);
    const deep = join(ws, "work", "e364-yf2451-forensics-1125", "batch");
    mkdirSync(deep, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(deep);
    expect(resolution.via).toBe("ancestor");
    expect(resolution.root).toBe(main);
    expect(resolution.workspace).toBe(deep);
    // 不产生子目录里的幻影根
    expect(existsSync(join(deep, ".crosschat"))).toBe(false);
  });

  it("2b. 同一会话三种启动方式（项目根 / 任意深度子目录 / .crosschat 本身）→ 同一主根", () => {
    const ws = tempDir("xc-c1-modes-");
    const main = makeStateRoot(ws);
    const deep = join(ws, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    const roots = [
      resolveStateRoot(ws),
      resolveStateRoot(deep),
      resolveStateRoot(main),
      resolveStateRoot(join(main, "logs")),
    ];
    for (const root of roots) expect(root).toBe(main);
  });

  it("3. 嵌套既存根 → 取最近的那个（子项目自有根不被父根吞并）", () => {
    const ws = tempDir("xc-c1-nested-");
    makeStateRoot(ws);
    const subProject = join(ws, "sub");
    const subRoot = makeStateRoot(subProject);
    const deep = join(subProject, "x", "y");
    mkdirSync(deep, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(deep);
    expect(resolution.via).toBe("ancestor");
    expect(resolution.root).toBe(subRoot);
  });

  it("4. `.crosschat` 标记不完整（空目录，无 registry/teams/logs）→ 不算既存根，继续向上", () => {
    const ws = tempDir("xc-c1-marker-");
    const main = makeStateRoot(ws);
    const mid = join(ws, "mid");
    mkdirSync(join(mid, ".crosschat"), { recursive: true }); // 空目录 = 半途残留，不可复用
    const deep = join(mid, "deep");
    mkdirSync(deep, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(deep);
    expect(resolution.via).toBe("ancestor");
    expect(resolution.root).toBe(main);
  });

  it("4b. 仅 logs 一个标记也构成既存根（registry/teams/logs 之一即可）", () => {
    const ws = tempDir("xc-c1-onelog-");
    const root = join(ws, ".crosschat");
    mkdirSync(join(root, "logs"), { recursive: true });
    const deep = join(ws, "deep");
    mkdirSync(deep, { recursive: true });
    expect(resolveStateRootWithDiscovery(deep).root).toBe(root);
  });

  it("5. cwd = `.crosschat` 本身 → 解析到它自己（不产生 .crosschat\\.crosschat 嵌套根）", () => {
    const ws = tempDir("xc-c1-inside-");
    const main = makeStateRoot(ws);
    const resolution = resolveStateRootWithDiscovery(main);
    expect(resolution.via).toBe("inside-root");
    expect(resolution.root).toBe(main);
    expect(existsSync(join(main, ".crosschat"))).toBe(false);
  });

  it("5b. cwd = `.crosschat` 的子目录 → 解析到那个 `.crosschat`（归一而非嵌套）", () => {
    const ws = tempDir("xc-c1-inside2-");
    const main = makeStateRoot(ws);
    const logs = join(main, "logs");
    mkdirSync(logs, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(logs);
    expect(resolution.via).toBe("inside-root");
    expect(resolution.root).toBe(main);
    // 日志子目录里绝不会再出现一层 .crosschat
    expect(existsSync(join(logs, ".crosschat"))).toBe(false);
  });

  it("5c. 存量嵌套根 `.crosschat\\.crosschat` → 归并到内层，不再继续嵌套", () => {
    const ws = tempDir("xc-c1-phantom-");
    const main = makeStateRoot(ws);
    const phantom = makeStateRoot(main); // main/.crosschat —— G-27 实证形态
    const insidePhantom = join(phantom, "registry", "sessions");
    mkdirSync(insidePhantom, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(insidePhantom);
    expect(resolution.via).toBe("inside-root");
    expect(resolution.root).toBe(phantom); // 最近的（内层）：不再套第三层
    expect(existsSync(join(insidePhantom, ".crosschat"))).toBe(false);
    // 外层主根本身仍可被其工作区正确解析
    expect(resolveStateRoot(ws)).toBe(main);
  });

  it("5d. 名字相近的目录（.crosschatfoo / a.crosschat）不当成状态根段", () => {
    const ws = tempDir("xc-c1-lookalike-");
    const near = join(ws, ".crosschatfoo", "x");
    mkdirSync(near, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(near);
    expect(resolution.via).toBe("bare");
    expect(resolution.root).toBe(join(near, ".crosschat"));
  });

  it("6. 12 层上限：界内命中、界外保持裸拼（到盘符根为止不抛错）", () => {
    const ws = tempDir("xc-c1-cap-");
    makeStateRoot(ws); // 唯一的根挂在 ws（= 21 层之上，超出上限）
    // 造一条 21 层链并记下每一环：chain[0]=ws, chain[1]=ws/l0, …, chain[21]=ws/l0/…/l20
    const chain: string[] = [ws];
    for (let i = 0; i <= 20; i += 1) chain.push(join(chain[chain.length - 1]!, `l${i}`));
    const deep = chain[chain.length - 1]!;
    mkdirSync(deep, { recursive: true });
    expect(STATE_ROOT_WALK_UP_MAX_LEVELS).toBe(12);

    // 根在 21 层之上 → 超出上限 → 裸拼
    const far = resolveStateRootWithDiscovery(deep);
    expect(far.via).toBe("bare");
    expect(far.root).toBe(join(deep, ".crosschat"));

    // 根恰好落在上限内（chain[11] = 自 deep 往上 10 层）→ 命中
    const near = makeStateRoot(chain[11]!);
    const hit = resolveStateRootWithDiscovery(deep);
    expect(hit.via).toBe("ancestor");
    expect(hit.root).toBe(near);

    // 更近的一环出局后，chain[10]（自 deep 往上 11 层）仍在上限内 → 命中
    rmSync(join(chain[11]!, ".crosschat"), { recursive: true, force: true });
    const inside12 = makeStateRoot(chain[10]!);
    expect(resolveStateRootWithDiscovery(deep).root).toBe(inside12);

    // 再往上一环 chain[9]（自 deep 往上 12 层）恰好出界 → 裸拼
    rmSync(join(chain[10]!, ".crosschat"), { recursive: true, force: true });
    const justOutside = makeStateRoot(chain[9]!);
    const outside = resolveStateRootWithDiscovery(deep);
    expect(outside.via).toBe("bare");
    expect(outside.root).toBe(join(deep, ".crosschat"));
    expect(existsSync(justOutside)).toBe(true); // 根确实存在，只是超出 12 层上限
  });

  it("6b. 盘符根形态不抛错（终止条件 dirname 自等）", () => {
    const resolution = resolveStateRootWithDiscovery("C:\\");
    expect(typeof resolution.root).toBe("string");
    expect(resolution.root.length).toBeGreaterThan(0);
    expect(resolution.root.toLowerCase().endsWith(".crosschat")).toBe(true);
  });

  it("7. 根后建（首启窗口先裸拼、别处随后建根）→ 下次解析即被发现（不缓存负面结论）", () => {
    const ws = tempDir("xc-c1-later-");
    const sub = join(ws, "sub");
    mkdirSync(sub, { recursive: true });
    expect(resolveStateRootWithDiscovery(sub).via).toBe("bare");
    const main = makeStateRoot(ws);
    const after = resolveStateRootWithDiscovery(sub);
    expect(after.via).toBe("ancestor");
    expect(after.root).toBe(main);
  });

  it("8. resolveStateRoot 出口与带 provenance 的出口逐字段一致（root 相同）", () => {
    const ws = tempDir("xc-c1-parity-");
    const main = makeStateRoot(ws);
    const deep = join(ws, "p", "q");
    mkdirSync(deep, { recursive: true });
    const resolution = resolveStateRootWithDiscovery(deep);
    expect(resolveStateRoot(deep)).toBe(resolution.root);
    expect(resolveStateRoot(deep)).toBe(main);
  });

  it("9. 相对工作区按进程 cwd 锚定后同样参与向上查找", () => {
    const ws = tempDir("xc-c1-rel-");
    const main = makeStateRoot(ws);
    const sub = join(ws, "relsub");
    mkdirSync(sub, { recursive: true });
    const previous = process.cwd();
    try {
      process.chdir(sub);
      const resolution = resolveStateRootWithDiscovery(".");
      expect(resolution.root).toBe(main);
      expect(resolution.via).toBe("ancestor");
    } finally {
      process.chdir(previous);
    }
  });

  it("10. 解析零写盘：任一形态都不创建 .crosschat（建根是调用方的事）", () => {
    const ws = tempDir("xc-c1-nowrite-");
    const sub = join(ws, "ro", "sub");
    mkdirSync(sub, { recursive: true });
    resolveStateRootWithDiscovery(sub);
    resolveStateRootWithDiscovery(ws);
    resolveStateRootWithDiscovery(join(ws, "ro"));
    expect(existsSync(join(ws, ".crosschat"))).toBe(false);
    expect(existsSync(join(sub, ".crosschat"))).toBe(false);
    expect(existsSync(join(ws, "ro", ".crosschat"))).toBe(false);
  });
});
