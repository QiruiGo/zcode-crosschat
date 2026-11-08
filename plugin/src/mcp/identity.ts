/**
 * M3 identity：连接绑定身份表 + xc_register 双路径校验（DESIGN.md §2.3、§2.7-3）。
 *
 * 身份模型（§2.3）：
 * - 身份绑定在 stdio 连接上，不绑进程：stdio 一条连接=一个客户端会话；无头回合
 *   每次 --resume 都是新连接（= 新的 MCP server 进程），因此每个被驱动的回合都
 *   必须重新注册。绑定随连接消亡 = 随进程消亡，模块级单例即连接级（V8 两种结果
 *   都成立；Map 结构为未来 HTTP 形态预留 per-session 键）。
 * - 路径 1（hook 锚定）：registry/sessions/<sid>.json 存在（任意年龄；lastSeen
 *   超 10 分钟仅告警不拒绝）∧ 名字未被其他 sid 绑定 ∧ sid 未被其他名字绑定。
 * - 路径 2（wakeToken 回退）：registry/wake/<nonce>.json 命中未过期未使用且
 *   {teamId, agentKey, sid} 匹配 → 直接绑定（允许覆盖同名旧绑定：无头回合身份以
 *   nonce 为准），并由服务端代写 sessions/<sid>.json（消除对钩子落盘的依赖），
 *   nonce 标记 used（M1 consumeWakeNonce）。
 * - 锁序全局固定：registry → team（§2.7-3）。xc_register 是唯一同时持两把锁的
 *   路径，直接用 M1 的 withRegistryThenTeamLocks（先 registry 绑名、后 team 入队；
 *   join 失败经 unbindName 回滚绑名——M1 专门为回滚设计的条件删除）。
 *
 * 锁超时：M1 抛 LockBusyError（toStructured() = {error:"busy", lock}），由
 * tools.ts 的 runCore 统一映射成结构化错误信封。
 */

import { createHash } from "node:crypto";
import { invalidParamsError, notRegisteredError, ToolError } from "./protocol.js";
import { withRegistryThenTeamLocks } from "../core/lock.js";
import { sanitizeKey } from "../core/sanitize.js";
import {
  WAKE_INFLIGHT_MS,
  bindName,
  consumeWakeNonce,
  readNames,
  readSession,
  readWakeNonce,
  unbindName,
  writeSession,
} from "../core/registry.js";
import { newTeamState, readTeam, writeTeam } from "../core/teamstate.js";
import { logEngineEvent } from "../core/log.js";
import { DEFAULT_TEAM_ID } from "../core/types.js";
import type { MemberRole, TeamMember, TeamState } from "../core/types.js";

export { DEFAULT_TEAM_ID };

/** hook 路径 lastSeen 新鲜度：超 10 分钟仅告警不拒绝（DESIGN §2.3-3）。 */
export const STALE_LASTSEEN_WARN_MS = 10 * 60 * 1000;

/**
 * 协议摘要：对协议要素的规范串做 sha256 截断，xc_register 返回给调用方，
 * 让两端可核对各自理解的协议一致（DESIGN §2.8 返回字段 protocolDigest）。
 */
const PROTOCOL_CANON = [
  "zcode-crosschat/1",
  "mailbox=inbox/<agentKey>.jsonl",
  "transitions=pending>claimed|cancelled;claimed>in_progress|failed|cancelled;in_progress>completed|failed|cancelled;terminal=no-out-edge",
  "attempt=capability-token;report-requires-current-attempt",
  "evidence>=1+sha256-on-completion",
].join(";");
export const PROTOCOL_DIGEST = createHash("sha256").update(PROTOCOL_CANON).digest("hex").slice(0, 12);

/** 已绑定到某条连接的身份（§2.3-2）。 */
export interface BoundIdentity {
  sessionKey: string;
  teamId: string;
  name: string;
  agentKey: string;
  sessionId: string;
  role: MemberRole;
  boundAt: number;
}

