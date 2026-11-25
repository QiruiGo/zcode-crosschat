/**
 * v0.7（C8，DESIGN-V0.7.md §4.1）：离线判定纯函数。
 *
 * 纪律与 core/stall.ts 完全同款：**无 I/O、无时钟副作用（now 注入）、无定时器**。
 * 挂载面 = 僵尸清扫节拍（mcp/task-edges.ts 的 sweeper）与 xc_overview team 视图
 * （mcp/tools-overview.ts）；peer 扫描由调用方做（core/peerregistry.ts 的
 * `scanPeers(root, now, { sweep: false })` **只读**扫描——查询路径不得有清扫副作用），
 * 本模块只吃扫描结果。
 *
 * 为什么必须区分「进程死」与「空闲」（E3 ③ + DESIGN-V0.7 §4.1）：
 * 成员是**回合制瞬态**——就绪态零专属进程，一个成员会话在两次回合之间既没有进程
 * 也没有心跳。把「心跳过期 / 无注册记录」当离线，会把每个正常空闲的成员误判成
 * 「没了」，进而在回池层误回收它的任务。因此：
 *
 * - `pid-dead`（sid 持有进程亡、记录未优雅摘除）= **硬证据**，唯一可检出的「进程死」
 *   （优雅退出会摘记录，transport/pipe.ts 的 removePeerRecord，故「用户主动关闭的
 *   会话」与「回合间隙」在注册表上同形、不可检出——如实声明，见 §4.1 可达性分析）；
 * - `heartbeat-stale` / `no-record` / `live` = 进程活着或未知，**只靠任务无进展时长**
 *   兜底（`XC_OFFLINE_MINUTES`，缺省 240min，长于 stall 120 与 stale 30）。
 *
 * @module core/offline
 */
import { PEER_STALE_MS, type PeerScanResult } from './peerregistry.js';
import { lastProgressTs } from './stall.js';
import {
  TERMINAL_TASK_STATUSES,
  memberState,
  plausibleLivenessTs,
  type Task,
  type TaskStatus,
  type TeamMember,
  type TeamState,
} from './types.js';

/** 成员活性四态（DESIGN-V0.7 §4.1 表）。 */
export type MemberLiveness = 'live' | 'pid-dead' | 'heartbeat-stale' | 'no-record';

/**
 * v0.9.4（A1）：会话记录的 **pid 证据**（成员 pid 判据的注入输入；调用方读盘 + 探测
 * 进程存活后传入——本模块保持无 I/O 纪律）。
 *
 * - `pid`：sessions/<sid>.json 的 pid（SessionStart 钩子写的宿主进程 pid）；
 * - `alive`：该 pid 当前是否活着（调用方用 core/lock.ts pidAlive 探测）；
 * - `turnInProgress`：记录是否处于回合中（liveness === 'running' 且时刻可信）。
 *
 * 为什么必须 turnInProgress 才判死：成员是**回合制瞬态**——就绪态零专属进程，无头
 * 回合结束（Stop 钩子 → idle）后宿主进程正常退出，旧 pid 已亡是**正常形态**；只有
 * 「回合还在跑（自述 running）而进程没了」才是崩溃的硬证据。这同时保住桌面会话：
 * 回合间隙（idle）不因旧 pid 误报，进程死由 peer 注册记录路径照常检出。
 *
 * v0.10.0（组 A / R6）：`selfClaimsDead`——记录自述 `dead`（看门狗判亡后
 * markSessionDead 的落盘翻转）且 pid 仍亡。没有它，翻转本身会**熄灭** pid 判据：
 * 记录从 running 变 dead 后 turnInProgress 不再成立，无 peer 记录的引擎成员在后续
 * 扫描里从 pid-dead 退化成 no-record——往轮已认领死亡者的自愈回池（V098-07：停机后
 * 新派给死者的单下一轮回池）随之失效。带上它，同一 pid 的死亡证据跨轮稳定。
 * `liveness` 取值域随 SessionRecord 放开到含 `dead`（本结构型入参同步收，否则
 * SessionRecord 无法直接传入）。
 */
export interface SessionPidEvidence {
  pid: number;
  alive: boolean;
  turnInProgress: boolean;
  /** v0.10.0（组 A / R6）：记录自述 dead（判亡翻转）且时刻可信——pid 判据的第二来源。 */
  selfClaimsDead?: boolean;
}

