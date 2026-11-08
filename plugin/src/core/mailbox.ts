/**
 * M1 core-store: per-agent JSONL mailboxes + message freshness adjudication.
 *
 * Ports from dsh-agent-teams-0.1.29/lib/mailbox.js (file line numbers cited
 * in each function; all read this session):
 * - isCurrentMail: mailbox.js:6-17, 1:1 (attemptId is the message's
 *   capability token; after a reassignment old mail self-invalidates)
 * - readCurrentMailboxLocked: mailbox.js:29-40, 1:1 (tolerant read with
 *   onMalformed, stale mail discarded on disk)
 * - mailboxContent/mailboxBody/mailboxPrompt: mailbox.js:19-27/49-51 (the
 *   machine-parseable receipt prefix, re-branded per DESIGN.md §2.4)
 * - ack/discard/claim/release/append: state.js:371-519, JSONL append instead
 *   of whole-file rewrite (DESIGN.md §2.7-5)
 *
 * Lock contract: the `*Locked` functions require the caller to hold the team
 * lock (in-process + cross-process, e.g. via lock.ts withTeamLock); the
 * non-Locked convenience wrappers take the locks themselves.
 *
 * @module core/mailbox
 */
import { randomUUID } from 'node:crypto';
import { appendJsonl, readJsonl, rewriteJsonl, type MalformedLine } from './jsonl.js';
import { sanitizeKey } from './sanitize.js';
import { isTeamMessage, normalizeMessage, type TeamMessage, type TeamState } from './types.js';
import { logEngineEvent } from './log.js';
import { withFileLock, withProcessLock } from './lock.js';
import { inboxFile, teamLockNames } from './paths.js';
import { readTeam } from './teamstate.js';

/** A crashed delivery attempt becomes retryable after this interval (state.js:26). */
export const MAILBOX_DELIVERY_LEASE_MS = 60_000;

/** Machine-parseable wake-prompt receipt prefix (DESIGN.md §2.4; dsh mailbox.js:5). */
export const RECEIPT_PREFIX = '[CrossChat inbox receipt: ';
const RECEIPT_SUFFIX = ']';

/** Build a fresh message record (port of state.js:371-373 createMessage + extras). */
export function createMessage(
  from: string,
  to: string,
  content: string,
  extra: Partial<Pick<TeamMessage, 'taskId' | 'attemptId' | 'sourceTaskId' | 'sourceAttemptId' | 'sourceTaskStatus' | 'deliveryClaimedAt'>> = {},
): TeamMessage {
  return { id: randomUUID(), from, to, content, ts: Date.now(), ...extra };
}

/**
 * Freshness adjudication, 1:1 port of mailbox.js:6-17.
 * A message is current when: not discarded; its source attempt (if any) is
 * still that task's current attempt held by the same sender in a compatible
 * status; and its delivery attempt (if any) is still the recipient's open
 * attempt. Anything else is stale -> discarded on disk, never delivered.
 */
export function isCurrentMail(team: TeamState, message: TeamMessage): boolean {
  if (message.discardedAt !== undefined) return false;
  if (message.sourceAttemptId !== undefined
    && !team.tasks.some((task) => task.id === message.sourceTaskId
      && task.attemptId === message.sourceAttemptId
      && task.assignee === message.from
      && (message.sourceTaskStatus === undefined
        || !['completed', 'failed', 'cancelled'].includes(task.status)
        || message.sourceTaskStatus === task.status))) {
    return false;
  }
  if (message.attemptId === undefined) return true;
  return team.tasks.some((task) => task.id === message.taskId
    && task.attemptId === message.attemptId
    && task.assignee === message.to
    && (task.status === 'claimed' || task.status === 'in_progress'));
}

/** Default malformed-line sink: skip + audit-log (DESIGN.md §2.7-5). */
function defaultOnMalformed(stateRoot: string, file: string): (malformed: MalformedLine) => void {
  return (malformed) => {
    void logEngineEvent(stateRoot, { event: 'malformed-line', file, lineNo: malformed.lineNo, error: malformed.error });
  };
}

function mailboxPath(stateRoot: string, teamId: string, agentKey: string): string {
  return inboxFile(stateRoot, teamId, sanitizeKey(agentKey));
}

/**
 * Read one agent's whole mailbox, oldest first. Malformed lines are skipped
 * and reported (onMalformed; default = engine.jsonl audit entry).
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<TeamMessage[]> {
  const file = mailboxPath(stateRoot, teamId, agentKey);
  const sink = onMalformed ?? defaultOnMalformed(stateRoot, file);
  const messages = await readJsonl<TeamMessage>(file, isTeamMessage, sink);
  return messages.map(normalizeMessage);
}

/** Read only messages neither read nor discarded (state.js:438-441). */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<TeamMessage[]> {
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformed))
    .filter((message) => message.readAt === undefined && message.discardedAt === undefined);
}

/**
 * Unread mail eligible for a delivery attempt: never delivered, and either
 * unclaimed or whose delivery lease has expired (state.js:443-449).
 */
export async function readPendingMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  now: number = Date.now(),
): Promise<TeamMessage[]> {
  return (await readUnreadMailbox(stateRoot, teamId, agentKey))
    .filter((message) => message.deliveredAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS));
}

/** Append one message as the next JSONL line (cross-process O_APPEND write). */
export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  await appendJsonl(mailboxPath(stateRoot, teamId, agentKey), [JSON.stringify(message)]);
}

/**
 * Rewrite the lines whose parsed message id is selected, preserving malformed
 * lines verbatim (state.js:450-479 mutateMailbox, atomic whole-file commit).
 * Caller holds the team lock.
 */
