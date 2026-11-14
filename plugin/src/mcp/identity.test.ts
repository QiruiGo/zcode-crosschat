/**
 * M3 identity 单测（DESIGN §7 M3 文件清单的 *.test.ts；集成自检时补写）：
 * xc_register 双路径校验 + 连接绑定身份表。
 *
 * 覆盖（DESIGN §2.3）：
 * - hook 路径：sessions/<sid>.json 在场（任意年龄；lastSeen 超 10 分钟仅告警）；
 *   文件缺失 → session_not_anchored（wakeToken 路径是兜底，不在此重复）；
 * - 名字/sid 交叉校验：名字被其他 sid 绑定 → name_taken；sid 被其他名字绑定 →
 *   session_already_bound；
 * - wakeToken 路径：命中未过期未使用 nonce → 绑定 + 服务端代写 sessions/<sid>.json
 *   + nonce 标记 used；已用 / 不匹配 → 拒绝；
 * - 连接绑定：注册后 identityStore.get(conn) 可取回；未注册连接 require 抛
 *   not_registered；connectionKeyOf 的 stdio 缺省键。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_DIGEST,
  STALE_LASTSEEN_WARN_MS,
  connectionKeyOf,
  identityStore,
  xcRegister,
} from "./identity.js";
import { createWakeNonce, readWakeNonce, writeSession } from "../core/registry.js";
import { readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamState } from "../core/types.js";
import type { ToolError } from "./protocol.js";

let workDir: string;
let stateRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-m3-identity-"));
  stateRoot = join(workDir, ".crosschat");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 取 ToolError 的结构化负载（xcRegister 校验失败以 throw 传播）。 */
async function errorPayload(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (err) {
    return (err as ToolError).payload;
  }
  throw new Error("expected the call to reject with ToolError");
}

let connSeq = 0;
function nextConn(): string {
  connSeq += 1;
  return `conn-${connSeq}`;
}

describe("identity: hook 路径（§2.3-1/3）", () => {
  it("sessions/<sid>.json 在场 → 绑定成功并返回花名册/协议摘要", async () => {
    await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    const conn = nextConn();
    const out = await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, conn);

    expect(out.via).toBe("hook");
    expect(out.sessionKey).toBe("xc:default:a");
    expect(out.teamId).toBe("default");
    expect(out.protocolDigest).toBe(PROTOCOL_DIGEST);
    expect(out.roster.map((m) => m.key)).toEqual(["a"]);
    expect(out.warnings).toEqual([]);

    // 连接绑定生效（§2.3-2）：本连接身份可取回，require 不再抛错。
    const bound = identityStore.get(conn);
    expect(bound?.agentKey).toBe("a");
    expect(bound?.sessionId).toBe("sess-a");
    expect(identityStore.require(conn).agentKey).toBe("a");

    // team.json 已建队，首个注册者是 founder（§2.2）。
    const team = JSON.parse(await readFile(join(stateRoot, "teams", "default", "team.json"), "utf8")) as {
      founderKey: string;
      members: Array<{ key: string; sessionId: string; role: string }>;
    };
    expect(team.founderKey).toBe("a");
    expect(team.members[0]).toMatchObject({ key: "a", sessionId: "sess-a", role: "peer" });

    // names.json 已绑名。
    const names = JSON.parse(await readFile(join(stateRoot, "registry", "names.json"), "utf8")) as {
      a: { sessionId: string };
    };
    expect(names.a.sessionId).toBe("sess-a");
  });

  it("sessions/<sid>.json 缺失 → session_not_anchored（结构化拒绝）", async () => {
    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-ghost" }, nextConn()),
    );
    expect(payload.error).toBe("session_not_anchored");
    expect(payload.sessionId).toBe("sess-ghost");
  });

  it("lastSeen 超 10 分钟 → 仅告警不拒绝（§2.3-3）", async () => {
    await writeSession(stateRoot, {
      sessionId: "sess-old",
      cwd: workDir,
      startedAt: Date.now() - STALE_LASTSEEN_WARN_MS - 60_000,
      lastSeen: Date.now() - STALE_LASTSEEN_WARN_MS - 60_000,
    });
    const out = await xcRegister(stateRoot, { name: "old", sessionId: "sess-old" }, nextConn());
    expect(out.via).toBe("hook");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/lastSeen/);
  });

  it("名字被其他 sid 绑定 → name_taken；sid 被其他名字绑定 → session_already_bound", async () => {
    await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await writeSession(stateRoot, { sessionId: "sess-b", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn());

    const nameTaken = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-b" }, nextConn()),
    );
    expect(nameTaken.error).toBe("name_taken");

    const sidTaken = await errorPayload(() =>
      xcRegister(stateRoot, { name: "b", sessionId: "sess-a" }, nextConn()),
    );
    expect(sidTaken.error).toBe("session_already_bound");
  });
});