/**
 * v0.9.4 打回第 1 轮（V094-13）：pid 证据的**单一派生点**（纯函数；存活探测由调用方
 * 注入，本模块仍无 I/O）。
 *
 * 为什么必须单一：V094-13 的形态是「看门狗按 pid 判死并落 member-dead，而
 * xc_overview 三视图仍报 running」——两处各自拼证据时，接线漏一处就产生跨面矛盾。
 * 现在 watchdog（判死发射面）、core/liveness.ts memberLivenessView（展示面）都调本
 * 函数取同一份证据；record 无 pid / pid 非正整数 → undefined（无证据，判据不参与）。
 *
 * `turnInProgress` 的语义见 {@link SessionPidEvidence}：只有「回合中自述且时刻可信」
 * 才让 pid-dead 参与判定——回合间隙（idle）零进程是成员正常形态。
 */
export function deriveSessionPidEvidence(
  record: { pid?: number; liveness?: 'running' | 'idle' | 'dead'; livenessTs?: number } | undefined,
  now: number,
  alive: (pid: number) => boolean,
): SessionPidEvidence | undefined {
  const pid = record?.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    alive: alive(pid),
    turnInProgress: record?.liveness === 'running' && plausibleLivenessTs(record.livenessTs, now),
    // v0.10.0（组 A / R6）：判亡翻转的自述（dead + 可信时刻）——pid 判据的第二来源，
    // 使「member-dead 后注册表翻 dead」不熄灭同一 pid 的死亡证据（自愈回池的前置）。
    // 只在真dead时在场（conditional spread）：非 dead 记录的对象形状逐字节不变
    // （V094-13 的纯判据对拍测试锚定 {pid,alive,turnInProgress} 三键）。
    ...(record?.liveness === 'dead' && plausibleLivenessTs(record.livenessTs, now) ? { selfClaimsDead: true } : {}),
  };
}

/** 离线证据：进程死（硬证据，免空闲阈值）/ 空闲超时（兜底路径）。 */
export type OfflineEvidence = 'process-dead' | 'idle-timeout';

/** 单任务离线判据（§4.1 判定规则）。 */
export interface OfflineVerdict {
  offline: boolean;
  /** offline=false 时为 null（调用方据此跳过，不产升级信号）。 */
  evidence: OfflineEvidence | null;
}

/** 离线成员名下的一项非终态任务（回池/重派面用）。 */
export interface OfflineTaskInfo {
  taskId: string;
  title: string;
  status: TaskStatus;
  /** 该任务无进展时长（分钟，展示取整；判定用毫秒原值，见 offlineVerdict）。 */
  idleForMin: number;
  /**
   * v0.9.1 r3（V090-02）：该任务是否**真被回池**（revokeAttempt 重置回 pending）。
   * false = 活性豁免滞留（任务仍在属主名下、未回池）——C8 转交通知据此分流文案，
   * 不再对豁免任务谎称「requeued to the pending pool」。absent = 旧调用方（默认 true）。
   */
  requeued?: boolean;
  /**
   * v0.9.6（A8/V095-21）：该任务**待回池**的预计回池时刻（epoch ms）——属主已判离线
   * 而任务尚未被 stale 清扫回池的冻结窗内，四面（xc_overview 板面任务行 / Offline 行 /
   * handoff 待回池面 / 死亡告警文案）统一显示「待回池 + 此时刻」，不再出现
   * 「overview 建议重派 vs 任务仍 claimed vs 待领池找不到」的矛盾。
   * 口径 = `task.updatedAt + stale 清扫阈值`（与 graph.staleTasks 同判据；实际回池可能
   * 晚至一个清扫节拍，或在途 wake nonce 豁免会再顺延）。absent = 任务已回池 / 调用方
   * 未注入 stale 阈值（opts.requeueStaleMs；旧调用方零变化）。
   */
  requeueAtMs?: number;
}

/** 一名被判离线的成员 + 其名下**判据命中**的非终态任务。 */
export interface OfflineMember {
  key: string;
  sessionId: string | null;
  liveness: MemberLiveness;
  evidence: OfflineEvidence;
  /** 名下命中任务里最长无进展时长（分钟，展示取整）。 */
  idleForMin: number;
  tasks: OfflineTaskInfo[];
}

