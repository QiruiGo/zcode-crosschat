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
 *   v0.5.3（安全对-1/a6 修复）：**重绑已绑定的 (name, sid) 精确对**还须出示锚定
 *   令牌 regToken（SessionStart 铸造、只注入本会话上下文；同连接幂等重试与旧锚
 *   免除外）——(name, sid) 对可经 xc_status 免注册读到，本身不是凭据，不验令牌
 *   即可精确重放冒充任意成员（偷邮箱/移 lead/零告警）。
 * - 路径 2（wakeToken 回退）：registry/wake/<nonce>.json 命中未过期未使用且
 *   {teamId, agentKey, sid} 匹配 → 直接绑定（允许覆盖同名旧绑定：无头回合身份以
 *   nonce 为准），并由服务端代写 sessions/<sid>.json（消除对钩子落盘的依赖；
 *   v0.5.3 起代写保留/补铸 regToken），nonce 标记 used（M1 consumeWakeNonce）。
 * - v0.5.3（安全对-3/a8 修复）：注册成功后把 boundName 盖到机器全局基记录
 *   peers/base/<sid>.json（options.peerRoot 给出时）——peer 轴据此对「已绑定
 *   队内身份的 sid」强制验 regToken。
 * - 锁序全局固定：registry → team（§2.7-3）。xc_register 是唯一同时持两把锁的
 *   路径，直接用 M1 的 withRegistryThenTeamLocks（先 registry 绑名、后 team 入队；
 *   join 失败经 unbindName 回滚绑名——M1 专门为回滚设计的条件删除）。
 *
 * 锁超时：M1 抛 LockBusyError（toStructured() = {error:"busy", lock}），由
 * tools.ts 的 runCore 统一映射成结构化错误信封。
 */

import { createHash, randomUUID } from "node:crypto";
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
import { readPeerBaseRecord, writePeerBaseRecord } from "../core/peerdir.js";
import { newTeamState, noteTeamReset, readTeam, writeTeam } from "../core/teamstate.js";
import { logEngineEvent } from "../core/log.js";
import { DEFAULT_TEAM_ID, memberState, RESERVED_MEMBER_KEYS } from "../core/types.js";
import type { MemberRole, SessionRecord, TeamMember, TeamState } from "../core/types.js";

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
  /**
   * v0.5.3（安全对-1/a6 修复）：锚定令牌——SessionStart 钩子铸造并只注入到本会话
   * 上下文的凭据。(name, sessionId) 对可经 xc_status 公开读到，不构成凭据；重绑
   * 已绑定的 (name, sid) 对时必须出示与锚定记录一致的 regToken，否则精确对重放
   * 冒充（偷邮箱/移 lead/零告警）成立。wakeToken 路径不需要它（一次性 nonce 即
   * 属主凭据）。
   */
  regToken?: string;
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
 *
 * v0.5.3（安全对-1/a6 修复）：`options.peerRoot` 缺省 undefined——给出时（生产装配
 * 由 tools.ts 传 `peerRootFromEnv(deps.env)`），注册成功后会在机器全局基记录
 * `peers/base/<sid>.json` 上盖 `boundName` 队内绑定标记；peer 轴（xc_peer_register）
 * 据此识别「该 sid 已是队内成员身份」并强制验 regToken（跨工作区也可见）。
 */
