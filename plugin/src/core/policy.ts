/**
 * W5 security core: per-team inbound message policy + held mailbox +
 * the xc_inbound_review core (DESIGN-V0.2.md §7.4-I4, G6 closure).
 *
 * Policy model (CC crossSessionInbound = accept/hold/refuse,
 * doc-cross-session-messaging.html):
 * - `accept` (default): chat messages flow to the main mailbox as in v0.1.0;
 * - `hold`: chat messages are appended to `inbox/<key>.held.jsonl` — a separate
 *   file the hooks and wake prompts never read (they only read the main
 *   mailbox, v0.1.0 mechanism unchanged), pending xc_inbound_review;
 * - `refuse`: the message never enters the target mailbox; the SENDER's
 *   mailbox receives a whitelisted `{type:"delivery-refused"}` receipt frame.
 *
 * Scope discipline: the policy governs CHAT frames ONLY. Protocol frames
 * (task-assignment / task-receipt / idle-notification / unblock-notice /
 * shutdown-request / delivery-refused) are engine-mediated and capability-
 * tokened — refusing them would cut the collaboration loop, so they are
 * always exempt (§7.4-I4). Whitelist enforcement itself lives in mailbox.ts.
 *
 * Files owned here (core/paths.ts is a no-change file in v0.2, §9.1 — the
 * policy/held layouts are defined at this single point):
 *   teams/<teamId>/policy.json          {"mode": "accept"|"hold"|"refuse"}
 *   teams/<teamId>/inbox/<key>.held.jsonl
 *
 * Lock contract: appendHeldMessage is an O_APPEND write (mailbox discipline);
 * accept/discard Hheld rewrite the held file and appendHeldMessage touches the
 * main mailbox — both MUST run under the team lock (mcp/guards.ts enforces).
 * Policy reads are lockless (rename-atomic whole-file writes, §2.7-5); a
 * corrupt/absent policy file falls back to env/default + audit — the policy
 * must never break the collaboration loop (fail-open, documented).
 *
 * @module core/policy
 */
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { appendJsonl, readJsonl, type MalformedLine } from './jsonl.js';
import { appendMailbox } from './mailbox.js';
import { logEngineEvent } from './log.js';
import { sanitizeKey } from './sanitize.js';
import { isRecord, type TeamMessage } from './types.js';

/** Inbound policy modes (CC crossSessionInbound; §7.4-I4). */
export type InboundMode = 'accept' | 'hold' | 'refuse';
export const INBOUND_MODES: readonly InboundMode[] = ['accept', 'hold', 'refuse'];
export const DEFAULT_INBOUND_MODE: InboundMode = 'accept';

// ---------------------------------------------------------------------------
// On-disk paths (single definition point; core/paths.ts unchanged in v0.2)
// ---------------------------------------------------------------------------

/** teams/<teamId>/policy.json — the whole policy record for one team. */
export function policyFile(stateRoot: string, teamId: string): string {
  return join(stateRoot, 'teams', teamId, 'policy.json');
}

/** teams/<teamId>/inbox/<agentKey>.held.jsonl — the held (quarantine) queue. */
export function heldInboxFile(stateRoot: string, teamId: string, agentKey: string): string {
  return join(stateRoot, 'teams', teamId, 'inbox', `${sanitizeKey(agentKey)}.held.jsonl`);
}

// ---------------------------------------------------------------------------
// Mode resolution: policy.json > XC_INBOUND_MODE env > default
// ---------------------------------------------------------------------------

/** Env spelling of one mode; anything else falls back to accept (V7 defense:
 * template expansion behavior unconfirmed, so unknown values never escalate). */
export function inboundModeFromEnv(raw: string | undefined | null): InboundMode {
  if (raw === 'hold' || raw === 'refuse') return raw;
  return DEFAULT_INBOUND_MODE;
}

/** Validate one parsed policy value; undefined when it is not a mode record. */
export function coerceInboundPolicy(value: unknown): InboundMode | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value['mode'];
  return typeof mode === 'string' && (INBOUND_MODES as readonly string[]).includes(mode)
    ? (mode as InboundMode)
    : undefined;
}

export interface InboundPolicyResolution {
  mode: InboundMode;
  /** Where the mode came from (audit/diagnostics). */
  source: 'policy' | 'env' | 'default';
}

/**
 * Resolve the effective inbound mode for one team (lockless read):
 * 1. policy.json when it parses to a valid mode record;
 * 2. else XC_INBOUND_MODE env ("hold"/"refuse" honored, V7: unknown → accept);
 * 3. else accept. A corrupt policy file audits `policy-invalid` and fails open.
 */