/** XC_OFFLINE_MINUTES 缺省（§4.1：240min，长于 stall 120 与 stale 30）。 */
export const DEFAULT_OFFLINE_MINUTES = 240;

/**
 * 成员活性四态判定（纯函数；scan 为调用方的一次只读 peer 扫描结果）。
 *
 * 匹配口径 = **sessionId**（队内成员记录与 peer 注册记录都带它，且会话重启换 pid
 * 不换 sid、roster 侧 joinTeam 会随之更新 sessionId）。不按 peer 花名匹配：花名是
 * peer 轴自由别名，成员可以不注册 peer（那就没有记录），按名匹配会把别人的会话
 * 误挂到该成员头上。
 *
 * 优先级（保守：宁可不判进程死，也不错判）：
 * 1. `active` 里有同 sid 记录 → `live`（调用方 now 晚于扫描时刻、心跳又过期时降级
 *    为 `heartbeat-stale`——扫描分区是扫描时刻的快照，判定时刻才是真时刻）；
 * 2. `dead` 里有同 sid 记录：任一条**不是** pid-dead（pid 仍活着，只是心跳过期；
 *    或 reason 缺失＝没有硬证据）→ `heartbeat-stale`；全部 pid-dead → **先看注册表
 *    会话 pid**：`opts.sessionPid.alive === true`（活证据一票否决，dead 分区记录是旧
 *    化身残留）→ `heartbeat-stale`，否则才 `pid-dead`；
 * 3. 无任何记录（回合间隙 / 从未 peer 注册 / 优雅退出已摘记录）→ `no-record`。
 *
 * v0.9.4（A1）增量：第 3 类补**会话记录 pid 判据**——peer 注册表没有该 sid 的记录
 * （引擎成员从未 xc_identify、或优雅退出已摘记录撞上进程死）时，会话记录的 pid
 * （SessionStart 钩子写的宿主进程 pid）+ 回合中自述 = 第二条进程死硬证据：
 * `turnInProgress ∧ ¬alive` → `pid-dead`。判据只补第 3 类空档：active 分区有记录
 * （有进程活着且在心跳）或 dead 分区有 lastSeen-stale 记录（有进程活着只是沉默）
 * 时都不改判——保守方向不变，peer 证据与 pid 证据冲突时活证据优先。
 * v0.10.0（集成员·第 5 轮 / 真实复测 mustFix #1）增量：上句「冲突时活证据优先」补到
 * **第 2 类的 dead 分区分支**——此前该分支在全 pid-dead 时直接 return，注册表里活着的
 * 新 pid 从不被咨询（pid 证据只在无任何 peer 记录时才被咨询），与自述原则自相矛盾。
 * 现在 dead 分区全部 pid-dead ∧ `opts.sessionPid.alive === true` → `heartbeat-stale`
 * （活 pid 一票否决）；无证据 / alive=false 仍 `pid-dead`（不放松既有判死）。
 *
 * v0.10.0（组 A / R6）增量：pid 判据的第二来源补 `selfClaimsDead`——记录自述
 * `dead`（看门狗判亡翻转，markSessionDead 落盘）且 pid 仍亡 ⇒ 同样 `pid-dead`。
 * 修「翻转熄灭判据」：不补它，member-dead 之后记录从 running 变 dead，
 * turnInProgress 不再成立，无 peer 记录的引擎成员在后续扫描里退化成 no-record，
 * 往轮已死者的自愈回池（V098-07）随之失效。
 */
