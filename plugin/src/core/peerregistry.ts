/**
 * W1 peer-registry: the machine-global peer record store.
 *
 * Mechanism baseline (CC, read from the bundle — see 11-cc逆向.md §3.b):
 * - one record per session, file name = pid (`sessions/<pid>.json`, @4326698/
 *   @4327411); the scanner only accepts `/^\d+\.json$/` and parses the pid out
 *   of the file name (`NXi`, @3309289);
 * - single record read cap 262144 B (`RUt`, @3309289);
 * - update = read-merge-write (`xn()`, @4332192), patch carries `updatedAt`;
 * - liveness = process alive (+ procStart match in CC, `Y()`, @9597797);
 * - records of a foreign `pidDomain` never enter the local discovery set
 *   (`ne()`, @9603429);
 * - dead owners' key files are swept lazily (`Ee()`, @3374556).
 *
 * v0.3 deviations (DESIGN-V0.3.md §3.2-§3.4, all deliberate and marked there):
 * - `peerFeatures` is written EMPTY: the two CC features (notify_idle /
 *   artifact_yield) are not implemented in v0.3, and advertising an
 *   unimplemented capability is lying (SPEC R-34 / DESIGN §3.2 修正);
 * - `procStart` is reserved but not populated (the Windows acquisition method
 *   was not measured — DESIGN §12 V-P2); liveness therefore approximates with
 *   `pid alive AND lastSeen fresh`;
 * - `tmux` / `bridgeSessionId` / `asksForConvertedSkills` are cut (no tmux, no
 *   bridge, no such negotiation bit).
 *
 * Discipline that MUST survive into production (FEASIBILITY-V0.3 §5.4):
 * 1. every write is atomic (core/atomic.ts tmp+rename with the Windows
 *    EPERM/EBUSY/EEXIST retry + direct-write degradation) — a non-atomic
 *    overwrite was observed to be read as half JSON;
 * 2. a failed write NEVER crashes the caller (the R2 run had a heartbeat
 *    process die on an unhandled rename EPERM);
 * 3. name-occupancy checks filter dead pids, otherwise a dead peer keeps its
 *    name forever and a revived peer can never register (T5 E7);
 * 4. two scanners may sweep the same batch — ENOENT must be tolerated.
 *
 * @module core/peerregistry
 */
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { appendJsonl } from './jsonl.js';
import { pidAlive, withFileLock } from './lock.js';
import {
  isLocalPidDomain,
  localPidDomain,
  peerAuditLogFile,
  peerKeyFile,
  peerRecordFile,
  peerSessionsDir,
} from './peerdir.js';

/** Single record read cap (CC `RUt` = 262144, @3309289). */
export const PEER_RECORD_MAX_BYTES = 262_144;
/** Key file read cap (CC `R` = 4096, @3374186). */
export const PEER_KEY_MAX_BYTES = 4096;
/** Staleness window: a peer whose lastSeen is older is considered dead. */
export const PEER_STALE_MS = 60_000;
/** Heartbeat cadence the registration side is expected to use (4x margin). */
export const PEER_HEARTBEAT_MS = 15_000;
/** formerNames FIFO cap (SPEC R-10; CC token list cap `Mjn` = 32). */
export const PEER_FORMER_NAMES_MAX = 32;
/** Current peer protocol version (CC `rq` = 1, @4323352). */
export const PEER_PROTOCOL_VERSION = 1;
/** Registry lock budget (the hook runner kills hooks at 10 s). */
export const PEER_LOCK_WAIT_MS = 3_000;

