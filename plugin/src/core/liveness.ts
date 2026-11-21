/**
 * v0.9.0（G-9/G-5，方案 §一）：会话活性真源——纯函数模块（与 core/stall.ts、
 * core/offline.ts 同款纪律：**无 I/O、无时钟副作用（now 注入）、无定时器**）。
 *
 * 背景（GAP-V0.9 §G-9）：`lastSeen` 是「上次见过」，不是「正在运转」——成员回合
 * 运行中（长时间执行工具不打 xc 事件）lastSeen 停滞；回合已结束的会话 lastSeen
 * 却还新鲜。误扫的本质（G-5）：清扫只看任务时间线（task.updatedAt），看不见会话
 * 活性。两项共用本模块产出的活性真源一揽子解决（方案决策表 G-9/G-5 → 组 A）。
 *
 * 状态机（三态，PROTOCOL §12.4）：
 * - `running`：回合执行中——UserPromptSubmit / SessionStart 钩子起（回合开始），
 *   Stop 钩子止（回合结束）。落盘于 registry/sessions/<sid>.json 的 `liveness` 字段
 *   （registry.ts 是记录属主：refreshSessionLastSeen 标 running、markSessionIdle 标
 *   idle，迁移写 engine.jsonl `session-running`/`session-idle` 事件）；
 * - `idle`：回合已结束（Stop 钩子）；
 * - `dead`：**派生**，不落盘——复用 C8 进程死判据（core/offline.ts memberLiveness 的
 *   `pid-dead`：peer 注册记录里的 sid 持有进程已亡）。崩溃会话即使残留 running
 *   记录也判 dead（保守：dead 压过 running）。
 * 记录缺失（存量 v0.8 记录 / 会话从未被钩子锚定）→ 读作 `idle`（非 running 不给
 * 清扫豁免，保守方向）。
 *
 * 清扫联动（G-5，sweepOwnerGuard）：
 * - 任务 SWEEPABLE 且属主 `running` → 暂停 stale 倒计时（长回合/长任务不误扫，
 *   t17 模式）；`dead`（pid-dead 硬证据）不豁免——C8 的 process-dead 快刀不受影响；
 * - 属主在 stale 窗口内有过引擎事件（registry `lastEventTs`，钩子回合边界 + MCP
 *   工具调用心跳共同刷新，见 registry.ts）= 心跳代理，不再要求手动 xc_report 打卡
 *   （t1 模式：活跃等待裁决的会话不再被误扫）；
 * - blocked 不在 SWEEPABLE 清扫域的旧口径不变（types.ts）。
 *
 * 观测（memberLivenessView）：xc_overview team/panel/status 三视图成员行的统一
 * 口径——state + stateAgeMin + lastEventAgeMin（三视图同源同形，跨面一致性由
 * 本模块单一实现保证）。
 *
 * v0.9.3（C1 活性四判据合判）：视图增 `livenessSources`——hooks/pid、registry
 * lastSeen、engine 事件（证言）、mailbox 写入 mtime 四判据各自独立可判活，合成结论
 * 如实列出依据；全静默 = 空列表（unknown，`state` 落保守 idle），`dead` 仍只认
 * pid-dead。合判只服务展示面：清扫豁免输入不变（仍只认证言，sweepOwnerGuard）。
 *
 * @module core/liveness
 */
import { memberLiveness, deriveSessionPidEvidence } from './offline.js';
import { pidAlive } from './lock.js';
import type { PeerScanResult } from './peerregistry.js';
import { plausibleLivenessTs, type SessionRecord, type SessionWitness, type SessionWitnessKind, type TeamMember } from './types.js';

// 证言型唯一定义在 core/types.ts（M1 纪律：持久化字段单一定义点），此处再出口保持
// 既有 import 面（registry.ts / task-edges.ts 从本模块取型）。
export type { SessionWitness, SessionWitnessKind };

/** 落盘的会话活性两态（registry/sessions/<sid>.json 的 `liveness` 字段）。 */
export type StoredLiveness = 'running' | 'idle';

/** 观测三态：落盘两态 + dead（C8 pid-dead 派生，不落盘）。 */
export type SessionLivenessState = StoredLiveness | 'dead';

/** engine.jsonl 活性迁移事件名（PROTOCOL §12.4 冻结示例；family=liveness）。 */
export const SESSION_RUNNING_EVENT = 'session-running';
export const SESSION_IDLE_EVENT = 'session-idle';

/** 一次活性状态迁移（from=null = 记录此前无活性字段：存量/首标）。 */
export interface LivenessTransition {
  from: StoredLiveness | null;
  to: StoredLiveness;
}

