/**
 * 红队四番战 边界-1（P1）修复回归单测：lead/founder 改名时 key 随动。
 *
 * 漏洞（裁决 b123.mjs 复现）：A xc_team{init}（leadKey=ld-a）后清箱改名
 * ld-a → ld-a2，队内花名换绑成功但 team.json 的 leadKey/founderKey 仍指向
 * "ld-a"——悬空。A 的 transfer/release 全得 not_lead，B 的 init 得
 * lead_exists(sessionId:null)：现任 lead 被锁死在角色操作之外，只能靠
 * takeover 恢复。
 *
 * 修复（tools-identify.ts 改名路径）：成员 key 换绑时 leadKey/founderKey 同步
 * 改写为 newKey（角色跟随会话本人，不改变 lead 归属语义）；改名被「板面不干净」
 * 守卫阻止时一律不动键。
 *
 * v0.7.1（红队四番战 边界-6 修复）：板面不干净时不再做「队内拒 + peer 改名」的
 * 半边改名，改为两轴原子的显式 `team_rename_blocked`（见下方该用例）。
 *
 * 驱动方式：白盒播种 team.json + identityStore（lead-tools.test.ts 同模式），
 * 改名走 handleIdentify 真路径（peer 轴无会话上下文 → 只改队内轴），角色操作走
 * createLeadToolCore 真路径；XC_MESSAGING_DIR 钉临时目录。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadOf } from "./protocol.js";
import { handleIdentify } from "./tools-identify.js";
import { createLeadToolCore, type LeadToolCore } from "./tools-team.js";
import { identityStore } from "./identity.js";
import { resetPeerServicesForTests } from "./peer-services.js";
import { engineLogFile } from "../core/paths.js";
import { makeTask, newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import type { TeamMember, TeamState } from "../core/types.js";
import type { ToolDeps } from "./core.js";

let workDir: string;
let stateRoot: string;
let deps: ToolDeps;
let lead: LeadToolCore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xc-lead-rename-"));
  stateRoot = join(workDir, ".crosschat");
  deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, "peers-root"), XC_WAKE_ENABLED: "false" } };
  lead = createLeadToolCore(deps);
  resetPeerServicesForTests();
});

afterEach(async () => {
  identityStore.bind("__discard__", {
    sessionKey: "__discard__",
    teamId: "default",
    name: "ghost",
    agentKey: "ghost",
    sessionId: "sess-ghost",
    role: "peer",
    boundAt: Date.now(),
  });
  resetPeerServicesForTests();
  await rm(workDir, { recursive: true, force: true });
});

function member(key: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key,
    sessionId: `sess-${key}`,
    role: "peer",
    joinedAt: 1,
    lastSeen: 1,
    ...overrides,
  };
}

/** 播种一版 team.json（founder=a；可指定 leadKey / 额外成员 / 带 createdBy=a 的任务）。 */
async function seedTeam(options: { leadKey?: string; members?: TeamMember[]; withTaskFromA?: boolean } = {}): Promise<TeamState> {
  const team = newTeamState({ teamId: "default", name: "default", founderKey: "a", founder: member("a"), now: 1 });
  for (const extra of options.members ?? [member("b")]) {
    if (extra.key !== "a") team.members.push(extra);
  }
  if (options.leadKey !== undefined) team.leadKey = options.leadKey;
  if (options.withTaskFromA === true) makeTask(team, { title: "t", prompt: "p", createdBy: "a" }, 1);
  await writeTeam(stateRoot, team);
  return team;
}

/** 绑定一个连接身份（改名路径要求 identityStore 已有绑定）。 */
function bind(name: string): string {
  const conn = `conn-${name}`;
  identityStore.bind(conn, {
    sessionKey: `xc:default:${name}`,
    teamId: "default",
    name,
    agentKey: name,
    sessionId: `sess-${name}`,
    role: "peer",
    boundAt: Date.now(),
  });
  return conn;
}

/** 走真改名路径（handleIdentify 的 T1 #4 分支；peer 轴无上下文 → 只改队内轴）。 */
async function rename(conn: string, from: string, to: string) {
  return handleIdentify(deps, { name: to, sessionId: `sess-${from}` }, conn);
}