/** The peer registry record (DESIGN-V0.3 §3.2 schema). */
export interface PeerRecord {
  /** Process id — the file name IS the pid. */
  pid: number;
  /** Session id (`sess_…`). */
  sessionId: string;
  /** Messaging endpoint (Windows named pipe path). */
  messagingSocketPath: string;
  /** Machine-domain digest; foreign-domain records are not discoverable. */
  pidDomain: string;
  /** Protocol version. */
  peerProtocol: number;
  /** Advertised features — empty in v0.3 (nothing is implemented). */
  peerFeatures: string[];
  /** `interactive` (hosted session) | `bg` (background turn). */
  kind: 'interactive' | 'bg';
  /** Addressable name (unique per machine). */
  name?: string;
  /** Display name (may contain CJK; never used for addressing). */
  displayName?: string;
  /** Released names (rename history), FIFO cap 32. */
  formerNames: { name: string; releasedAt: number }[];
  /** Team member sessions record their lead's session id. */
  hostSessionId?: string;
  /** Workspace root (ZCODE_PROJECT_DIR). */
  workspace?: string;
  /** Working directory. */
  cwd?: string;
  /** Process start time (reserved; Windows acquisition unmeasured). */
  startedAt: number;
  /** Last heartbeat. */
  lastSeen: number;
  /** Process creation time (reserved). */
  procStart?: number;
  /** `busy | shell | idle | waiting`. */
  status?: 'busy' | 'shell' | 'idle' | 'waiting';
  /** `active | idle | blocked`. */
  tempo?: 'active' | 'idle' | 'blocked';
  /** Record update time. */
  updatedAt?: number;
  /** Status change time. */
  statusUpdatedAt?: number;
  /** Host entrypoint (照写). */
  entrypoint?: string;
  /** Session log path (照写). */
  logPath?: string;
  /** Agent kind (照写). */
  agent?: string;
  /** Plugin version. */
  version?: string;
}

/** Why a record was classified dead. */
export type PeerDeadReason = 'pid-dead' | 'lastSeen-stale';

/** One scan result row. */
export interface PeerScanRow {
  record: PeerRecord;
  reason?: PeerDeadReason;
}

/** Scan outcome: live (discoverable), dead (swept) and foreign-domain rows. */
export interface PeerScanResult {
  active: PeerRecord[];
  dead: PeerScanRow[];
  /** Records written by another machine domain — not discoverable here. */
  foreign: PeerRecord[];
  /** Records that were skipped (unreadable / oversized / bad schema). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PEER_KINDS = new Set(['interactive', 'bg']);
const PEER_STATUSES = new Set(['busy', 'shell', 'idle', 'waiting']);
const PEER_TEMPOS = new Set(['active', 'idle', 'blocked']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFormerNameList(value: unknown): value is { name: string; releasedAt: number }[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'object' && entry !== null
      && typeof (entry as Record<string, unknown>)['name'] === 'string'
      && typeof (entry as Record<string, unknown>)['releasedAt'] === 'number');
}

/**
 * Validate one parsed record. Required fields follow DESIGN-V0.3 §3.2;
 * unknown extra fields are tolerated (forward compatibility with a newer
 * plugin version — CC keeps reading newer records with a permissive schema).
 */
export function isPeerRecord(value: unknown): value is PeerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['pid'] !== 'number' || !Number.isInteger(record['pid']) || record['pid'] <= 0) return false;
  if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') return false;
  if (typeof record['messagingSocketPath'] !== 'string') return false;
  if (typeof record['pidDomain'] !== 'string' || record['pidDomain'] === '') return false;
  if (typeof record['peerProtocol'] !== 'number') return false;
  if (!isStringArray(record['peerFeatures'])) return false;
  if (typeof record['kind'] !== 'string' || !PEER_KINDS.has(record['kind'])) return false;
  if (typeof record['startedAt'] !== 'number') return false;
  if (typeof record['lastSeen'] !== 'number') return false;
  if (record['name'] !== undefined && typeof record['name'] !== 'string') return false;
  if (record['displayName'] !== undefined && typeof record['displayName'] !== 'string') return false;
  if (!isFormerNameList(record['formerNames'])) return false;
  if (record['status'] !== undefined && (typeof record['status'] !== 'string' || !PEER_STATUSES.has(record['status']))) return false;
  if (record['tempo'] !== undefined && (typeof record['tempo'] !== 'string' || !PEER_TEMPOS.has(record['tempo']))) return false;
  return true;
}