export function memberLiveness(
  member: TeamMember,
  scan: PeerScanResult,
  now: number,
  opts: { staleMs?: number; sessionPid?: SessionPidEvidence } = {},
): MemberLiveness {
  const staleMs = opts.staleMs ?? PEER_STALE_MS;
  const live = scan.active.find((record) => record.sessionId === member.sessionId);
  if (live !== undefined) {
    return now - live.lastSeen > staleMs ? 'heartbeat-stale' : 'live';
  }
  const dead = scan.dead.filter((row) => row.record.sessionId === member.sessionId);
  if (dead.length === 0) {
    // v0.9.4（A1）：无 peer 记录时，会话记录 pid + running 自述 = 进程死硬证据。
    // v0.10.0（组 A / R6）：追加 `dead` 自述（看门狗判亡翻转的落盘值）——同一 pid 的
    // 死亡证据不因翻转熄灭，往轮已认领死者的自愈回池（V098-07）照常工作。
    const pidEvidence = opts.sessionPid;
    if (pidEvidence !== undefined && !pidEvidence.alive
      && (pidEvidence.turnInProgress || pidEvidence.selfClaimsDead === true)) {
      return 'pid-dead';
    }
    return 'no-record';
  }
  if (dead.some((row) => row.reason !== 'pid-dead')) return 'heartbeat-stale';
  // v0.10.0（集成员·第 5 轮 / 真实复测 mustFix #1）：**注册表活 pid 一票否决**——dead 分区
  // 里同 sid 的记录可能是**旧化身残留**（会话重启换 pid 不换 sid；曾 xc_identify 的会话
  // 当前回合不刷新 peer 端点时，扫描只剩 60s 后失效的旧端点记录、其 pid 已亡）。注册表
  // 会话记录的 pid 活着（SessionStart 钩子写的宿主进程 pid）= 硬活证据：peer 证据与 pid
  // 证据冲突时**活证据优先**（:155-167 的自述原则，v0.9.4 起只在「无任何 peer 记录」的
  // 第 3 类空档里落实，dead 分区分支漏了——生产实测主控保活进程全程存活仍于 02:11:39 被
  // 判 pid-dead 并连锁唤醒 m1/m2，即此形态）。
  // 判 `heartbeat-stale` 而非 `live`：没有心跳证据证明它在协作面上活着，只证明进程没死
  // （宁可不判进程死，也不错判——:155 的保守方向不变）。无 sessionPid 证据或 alive=false
  // 时维持 `pid-dead` 不变（不放松既有判死）。
  if (opts.sessionPid?.alive === true) return 'heartbeat-stale';
  return 'pid-dead';
}

/**
 * v0.10.0（组 A / R3/G-29）：**判亡前的四道校验之前三道**（纯函数；第④道二次确认的
 * 跨周期账在看门狗台账，见 engine/watchdog.ts）。
 *
 * 缺陷形态（生产实测，21 次 member-dead 全部 pid-dead/process-dead）：
 * 唤醒子启动窗内旧 pid 已亡、新 pid 未写回注册表（或唤醒 child 退出后回合仍在跑），
 * 看门狗以注册表存储的旧 pid 判 `member-dead` → V098-07 无人认领回池 → 撤回派单回执
 * （"revoked: member became unavailable (member-dead)"）。看门狗**已经握有**在途唤醒
 * 数据（nonce 账本 / wake 生命周期账）却只用于 limbo 候选判定，没用在判死路径上。
 *
 * 判据（任一命中即**不判亡**——方向保守：漏报一次死亡有 stale 清扫与下一轮兜底，
 * 误判亡会撤回在途派单、惊动 lead）：
 * 1. **在途唤醒**（`wake` 块）：fresh 未消费 nonce（§2.5-3 在途标记）∨ 生命周期账
 *    start 头行无 exit 尾行且未过 15min 窗 ∨ spawn 后 60s 内还没见到 session-running
 *    ∨ 唤醒子 pid 活着——此时以唤醒子进程的 pid 或最新注册的 pid 为准，记录里的旧
 *    pid 亡不算死（G-29 修法①②）；
 * 2. **在途任务**（`openTaskCount`）：成员名下 claimed/in_progress 任务 > 0——
 *    在途即活（17:42:11 误判实例：t111 正在跑却被判亡，R3 修法③）；
 * 3. **更新的 pid**（`newerPidAlive`）：记录 pid 亡但注册表里已有更新的活 pid
 *    （SessionStart 钩子已写回新 pid / 唤醒子 pid 活着）——不算死（R3 修法③）。
 *
 * 输入全部由调用方读盘后注入（本模块无 I/O 纪律不变）；`now` 注入保持纯度。
 */
