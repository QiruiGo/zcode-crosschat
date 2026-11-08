/**
 * M1 core-store: engine audit log (logs/engine.jsonl).
 *
 * One line per state transition / delivery / wake / malformed-line event
 * (DESIGN.md §2.2, §4.3): `{ts, event, ...fields}`. The audit log is
 * best-effort: a logging failure must never break the business operation it
 * observes, so logEngineEvent swallows its own write errors.
 *
 * @module core/log
 */
import { mkdir } from 'node:fs/promises';
import { appendJsonl } from './jsonl.js';
import { engineLogFile, logsDir } from './paths.js';

export interface EngineEvent {
  event: string;
  [field: string]: unknown;
}

/**
 * Append one engine event line. Never throws: audit logging is best-effort.
 * The event's `ts` is stamped here (callers may not override it).
 */
export async function logEngineEvent(stateRoot: string, event: EngineEvent): Promise<void> {
  try {
    await mkdir(logsDir(stateRoot), { recursive: true });
    const { event: name, ...fields } = event;
    await appendJsonl(engineLogFile(stateRoot), [JSON.stringify({ ts: Date.now(), event: name, ...fields })]);
  } catch {
    // Best-effort audit log: swallow write failures (disk full, permissions...).
  }
}

/** Alias of logEngineEvent (module-2/3 call name). */
export const appendEngineLog = logEngineEvent;