/**
 * 连接绑定身份表。stdio 形态下一个进程=一条连接，模块单例即连接绑定；
 * Map 键取 SDK extra.sessionId（stdio 下 undefined → 常量键），为 HTTP 预留。
 */
export class IdentityStore {
  readonly #byConnection = new Map<string, BoundIdentity>();

  bind(connectionKey: string, identity: BoundIdentity): void {
    this.#byConnection.set(connectionKey, identity);
  }

  get(connectionKey: string): BoundIdentity | undefined {
    return this.#byConnection.get(connectionKey);
  }

  /** 身份类工具入口：未注册连接一律硬拒（§2.8）。 */
  require(connectionKey: string): BoundIdentity {
    const bound = this.#byConnection.get(connectionKey);
    if (!bound) throw notRegisteredError();
    return bound;
  }
}

/** 进程级单例：stdio 下一进程=一连接（见类注释，DESIGN §2.3-2）。 */
export const identityStore = new IdentityStore();

/** 从 SDK 请求 extra 提取连接键（stdio：undefined → "__stdio__"）。 */
export function connectionKeyOf(extra: { sessionId?: string } | undefined): string {
  return extra?.sessionId ?? "__stdio__";
}

export interface RegisterArgs {
  name: string;
  sessionId: string;
  role?: MemberRole;
  wakeToken?: string;
}

export interface RegisterOutcome {
  sessionKey: string;
  teamId: string;
  roster: TeamMember[];
  protocolDigest: string;
  warnings: string[];
  via: "hook" | "wake";
}

/**
 * xc_register 主体（双路径校验 + join default team）。
 * 成功后由本函数把身份绑定到 connectionKey（§2.3-2：校验通过即绑定）。
 * 抛出的 LockBusyError 由 tools.ts runCore 映射为 {error:"busy"} 信封。
 */
