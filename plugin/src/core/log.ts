/**
 * M1 core-store: engine audit log (logs/engine.jsonl).
 *
 * One line per state transition / delivery / wake / malformed-line event
 * (DESIGN.md §2.2, §4.3): `{ts, event, ...fields}`. The audit log is
 * best-effort: a logging failure must never break the business operation it
 * observes, so logEngineEvent swallows its own write errors.
 *
 * v0.5.2（故障注-3 修复）：吞掉写失败的同时，把「审计正在丢失」的事实记进
 * 进程内台账（auditDegradation）——此前 engine.jsonl 被目录占用/不可写时
 * 全部工具照常成功、审计静默全丢、工具面零诊断（红队二番战 FI-6c/FI-9a）。
 * 台账由工具面 wrapper 取出渲染为响应内联告警（mcp/tools.ts 的 runCore 与
 * mcp/peer-tools.ts 的 call），审计恢复（下一次写成功）即自动清除。
 *
 * @module core/log
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendJsonl } from './jsonl.js';
import { engineLogFile, logsDir } from './paths.js';

export interface EngineEvent {
  event: string;
  [field: string]: unknown;
}

/** 单个状态根的审计降级事实（v0.5.2 故障注-3）。 */
export interface AuditDegradation {
  /** 目标审计文件路径（诊断用）。 */
  file: string;
  /** 首次失败的错误信息（后续同因失败不覆盖，保持首因）。 */
  error: string;
  /** 自首次失败以来被丢弃的事件条数。 */
  dropped: number;
  firstFailureAt: number;
  lastFailureAt: number;
}

/** 台账容量上限：一个 server 进程通常只有一个状态根；多余条目防内存无界。 */
const MAX_TRACKED_ROOTS = 16;

const degradations = new Map<string, AuditDegradation>();

/**
 * v0.5.2（故障注-3 修复）：查询某状态根的审计降级事实（undefined = 健康）。
 * 只读快照；清除只由 logEngineEvent 写成功时自动完成。
 */
export function auditDegradation(stateRoot: string): AuditDegradation | undefined {
  return degradations.get(resolve(stateRoot));
}

/**
 * v0.5.2（故障注-3 修复）：审计降级的工具面告警行（undefined = 健康，无需披露）。
 * 文案带首因错误、丢弃计数与恢复动作指引——与 inbox 坏行的
 * `N unreadable line(s) skipped`、peer 的 `peer-frame-rejected` 同一披露口径。
 */
export function auditDegradationWarning(stateRoot: string): string | undefined {
  const degradation = auditDegradation(stateRoot);
  if (degradation === undefined) return undefined;
  return (
    `WARNING engine audit log is not writable (${degradation.error}); `
    + `${degradation.dropped} audit event(s) dropped since ${new Date(degradation.firstFailureAt).toISOString()} — `
    + `the audit trail for this workspace is incomplete. `
    + `Restore writability of "${degradation.file}" (fix permissions or remove whatever occupies that path) to resume logging.`
  );
}

/**
 * Append one engine event line. Never throws: audit logging is best-effort.
 * The event's `ts` is stamped here (callers may not override it).
 *
 * v0.5.2（故障注-3 修复）：写失败不再完全无声——记入进程内降级台账
 * （工具面据此披露）；写成功即清除该状态根的降级记录（恢复自动复明）。
 */
export async function logEngineEvent(stateRoot: string, event: EngineEvent): Promise<void> {
  const key = resolve(stateRoot);
  try {
    await mkdir(logsDir(stateRoot), { recursive: true });
    const { event: name, ...fields } = event;
    await appendJsonl(engineLogFile(stateRoot), [JSON.stringify({ ts: Date.now(), event: name, ...fields })]);
    degradations.delete(key);
  } catch (error) {
    const now = Date.now();
    const previous = degradations.get(key);
    degradations.set(key, {
      file: engineLogFile(stateRoot),
      error: previous?.error ?? (error instanceof Error ? error.message : String(error)),
      dropped: (previous?.dropped ?? 0) + 1,
      firstFailureAt: previous?.firstFailureAt ?? now,
      lastFailureAt: now,
    });
    // 有界台账：只留最早插入的 MAX_TRACKED_ROOTS 个状态根（Map 保序）。
    if (degradations.size > MAX_TRACKED_ROOTS) {
      const oldest = degradations.keys().next();
      if (!oldest.done) degradations.delete(oldest.value);
    }
  }
}

/** Alias of logEngineEvent (module-2/3 call name). */
export const appendEngineLog = logEngineEvent;