/**
 * 把一次活性标记应用到会话记录（纯函数；读改写与持锁是调用方 registry.ts 的事）。
 *
 * 语义：
 * - `lastEventTs` 恒刷新为 now（凡是触到 registry 的引擎事件都是心跳）；
 * - `to` 与既有 `liveness` 同值 → 只刷新 lastEventTs，不产生迁移（防每个 prompt
 *   都写一条 engine.jsonl 事件）；
 * - 迁移发生 → 记 `livenessTs = now`（状态进入时刻，观测面算 stateAgeMin 用）。
 */
export function applyLivenessTransition(
  record: SessionRecord,
  to: StoredLiveness,
  now: number,
): { record: SessionRecord; transition: LivenessTransition | null } {
  const from = record.liveness ?? null;
  if (from === to) {
    return { record: { ...record, lastEventTs: now }, transition: null };
  }
  return {
    record: { ...record, liveness: to, livenessTs: now, lastEventTs: now },
    transition: { from, to },
  };
}

/**
 * v0.9.3（C1）：活性四判据的判据来源标识（固定序，跨面稳定可对拍）。
 *
 * 判据与读取面（本模块纯函数不做 I/O，落盘读取在调用方）：
 * 1. `hooks-pid`：第①判据——hooks 自述（`registry/sessions/<sid>.json` 的 `liveness`）
 *    + peer 扫描的进程事实（`endpointLive` / `pid-dead`）；v0.9 起就有的那一项；
 * 2. `registry-lastSeen`：第②判据——会话记录的 `lastSeen`（`registry/sessions/<sid>.json`，
 *    SessionStart / UserPromptSubmit 钩子经 refreshSessionLastSeen 刷新的「上次见过」；
 *    `team.json` 花名册的 `lastSeen` 是建员/注册时刻的粗粒度值，**不作**新鲜度判据）；
 * 3. `engine-events`：第③判据——引擎证言 `registry/witness/<sid>.json`（与清扫豁免
 *    **同一读取路径**、同一文件；豁免仍只认证言，见 {@link sweepOwnerGuard}）；
 * 4. `mailbox-mtime`：第④判据——成员邮箱文件（`teams/<teamId>/inbox/<key>.jsonl`）
 *    的写入 mtime：投递、消费确认回写都在动这个文件。
 */
export type LivenessCriterion =
  | 'hooks-pid'
  | 'registry-lastSeen'
  | 'engine-events'
  | 'mailbox-mtime';

/**
 * 第②③④判据的新鲜窗（ms）——与 stale 清扫阈值的内置缺省同宽（30min，
 * `core/snapshot.ts DEFAULT_STALE_TASK_MINUTES`）。**只服务活性合判的展示面**：
 * 清扫豁免仍由 {@link sweepOwnerGuard} 用自己的 2×阈值上界裁决（口径不变），本窗
 * 不是豁免输入。调用方（mcp/tools-overview.ts）按 env 解析后注入，core 不解析 env。
 */
export const LIVENESS_EVIDENCE_FRESH_MS = 30 * 60_000;

/** 三视图统一口径的成员活性视图（team/panel/status 同形，跨面一致）。 */
export interface SessionLivenessView {
  state: SessionLivenessState;
  /** 距状态进入的分钟数（展示取整）；dead（无落盘时刻）或无记录/时刻不可信 → null。 */
  stateAgeMin: number | null;
  /** 距最近引擎事件的分钟数（registry lastEventTs）；无事件或时刻不可信 → null。 */
  lastEventAgeMin: number | null;
  /**
   * v0.9.1（V090-01/05 r2）**端点活性**（peer 注册表里该会话存在 pid 活且心跳新鲜的
   * 记录，memberLiveness === 'live'）——**仅展示，不作豁免输入**（r3 起豁免只认引擎
   * 证言：成员自有 MCP server 全会话常驻，端点活性可被攻击者自己的存活 server 满足，
   * 裁决 case1r3/case7br3 实证）。保留字段供 lead 观测「自述 vs 端点」的并列事实。
   */
  endpointLive: boolean;
  /**
   * v0.9.3（C1）：**四判据合判**——本次结论实际依据的**新鲜**证据来源（固定序）。
   *
   * - 四判据各自单独可判活：任一判据有新鲜证据即出现在列表里（G-9 的本体诉求——
   *   `lastSeen` 停滞不再等同于「没有证据」，邮箱还在被写也不再看不见）；
   * - **空列表 = 全静默（unknown）**：四判据全无声 → 既不自称 running，也不判 dead，
   *   `state` 按保守口径落 `idle`（不给清扫豁免，见 {@link sweepOwnerGuard}）；
   * - `dead`（pid-dead 硬证据）压过一切活证据：判死时列表为空——pid-dead 是「不活」
   *   的证据，不是活证据；
   * - 列表是**展示面合成**：不清扫豁免、不改 `state` 语义（`state` 仍是 hooks 回合
   *   三态的自述），只回答「这个结论是拿什么判据合出来的」。
   */
  livenessSources: LivenessCriterion[];
}