async function engineEvents(): Promise<Array<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await readFile(engineLogFile(stateRoot), "utf8");
  } catch {
    return []; // 一条审计都没落（例：改名被守卫阻止、零副作用路径）
  }
  return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("红队四番战 边界-1（P1）：lead/founder 改名 key 随动", () => {
  it("lead 改名 → leadKey/founderKey 随动；transfer/release/init 不被锁死", async () => {
    await seedTeam({ leadKey: "a", members: [member("b")] });
    const connA = bind("a");
    bind("b");

    const res = await rename(connA, "a", "a2");
    expect(res.isError).toBeFalsy();
    expect(String(res.content[0]?.text)).toContain('leadKey/founderKey updated to "a2"');

    // 悬空消除：花名册、leadKey、founderKey 三者一致。
    let team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["a2", "b"]);
    expect(team.leadKey).toBe("a2");
    expect(team.founderKey).toBe("a2");

    // 现任 lead（改名后）transfer 成功（修复前 not_lead）。
    const transfer = await lead.xc_lead_transfer({ to: "b" }, connA);
    expect(transfer.isError).toBeFalsy();
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBe("b");

    // 新 lead release 成功；随后任何人 init 都是空位认领（不得 lead_exists 锁死）。
    const release = await lead.xc_lead_release({}, "conn-b");
    expect(release.isError).toBeFalsy();
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey).toBeUndefined();

    const init = await lead.xc_team_init({}, connA);
    expect(init.isError).toBeFalsy();
    expect(payloadOf(init)["leadKey"]).toBe("a2");
    const bInit = await lead.xc_team_init({}, "conn-b");
    expect(bInit.isError).toBe(true);
    expect(payloadOf(bInit)["error"]).toBe("lead_exists");
    // R-1 载荷：现任 lead 的 sessionId 可解析（修复前是 null——悬空）。
    expect(payloadOf(bInit)["sessionId"]).toBe("sess-a");
  });

  it("founder（无显式 lead）改名 → founderKey 随动；idle 收件人与 init 不悬空", async () => {
    await seedTeam({ members: [member("b")] }); // 无 leadKey：founder 兜底
    const connA = bind("a");
    bind("b");

    const res = await rename(connA, "a", "a2");
    expect(res.isError).toBeFalsy();
    let team = (await readTeam(stateRoot, "default"))!;
    expect(team.founderKey).toBe("a2");
    expect(team.leadKey).toBeUndefined();

    // founder 兜底链：改名后的 founder 仍可自任 lead（成员 add 的隐式物化路径同）。
    const init = await lead.xc_team_init({}, connA);
    expect(init.isError).toBeFalsy();
    expect(payloadOf(init)["leadKey"]).toBe("a2");

    // 他人不得抢 second lead（修复前 founderKey 悬空时该闸仍不误放，此处锁死行为）。
    const bInit = await lead.xc_team_init({}, "conn-b");
    expect(bInit.isError).toBe(true);
    expect(payloadOf(bInit)["error"]).toBe("lead_exists");

    // idle 收件人解析（leadKey ?? founderKey）指向真实成员。
    team = (await readTeam(stateRoot, "default"))!;
    expect(team.leadKey ?? team.founderKey).toBe("a2");
    expect(team.members.some((m) => m.key === (team.leadKey ?? team.founderKey))).toBe(true);
  });

  it("普通成员改名 → leadKey/founderKey 不动", async () => {
    await seedTeam({ leadKey: "a", members: [member("b")] });
    bind("a");
    const connB = bind("b");

    const res = await rename(connB, "b", "b2");
    expect(res.isError).toBeFalsy();
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["a", "b2"]);
    expect(team.leadKey).toBe("a");
    expect(team.founderKey).toBe("a");
  });

  // v0.7.1（红队四番战 边界-6 修复）：语义变更——板面不干净时改名**两轴原子**：
  // 显式 team_rename_blocked 错误、peer 轴也不改名（修复前是成功回执
  // `renamed:{peer:true,team:false}`，同一会话留下队内旧名 + peer 新名两个身份，
  // 红队 b678/g3-b6 复放：`xc_dispatch{to:"tm-b2"}` → not_a_member）。
  it("板面不干净（task 引用）→ team_rename_blocked，两轴都不动、键一律不动（边界-6）", async () => {
    await seedTeam({ leadKey: "a", members: [member("b")], withTaskFromA: true });
    const connA = bind("a");

    const res = await rename(connA, "a", "a2");
    const payload = payloadOf(res);
    // 显式错误而非「半边改名」的成功回执。
    expect(res.isError).toBe(true);
    expect(payload["error"]).toBe("team_rename_blocked");
    expect((payload["renamed"] as Record<string, unknown>)).toEqual({ peer: false, team: false });
    expect(String(payload["reason"])).toContain("task references");
    expect(String(res.content[0]?.text)).toContain("BOTH axes");
    // 队内轴未换绑：花名册与 lead/founder 全部保持旧键。
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["a", "b"]);
    expect(team.leadKey).toBe("a");
    expect(team.founderKey).toBe("a");
    // 连接身份也没被改写（修复前 identityStore 已换成新键）。
    expect(identityStore.get(connA)?.agentKey).toBe("a");
    // 没有任何 register-renamed 审计（没发生改名）。
    expect((await engineEvents()).some((e) => e["event"] === "register-renamed")).toBe(false);
  });

  it("邮箱非空同样触发 team_rename_blocked（另一条守卫理由，同原子语义）", async () => {
    await seedTeam({ leadKey: "a", members: [member("b")] });
    const connA = bind("a");
    // 给 a 的邮箱写一条消息（readMailbox 非空 → 板面不干净）。
    const { appendMailbox, createMessage } = await import("../core/mailbox.js");
    await appendMailbox(stateRoot, "default", "a", createMessage("b", "a", "hello", {}));

    const res = await rename(connA, "a", "a2");
    expect(res.isError).toBe(true);
    expect(payloadOf(res)["error"]).toBe("team_rename_blocked");
    expect(String(payloadOf(res)["reason"])).toContain("mailbox");
    const team = (await readTeam(stateRoot, "default"))!;
    expect(team.members.map((m) => m.key)).toEqual(["a", "b"]);
    expect(team.leadKey).toBe("a");
  });

  it("审计面：register-renamed 披露 leadKeyFollowed/founderKeyFollowed", async () => {
    await seedTeam({ leadKey: "a", members: [member("b")] });
    const connA = bind("a");
    const connB = bind("b");

    await rename(connA, "a", "a2");
    const renamed = (await engineEvents()).find((e) => e["event"] === "register-renamed");
    expect(renamed).toBeDefined();
    expect(renamed!["from"]).toBe("a");
    expect(renamed!["to"]).toBe("a2");
    expect(renamed!["leadKeyFollowed"]).toBe(true);
    expect(renamed!["founderKeyFollowed"]).toBe(true);

    // 普通成员改名不带跟随标记。
    await rename(connB, "b", "b2");
    const renamed2 = (await engineEvents()).filter((e) => e["event"] === "register-renamed").at(-1);
    expect(renamed2!["leadKeyFollowed"]).toBeUndefined();
    expect(renamed2!["founderKeyFollowed"]).toBeUndefined();
  });
});