export async function xcRegister(
  stateRoot: string,
  args: RegisterArgs,
  connectionKey: string,
): Promise<RegisterOutcome> {
  const name = args.name.trim();
  if (!name) throw invalidParamsError("name is required");
  const agentKey = sanitizeKey(name);
  if (!agentKey) {
    throw invalidParamsError(`name ${JSON.stringify(name)} sanitizes to an empty key`);
  }
  const sessionId = args.sessionId.trim();
  if (!sessionId) throw invalidParamsError("sessionId is required");
  const role: MemberRole = args.role ?? "peer";
  const teamId = DEFAULT_TEAM_ID;

  // 锁序 registry → team（§2.7-3）：M1 组合锁一次持有两把，整个校验+绑定+入队在其内。
  return withRegistryThenTeamLocks(stateRoot, teamId, async () => {
    const now = Date.now();
    const warnings: string[] = [];
    let via: "hook" | "wake";

    if (args.wakeToken !== undefined && args.wakeToken.trim() !== "") {
      // ---- 路径 2：wakeToken 回退（§2.3-4）----
      via = "wake";
      const nonce = args.wakeToken.trim();
      // 先读一次以给出精确错误（unknown/used/expired/mismatch），再原子消费。
      const stored = await readWakeNonce(stateRoot, nonce);
      if (stored === undefined) throw invalidParamsError(`wakeToken "${nonce}" is unknown`);
      if (stored.used === true) throw invalidParamsError(`wakeToken "${nonce}" was already used`);
      if (now - stored.ts > WAKE_INFLIGHT_MS) {
        throw invalidParamsError(`wakeToken "${nonce}" expired (TTL ${WAKE_INFLIGHT_MS} ms)`);
      }
      if (stored.agentKey !== agentKey || stored.sid !== sessionId) {
        throw invalidParamsError("wakeToken does not match this name/sessionId");
      }
      const consumed = await consumeWakeNonce(stateRoot, nonce, { teamId, agentKey, sid: sessionId }, now);
      if (consumed === undefined) throw invalidParamsError(`wakeToken "${nonce}" is no longer usable`);
      // 服务端代写 sessions/<sid>.json：wakeToken 路径不依赖钩子落盘（§2.3-4 ②）。
      const record = { sessionId, cwd: process.cwd(), startedAt: now, lastSeen: now, boundName: agentKey };
      await writeSession(stateRoot, record);
    } else {
      // ---- 路径 1：hook 锚定（§2.3-1/3）----
      via = "hook";
      const sess = await readSession(stateRoot, sessionId);
      if (sess === undefined) {
        throw new ToolError({
          error: "session_not_anchored",
          sessionId,
          message:
            `no session record for "${sessionId}": the SessionStart hook did not anchor this session; ` +
            "use a wakeToken (headless rounds) or verify the hook ran",
        });
      }
      const ageMs = now - sess.lastSeen;
      if (ageMs > STALE_LASTSEEN_WARN_MS) {
        warnings.push(`session lastSeen is ${Math.round(ageMs / 60000)}m old (warn only, not rejected)`);
      }
    }

    // 名字/sid 交叉校验（§2.3-3）：名字未被其他 sid 绑定；sid 未被其他名字绑定。
    // wake 路径允许覆盖同名旧绑定（无头回合身份以 nonce 为准，§2.3-4）。
    const names = await readNames(stateRoot);
    const existingBinding = names[agentKey];
    if (existingBinding && existingBinding.sessionId !== sessionId && via !== "wake") {
      throw new ToolError({
        error: "name_taken",
        name: agentKey,
        boundSessionId: existingBinding.sessionId,
        message: `name "${agentKey}" is already bound to session "${existingBinding.sessionId}"`,
      });
    }
    const conflicting = Object.entries(names).find(
      ([otherName, binding]) => otherName !== agentKey && binding.sessionId === sessionId,
    );
    if (conflicting) {
      throw new ToolError({
        error: "session_already_bound",
        sessionId,
        boundName: conflicting[0],
        message: `session "${sessionId}" is already bound to name "${conflicting[0]}"`,
      });
    }

    // 先绑名（registry），后 team 入队；入队失败经 unbindName 回滚（§2.7-3 原顺序）。
    await bindName(stateRoot, agentKey, { sessionId, role, registeredAt: now });
    let team: TeamState;
    try {
      team = await joinTeam(stateRoot, teamId, agentKey, sessionId, role, now);
    } catch (err) {
      await unbindName(stateRoot, agentKey, sessionId); // 条件回滚：仍指向本 sid 才删
      throw err;
    }

    const sessionKey = `xc:${teamId}:${agentKey}`;
    identityStore.bind(connectionKey, {
      sessionKey,
      teamId,
      name,
      agentKey,
      sessionId,
      role,
      boundAt: now,
    });

    await logEngineEvent(stateRoot, {
      event: "register",
      teamId,
      agentKey,
      sessionId,
      via,
      warnings: warnings.length,
    });

    return {
      sessionKey,
      teamId,
      roster: team.members,
      protocolDigest: PROTOCOL_DIGEST,
      warnings,
      via,
    };
  });
}

/** team 入队：不存在则建队（首个注册者=founderKey，§2.2）；存在则 upsert 成员。 */
async function joinTeam(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  sessionId: string,
  role: MemberRole,
  now: number,
): Promise<TeamState> {
  const found = await readTeam(stateRoot, teamId);
  if (found === undefined) {
    const member: TeamMember = { key: agentKey, sessionId, role, joinedAt: now, lastSeen: now };
    const created = newTeamState({ teamId, name: teamId, founderKey: agentKey, founder: member, now });
    await writeTeam(stateRoot, created);
    return created;
  }
  const idx = found.members.findIndex((m) => m.key === agentKey);
  if (idx >= 0) {
    // 重复注册：同名字刷新（会话重启换 sid 也在此更新）。
    found.members[idx] = { ...found.members[idx], sessionId, role, lastSeen: now };
  } else {
    found.members.push({ key: agentKey, sessionId, role, joinedAt: now, lastSeen: now });
  }
  await writeTeam(stateRoot, found);
  return found;
}