export async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage,
): Promise<void> {
  if (messageIds.length === 0) return;
  const selected = new Set(messageIds);
  await rewriteJsonl(mailboxPath(stateRoot, teamId, agentKey), (value) => {
    if (!isTeamMessage(value) || !selected.has(value.id)) return undefined;
    return JSON.stringify(mutate(normalizeMessage(value)));
  });
}

/** Lease selected messages to one delivery path (state.js:481-487). */
export async function claimMailboxDelivery(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => ({ ...message, deliveryClaimedAt: now }));
}

/** Release a failed delivery lease so delivery can retry later (state.js:489-494). */
export async function releaseMailboxDelivery(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _released, ...rest } = message;
    return rest;
  });
}

/** Mark selected messages delivered (host accepted; not yet read) (state.js:511-516). */
export async function markMailboxDelivered(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message;
    return { ...rest, deliveredAt: message.deliveredAt ?? now };
  });
}

/**
 * Acknowledge selected messages as read. This happens at the instant the tool
 * returns the messages to the model — host acceptance is NOT consumption
 * (DESIGN.md §2.1; dsh state.js:500-509).
 */
export async function acknowledgeMailbox(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message;
    return { ...rest, deliveredAt: message.deliveredAt ?? now, readAt: message.readAt ?? now };
  });
}

/** Mark selected messages discarded (stale on arrival) (state.js:517-519). */
export async function discardMailboxMessages(
  stateRoot: string, teamId: string, agentKey: string, ids: readonly string[], now: number = Date.now(),
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => ({
    ...message,
    discardedAt: message.discardedAt ?? now,
  }));
}

/**
 * Read current (non-stale) unread mail while the caller holds the team lock:
 * stale messages are discarded on disk and not returned. 1:1 port of
 * mailbox.js:29-40 readCurrentMailboxLocked.
 */
export async function readCurrentMailboxLocked(
  stateRoot: string,
  team: TeamState,
  recipient: string,
  onMalformed?: (malformed: MalformedLine) => void,
): Promise<TeamMessage[]> {
  const messages = await readUnreadMailbox(stateRoot, team.teamId, recipient, onMalformed);
  const current: TeamMessage[] = [];
  const staleIds: string[] = [];
  for (const message of messages) {
    if (isCurrentMail(team, message)) current.push(message);
    else staleIds.push(message.id);
  }
  await discardMailboxMessages(stateRoot, team.teamId, recipient, staleIds);
  return current;
}

/**
 * Standalone current-mail read: takes the in-process chain AND the
 * cross-process team lock itself (for hook/engine callers outside a tool
 * transaction). Tools that already hold the lock must call
 * readCurrentMailboxLocked instead (nesting the same lock deadlocks).
 */
export async function readCurrentMailbox(
  stateRoot: string,
  teamId: string,
  recipient: string,
  onMalformed?: (malformed: MalformedLine) => void,
  options: { waitMs?: number } = {},
): Promise<TeamMessage[]> {
  const names = teamLockNames(stateRoot, teamId);
  return withProcessLock(names.processKey, async () => {
    return withFileLock(stateRoot, names.file, async () => {
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return [];
      return readCurrentMailboxLocked(stateRoot, team, recipient, onMalformed);
    }, options);
  });
}

// ---------------------------------------------------------------------------
// Receipt prefix + human body (port of mailbox.js:19-27/49-70, re-branded)
// ---------------------------------------------------------------------------

export interface MailReceipt {
  teamId: string;
  recipient: string;
  ids: string[];
}

/** Serialize the receipt payload the wake prompt carries (DESIGN.md §2.4). */
export function formatReceipt(teamId: string, recipient: string, ids: readonly string[]): string {
  return `${RECEIPT_PREFIX}${JSON.stringify({ teamId, recipient, ids: [...ids] })}${RECEIPT_SUFFIX}`;
}

/** Parse one text block's receipt line; undefined when the text is not one. */
export function parseReceipt(text: string): MailReceipt | undefined {
  if (!text.startsWith(RECEIPT_PREFIX)) return undefined;
  try {
    const body = text.slice(RECEIPT_PREFIX.length).split('\n')[0];
    const parsed = JSON.parse(body.endsWith(RECEIPT_SUFFIX) ? body.slice(0, -RECEIPT_SUFFIX.length) : body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw['teamId'] !== 'string' || typeof raw['recipient'] !== 'string'
      || !Array.isArray(raw['ids']) || !raw['ids'].every((id) => typeof id === 'string')) {
      return undefined;
    }
    return { teamId: raw['teamId'], recipient: raw['recipient'], ids: raw['ids'] as string[] };
  } catch {
    return undefined;
  }
}

/** Structured provenance header for task-sourced messages (mailbox.js:19-22). */
export function mailboxContent(message: TeamMessage): string {
  return (message.sourceTaskId === undefined
    ? ''
    : `[Source task ${message.sourceTaskId}, attempt_id ${message.sourceAttemptId ?? ''}${message.sourceTaskStatus === undefined ? '' : `, status=${message.sourceTaskStatus}`}]\n`)
    + message.content;
}

/** Human-readable body for a batch of messages (mailbox.js:23-27, no captain branch). */
export function mailboxBody(recipient: string, messages: readonly TeamMessage[]): string {
  return messages.map((message) => `CrossChat message from ${message.from}${message.attemptId === undefined ? '' : ` for task ${message.taskId ?? ''}, attempt_id ${message.attemptId}`}:\n\n${mailboxContent(message)}`).join('\n\n');
}

/** Full wake-prompt mail section: receipt line first, then the body (mailbox.js:49-51). */
export function mailboxPrompt(teamId: string, recipient: string, messages: readonly TeamMessage[]): string {
  return `${formatReceipt(teamId, recipient, messages.map((message) => message.id))}\n\n${mailboxBody(recipient, messages)}`;
}