describe("identity: wakeToken 路径（§2.3-4）", () => {
  it("nonce 命中 → 绑定 + 服务端代写 sessions/<sid>.json + nonce 标记 used", async () => {
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "a", sid: "sess-w" });
    const conn = nextConn();
    const out = await xcRegister(stateRoot, { name: "a", sessionId: "sess-w", wakeToken: token }, conn);

    expect(out.via).toBe("wake");
    expect(identityStore.get(conn)?.agentKey).toBe("a");
    // 服务端代写（不依赖钩子落盘）。
    expect(existsSync(join(stateRoot, "registry", "sessions", "sess-w.json"))).toBe(true);
    // nonce 一次性：已标记 used。
    const nonce = await readWakeNonce(stateRoot, token);
    expect(nonce?.used).toBe(true);
  });

  it("已用 nonce → invalid_params；不匹配的 sid → invalid_params；未知 token → invalid_params", async () => {
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "a", sid: "sess-w" });
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-w", wakeToken: token }, nextConn());

    const reused = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-w", wakeToken: token }, nextConn()),
    );
    expect(reused.error).toBe("invalid_params");

    const { token: fresh } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "b", sid: "sess-x" });
    const mismatch = await errorPayload(() =>
      xcRegister(stateRoot, { name: "b", sessionId: "sess-OTHER", wakeToken: fresh }, nextConn()),
    );
    expect(mismatch.error).toBe("invalid_params");

    const unknown = await errorPayload(() =>
      xcRegister(stateRoot, { name: "c", sessionId: "sess-y", wakeToken: "no-such-token" }, nextConn()),
    );
    expect(unknown.error).toBe("invalid_params");
  });
});

describe("identity: 连接键与未注册拒绝", () => {
  it("connectionKeyOf：SDK extra 缺 sessionId → __stdio__ 常量键", () => {
    expect(connectionKeyOf(undefined)).toBe("__stdio__");
    expect(connectionKeyOf({})).toBe("__stdio__");
    expect(connectionKeyOf({ sessionId: "sdk-sid" })).toBe("sdk-sid");
  });

  it("未注册连接 require → not_registered（结构化错误）", () => {
    try {
      identityStore.require("never-registered");
      throw new Error("expected require to throw");
    } catch (err) {
      expect((err as ToolError).payload.error).toBe("not_registered");
    }
  });
});

// ---------------------------------------------------------------------------
// v0.2（DESIGN-V0.2 §7.4-I5/§9.1-W5）：removed 成员的注册路径拒绝。
// 重供给流（xc_member_add 同名重调）会先把 roster state 置回 provisioning 再发
// 欢迎 prompt，故 provisioning 态注册不受此门影响。
// ---------------------------------------------------------------------------

async function setMemberState(stateRoot: string, key: string, state: "removed" | "provisioning"): Promise<void> {
  const team = (await readTeam(stateRoot, "default")) as TeamState;
  const member = team.members.find((m) => m.key === key);
  if (!member) throw new Error(`member ${key} not in roster`);
  member.state = state;
  await writeTeam(stateRoot, team);
}