export async function readInboundPolicy(
  stateRoot: string,
  teamId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InboundPolicyResolution> {
  let raw: string;
  try {
    raw = await readFile(policyFile(stateRoot, teamId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable policy (permissions): fail open + audit, never break chat.
      await logEngineEvent(stateRoot, { event: 'policy-invalid', teamId, error: String(error) });
      return { mode: inboundModeFromEnv(env['XC_INBOUND_MODE']), source: 'env' };
    }
    const envMode = inboundModeFromEnv(env['XC_INBOUND_MODE']);
    return { mode: envMode, source: envMode === DEFAULT_INBOUND_MODE ? 'default' : 'env' };
  }
  try {
    const parsed = coerceInboundPolicy(JSON.parse(raw));
    if (parsed !== undefined) return { mode: parsed, source: 'policy' };
  } catch {
    /* fall through to the invalid audit */
  }
  await logEngineEvent(stateRoot, { event: 'policy-invalid', teamId, raw: raw.slice(0, 200) });
  return { mode: inboundModeFromEnv(env['XC_INBOUND_MODE']), source: 'env' };
}

/** Persist the team policy record (whole-file atomic; caller locks if racing). */
export async function writeInboundPolicy(
  stateRoot: string,
  teamId: string,
  mode: InboundMode,
): Promise<void> {
  const file = policyFile(stateRoot, teamId);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ mode }, null, 2));
}

// ---------------------------------------------------------------------------
// Held mailbox (quarantine queue): JSONL, same tolerance rules as the inbox
// ---------------------------------------------------------------------------

/** Append one message to the held queue (O_APPEND; cross-process safe). */
export async function appendHeldMessage(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  await appendJsonl(heldInboxFile(stateRoot, teamId, agentKey), [JSON.stringify(message)]);
}

/**
 * Read the whole held queue, oldest first. Held messages are a REVIEW queue:
 * no freshness adjudication here (the reviewer decides; once accepted into the
 * main mailbox, isCurrentMail adjudicates as usual). Malformed lines are
 * skipped and audited before the read returns (deterministic for callers).
 */
export async function readHeldMessages(
  stateRoot: string,
  teamId: string,
  agentKey: string,
): Promise<TeamMessage[]> {
  const file = heldInboxFile(stateRoot, teamId, agentKey);
  const malformed: MalformedLine[] = [];
  const messages = await readJsonl<TeamMessage>(
    file,
    (value): value is TeamMessage =>
      isRecord(value) && typeof value['id'] === 'string' && typeof value['content'] === 'string',
    (line) => malformed.push(line),
  );
  for (const line of malformed) {
    await logEngineEvent(stateRoot, { event: 'malformed-line', file, lineNo: line.lineNo, error: line.error });
  }
  return messages;
}

/**
 * Move held messages (ids; empty = all) into the recipient's MAIN mailbox.
 * Caller holds the team lock (appends to inbox/<key>.jsonl + rewrites held).
 * @returns the messages that were moved (in held order).
 */
export async function acceptHeldMessages(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<TeamMessage[]> {
  const held = await readHeldMessages(stateRoot, teamId, agentKey);
  const selected = ids.length === 0 ? held : held.filter((m) => ids.includes(m.id));
  if (selected.length === 0) return [];
  const movedIds = new Set(selected.map((m) => m.id));
  for (const message of selected) {
    // 入主邮箱的时机=审阅者放行：此刻盖 deliveredAt/readAt 语义保持 v0.1.0 惯例——
    // deliveredAt 盖 now（进入主邮箱=一次真实投递），readAt 留给收件人消费。
    await appendMailbox(stateRoot, teamId, agentKey, {
      ...message,
      deliveredAt: message.deliveredAt ?? now,
      deliveryClaimedAt: undefined,
    });
  }
  await rewriteHeldFile(stateRoot, teamId, agentKey, (m) => !movedIds.has(m.id));
  return selected;
}

/**
 * Drop held messages (ids; empty = all) from the queue without delivering.
 * Caller holds the team lock (rewrites the held file).
 * @returns the messages that were dropped.
 */
export async function discardHeldMessages(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  ids: readonly string[],
): Promise<TeamMessage[]> {
  const held = await readHeldMessages(stateRoot, teamId, agentKey);
  const selected = ids.length === 0 ? held : held.filter((m) => ids.includes(m.id));
  if (selected.length === 0) return [];
  const droppedIds = new Set(selected.map((m) => m.id));
  await rewriteHeldFile(stateRoot, teamId, agentKey, (m) => !droppedIds.has(m.id));
  return selected;
}

/** Rewrite the held file keeping only messages matching keep (atomic write). */
async function rewriteHeldFile(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  keep: (message: TeamMessage) => boolean,
): Promise<void> {
  const file = heldInboxFile(stateRoot, teamId, agentKey);
  const held = await readHeldMessages(stateRoot, teamId, agentKey);
  const kept = held.filter(keep);
  await mkdir(dirname(file), { recursive: true });
  if (kept.length === 0) {
    // 空队列直接删除文件：主邮箱/钩子路径从未见过它，删除无副作用。
    try {
      await unlink(file);
    } catch {
      /* already gone */
    }
    return;
  }
  await writeFileAtomic(file, kept.map((m) => JSON.stringify(m)).join('\n') + '\n');
}