/** v0.9.3（C1）：四判据合判的注入输入（第③④判据的落盘读取在调用方；本模块无 I/O）。 */
export interface LivenessJudgeInput {
  /** 引擎证言（`registry/witness/<sid>.json`；第③判据；undefined = 无证言）。 */
  witness?: SessionWitness;
  /** 成员邮箱文件的写入 mtime（epoch ms；第④判据；undefined = 读不到/不判）。 */
  mailboxMtimeMs?: number;
  /** 第②③④判据的新鲜窗（ms；缺省 {@link LIVENESS_EVIDENCE_FRESH_MS}）。 */
  freshMs?: number;
  /**
   * v0.9.4（A1）：会话记录 pid 的**存活探测结果**（调用方读 sessions/<sid>.json 的
   * `pid` 并用 core/lock.ts pidAlive 探测后注入；本模块无盘 I/O）。`turnInProgress`
   * 由本模块从记录自述推导（liveness==='running' 且 livenessTs 可信）——只有回合
   * 中的死进程才判 pid-dead（回合间隙零进程是正常形态，见 offline.ts 同款判据）。
   *
   * v0.9.4 打回第 1 轮（V094-13）：**缺省不再「不参与」**——未显式注入时本模块按
   * `record.pid` + `pidAlive` 现场派生（见 {@link LivenessJudgeInput.pidAliveProbe}）。
   * 旧行为「不注入 = 判据不参与」正是 V094-13 的根因：看门狗（显式注入）判
   * pid-dead 并落 member-dead，而 xc_overview 的展示面未注入 → 三视图仍报 running，
   * 同一死亡在两个面对不上账。派生点单一化后，凡拿到会话记录的展示面自动同判据。
   */
  sessionPid?: { pid: number; alive: boolean };
  /**
   * v0.9.4 打回第 1 轮（V094-13）：pid 存活探测的注入面（测试用；缺省 core/lock.ts
   * 的 `pidAlive`，即真实 `process.kill(pid, 0)`）。**无盘 I/O**：唯一副作用是一次
   * 进程存在性系统调用，与既有 peer 扫描的 pidAlive 同族；纯函数纪律的例外在此显式
   * 声明（本模块仍是「无盘 I/O、无时钟副作用、无定时器」）。
   */
  pidAliveProbe?: (pid: number) => boolean;
}

/** 分钟取整展示（仅可信时刻；未来值不钳 0 展示——伪造的 lastEventTs 不进观测面）。 */
function ageMin(now: number, ts: number | undefined): number | null {
  if (!plausibleLivenessTs(ts, now)) return null;
  return Math.max(0, Math.round((now - ts!) / 60_000));
}

/**
 * 成员活性视图组装（纯函数；记录、peer 扫描、证言与邮箱 mtime 由调用方读取——本模块
 * 不做 I/O）。
 *
 * - `dead` 判据复用 C8（offline.memberLiveness 的 pid-dead；scan 缺失 = 扫描面
 *   不可用，退化按记录状态呈现——观测面永不为难，不猜进程死）；
 * - 记录缺失 / 无 liveness 字段（存量记录）→ `idle`（保守：不给清扫豁免）；
 * - v0.9.1（V090-01）：`running` **必须伴随可信的 livenessTs**（产品自写的 running
 *   恒由 applyLivenessTransition 同步落状态时刻）——`running` 而无时刻/时刻在未来
 *   = 伪造或损坏，按 `idle` 呈现与豁免判定（保守：不给清扫豁免）；
 * - `endpointLive`：peer 注册表端点心跳证词（state 的自述 vs 进程事实并列展示，
 *   伪造 running 在三视图可见）；
 * - v0.9.3（C1）：`livenessSources` 四判据合判（见该字段注释）——判活证据的**展示面**
 *   合成，`state` 与清扫豁免口径均不变（豁免只认证言，见 {@link sweepOwnerGuard}）。
 *   证言判据不继承自述的 5min 未来容差（r4 V090-02：证言与判定同机同钟，`ts > now`
 *   即拒）。
 */