export async function xcRegister(
  stateRoot: string,
  args: RegisterArgs,
  connectionKey: string,
  options: { peerRoot?: string } = {},
): Promise<RegisterOutcome> {
  const name = args.name.trim();
  if (!name) throw invalidParamsError("name is required");
  const agentKey = sanitizeKey(name);
  if (!agentKey) {
    throw invalidParamsError(`name ${JSON.stringify(name)} sanitizes to an empty key`);
  }
  // v0.5.1（BND-5 修复）：保留名规则与 xc_member_add 统一（member-tools.ts 同码）。
  // 此前 xc_register 放行 lead/default：字面成员名与 lead 角色语义 / 缺省 teamId
  // 撞名（xc_lead_transfer{to:"lead"} 会把角色授予字面成员 "lead"），两入口
  // 不一致构成注册旁路。锁外快拒，任何路径（hook/wake）都到不了绑定。
  if ((RESERVED_MEMBER_KEYS as readonly string[]).includes(agentKey)) {
    throw new ToolError({
      error: "name_reserved",
      name: agentKey,
      message: `member name "${agentKey}" is reserved (${RESERVED_MEMBER_KEYS.join("/")})`,
    });
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
    // v0.5.3（a6）：锚定记录（hook 路径读取；wake 路径为代写后的记录）——重绑属主
    // 校验要读它的 regToken，故提升到双路径分支之外声明。
    let sess: SessionRecord | undefined;

    // ---- v0.2（DESIGN-V0.2 §7.4-I5/§7.3.3）：removed 成员的注册一律拒绝 ----
    // xc_member_stop 后花名不释放（roster 记录保留）；重新启用必须由 lead 走
    // xc_member_add 幂等重供给——供给流程会先把 roster state 置回 provisioning
    // 再发欢迎 prompt（W2 契约 §6.4），故正常的重供给注册不受此门影响。
    // 先于 wake/hook 分支：不给 removed 会话消费任何一次性 nonce 的机会。
    const teamNow = await readTeam(stateRoot, teamId);
    if (teamNow !== undefined) {
      const stopped = teamNow.members.find((m) => m.key === agentKey && memberState(m) === "removed");
      if (stopped !== undefined) {
        throw new ToolError({
          error: "member_removed",
          name: agentKey,
          sessionId,
          teamId,
          message: `member "${agentKey}" was removed from team "${teamId}" (xc_member_stop); ` +
            "re-enable it via the lead's xc_member_add (idempotent reprovision)",
        });
      }
    }

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
      // v0.5.3（a6）：代写不得抹掉钩子已写的锚定令牌（保留既有 regToken；缺失则
      // 补铸一枚，令牌与后续 SessionStart 的延续逻辑同源）。
      const existingRecord = await readSession(stateRoot, sessionId);
      const record: SessionRecord = {
        ...(existingRecord ?? {}),
        sessionId,
        cwd: process.cwd(),
        startedAt: existingRecord?.startedAt ?? now,
        lastSeen: now,
        boundName: agentKey,
        regToken: existingRecord?.regToken ?? randomUUID(),
      };
      await writeSession(stateRoot, record);
      sess = record;
    } else {
      // ---- 路径 1：hook 锚定（§2.3-1/3）----
      via = "hook";
      sess = await readSession(stateRoot, sessionId);
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

    // ---- v0.5.3（安全对-1/a6 修复）：重绑属主校验 ----
    // (name, sid) 精确对可经 xc_status 免注册读到，本身不构成凭据：已绑定对的再次
    // 出示必须附带锚定令牌（SessionStart 铸造、只注入本会话上下文），否则精确对
    // 重放可完全冒充任意成员（偷消费邮箱 / xc_lead_transfer 移走 lead / 零告警）。
    // 豁免三条：
    // ① 本连接已绑定同一身份 ⇒ 同一连接的幂等重试（agent 重试语义），不再索要；
    // ② wakeToken 路径 ⇒ 一次性 nonce 即属主凭据（via === "wake"）；
    // ③ 锚定记录缺 regToken（v0.5.3 之前铸的旧锚）⇒ 放行 + 告警（不静默：该会话
    //    下次 SessionStart 即携带令牌，过渡窗口在响应 warnings 与审计里如实披露）。
    // 错误码 identity_token_required：与 name_taken/session_already_bound（仍先行
    // 触发，行为不变）区分开——那里挡「对不上」，这里挡「对得上但不是你」。
    const pairAlreadyBound = existingBinding !== undefined && existingBinding.sessionId === sessionId;
    const connBound = identityStore.get(connectionKey);
    const sameConnectionRetry = connBound !== undefined
      && connBound.agentKey === agentKey
      && connBound.sessionId === sessionId;
    if (pairAlreadyBound && via === "hook" && !sameConnectionRetry) {
      if (sess?.regToken !== undefined) {
        if (args.regToken?.trim() !== sess.regToken) {
          await logEngineEvent(stateRoot, {
            event: "register-replay-blocked",
            teamId,
            agentKey,
            sessionId,
            tokenPresented: args.regToken !== undefined,
          });
          throw new ToolError({
            error: "identity_token_required",
            name: agentKey,
            sessionId,
            message: `pair (name "${agentKey}", session "${sessionId}") is already bound; re-binding it from a new connection ` +
              "requires the session's regToken (injected by the SessionStart hook into this session's own context). " +
              "A (name, sessionId) pair readable via xc_status is not a credential — presenting it alone is rejected.",
          });
        }
      } else {
        warnings.push(
          "anchor predates regToken protection (v0.5.3): exact-pair replay protection inactive for this session until its next SessionStart",
        );
      }
    }

    // 先绑名（registry），后 team 入队；入队失败经 unbindName 回滚（§2.7-3 原顺序）。
    await bindName(stateRoot, agentKey, { sessionId, role, registeredAt: now });
    let team: TeamState;
    try {
      team = await joinTeam(stateRoot, teamId, agentKey, sessionId, role, now, warnings);
    } catch (err) {
      await unbindName(stateRoot, agentKey, sessionId); // 条件回滚：仍指向本 sid 才删
      throw err;
    }

    // ---- v0.5.3（安全对-3/a8 修复）：队内绑定标记盖章 ----
    // 注册成功 ⇒ 该 sid 已是队内成员身份。把 boundName 盖到机器全局基记录
    //（peers/base/<sid>.json，跨工作区可见）上，peer 轴 xc_peer_register 据此识别
    //「受保护 sid」并强制验锚定令牌——堵住「任意花名 + 队内成员真 sid」的 peer
    // 冒充。基记录缺失时按注册事实补建（cwd=进程工作区；regToken 与 workspace 侧
    // 锚定记录同值）；盖章失败只审计不回滚注册（保护是尽力面，注册本身已验证）。
    if (options.peerRoot !== undefined) {
      try {
        const base = await readPeerBaseRecord(options.peerRoot, sessionId);
        // 令牌取值：workspace 侧锚定记录的 regToken 优先；它缺（旧锚）时保留基记录
        // 既有值。**绝不凭空铸造**——模型只见过 SessionStart 注入的那一枚，写一枚
        // 它没见过的令牌会把合法的 peer 注册锁死。
        const stampToken = sess?.regToken ?? base?.regToken;
        await writePeerBaseRecord(options.peerRoot, {
          sessionId,
          cwd: base?.cwd ?? process.cwd(),
          source: base?.source ?? null,
          startedAt: base?.startedAt ?? now,
          lastSeen: base?.lastSeen ?? now,
          ...(base?.permissionMode !== undefined ? { permissionMode: base.permissionMode } : {}),
          ...(stampToken !== undefined ? { regToken: stampToken } : {}),
          boundName: agentKey,
        });
        if (base === undefined) {
          await logEngineEvent(stateRoot, {
            event: "bound-name-stamp-created-base",
            teamId,
            agentKey,
            sessionId,
          });
        }
      } catch (error) {
        await logEngineEvent(stateRoot, {
          event: "bound-name-stamp-failed",
          teamId,
          agentKey,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

/** team 入队：不存在则建队（首个注册者=founderKey，§2.2）；存在则 upsert 成员。
 *  v0.5.1（故障注-5 修复）：team.json 缺失但有残迹（邮箱/快照）时建队不再静默
 *  ——noteTeamReset 产出告警进注册响应的 warnings 并落 `team-reset-detected` 审计。 */
async function joinTeam(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  sessionId: string,
  role: MemberRole,
  now: number,
  warnings: string[],
): Promise<TeamState> {
  const found = await readTeam(stateRoot, teamId);
  if (found === undefined) {
    const resetWarning = await noteTeamReset(stateRoot, teamId);
    if (resetWarning !== undefined) warnings.push(resetWarning);
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