export interface DeathGuardInput {
  /** 在途唤醒证据（调用方读 registry/wake nonce 账 + logs 生命周期账 + 证言后注入）。 */
  wake: {
    /** 存在 fresh（未消费 ∧ 15min 窗内）的有活体证据 nonce（§2.5-3 在途标记）。 */
    inflightNonce: boolean;
    /** 生命周期账里最近一次 spawn 有 start 头行且无 exit 尾行（唤醒子可能仍在跑）。 */
    lifecycleStartNoExit: boolean;
    /** 该 start 头行的 spawn 时刻（epoch ms；undefined = 无 spawn 证据）。 */
    lastSpawnTs?: number;
    /** spawn 之后是否已见到 session-running（引擎证言 kind='running' 且 ts ≥ spawn）。 */
    sessionRunningSinceSpawn: boolean;
    /** 唤醒子 pid（生命周期账 start-confirmed 行汇报的 pid）是否活着。 */
    wakeChildPidAlive: boolean;
  };
  /** 成员名下 claimed/in_progress 任务数（任务板快照）。 */
  openTaskCount: number;
  /** 注册表里是否有比记录 pid 更新且活着的 pid（新 pid 已写回 / 唤醒子 pid 活着）。 */
  newerPidAlive: boolean;
  /** 判定时刻（注入）。 */
  now: number;
  /** 唤醒启动窗（ms）：spawn 后这么久内没见到 session-running 即豁免（R3 修法②）。 */
  wakeStartWindowMs?: number;
}

/** 判亡校验裁决：`exempt` = 不判亡（任一校验命中）；`reasons` = 命中的校验名（审计用）。 */
export interface DeathGuardVerdict {
  exempt: boolean;
  reasons: Array<'inflight-wake' | 'open-tasks' | 'newer-pid'>;
}

/** 唤醒启动窗缺省值（ms）：spawn 后 60s 内没见到 session-running 不判亡（R3 修法②）。 */
export const DEATH_GUARD_WAKE_START_WINDOW_MS = 60_000;

/** 生命周期账「start 无 exit」的在途窗（ms）——与 engine/wake.ts WAKE_INFLIGHT_MS 同值
 *  （15min；强杀唤醒子可能不留 exit 尾行，窗后不再无限豁免）。 */
export const DEATH_GUARD_LIFECYCLE_INFLIGHT_MS = 15 * 60_000;

export function sessionDeathGuard(input: DeathGuardInput): DeathGuardVerdict {
  const reasons: DeathGuardVerdict['reasons'] = [];
  const wakeStartWindowMs = input.wakeStartWindowMs ?? DEATH_GUARD_WAKE_START_WINDOW_MS;
  const spawnAgeMs = input.wake.lastSpawnTs === undefined
    ? undefined
    : input.now - input.wake.lastSpawnTs;
  const inflightWake = input.wake.inflightNonce
    || (input.wake.lifecycleStartNoExit && spawnAgeMs !== undefined && spawnAgeMs < DEATH_GUARD_LIFECYCLE_INFLIGHT_MS)
    || (spawnAgeMs !== undefined && spawnAgeMs < wakeStartWindowMs && !input.wake.sessionRunningSinceSpawn)
    || input.wake.wakeChildPidAlive;
  if (inflightWake) reasons.push('inflight-wake');
  if (input.openTaskCount > 0) reasons.push('open-tasks');
  if (input.newerPidAlive) reasons.push('newer-pid');
  return { exempt: reasons.length > 0, reasons };
}

/**
 * 单任务离线判据（§4.1 判定规则，保守）：
 *
 * - `removed` 成员（xc_team member-stop 已回池其开放任务并留档）= 显式生命周期终态，
 *   「不在册」不是「离线」——不产升级信号，否则每次清理成员都惊动 lead；
 * - `pid-dead` → **免 240min 空闲阈值**：崩溃成员的 fresh 任务也要能立刻标出
 *   「这个成员没了」（回池快刀仍是 stale 30min 的职责，C8 的增量是证据标注与
 *   lead 通知，不是更快的回池）；
 * - 其余活性态（live / heartbeat-stale / no-record）→ 只有任务无进展超
 *   `thresholdMs` 才判离线（兜底路径：可达性窄，见 §4.1 可达性如实声明）。
 */
export function offlineVerdict(
  task: Task,
  member: TeamMember,
  liveness: MemberLiveness,
  now: number,
  thresholdMs: number,
): OfflineVerdict {
  if (memberState(member) === 'removed') return { offline: false, evidence: null };
  if (liveness === 'pid-dead') return { offline: true, evidence: 'process-dead' };
  const idleMs = now - lastProgressTs(task);
  if (idleMs > thresholdMs) return { offline: true, evidence: 'idle-timeout' };
  return { offline: false, evidence: null };
}