/** Parse a record from raw JSON text; invalid input yields undefined. */
export function parsePeerRecord(raw: string): PeerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingBom(raw));
  } catch {
    return undefined;
  }
  return isPeerRecord(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// 锁（跨进程：多会话进程各写一份注册表）
// ---------------------------------------------------------------------------

/** Registry lock identity for one peer root (file name must be Windows-safe). */
export function peerRegistryLockName(root: string): string {
  const digest = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8);
  return `peer-registry-${digest}`;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/**
 * Write one peer record atomically (`sessions/<pid>.json`).
 * Throws on failure — callers on a heartbeat path MUST use
 * {@link tryWritePeerRecord} / {@link touchPeerRecord} instead (a failed write
 * must never crash the process, FEASIBILITY-V0.3 §5.4-1).
 */
export async function writePeerRecord(root: string, record: PeerRecord): Promise<void> {
  const file = peerRecordFile(root, record.pid);
  await mkdir(peerSessionsDir(root), { recursive: true });
  const payload: PeerRecord = {
    ...record,
    peerProtocol: record.peerProtocol || PEER_PROTOCOL_VERSION,
    peerFeatures: record.peerFeatures ?? [],
    formerNames: record.formerNames ?? [],
    updatedAt: record.updatedAt ?? Date.now(),
  };
  await writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Write a peer record, swallowing every failure.
 * @returns whether the record was written.
 */
export async function tryWritePeerRecord(root: string, record: PeerRecord): Promise<boolean> {
  try {
    await writePeerRecord(root, record);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one peer record by pid.
 * - missing file -> undefined
 * - file larger than {@link PEER_RECORD_MAX_BYTES} -> undefined (bad record)
 * - unparsable / schema-invalid -> undefined
 * - `record.pid` not equal to the file name pid -> undefined (CC `NXi` check)
 */
export async function readPeerRecord(root: string, pid: number): Promise<PeerRecord | undefined> {
  const file = peerRecordFile(root, pid);
  try {
    const info = await stat(file);
    if (info.size > PEER_RECORD_MAX_BYTES) return undefined;
    const raw = await readFile(file, 'utf8');
    const record = parsePeerRecord(raw);
    if (record === undefined) return undefined;
    if (record.pid !== pid) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

/**
 * Read-merge-write one peer record (CC `xn()` semantics, @4332192).
 * The patch is merged over the old record and `updatedAt` is stamped.
 * A missing record is created from the patch alone.
 * Failures are swallowed (heartbeat safety) — the boolean says what happened.
 */
export async function touchPeerRecord(
  root: string,
  pid: number,
  patch: Partial<PeerRecord>,
): Promise<boolean> {
  try {
    return await withFileLock(root, peerRegistryLockName(root), async () => {
      const current = await readPeerRecord(root, pid);
      const merged: PeerRecord = {
        pid,
        sessionId: patch.sessionId ?? current?.sessionId ?? '',
        messagingSocketPath: patch.messagingSocketPath ?? current?.messagingSocketPath ?? '',
        pidDomain: patch.pidDomain ?? current?.pidDomain ?? localPidDomain(),
        peerProtocol: patch.peerProtocol ?? current?.peerProtocol ?? PEER_PROTOCOL_VERSION,
        peerFeatures: patch.peerFeatures ?? current?.peerFeatures ?? [],
        kind: patch.kind ?? current?.kind ?? 'interactive',
        formerNames: patch.formerNames ?? current?.formerNames ?? [],
        startedAt: patch.startedAt ?? current?.startedAt ?? Date.now(),
        lastSeen: patch.lastSeen ?? Date.now(),
        ...(current ?? {}),
        ...patch,
        updatedAt: Date.now(),
      };
      // `formerNames` must survive an explicit empty patch from the caller
      // (rename writes the new list, heartbeat writes none).
      if (patch.formerNames === undefined && current !== undefined) merged.formerNames = current.formerNames;
      await writePeerRecord(root, merged);
      return true;
    }, { waitMs: PEER_LOCK_WAIT_MS });
  } catch {
    return false;
  }
}

/** Remove one peer record (process exit cleanup, CC @4327411). */
export async function removePeerRecord(root: string, pid: number): Promise<void> {
  await rm(peerRecordFile(root, pid), { force: true });
}

// ---------------------------------------------------------------------------
// 扫描 / 活性 / 清扫
// ---------------------------------------------------------------------------

/** Whether a record is alive: pid alive AND lastSeen fresh (§3.4). */
export function peerIsAlive(record: PeerRecord, now: number, staleMs: number = PEER_STALE_MS): boolean {
  if (!pidAlive(record.pid)) return false;
  return now - record.lastSeen <= staleMs;
}

/**
 * Scan the registry.
 *
 * - only `/^\d+\.json$/` files are considered (CC @3309289);
 * - records of a foreign `pidDomain` are separated into `foreign` and never
 *   enter the discovery set (CC `ne()` @9603429) — they are NOT deleted;
 * - dead records (pid dead, or lastSeen stale) are deleted lazily; a concurrent
 *   scanner that already deleted the file gets ENOENT, which is tolerated
 *   (FEASIBILITY-V0.3 §5.3: two scanners, both `errors: []`).
 */
export async function scanPeers(root: string, now: number = Date.now()): Promise<PeerScanResult> {
  const result: PeerScanResult = { active: [], dead: [], foreign: [], skipped: 0 };
  let entries: string[];
  try {
    entries = await readdir(peerSessionsDir(root));
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    const pid = Number.parseInt(entry.slice(0, -'.json'.length), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const record = await readPeerRecord(root, pid);
    if (record === undefined) {
      result.skipped += 1;
      continue;
    }
    if (!isLocalPidDomain(record.pidDomain)) {
      result.foreign.push(record);
      continue;
    }
    if (peerIsAlive(record, now)) {
      result.active.push(record);
      continue;
    }
    const reason: PeerDeadReason = pidAlive(record.pid) ? 'lastSeen-stale' : 'pid-dead';
    result.dead.push({ record, reason });
    try {
      await rm(peerRecordFile(root, pid), { force: true });
    } catch {
      // ENOENT (another scanner won) is fine; anything else is best effort.
    }
  }
  return result;
}

/**
 * Whether a peer name is still free on this machine.
 *
 * Occupancy is decided by LIVE peers only: a dead peer must not keep its name
 * forever, otherwise a restarted session can never re-register (FEASIBILITY-V0.3
 * §5.4-2, T5 E7). The scan also performs the lazy sweep of dead records.
 */
export async function isPeerNameFree(root: string, name: string, now: number = Date.now()): Promise<boolean> {
  if (name.trim() === '') return false;
  const scan = await scanPeers(root, now);
  return !scan.active.some((record) => record.name === name);
}

/**
 * Find the live peer holding `name` (exact current-name match), if any.
 * Former names are NOT considered here — the former-name fallback belongs to
 * the addressing layer (W3, `resolvePeerTarget`).
 */
export async function findPeerByName(root: string, name: string, now: number = Date.now()): Promise<PeerRecord | undefined> {
  const scan = await scanPeers(root, now);
  return scan.active.find((record) => record.name === name);
}

// ---------------------------------------------------------------------------
// formerNames（R-10）
// ---------------------------------------------------------------------------

/**
 * Append a released name to the former-name list (FIFO, cap 32).
 * The newest release wins when the addressing layer falls back to former names
 * (R-10: 最新释放者胜).
 */
export function pushFormerName(
  formerNames: readonly { name: string; releasedAt: number }[],
  name: string,
  releasedAt: number,
): { name: string; releasedAt: number }[] {
  const next = formerNames.filter((entry) => entry.name !== name);
  next.push({ name, releasedAt });
  while (next.length > PEER_FORMER_NAMES_MAX) next.shift();
  return next;
}

// ---------------------------------------------------------------------------
// key 文件（令牌发布，SPEC R-6）
// ---------------------------------------------------------------------------

/** The published transport token file content (CC schema `Q`). */
export interface PeerKeyContent {
  peerToken: string;
  procStart?: number;
  pidDomain?: string;
}

/** Publish the transport token (atomic write, content `{peerToken, pidDomain}`). */
export async function writePeerKeyFile(root: string, pid: number, socketPath: string, content: PeerKeyContent): Promise<void> {
  const file = peerKeyFile(root, pid, socketPath);
  await mkdir(join(root, 'keys'), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(content)}\n`);
}

/** Read a published token; oversized or malformed content yields undefined. */
export async function readPeerKeyFile(root: string, pid: number, socketPath: string): Promise<PeerKeyContent | undefined> {
  try {
    const file = peerKeyFile(root, pid, socketPath);
    const info = await stat(file);
    if (info.size > PEER_KEY_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(file, 'utf8')));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record['peerToken'] !== 'string') return undefined;
    return {
      peerToken: record['peerToken'],
      ...(typeof record['procStart'] === 'number' ? { procStart: record['procStart'] } : {}),
      ...(typeof record['pidDomain'] === 'string' ? { pidDomain: record['pidDomain'] } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Remove a published token file (process exit cleanup). */
export async function removePeerKeyFile(root: string, pid: number, socketPath: string): Promise<void> {
  await rm(peerKeyFile(root, pid, socketPath), { force: true });
}

// ---------------------------------------------------------------------------
// 审计（机器全局 logs/peer.jsonl）
// ---------------------------------------------------------------------------

/** Append one audit line to the machine-global peer log (best effort). */
export async function logPeerEvent(root: string, event: Record<string, unknown>): Promise<void> {
  try {
    const file = peerAuditLogFile(root);
    await mkdir(join(root, 'logs'), { recursive: true });
    await appendJsonl(file, [JSON.stringify({ event, ts: Date.now() })]);
  } catch {
    // Audit must never break a caller.
  }
}
