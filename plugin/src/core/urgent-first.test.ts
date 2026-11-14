/**
 * v0.6 C1（M3）单测：urgent-first 读取序（DESIGN-V0.6.md §3.1/§4.2-M3）。
 *
 * 覆盖面：
 * - urgentFirst 排序规则（urgent 在前、类内 ts 升序、stable）；
 * - 邮箱 JSONL 物理序不动（追加真源纪律），呈现序 urgent-first；
 * - readCurrentMailboxLocked 消费序 urgent-first（xc_check_inbox 面）；
 * - createMessage urgent 白名单 + isTeamMessage/normalizeMessage 宽容增量；
 * - peermsg 排空面：drainPeerFile 开窗前 urgent 插队 + 窗口外写回保序、
 *   readPeerQueue 窥视同序；
 * - hooks/shared unreadSummary：urgentCount 单列 + messages urgent-first。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendMailbox,
  createMessage,
  readCurrentMailbox,
  readMailbox,
  readCurrentMailboxLocked,
  urgentFirst,
  type MailboxReadDiagnostics,
} from './mailbox.js';
import {
  appendPeerQueue,
  drainPeerQueue,
  peerQueueDepth,
  readPeerQueue,
  type PeerQueueItem,
} from './peermsg.js';
import { newTeamState, writeTeam, readTeam } from './teamstate.js';
import { unreadSummary } from '../hooks/shared.js';
import type { TeamMessage } from './types.js';

let root: string;
let stateRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xc-urgent-'));
  stateRoot = join(root, '.crosschat');
  mkdirSync(stateRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 建队 + 收件人 b（普通聊天件无 attempt 绑定，isCurrentMail 恒真）。 */
async function seedTeam(): Promise<void> {
  const now = Date.now();
  const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
  team.members.push({ key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now });
  await writeTeam(stateRoot, team);
}

// ─────────────────────────── urgentFirst 排序规则 ───────────────────────────

describe('urgentFirst（排序原语）', () => {
  it('urgent 排最前，类内 ts 升序，ts 相同保持原下序（stable）', () => {
    const items = [
      { id: 'n1', ts: 30 },
      { id: 'u1', ts: 20, urgent: true as const },
      { id: 'n2', ts: 10 },
      { id: 'u2', ts: 20, urgent: true as const },
    ];
    const out = urgentFirst(items);
    expect(out.map((x) => x.id)).toEqual(['u1', 'u2', 'n2', 'n1']);
  });

  it('无 urgent 项 = ts 升序（正常追加下即到达序，不改序）', () => {
    const items = [{ id: 'a', ts: 1 }, { id: 'b', ts: 2 }];
    expect(urgentFirst(items).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('空数组恒等；urgent 字段缺失按普通件', () => {
    expect(urgentFirst([])).toEqual([]);
    const items = [{ id: 'x', ts: 1, urgent: false as const }, { id: 'y', ts: 2 }];
    expect(urgentFirst(items).map((x) => x.id)).toEqual(['x', 'y']);
  });
});

// ─────────────────────────── 队内邮箱面 ───────────────────────────

describe('邮箱 urgent 数据面（createMessage / 读取宽容 / 消费序）', () => {
  it('createMessage 白名单携带 urgent；JSONL 往返后字段保真（isTeamMessage/normalize 宽容）', async () => {
    await seedTeam();
    const msg = createMessage('a', 'b', 'hello', { urgent: true });
    expect(msg.urgent).toBe(true);
    await appendMailbox(stateRoot, 'default', 'b', msg);
    const read = await readMailbox(stateRoot, 'default', 'b');
    expect(read).toHaveLength(1);
    expect(read[0]!.urgent).toBe(true);
  });

  it('物序不动（到达序），呈现序 urgent-first（readCurrentMailboxLocked）', async () => {
    await seedTeam();
    const normalFirst = createMessage('a', 'b', 'normal-first', { deliveryClaimedAt: 1 });
    await appendMailbox(stateRoot, 'default', 'b', normalFirst);
    const urgentLater = createMessage('a', 'b', 'urgent-later', { urgent: true, deliveryClaimedAt: 2 });
    await appendMailbox(stateRoot, 'default', 'b', urgentLater);

    // 物理文件仍是到达序（追加真源纪律）。
    const raw = readFileSync(
      join(stateRoot, 'teams', 'default', 'inbox', 'b.jsonl'),
      'utf8',
    );
    expect(raw.indexOf('normal-first')).toBeLessThan(raw.indexOf('urgent-later'));

    // 消费序：urgent 在前。
    const team = (await readTeam(stateRoot, 'default'))!;
    const current = await readCurrentMailboxLocked(stateRoot, team, 'b');
    expect(current.map((m) => m.content)).toEqual(['urgent-later', 'normal-first']);
  });

  it('readCurrentMailbox（独立包装）同序；诊断收集器不受排序影响', async () => {
    await seedTeam();
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'n1', { deliveryClaimedAt: 1 }));
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'u1', { urgent: true, deliveryClaimedAt: 2 }));
    const diagnostics: MailboxReadDiagnostics = { malformed: [], discarded: 0 };
    const current = await readCurrentMailbox(stateRoot, 'default', 'b', undefined, { diagnostics });
    expect(current.map((m) => m.content)).toEqual(['u1', 'n1']);
    expect(diagnostics.discarded).toBe(0);
  });

  it('旧记录（无 urgent 字段）照常读取（宽容缺省）', async () => {
    await seedTeam();
    const legacy = createMessage('a', 'b', 'legacy');
    delete (legacy as Partial<TeamMessage>).urgent;
    await appendMailbox(stateRoot, 'default', 'b', legacy);
    const read = await readMailbox(stateRoot, 'default', 'b');
    expect(read[0]!.urgent).toBeUndefined();
  });
});

