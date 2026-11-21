/**
 * M4 hooks-and-face: SessionStart hook — identity anchoring + v0.3 peer 基记录。
 *
 * v0.2 behavior（DESIGN.md §2.3-1、§7 M4）：写/刷新 registry/sessions/<sessionId>.json，
 * 再用严格单键 additionalContext 注入会话身份。
 *
 * v0.3 增量（DESIGN-V0.3.md §3.1、§10.1）：
 * 1. 额外写**机器全局**的 peer 基记录 peers/base/<sessionId>.json：
 *    { sessionId, cwd, permissionMode, source, startedAt, lastSeen }。
 *    permissionMode 来自钩子 stdin 载荷的 permission_mode/mode（实测载荷含
 *    "permission_mode":"yolo" / "mode":"yolo"，FEASIBILITY-V0.3 §1.2）；
 *    它是 mode-parity 自动档的档类真源（收方档类 + 发方档类都出自这里）。
 * 2. 注入文案追加一行 peer 注册指引（xc_identify）。
 *
 * v0.9.4 增量（39-v094 方案 §二 组A）：
 * - **A1 成员 pid 证据**：会话记录与 peer 基记录补 `pid`（宿主进程 pid，见
 *   {@link hookSessionPid} 的取值口径）——memberLiveness 的 pid 判据（pid-dead）
 *   与看门狗的成员死亡检测据此在「无 peer 注册记录的引擎成员」上也能成立；
 * - **A6 唤醒一次到位（机制合并）**：本钩子消费以本 sid 为目标的**唤醒票据**
 *   （registry/wake/<nonce>.json，一次性、非目标 sid 拒）并**自动绑定身份**
 *   （队内轴 names.json/roster + peer 轴基记录 boundName 盖章），不经模型回合；
 *   成员被唤醒后的首回合因此只需 xc_claim（wake prompt 的行动行同步改口径）。
 *
 * v0.9.5 增量（41-v095 方案 §一 组A）：
 * - **A1（V094-02）ppid 采纳默认关**：上面的 A6 票据消费+自动绑定随之**默认关**
 *   （`XC_ADOPT_BY_PPID=1` 才启用，core/registry.ts adoptByPpidEnabledFromEnv）——
 *   默认把票据留给模型回合的 wakeToken xc_identify 兜底（2 次调用），宁可多一次
 *   调用，不许 ppid 采纳在多会话宿主上错绑身份；
 * - **A6（V094-03）钩子消费失败回滚票据**：启用档下票据已置 used 而绑定失败
 *   （锁忙/花名被别人持有/本会话已有别的 boundName）时，把票据恢复未用形态
 *   （core/registry.ts restoreWakeNonce）——wake prompt 承诺的 wakeToken 兜底路径
 *   不再因「已消费」断裂（旧实现只审计不回滚，兜底必失败）。
 *
 * 降级规则不变：无 sessionId → 不锚定（静默 exit 0）；任何异常 → engine.jsonl 审计 → exit 0。
 *
 * Build entry: dist/hooks/session-start.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  peerRootFromEnv,
  readHookPermissionMode,
  readPeerBaseRecord,
  readStdinPayload,
  refreshSessionRegistration,
  resolveHookContext,
  writePeerBaseRecord,
} from './shared.js';
// v0.9.4（A6）：票据消费 + 身份绑定的 M1 原语（M4 → M1 纪律：只 import core）。
import { createHash } from 'node:crypto';
import {
  adoptByPpidEnabledFromEnv,
  consumeWakeTicketForSession,
  readNames,
  readSession,
  restoreWakeNonce,
  writeNames,
  writeSession,
} from '../core/registry.js';
import { readTeam, writeTeam } from '../core/teamstate.js';
import { withRegistryThenTeamLocks } from '../core/lock.js';
import { DEFAULT_TEAM_ID, memberState, type NameBindings } from '../core/types.js';
import { logEngineEvent } from '../core/log.js';

/**
 * v0.9.4（A1）：本会话的**宿主进程 pid**（写进会话记录/基记录的 pid 证据）。
 *
 * 取值口径（写死，勿改）：钩子进程自身是短命的——hooks.json `type:"process"` +
 * timeoutMs 10000，写完 additionalContext 即退出。记它自己的 pid，秒级之后就是
 * 「进程已亡」，memberLiveness 的 pid 判据会把每个**活**会话误判成 pid-dead
 * （成员死亡告警全面误报）。因此记的是**拉起本钩子的宿主会话进程**（钩子的父进程）：
 * 桌面会话的宿主进程 / 无头 --resume 的 CLI 进程——杀它即会话亡，正是 A1 验收
 * 「kill 该 pid 后 90s 内 member-dead 恰一条」要观测的对象。
 * 取不到（ppid 非法/0）→ undefined（无 pid 证据，判据不参与，不猜）。
 */
