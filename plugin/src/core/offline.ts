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
import { TERMINAL_TASK_STATUSES, memberState, type Task, type TaskStatus, type TeamMember, type TeamState } from './types.js';

/** 成员活性四态（DESIGN-V0.7 §4.1 表）。 */
export type MemberLiveness = 'live' | 'pid-dead' | 'heartbeat-stale' | 'no-record';

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
 *    或 reason 缺失＝没有硬证据）→ `heartbeat-stale`；全部 pid-dead → `pid-dead`；
 * 3. 无任何记录（回合间隙 / 从未 peer 注册 / 优雅退出已摘记录）→ `no-record`。
 */
export function memberLiveness(
  member: TeamMember,
  scan: PeerScanResult,
  now: number,
  opts: { staleMs?: number } = {},
): MemberLiveness {
  const staleMs = opts.staleMs ?? PEER_STALE_MS;
  const live = scan.active.find((record) => record.sessionId === member.sessionId);
  if (live !== undefined) {
    return now - live.lastSeen > staleMs ? 'heartbeat-stale' : 'live';
  }
  const dead = scan.dead.filter((row) => row.record.sessionId === member.sessionId);
  if (dead.length === 0) return 'no-record';
  if (dead.some((row) => row.reason !== 'pid-dead')) return 'heartbeat-stale';
  return 'pid-dead';
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
 */
export function offlineMembers(
  team: TeamState,
  scan: PeerScanResult,
  now: number,
  thresholdMs: number,
  opts: { staleMs?: number } = {},
): OfflineMember[] {
  const out: OfflineMember[] = [];
  for (const member of team.members) {
    const liveness = memberLiveness(member, scan, now, opts);
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
 */
export function offlineSuggestion(evidence: OfflineEvidence): string {
  if (evidence === 'process-dead') {
    return '成员进程已亡（崩溃残留记录）——名下任务已回池，用 xc_dispatch 重派给指定成员';
  }
  return '任务长时间无进展且判定该成员离线——用 xc_dispatch 重派给指定成员或 xc_team({action:"cancel"})';
}

/** overview 文本行的成员片段（§4.3 行格式：`<名>(证据, 名下任务 n 个 → 建议 xc_dispatch 重派)`）。 */
export function offlineMemberLine(member: OfflineMember): string {
  return `${member.key}(${member.evidence}, 名下任务 ${member.tasks.length} 个 → 建议 xc_dispatch 重派)`;
}