describe("identity: removed 成员注册拒绝（v0.2 §7.4-I5）", () => {
  it("hook 路径：roster 中 removed 成员 → member_removed（先于 session 校验语义照常报锚错误则不受影响）", async () => {
    await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn());
    await setMemberState(stateRoot, "a", "removed");

    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn()),
    );
    expect(payload.error).toBe("member_removed");
    expect(payload.name).toBe("a");
  });

  it("wake 路径：removed 成员 → member_removed 且 nonce 不被消费（不给 stopped 会话烧令牌）", async () => {
    await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn());
    await setMemberState(stateRoot, "a", "removed");
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "a", sid: "sess-a2" });

    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "a", sessionId: "sess-a2", wakeToken: token }, nextConn()),
    );
    expect(payload.error).toBe("member_removed");
    const nonce = await readWakeNonce(stateRoot, token);
    expect(nonce?.used).toBeUndefined(); // 未消费
  });

  it("provisioning / 无 state（v0.1.0 旧记录）→ 注册照常通过（重供给与 peer 兼容不破门）", async () => {
    await writeSession(stateRoot, { sessionId: "sess-a", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn());

    await setMemberState(stateRoot, "a", "provisioning");
    const conn = nextConn();
    const ok1 = await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, conn);
    expect(ok1.via).toBe("hook");

    // 回到 legacy（无 state）：手工写回 team.json，去掉 state 字段。
    const raw = JSON.parse(await readFile(join(stateRoot, "teams", "default", "team.json"), "utf8")) as {
      members: Array<{ key: string; state?: string }>;
    };
    for (const m of raw.members) delete m.state;
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(stateRoot, "teams", "default", "team.json"), JSON.stringify(raw, null, 2), "utf8"),
    );
    const ok2 = await xcRegister(stateRoot, { name: "a", sessionId: "sess-a" }, nextConn());
    expect(ok2.via).toBe("hook");
  });
});