export function memberLivenessView(
  member: TeamMember,
  record: SessionRecord | undefined,
  scan: PeerScanResult | undefined,
  now: number,
  judge: LivenessJudgeInput = {},
): SessionLivenessView {
  // v0.9.4（A1）：pid 证据（记录 pid + 存活探测 + 本模块推导的回合中自述）
  // ——注入 memberLiveness 的 pid 判据。
  // v0.9.4 打回第 1 轮（V094-13）：**未显式注入时按记录现场派生**（单一派生点
  // core/offline.ts deriveSessionPidEvidence）——看门狗判死与三视图展示由此必然同判据，
  // 修掉「看门狗 member-dead 而 overview 仍报 running」的跨面矛盾。
  const sessionPid = judge.sessionPid !== undefined
    ? {
        pid: judge.sessionPid.pid,
        alive: judge.sessionPid.alive,
        turnInProgress: record?.liveness === 'running' && plausibleLivenessTs(record.livenessTs, now),
      }
    : deriveSessionPidEvidence(record, now, judge.pidAliveProbe ?? pidAlive);
  const liveness = scan !== undefined ? memberLiveness(member, scan, now, { sessionPid }) : null;
  const dead = liveness === 'pid-dead';
  const endpointLive = liveness === 'live';
  const runningTrusted = record?.liveness === 'running' && plausibleLivenessTs(record.livenessTs, now);
  const state: SessionLivenessState = dead ? 'dead' : runningTrusted ? 'running' : 'idle';
  const freshMs = judge.freshMs ?? LIVENESS_EVIDENCE_FRESH_MS;
  // 时间型判据的可信度前置（与自述字段同纪律：有限正数、非未来值），防伪造未来时刻
  // 制造「恒新鲜」的假证据。
  const fresh = (ts: number | undefined): boolean =>
    plausibleLivenessTs(ts, now) && now - ts! <= freshMs;
  const sources: LivenessCriterion[] = [];
  if (!dead) {
    // 第①判据：hooks 自述 running（带可信时刻）或 peer 扫描端点活。
    if (runningTrusted || endpointLive) sources.push('hooks-pid');
    // 第②判据：registry 会话记录的 lastSeen 新鲜（SessionStart/UserPromptSubmit 钩子
    // 经 refreshSessionLastSeen 刷新的「上次见过」——不是「正在运转」，只作判活证据）。
    if (fresh(record?.lastSeen)) sources.push('registry-lastSeen');
    // 第③判据：引擎证言在窗内（容差 0——证言是引擎写入时刻，同机同钟无漂移场景）。
    if (judge.witness !== undefined && judge.witness.ts <= now && now - judge.witness.ts <= freshMs) {
      sources.push('engine-events');
    }
    // 第④判据：邮箱文件写入新鲜（投递/消费确认都在动它；他人投递不算属主心跳的
    // §12.4 口径不变——这里只作展示面判活证据，不作豁免输入）。
    if (fresh(judge.mailboxMtimeMs)) sources.push('mailbox-mtime');
  }
  return {
    state,
    // dead 是扫描时刻的派生事实，无落盘进入时刻；可信的 record 状态才可算年龄。
    stateAgeMin: dead || !runningTrusted ? null : ageMin(now, record?.livenessTs),
    lastEventAgeMin: ageMin(now, record?.lastEventTs),
    endpointLive,
    livenessSources: sources,
  };
}

/** 清扫守卫裁决（G-5 联动的单一事实源；null = 不豁免，清扫按旧口径走）。 */
export type SweepOwnerGuard = 'owner-running' | 'heartbeat';

/**
 * v0.9.1 r3（V090-01）：证言语义——`running`/`idle` = hook 三态迁移（回合起/止，
 * engine.jsonl session-running/session-idle 同源）；`heartbeat` = 队内工具调用
 * （引擎亲见 dispatch/relay/report/claim 等一切被包装的工具，见 peer-drain 包装层）。
 * 型定义在 core/types.ts（持久化字段单一定义点），本模块只放纯判据。
 */

/**
 * 豁免上限倍数（V090-GUIDANCE-R3）：连续豁免超过 2×stale 阈值仍无任何引擎证言 →
 * 照扫。防「回合起了但永远不结束」的永久滞留（t17 长回合保护有上界）。
 */
export const SWEEP_EXEMPTION_BOUND_FACTOR = 2;

/** 守卫裁决的审计短语（task-sweep-deferred 事件 note 用，V090-06）。 */
export function sweepOwnerGuardReason(guard: SweepOwnerGuard): string {
  return guard === 'owner-running'
    ? 'owner turn in progress per engine witness (stale countdown paused)'
    : 'engine witness (tool call) within stale window';
}