/**
 * 团队内当前离线成员清单（§4.2 转交面 / §4.3 overview 挂载共用）。
 *
 * 只收**判据命中**的成员：名下非终态任务里至少一条 offlineVerdict 命中；`tasks`
 * 同样只列命中的那些（未命中的任务不该被建议重派——「alive-idle 任务不被误标」的
 * 验收口径在任务级成立，AC8）。名下无任何任务的成员不进清单（没有可转交物）。
 *
 * v0.9.5（A3/V094-14）：`opts.sessionPidFor`——**成员 → 会话记录 pid 证据**的注入面
 * （调用方读 sessions/<sid>.json 并经 {@link deriveSessionPidEvidence} 派生后按成员
 * 给出；本模块保持无 I/O）。不注入时与 v0.9.4 行为一致（pid 判据不参与）——那正是
 * V094-14 的跨面矛盾根源：成员行（memberLivenessView 现场派生 pid 证据）判 dead，
 * 本清单却因「无 pid 证据」报 null。接线后清单与展示面/判死面同判据：pid-dead 成员
 * 的名下任务命中 process-dead（免 240min 阈值），照常列入 + 转交通知。
 */
export function offlineMembers(
  team: TeamState,
  scan: PeerScanResult,
  now: number,
  thresholdMs: number,
  opts: {
    staleMs?: number;
    sessionPidFor?: (member: TeamMember) => SessionPidEvidence | undefined;
    /**
     * v0.9.6（A8/V095-21）：stale 清扫阈值（ms，XC_STALE_TASK_MINUTES 的生效值）——
     * 注入后每个命中任务带 `requeueAtMs = task.updatedAt + 本值`（待回池的预计回池时刻，
     * 见 {@link OfflineTaskInfo.requeueAtMs}）。不注入 = 旧调用方零变化（字段缺席）。
     */
    requeueStaleMs?: number;
  } = {},
): OfflineMember[] {
  const out: OfflineMember[] = [];
  const requeueStaleMs = typeof opts.requeueStaleMs === 'number' && Number.isFinite(opts.requeueStaleMs) && opts.requeueStaleMs > 0
    ? opts.requeueStaleMs
    : undefined;
  for (const member of team.members) {
    const liveness = memberLiveness(member, scan, now, {
      staleMs: opts.staleMs,
      sessionPid: opts.sessionPidFor?.(member),
    });
    const hits: OfflineTaskInfo[] = [];
    let worstIdleMs = 0;
    let evidence: OfflineEvidence | null = null;
    for (const task of team.tasks) {
      if (task.assignee !== member.key) continue;
      if (TERMINAL_TASK_STATUSES.includes(task.status)) continue;
      const verdict = offlineVerdict(task, member, liveness, now, thresholdMs);
      if (!verdict.offline || verdict.evidence === null) continue;
      const idleMs = Math.max(0, now - lastProgressTs(task));
      if (idleMs > worstIdleMs) worstIdleMs = idleMs;
      hits.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        idleForMin: Math.round(idleMs / 60_000),
        // v0.9.6（A8/V095-21）：待回池的预计回池时刻（updatedAt + stale 阈值，与
        // graph.staleTasks 同判据）。任务被豁免/在途 nonce 顺延时时刻会漂移——展示面
        // 口径如实按「无干扰时的清扫到期时刻」。
        ...(requeueStaleMs !== undefined ? { requeueAtMs: task.updatedAt + requeueStaleMs } : {}),
      });
      if (evidence === null) evidence = verdict.evidence;
    }
    if (evidence === null) continue; // 名下任务都未达离线判据 → 不列入
    out.push({
      key: member.key,
      sessionId: member.sessionId ?? null,
      liveness,
      evidence,
      idleForMin: Math.round(worstIdleMs / 60_000),
      tasks: hits,
    });
  }
  return out;
}