// v0.5.1（BND-5 回归）：xc_register 接受保留名 lead/default 的双路径不一致。
// 红队原始复现（adjudication.md #5 / cases.md C-4）：xc_register{name:"default"}
// 与 {name:"lead"} 均成功入册，而 xc_member_add 同名硬拒 name_reserved；
// xc_lead_transfer{to:"lead"} 把 lead 角色授予字面成员。修复后与 member_add
// 同一规则（RESERVED_MEMBER_KEYS 唯一定义处 core/types.ts），锁外快拒、
// 零副作用（names.json / team.json 不落）。
// v0.6.1（红队四番战 安全对-5 修复）：保留名表扩为两轴并集——队内轴此前只保留
// lead/default，peer 轴保留集（main/team-lead/user/system）可注册进队内花名册。
describe("identity: 保留名注册拒绝（BND-5 + 安全对-5，与 xc_member_add/peer 轴规则统一）", () => {
  it("hook 路径：name=default / lead → name_reserved（错误信封与 member_add 同码）", async () => {
    for (const name of ["default", "lead"]) {
      const payload = await errorPayload(() =>
        xcRegister(stateRoot, { name, sessionId: "sess-a" }, nextConn()),
      );
      expect(payload.error).toBe("name_reserved");
      expect(payload.name).toBe(name);
      expect(payload.message).toContain(`member name "${name}" is reserved (lead/default/main/team-lead/user/system)`);
    }
  });

  it("peer 轴保留集（system/user/main/team-lead）同样拒（两轴一致，安全对-5）", async () => {
    for (const name of ["system", "user", "main", "team-lead"]) {
      const payload = await errorPayload(() =>
        xcRegister(stateRoot, { name, sessionId: "sess-a" }, nextConn()),
      );
      expect(payload.error).toBe("name_reserved");
      expect(payload.name).toBe(name);
    }
    // 零副作用：保留名拒尽后花名册不落盘。
    expect(existsSync(join(stateRoot, "registry", "names.json"))).toBe(false);
    expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);
  });

  it("先于锚定/绑定校验：无 session 记录也报 name_reserved（锁外快拒，与 member_add 同位）", async () => {
    // 不写 sessions/<sid>.json：若保留名闸缺席，此调用会以 session_not_anchored 失败。
    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "default", sessionId: "sess-no-anchor" }, nextConn()),
    );
    expect(payload.error).toBe("name_reserved");
  });

  it("wake 路径同样拒绝且 nonce 不被消费（不给旁路烧令牌）", async () => {
    // 手工放一枚合法 nonce：agentKey=lead、sid 匹配——闸缺席时它会走通绑定。
    const { token } = await createWakeNonce(stateRoot, { teamId: "default", agentKey: "lead", sid: "sess-w" });
    const payload = await errorPayload(() =>
      xcRegister(stateRoot, { name: "lead", sessionId: "sess-w", wakeToken: token }, nextConn()),
    );
    expect(payload.error).toBe("name_reserved");
    const nonce = await readWakeNonce(stateRoot, token);
    expect(nonce?.used).toBeUndefined(); // 未消费
  });

  it("零副作用：names.json / team.json 不落盘、花名册不增（对照：非保留名照常入册）", async () => {
    for (const name of ["default", "lead"]) {
      const payload = await errorPayload(() =>
        xcRegister(stateRoot, { name, sessionId: `sess-${name}` }, nextConn()),
      );
      expect(payload.error).toBe("name_reserved");
    }
    expect(existsSync(join(stateRoot, "registry", "names.json"))).toBe(false);
    expect(existsSync(join(stateRoot, "teams", "default", "team.json"))).toBe(false);

    // 大小写归一后命中保留名同样拒（sanitizeKey → 小写）。
    const upper = await errorPayload(() =>
      xcRegister(stateRoot, { name: "LEAD", sessionId: "sess-upper" }, nextConn()),
    );
    expect(upper.error).toBe("name_reserved");

    // 对照：普通名字仍可注册（修复不误伤正常路径）。
    await writeSession(stateRoot, { sessionId: "sess-ok", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    const ok = await xcRegister(stateRoot, { name: "a", sessionId: "sess-ok" }, nextConn());
    expect(ok.roster.map((m) => m.key)).toEqual(["a"]);
  });
});

// ─────────────────────────── v0.5.3（A11 修复）：同形字花名注册闸 ───────────────────────────