/**
 * v0.9.1 r3（V090-01）：会话记录自述与引擎证言的不一致检测（纯函数；审计面用）。
 * 自述记录（sessions/<sid>.json）可被一次本地文件写伪造；证言不能（引擎分路写）。
 * 记录声称 running 而证言不支持（无证言 / 证言止于 idle）= 伪造或损坏签名——
 * 清扫面据实落 `session-record-anomaly`（lead 在时间线可见「谁在自述活性」）。
 */
export function sessionRecordWitnessMismatch(
  record: SessionRecord | undefined,
  witness: SessionWitness | undefined,
  now: number,
): { field: 'liveness'; detail: string } | null {
  if (record?.liveness !== 'running') return null;
  if (!plausibleLivenessTs(record.livenessTs, now)) return null; // 自述本身不可信：由未来值检查负责
  if (witness === undefined) {
    return {
      field: 'liveness',
      detail: 'record self-claims running but no engine witness exists (single-write forgery signature)',
    };
  }
  if (witness.kind === 'idle') {
    return {
      field: 'liveness',
      detail: 'record self-claims running but engine witness says the turn ended (idle)',
    };
  }
  return null;
}

/**
 * v0.9.1 r3（V090-01）：会话记录活性字段的**未来值异常检测**（纯函数；审计面用）。
 * 保留 v0.9.1 的未来值口径（自述记录里的未来时刻必为伪造/损坏），与
 * {@link sessionRecordWitnessMismatch}（自述 vs 证言）共同构成审计面。
 */
export function sessionRecordLivenessAnomaly(
  record: SessionRecord | undefined,
  now: number,
): { field: 'livenessTs' | 'lastEventTs'; detail: string } | null {
  if (record === undefined) return null;
  if (record.liveness === 'running' && !plausibleLivenessTs(record.livenessTs, now)) {
    return {
      field: 'livenessTs',
      detail: 'liveness=running lacks a plausible livenessTs (state claim untrusted; treated as idle)',
    };
  }
  if (record.lastEventTs !== undefined && !plausibleLivenessTs(record.lastEventTs, now)) {
    return { field: 'lastEventTs', detail: 'lastEventTs is implausible (future value; heartbeat claim dropped)' };
  }
  return null;
}

/**
 * 属主清扫守卫（纯函数）：任务 ∈ SWEEPABLE 且超阈时，属主活性能否豁免本轮清扫。
 *
 * **证据源 = 引擎证言（V090-01 r3，V090-GUIDANCE-R3）**：registry/sessions/<sid>.json
 * 的 liveness 自述字段**降级为仅展示**，不得作豁免输入——成员自有的 MCP server 全会话
 * 常驻（15s 端点心跳），端点活性证词闸（v0.9.1 r2）可被攻击者自己的存活 server 满足
 * （裁决 case1r3/case7br3：伪造自述 + 自有活端点 = 永久 owner-running 豁免）。豁免改为
 * 只认**引擎亲见事件**（hook 三态迁移 + 工具调用心跳，registry/witness/<sid>.json）：
 * - 无证言（含一次外部写伪造的自述记录）→ null：照扫；
 * - `dead`（C8 pid-dead）→ null（调用方先判；残留自述压不过进程死）；
 * - 证言 `running`（回合执行中）且年龄 ≤ 2×threshold → 'owner-running'（t17 长回合）；
 * - 证言年龄 ≤ threshold（任何引擎事件：工具调用/回合边界）→ 'heartbeat'（t1 活跃等待）；
 * - **有界**（防永久滞留）：年龄 > 2×threshold → null，照扫（V090-GUIDANCE-R3）。
 */
export function sweepOwnerGuard(
  witness: SessionWitness | undefined,
  now: number,
  thresholdMs: number,
): SweepOwnerGuard | null {
  if (witness === undefined) return null;
  // 同机未来值不可信（r4 V090-02）：证言与判定同机同钟，ts > now 即伪造——兜住读盘
  // 之外的内联构造路径（age 为负会恒满足 boundMs，豁免窗被放大 skew+2×阈值）。
  if (witness.ts > now) return null;
  const age = now - witness.ts;
  const boundMs = thresholdMs * SWEEP_EXEMPTION_BOUND_FACTOR;
  if (age > boundMs) return null; // 有界：2× 阈值内无任何引擎证言 → 照扫
  if (witness.kind === 'running') return 'owner-running';
  if (age <= thresholdMs) return 'heartbeat';
  return null;
}