export function hookSessionPid(): number | undefined {
  const ppid = process.ppid;
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/** v0.9.4（A6）：一次票据消费 + 自动绑定的结局（审计/测试用）。 */
export interface WakeTicketBindingOutcome {
  /** true = 票已消费且身份绑定落地；false = 无票可消或状态冲突（模型回合兜底）。 */
  bound: boolean;
  /** 票据签发的花名（无票时缺省）。 */
  name?: string;
  /** 结局细目（审计事件 reason 同值）。 */
  detail: 'bound' | 'no-ticket' | 'name-bound-elsewhere' | 'bound-name-conflict' | 'lock-busy';
}

/**
 * v0.9.4（A6）：**唤醒票据一次性消费 + 身份自动绑定**（SessionStart 钩子专用，
 * 不经模型回合——「唤醒一次到位」的机制本体）。
 *
 * 顺序（消费先行，绑定随后）：
 * 1. {@link consumeWakeTicketForSession} 按 sid 找票并原子置 used（registry 锁内）——
 *    只认 sid/issuedToSid 都指向本会话的票（非目标 sid 拒）；无票 = 普通会话启动，
 *    零副作用返回；
 * 2. 冲突预检（只读）：花名已被**别的 sid**持有、或本会话记录已有**别的** boundName
 *    → 不绑（与 xc_identify 的 name_taken/session_already_bound 同口径，但钩子不抛，
 *    只留审计——模型回合随后会拿到明确错误而非静默错绑）；
 * 3. 落盘（registry → team 固定锁序）：names.json 缺绑才绑（同 sid 幂等刷新）、
 *    roster 行 sid 刷新（仅 ready 态的在册行；不新建行——钩子不虚构成员）、
 *    会话记录 boundName（缺才写，不覆盖别人的身份）；
 * 4. peer 轴盖章：机器全局基记录 boundName + pid（xc_identify 的同款盖章面）。
 *
 * 边界（如实声明）：票据消费属同机信任域（PROTOCOL §10/§11.5：同机进程可读写状态
 * 文件，不做签名/哈希链）；本机制把身份绑定从模型回合前移到钩子，不防同机伪造。
 */
async function bindWakeTicketIdentity(input: {
  stateRoot: string;
  sessionId: string;
  /** A1 的宿主进程 pid（一并盖章进基记录）。 */
  pid: number | undefined;
  peerRoot: string;
  now: number;
}): Promise<WakeTicketBindingOutcome> {
  const consumed = await consumeWakeTicketForSession(input.stateRoot, { sid: input.sessionId, now: input.now });
  if (consumed === undefined) return { bound: false, detail: 'no-ticket' };
  const name = consumed.nonce.name ?? consumed.nonce.agentKey;

  /**
   * v0.9.5（A6/V094-03）：绑定失败的善后——**回滚票据**（恢复未用）+ 审计留痕。
   * 票据已置 used 而绑定没落地时，wake prompt 承诺的 wakeToken 兜底路径（模型回合
   * 用同一 token 调 xc_identify）才会可用；旧实现只审计不回滚，兜底必撞
   * "already used"（V094-03）。回滚失败只审计不抛（钩子永不失败；最坏后果回到
   * 旧行为——兜底撞 used，模型回合仍可走 hook 路径显式 identify）。
   * 审计事件沿用 wake-ticket-binding-skipped 家族并补 `ticketRolledBack` 位——
   * reason/上下文字段与旧事件逐字段一致（不新增事件名，观测面无新键）。
   */
  const rollbackTicket = async (
    payload: Record<string, unknown> & { reason: string; note: string },
  ): Promise<void> => {
    let rolledBack = true;
    try {
      await restoreWakeNonce(input.stateRoot, consumed);
    } catch (error) {
      rolledBack = false;
      await logEngineEvent(input.stateRoot, {
        event: 'wake-ticket-rollback-failed',
        reason: payload.reason,
        name,
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    await logEngineEvent(input.stateRoot, {
      ...payload,
      event: 'wake-ticket-binding-skipped',
      name,
      sessionId: input.sessionId,
      ticketRolledBack: rolledBack,
      note: rolledBack
        ? `${payload.note}（票据已回滚未用——wakeToken 兜底路径可用）`
        : `${payload.note}（票据回滚失败——兜底 xc_identify 将撞 already used，可走 hook 路径显式 identify）`,
    }).catch(() => undefined);
  };

  // 2. 冲突预检（只读两步，随后锁内复判——预检只为提前给出审计原因）。
  const namesBefore = await readNames(input.stateRoot).catch((): NameBindings => ({}));
  const holder = namesBefore[name];
  if (holder !== undefined && holder.sessionId !== input.sessionId) {
    await rollbackTicket({
      reason: 'name-bound-elsewhere',
      boundSessionId: holder.sessionId,
      note: '唤醒票据的花名已被别的 sid 持有——不抢绑，交由模型回合的 xc_identify 显式处理',
    });
    return { bound: false, name, detail: 'name-bound-elsewhere' };
  }
  const recordBefore = await readSession(input.stateRoot, input.sessionId).catch(() => undefined);
  if (recordBefore?.boundName !== undefined && recordBefore.boundName !== name) {
    await rollbackTicket({
      reason: 'bound-name-conflict',
      boundName: recordBefore.boundName,
      note: '本会话记录已绑定别的花名——不覆盖既有身份，交由模型回合显式处理',
    });
    return { bound: false, name, detail: 'bound-name-conflict' };
  }

  // 3. 落盘（registry → team 固定锁序；钩子 2s 锁预算，锁忙即放弃——票据已消费，
  //    v0.9.5（A6）起锁忙时**回滚票据**（restoreWakeNonce），保 wakeToken 兜底可用；
  //    锁忙只丢「免 identify」的优化，不丢消息——消息本就在邮箱，pull 不依赖身份绑定。
  const locked = await withRegistryThenTeamLocks(
    input.stateRoot,
    DEFAULT_TEAM_ID,
    async () => {
      const names = await readNames(input.stateRoot).catch((): NameBindings => ({}));
      const current = names[name];
      if (current === undefined || current.sessionId === input.sessionId) {
        names[name] = {
          sessionId: input.sessionId,
          role: current?.role ?? 'worker',
          registeredAt: input.now,
        };
        await writeNames(input.stateRoot, names);
      }
      const team = await readTeam(input.stateRoot, DEFAULT_TEAM_ID);
      if (team !== undefined) {
        const row = team.members.find((m) => m.key === name);
        // 仅刷新在册 ready 行的 sid（wake 路径同语义：无头回合身份以票据为准）；
        // 不新建行（钩子不虚构成员）、不动 provisioning/failed/removed 行。
        if (row !== undefined && row.sessionId !== input.sessionId
          && memberState(row) !== 'removed' && memberState(row) !== 'provisioning' && memberState(row) !== 'failed') {
          row.sessionId = input.sessionId;
          row.lastSeen = input.now;
          await writeTeam(input.stateRoot, team);
        }
      }
      const record = await readSession(input.stateRoot, input.sessionId).catch(() => undefined);
      if (record !== undefined) {
        const next = {
          ...record,
          ...(record.boundName === undefined ? { boundName: name } : {}),
          ...(input.pid !== undefined ? { pid: input.pid } : {}),
        };
        if (next.boundName !== record.boundName || next.pid !== record.pid) {
          await writeSession(input.stateRoot, next);
        }
      }
      return true;
    },
    { waitMs: 2_000 },
  ).catch(async (error: unknown) => {
    // v0.9.5（A6/V094-03）：锁忙/IO——绑定落盘放弃，票据回滚未用（保 wakeToken 兜底）。
    // 审计留痕——本会话首回合可经 wakeToken xc_identify 自证（兜底不再必撞 used）。
    let rolledBack = false;
    try {
      await restoreWakeNonce(input.stateRoot, consumed);
      rolledBack = true;
    } catch (rollbackError) {
      await logEngineEvent(input.stateRoot, {
        event: 'wake-ticket-rollback-failed',
        reason: 'lock-busy',
        name,
        sessionId: input.sessionId,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      }).catch(() => undefined);
    }
    await logEngineEvent(input.stateRoot, {
      event: 'wake-ticket-binding-skipped',
      reason: 'lock-busy',
      name,
      sessionId: input.sessionId,
      ticketRolledBack: rolledBack,
      error: error instanceof Error ? error.message : String(error),
      note: rolledBack
        ? '绑定落盘遇锁忙/IO——票据已回滚未用，wakeToken 兜底路径可用（首回合 xc_identify 即自证）'
        : '绑定落盘遇锁忙/IO 且票据回滚失败——首回合可走 hook 路径显式 xc_identify（兜底将撞 already used）',
    }).catch(() => undefined);
    return false;
  });
  if (!locked) {
    return { bound: false, name, detail: 'lock-busy' };
  }

  // 4. peer 轴基记录盖章（队内绑定标记 + A1 的 pid 投影；与 xc_identify 的盖章同面）。
  try {
    const base = await readPeerBaseRecord(input.peerRoot, input.sessionId);
    await writePeerBaseRecord(input.peerRoot, {
      sessionId: input.sessionId,
      cwd: base?.cwd ?? process.cwd(),
      source: base?.source ?? null,
      startedAt: base?.startedAt ?? input.now,
      lastSeen: input.now,
      ...(base?.permissionMode !== undefined ? { permissionMode: base.permissionMode } : {}),
      ...(base?.regToken !== undefined ? { regToken: base.regToken } : {}),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      boundName: name,
    });
  } catch (error) {
    await auditHookFailure(input.stateRoot, 'session-start-wake-ticket-peer-base', error);
  }
  await logEngineEvent(input.stateRoot, {
    event: 'wake-ticket-bound',
    name,
    sessionId: input.sessionId,
    // v0.9.1（V091-01）同款纪律：nonce 真值不进共享日志——只落不可反查摘要
    // （sha256 前 12 hex），运维对账可做、收割不可行。
    nonce: createHash('sha256').update(consumed.token).digest('hex').slice(0, 12),
    note: 'SessionStart 钩子一次性消费唤醒票据并自动绑定身份（队内轴 + peer 轴），不经模型回合',
  });
  return { bound: true, name, detail: 'bound' };
}

/**
 * SessionStart 钩子主体（v0.9.4：与 stop.ts 同款形态导出——模块加载自启 +
 * 单测可显式驱动；`hookSessionPid` 经测试注入父进程 pid 的替代通道见其注释）。
 */
export async function runSessionStartHook(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('SessionStart', stdin);

  if (ctx.sessionId === undefined) return;

  // v0.9.4（A1）：宿主进程 pid（钩子父进程；钩子自身短命不能当会话进程证据）。
  const pid = hookSessionPid();

  // v0.5.3（安全对-1/a6 修复）：SessionStart 铸造/延续锚定令牌 regToken——
  // (name, sessionId) 对可经 xc_overview 公开读到，不构成凭据；重绑队内身份或
  // 认领已绑定队内身份的 sid（xc_identify）时必须出示本令牌。令牌只进
  // 本会话上下文（additionalContext）与两份锚定记录，不出现在任何工具输出里。
  // v0.9.4（A1）：同一点写入 pid 证据（读改写单点落盘，与 lastEventTs 同一原子写）。
  let regToken: string | undefined;
  try {
    const upserted = await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace, {
      ensureRegToken: true,
      ...(pid !== undefined ? { pid } : {}),
    });
    regToken = upserted?.regToken;
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-refresh', error);
  }

  // v0.3：机器全局 peer 基记录（跨会话域的档类真源 + 兜底身份来源）。
  // v0.5.3（a6/a8）：同步锚定令牌（与 workspace 侧 sessions/<sid>.json 同值），
  // 并保留既有 boundName（xc_identify 盖的队内绑定标记）——基记录每次
  // SessionStart 全量重写，不保留就会把绑定标记抹掉。
  // v0.9.4（A1）：同步 pid 证据（与 workspace 侧同值同口径）。
  try {
    const peerRoot = peerRootFromEnv(process.env);
    const existing = await readPeerBaseRecord(peerRoot, ctx.sessionId);
    // 令牌取值：本回合 workspace 侧铸造/延续的 regToken 优先；锁忙没拿到时回退
    // 基记录既有值（跨记录两处必须同值）。
    const baseToken = regToken ?? existing?.regToken;
    await writePeerBaseRecord(peerRoot, {
      sessionId: ctx.sessionId,
      cwd: ctx.workspace,
      permissionMode: readHookPermissionMode(stdin),
      source: stdin?.str('source', 'source') ?? null,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      ...(baseToken !== undefined ? { regToken: baseToken } : {}),
      ...(existing?.boundName !== undefined ? { boundName: existing.boundName } : {}),
      ...(pid !== undefined ? { pid } : {}),
    });
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-peer-base', error);
  }

  // v0.9.4（A6）：唤醒票据一次性消费 + 身份自动绑定（队内轴 + peer 轴，不经模型回合）。
  // 无票据（普通会话启动）= 零副作用；任何异常只审计不阻断（钩子永不失败）。
  // v0.9.5（A1/V094-02）：**默认关**——XC_ADOPT_BY_PPID=1 才执行本段。默认把票据
  // 留给模型回合的 wakeToken xc_identify 兜底（2 次调用：identify + claim）；ppid
  // 采纳在「本会话记录缺失 + 同宿主陈旧记录成唯一命中」时会错绑身份（V094-02），
  // 宁可 2 次调用也不默认开启。绑定失败时票据回滚（A6，见 bindWakeTicketIdentity）。
  if (adoptByPpidEnabledFromEnv(process.env)) {
    try {
      const peerRoot = peerRootFromEnv(process.env);
      await bindWakeTicketIdentity({
        stateRoot: ctx.stateRoot,
        sessionId: ctx.sessionId,
        pid,
        peerRoot,
        now: Date.now(),
      });
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'session-start-wake-ticket', error);
    }
  }

  let names: string[] = [];
  try {
    names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'session-start-names', error);
  }

  const registered = names.length > 0
    ? `已注册花名：${names.join('、')}。`
    : '尚未注册跨会话花名：用 /xc-work <名字> 注册（或调用 xc_identify，name=花名，sessionId=上方值）。';
  const lines = [
    `[zcode-crosschat] 本会话 sessionId：${ctx.sessionId}（已登记进协作注册表）。`,
    registered,
    '注册后可用：xc_dispatch 派发任务、xc_read({scope:"inbox"}) 查收、xc_claim/xc_report 认领与回报、xc_overview 看任务板。工作区协作状态根：' + ctx.stateRoot + '。',
    `[zcode-crosschat] 跨会话消息轴（peer）：如需与本机其他会话直接对话，调用 xc_identify（name=<短小写英文名>，sessionId=${ctx.sessionId}）；之后用 xc_overview({view:"peers"}) 找地址、xc_relay 发信。`,
  ];
  // v0.5.3（a6/a8）：把锚定令牌注入本会话上下文——这是攻击者拿不到的唯一凭据面
  // （注册表文件里的令牌需要文件读权限，超出「纯 MCP API」威胁模型，README 限制 5/12）。
  if (regToken !== undefined) {
    lines.push(
      `[zcode-crosschat] 本会话锚定令牌 regToken=${regToken}：xc_identify 重绑身份（队内轴与 peer 轴同一入口）时须原样携带；它只属于本会话，不外传。`,
    );
  }
  emitAdditionalContext(lines.join('\n'));
  await logHookEvent(ctx.stateRoot, { event: 'hook-session-start', sessionId: ctx.sessionId, names });
}

/** guarded 自启包装（与 stop.ts 同款：钩子永不因异常退出非零）。 */
export async function runSessionStartHookGuarded(): Promise<void> {
  try {
    await runSessionStartHook();
  } catch (error: unknown) {
    // Final guard: a hook must never exit non-zero (would mark the run failed).
    const stdin = readStdinPayload();
    const ctx = resolveHookContext('SessionStart', stdin);
    await auditHookFailure(ctx.stateRoot, 'session-start', error);
  }
}

void runSessionStartHookGuarded();