// ─────────────────── v0.6.1（红队四番战 安全对-2 修复）：同形字花名严格拒绝 ───────────────────
//
// 策略变更（supersedes v0.5.3 A11 的「折叠到同一把 name_taken 闸」）：
// A11 把同形写法归一到真名键，靠 name_taken 挡**后到**的攻击者；但攻击者
// **先到**时反而能抢占真名、锁死真人、把派给真人的任务重定向到自己邮箱
// （adjudication.md 安全对-2，P1：squatter 先注册 Ａｌｉｃｅ → 真人 alice 得
// name_taken，敏感任务落入 squatter 箱）。且 peer 轴对同一手法一直是严格正则
// 直接拒（invalid-name），队内轴静默收纳=两轴不一致。修复=队内轴同一道闸：
// 会被 sanitizeKey 静默归一到碰撞键的写法，注册时直接 invalid_name 拒，
// 零副作用（names.json / team.json 不落）。
describe("identity: 同形字/全角花名严格拒绝（v0.6.1 安全对-2；supersedes v0.5.3 A11 折叠策略）", () => {
  it("adj052 A11 攻击重放（先到顺序）：viсtim（с=U+0441）注册 → invalid_name，花名册零残留", async () => {
    await writeSession(stateRoot, { sessionId: "sess-victim", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await writeSession(stateRoot, { sessionId: "sess-homoglyph", cwd: workDir, startedAt: 1, lastSeen: Date.now() });

    const homoglyph = `vi${String.fromCodePoint(0x0441)}tim`; // viсtim
    const refused = await errorPayload(() =>
      xcRegister(stateRoot, { name: homoglyph, sessionId: "sess-homoglyph" }, nextConn()),
    );
    expect(refused.error).toBe("invalid_name");
    expect(refused.message).toContain("silently normalized");

    // 真人此时注册 victim 不受任何影响（修复前 squatter 先到会锁死真人）。
    const ok = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-victim" }, nextConn());
    expect(ok.sessionKey).toBe("xc:default:victim");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key).sort()).toEqual(["victim"]);
  });

  it("全角同形（ｖｉｃｔｉｍ）先到也拒；随后真人 victim 正常注册", async () => {
    await writeSession(stateRoot, { sessionId: "sess-f", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await writeSession(stateRoot, { sessionId: "sess-v", cwd: workDir, startedAt: 1, lastSeen: Date.now() });

    const fullwidth = String.fromCodePoint(0xff56, 0xff49, 0xff43, 0xff54, 0xff49, 0xff4d);
    const refused = await errorPayload(() =>
      xcRegister(stateRoot, { name: fullwidth, sessionId: "sess-f" }, nextConn()),
    );
    expect(refused.error).toBe("invalid_name");

    // 真人照常注册成功（严格闸只拒碰撞写法，不扩大化）。
    const ok = await xcRegister(stateRoot, { name: "victim", sessionId: "sess-v" }, nextConn());
    expect(ok.sessionKey).toBe("xc:default:victim");
  });

  it("规范键形的 Unicode 名字（CJK/带音调）保持合法可读（sanitize.ts 模块头纪律不破）", async () => {
    await writeSession(stateRoot, { sessionId: "sess-x", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    await writeSession(stateRoot, { sessionId: "sess-y", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    const xiaoming = await xcRegister(stateRoot, { name: "小明", sessionId: "sess-x" }, nextConn());
    expect(xiaoming.sessionKey).toBe("xc:default:小明");
    const cafe = await xcRegister(stateRoot, { name: "café", sessionId: "sess-y" }, nextConn());
    expect(cafe.sessionKey).toBe("xc:default:café");
  });

  it("路径符/控制符/空白/下划线/连续连字符等碰撞写法一律 invalid_name", async () => {
    await writeSession(stateRoot, { sessionId: "sess-p", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    for (const bad of ["a/b", "a\\b", "..", "a.b", "a b", "a\u0001b", "a_b", "a--b", "-a", "a-", "!!!"]) {
      const refused = await errorPayload(() =>
        xcRegister(stateRoot, { name: bad, sessionId: "sess-p" }, nextConn()),
      );
      expect(refused.error, `name ${JSON.stringify(bad)} must be refused`).toBe("invalid_name");
    }
    // 对照：同一 sid 的规范写法照常注册。
    const ok = await xcRegister(stateRoot, { name: "a-b", sessionId: "sess-p" }, nextConn());
    expect(ok.sessionKey).toBe("xc:default:a-b");
  });

  it("超长名 → name_too_long（键长上限 48；不再静默截断+摘要）", async () => {
    await writeSession(stateRoot, { sessionId: "sess-l", cwd: workDir, startedAt: 1, lastSeen: Date.now() });
    const refused = await errorPayload(() =>
      xcRegister(stateRoot, { name: "x".repeat(49), sessionId: "sess-l" }, nextConn()),
    );
    expect(refused.error).toBe("name_too_long");
    const ok = await xcRegister(stateRoot, { name: "x".repeat(48), sessionId: "sess-l" }, nextConn());
    expect(ok.sessionKey).toBe(`xc:default:${"x".repeat(48)}`);
  });
});