/**
 * 阈值解析与钳制（同 stall.ts:86-92 模式）：XC_OFFLINE_MINUTES 缺省 240min；
 * 小于 stale 清扫阈值（XC_STALE_TASK_MINUTES，缺省 30min）时按 stale 钳制并返回
 * `clamped`——离线阈值若低于 stale，无进展任务会先被 stale 收走，idle-timeout 分支
 * 永远轮不到，钳制保住「30 < 240 ⇒ stale 先动、C8 永不抢先」的边界（§4.2）。
 * 挂载面据此附 WARNING（同 stall 钳制告警）。
 *
 * v0.7.2（红队五番战 C8-B4 修复）：**0/负数/非数字不再静默回落**。
 * 红队实测：`XC_OFFLINE_MINUTES=0`（及 `-5`）时 overview 无
 * `offlineThresholdClamped`、无 WARNING——env 明明设了却被当「未设」处理，
 * 运维无法分辨「我没配」与「我配了但值被拒」。现在显式分辨三态：
 * - `clamped`：有效正值但低于 stale → 按 stale 钳制（原有披露）；
 * - `fellBack`：env 有值但非法（非有限/≤0/不可解析）→ 回落**内置缺省** 240min
 *   （安全方向：离线判定取最保守阈值），并由挂载面附 WARNING 披露；
 * - 两者皆 false = 未设置（或缺省空串）→ 就是缺省 240min，无需披露。
 */
export function offlineThresholdMsFromEnv(
  env: NodeJS.ProcessEnv,
  staleThresholdMs: number,
): { ms: number; clamped: boolean; fellBack: boolean } {
  const raw = env['XC_OFFLINE_MINUTES'];
  const provided = typeof raw === 'string' && raw.trim() !== '';
  const n = provided ? Number(raw) : Number.NaN;
  const valid = Number.isFinite(n) && n > 0;
  const minutes = valid ? n : DEFAULT_OFFLINE_MINUTES;
  const fellBack = provided && !valid;
  const staleMinutes = Math.round(staleThresholdMs / 60_000);
  // 两态可并存：非法值回落 240 后仍可能低于 stale（超大 stale 阈值）——钳制与
  // 回落各自披露，挂载面两条 WARNING 都出。
  if (minutes < staleMinutes) return { ms: staleThresholdMs, clamped: true, fellBack };
  return { ms: minutes * 60_000, clamped: false, fellBack };
}

/**
 * 转交建议文案（单源：sweeper 的 lead 通知与 overview 行共用，避免两处文案漂移）。
 * 不新增工具/动作——「回池 / 转交指定成员」由 lead 用现成 xc_dispatch 完成（§4.2）。
 *
 * v0.9.6（A8/V095-21）：process-dead 文案不再谎称「名下任务已回池」——死亡成员的
 * 任务在 stale 清扫到期前是**冻结**的（仍 claimed/in_progress 挂在死者名下，待领池
 * 找不到），如实写「由 stale 清扫按阈值自动回池 + 板面 requeueAtMs 时刻」。
 */
export function offlineSuggestion(evidence: OfflineEvidence): string {
  if (evidence === 'process-dead') {
    return '成员进程已亡（崩溃残留记录）——名下任务由 stale 清扫按阈值自动回池'
      + '（板面 offlineMembers[].tasks[].requeueAtMs 为预计回池时刻），回池后用 xc_dispatch 重派给指定成员';
  }
  return '任务长时间无进展且判定该成员离线——用 xc_dispatch 重派给指定成员或 xc_team({action:"cancel"})';
}

/**
 * overview 文本行的成员片段（§4.3 行格式：`<名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)`）。
 *
 * v0.9.6（A8/V095-21）：任务带 `requeueAtMs`（调用方注入 requeueStaleMs）时，行内
 * 如实列出「待回池 <taskId>@<ISO 时刻>」——与板面任务行 / handoff 待回池面 / 死亡
 * 文案四面同口径；不带 requeueAtMs（旧调用方）时行格式逐字节不变。
 */
export function offlineMemberLine(member: OfflineMember): string {
  const requeueable = member.tasks.filter((t) => typeof t.requeueAtMs === 'number');
  const requeueNote = requeueable.length === member.tasks.length && requeueable.length > 0
    ? `：待回池 ${requeueable.map((t) => `${t.taskId}@${new Date(t.requeueAtMs!).toISOString()}`).join(', ')}`
    : '';
  return `${member.key}(${member.evidence}, 名下任务 ${member.tasks.length} 个${requeueNote} → 建议 xc_dispatch 重派)`;
}