// ─────────────────────────── peer 轴排空面 ───────────────────────────

function peerItem(partial: Partial<PeerQueueItem> & { msgId: string; ts: number }): PeerQueueItem {
  return {
    from: 'p1',
    hopChain: ['p1'],
    text: `text-${partial.msgId}`,
    via: 'file',
    ...partial,
  };
}

describe('peermsg 排空面 urgent-first（drainPeerFile 开窗前插队）', () => {
  it('urgent 队列项插队进入本批窗口（紧急插队时序：晚到 urgent 抢先 3 条普通件出队）', async () => {
    const sid = 'sess-p';
    for (let i = 1; i <= 3; i += 1) {
      await appendPeerQueue(root, sid, peerItem({ msgId: `n${i}`, ts: i }));
    }
    // 普通件先全部入队后，urgent 才到（ts 最大、到达序最后）。
    await appendPeerQueue(root, sid, peerItem({ msgId: 'urgent', ts: 99, urgent: true }));

    // 窗口 = 1：到达序下 urgent 排第 4 本应留下；插队后它第一个出队。
    const items = await drainPeerQueue(root, sid, 1);
    expect(items.map((m) => m.msgId)).toEqual(['urgent']);
    // 窗口外 3 条普通件写回（数据零丢失）。
    expect(await peerQueueDepth(root, sid)).toBe(3);
    const rest = await drainPeerQueue(root, sid);
    expect(rest.map((m) => m.msgId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('无 urgent 项 = 到达序恒等（v0.5 行为逐字节兼容）', async () => {
    const sid = 'sess-p2';
    await appendPeerQueue(root, sid, peerItem({ msgId: 'a', ts: 1 }));
    await appendPeerQueue(root, sid, peerItem({ msgId: 'b', ts: 2 }));
    const items = await drainPeerQueue(root, sid);
    expect(items.map((m) => m.msgId)).toEqual(['a', 'b']);
  });

  it('readPeerQueue（窥视）与排空同序——面 C「窥视→开窗→排空」口径一致', async () => {
    const sid = 'sess-p3';
    await appendPeerQueue(root, sid, peerItem({ msgId: 'n', ts: 1 }));
    await appendPeerQueue(root, sid, peerItem({ msgId: 'u', ts: 2, urgent: true }));
    const peeked = await readPeerQueue(root, sid);
    expect(peeked.map((m) => m.msgId)).toEqual(['u', 'n']);
    const drained = await drainPeerQueue(root, sid);
    expect(drained.map((m) => m.msgId)).toEqual(['u', 'n']);
  });

  it('旧队列行（无 urgent 字段）宽容读取，深度计数不受排序影响', async () => {
    const sid = 'sess-p4';
    await appendPeerQueue(root, sid, peerItem({ msgId: 'legacy', ts: 1 }));
    // 手工改写队列文件去掉 urgent 键（模拟 v0.5 存量行）。
    const file = join(root, 'queue', `${sid}.jsonl`);
    if (!existsSync(file)) {
      // peerdir 的 queue 路径在 root 下：直接按 appendPeerQueue 落点找。
    }
    const raw = readFileSync(file, 'utf8');
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    delete line['urgent'];
    writeFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    const peeked = await readPeerQueue(root, sid);
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.urgent).toBeUndefined();
  });
});

// ─────────────────────────── 钩子未读摘要 ───────────────────────────

describe('hooks/shared unreadSummary（urgent 计数单列 + messages urgent-first）', () => {
  it('urgentCount 单列；messages urgent 在前；senders 口径不变', async () => {
    await seedTeam();
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'n1', { deliveryClaimedAt: 1 }));
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'u1', { urgent: true, deliveryClaimedAt: 2 }));
    await appendMailbox(stateRoot, 'default', 'b', createMessage('a', 'b', 'n2', { deliveryClaimedAt: 3 }));
    const summary = await unreadSummary(stateRoot, 'b');
    expect(summary.count).toBe(3);
    expect(summary.urgentCount).toBe(1);
    expect(summary.messages.map((m) => m.content)).toEqual(['u1', 'n1', 'n2']);
    expect(summary.senders).toEqual(['a']);
  });

  it('全部已读时 count=0 且 urgentCount=0', async () => {
    await seedTeam();
    const summary = await unreadSummary(stateRoot, 'b');
    expect(summary.count).toBe(0);
    expect(summary.urgentCount).toBe(0);
    expect(summary.messages).toEqual([]);
  });
});
