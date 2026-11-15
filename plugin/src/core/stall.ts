/**
 * v0.6 C5：停滞检测纯函数（DESIGN-V0.6.md §3.5 / §4.2-M5）。
 *
 * 无 I/O、无时钟副作用（now 注入）、无定时器（平台纪律：读时计算，发现时延 =
 * overview 轮询节拍，不是产品承诺常驻监控）。挂载点 = xc_overview team/panel
 * （M1 工具面）；阈值钳制引用 stale 阈值（task-edges.staleThresholdMsFromEnv）。
 *
 * @module core/stall
 */
import type { Task, TaskStatus } from './types.js';

export interface StallFlag {
  taskId: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  idleForMin: number;
  /** stalled=无进展超阈；blocked-long=显式阻塞超阈（建议行不同：解除/取消）。 */
  kind: 'stalled' | 'blocked-long';
}

/**
 * 最后进展时刻（epoch ms）——停滞检测（本模块）与 C8 离线 idle-timeout 判据
 * （core/offline.ts offlineVerdict）共用的单一事实源。
 *
 * v0.7.2（红队五番战 C8-B2 修复）：口径修正 + 落盘镜像。
 *
 * 1. **落盘镜像**：v0.7.2 起任务记录带 `lastProgressTs` 字段（PROTOCOL §12.1
 *    的 `task.lastProgressTs`），由 teamstate.appendTaskHistory（全部状态转移的
 *    唯一收口点）随 history 末条同步刷新——观测面（xc_read/板面）可直读，不必
 *    回溯 history。此前该字段不存在：离线判定的空闲源在磁盘上不可见，协议字面
 *    （§12.1 `now - task.lastProgressTs > XC_OFFLINE_MINUTES`）与实现脱节。
 * 2. **口径修正**：旧实现 = `max(createdAt, history 末条 ts)`。对自洽记录两者
 *    恒等（history 条目必然晚于建单），但按「回拨 updatedAt + 末条 history.ts」
 *    的既定时间加速手段（红队/验收模拟「N 分钟无进展」的标准做法）构造记录时，
 *    createdAt 下限会把回拨吞掉——黑盒复现里 idle-timeout 分支因此从未命中
 *    （C8-B2：判据看似死分支）。新口径 = 两个进展 Marker（history 末条 ts 与
 *    落盘 lastProgressTs）中**较旧**的一个；两者由同一收口点维护、正常记录恒等，
 *    取值分歧只可能是外部改写（时间加速/损坏），此时采纳较旧者——停滞/空闲是
 *    「宁可提示、不可漏报」的观测信号，保守方向正确。history 为空（从未有进展）
 *    时再退回 createdAt（含 makeTask 落盘的初值）。
 *
 * 兼容：v0.7.2 之前的存量记录无 `lastProgressTs` 字段 → 按 history 末条推导，
 * 自洽记录与旧口径结果一致（旧口径的 createdAt 下限只对外部改写记录生效）。
 */
export function lastProgressTs(task: Task): number {
  const markers: number[] = [];
  const last = task.history.length > 0 ? task.history[task.history.length - 1]!.ts : 0;
  if (Number.isFinite(last) && last > 0) markers.push(last);
  if (typeof task.lastProgressTs === 'number' && Number.isFinite(task.lastProgressTs) && task.lastProgressTs > 0) {
    markers.push(task.lastProgressTs);
  }
  if (markers.length > 0) return Math.min(...markers);
  return task.createdAt;
}

/**
 * 停滞任务旗标（§3.5：非终态 ∧ now - lastProgressTs > thresholdMs）。
 *
 * - blocked **不算 stalled**（阻塞是显式状态）：超阈的 blocked 以 kind:'blocked-long'
 *   单列，idleForMin 记 blocked 时长（blockedAt 起算；缺失时退回 lastProgress），
 *   建议行 = 处理阻塞原因（xc_team unblock）或 cancel。
 * - 终态（completed/failed/cancelled）永不进旗标。
 * - 边界判定用毫秒原值比较（> thresholdMs 严格大于），idleForMin 仅作展示取整——
 *   避免「119.6min 取整成 120min 被误判超阈」的分钟取整 off-by-one。
 */
export function stalledTasks(tasks: readonly Task[], now: number, thresholdMs: number): StallFlag[] {
  const out: StallFlag[] = [];
  for (const t of tasks) {
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') continue;
    if (t.status === 'blocked') {
      const blockedMs = t.blockedAt !== undefined ? now - t.blockedAt : now - lastProgressTs(t);
      if (blockedMs > thresholdMs) {
        out.push({
          taskId: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          idleForMin: Math.max(0, Math.round(blockedMs / 60_000)),
          kind: 'blocked-long',
        });
      }
      continue; // blocked 未超阈不算 stalled（阻塞是显式状态）
    }
    const idleMs = now - lastProgressTs(t);
    if (idleMs > thresholdMs) {
      out.push({
        taskId: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        idleForMin: Math.max(0, Math.round(idleMs / 60_000)),
        kind: 'stalled',
      });
    }
  }
  return out;
}

/** XC_STALL_MINUTES 缺省（方案 C5「默认 2h，可配」）。 */
export const DEFAULT_STALL_MINUTES = 120;

/**
 * 阈值解析与钳制：stall 阈值不得小于 stale 阈值（XC_STALE_TASK_MINUTES 缺省 30min，
 * task-edges.staleThresholdMsFromEnv）——否则 sweeper 先把无在途唤醒的死任务收走，
 * stall 永远轮不到展示；钳制时返回 clamped:true，由挂载面在 payload 附 WARNING。
 *
 * @param env 进程环境（XC_STALL_MINUTES，分钟；非有限正数取缺省 120）。
 * @param staleThresholdMs 僵尸清扫阈值（毫秒，调用方从 staleThresholdMsFromEnv 取）。
 */
export function stallThresholdMs(env: NodeJS.ProcessEnv, staleThresholdMs: number): { ms: number; clamped: boolean } {
  const raw = Number(env['XC_STALL_MINUTES']);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MINUTES;
  const staleMinutes = Math.round(staleThresholdMs / 60_000);
  if (minutes < staleMinutes) return { ms: staleThresholdMs, clamped: true };
  return { ms: minutes * 60_000, clamped: false };
}

/** 停滞建议行（§3.5 呈现；挂载面直接拼进 overview 行）。 */
export function stallSuggestion(kind: StallFlag['kind'], status: TaskStatus): string {
  if (kind === 'blocked-long') return '处理阻塞原因（xc_team unblock）或 cancel';
  if (status === 'pending') return '检查依赖或 cancel';
  return 'relay 催办 / cancel / 重派（转交）';
}
