/**
 * v0.7.1 红队四番战残留 15 项之**本组**（边界-7 / 边界-8 / 边界-9 / 规模压-B1 / B2 / B3）
 * 防回归单测。裁决与复现依据：
 * `deepseek-crosschat/redteam-4/evidence/adversarial/adjudication.md`
 * （边界-7 `b678.mjs`、边界-8 `b678.mjs`、边界-9 `b9.mjs`、
 *   规模压-B1 `b1scale.mjs`、B2 `b2scale.mjs`、B3 `b3scale.mjs`+`b3scale2.mjs`）。
 *
 * 本文件只放**本组新增**的回归面；既有文件的对应改判写在各自文件里：
 * - 证据门集成用例（含 forged sha256 / 目录 / note）→ `evidence-gate.test.ts`
 * - 成员上限报文自洽 → `member-cap-flow.test.ts`
 *
 * 覆盖：
 * 1. 边界-7：`sanitizeEvidenceNote`/`sha256File` 纯函数 + 去重键定义不含发送方；
 * 2. 规模压-B3：去重键 = (to, ticket) ∧ 未读 ∧ current——**谁派的无关**；
 *    回执披露 duplicateKey 与 originalCreatedBy；
 * 3. 边界-9：peers 视图里队内成员行**不再渲染不可作地址的 `[ref]`**，跨会话行照旧
 *    渲染且 `名字 [ref]` 精确可寻址；
 * 4. 规模压-B1：peer 入队闸 dropped 时，`xc_relay` 把接收方给的「原因 + 恢复动作」
 *    （detail）透进 payload 与摘要行（README §7 承诺面）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payloadOf, type ToolResult } from './protocol.js';
import { createToolCore, type ToolCore } from './core.js';
import { dispatchDedupKey, sanitizeEvidenceNote, sha256File } from './tools-tasks.js';
import { createTeamRelayCore, xcRelay, type RelayArgs } from './tools-relay.js';
import { identityStore } from './identity.js';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { writeSession } from '../core/registry.js';
import { localPidDomain } from '../core/peerdir.js';
import { writePeerKeyFile, writePeerRecord } from '../core/peerregistry.js';
import { formatPeerRows, peerRowsFromRecord, resolvePeerTarget, type PeerRow } from '../core/peeraddr.js';
import { setPeerSessionContext, clearPeerSessionContext } from './peer-drain.js';
import type { PeerRecord } from '../core/peerregistry.js';

// ---------------------------------------------------------------------------
// 1) 边界-7 / 边界-8 纯函数
// ---------------------------------------------------------------------------

describe('边界-8：sanitizeEvidenceNote（note 可选性显式 + 控制字符不原样入库）', () => {
  it('undefined / 空串 → 空串（note 可选，省略不等于拒绝）', () => {
    expect(sanitizeEvidenceNote(undefined)).toBe('');
    expect(sanitizeEvidenceNote('')).toBe('');
    expect(sanitizeEvidenceNote('   ')).toBe('');
  });

  it('控制字符（NUL/TAB/换行/CR/DEL）一律降为空格并去首尾空白', () => {
    expect(sanitizeEvidenceNote('a\nb\tc\u0000d')).toBe('a b c d');
    // 每个控制字符各降一个空格（与 sanitizeLeadReason 同口径，不做空白折叠）。
    expect(sanitizeEvidenceNote('  x\r\ny  ')).toBe('x  y');
    expect(sanitizeEvidenceNote('\u007f')).toBe('');
  });

  it('普通摘要原样保留；超长截断到 500 字符', () => {
    expect(sanitizeEvidenceNote('结果 391')).toBe('结果 391');
    expect(sanitizeEvidenceNote('x'.repeat(5000))).toHaveLength(500);
  });
});

describe('边界-7：sha256File（现算复核的纯函数面）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('普通文件 → hex 摘要；目录 / 不存在 → null（调用方转 evidence_not_a_file / evidence_file_missing）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xc-v071-evi-'));
    dirs.push(dir);
    const file = join(dir, 'a.txt');
    writeFileSync(file, '391\n', 'utf8');
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('391\n', 'utf8').digest('hex');
    expect(await sha256File(file)).toBe(expected);
    expect(await sha256File(dir)).toBeNull();
    expect(await sha256File(join(dir, 'nope.txt'))).toBeNull();
  });

  it('dispatchDedupKey：同一 (to, ticket) 恒定，发送方不在键里', () => {
    const ticket = JSON.stringify({ type: 'task-assignment', teamId: 'default', title: 'T', prompt: 'P', acceptance: '' });
    const k1 = dispatchDedupKey('c', ticket);
    const k2 = dispatchDedupKey('c', ticket);
    expect(k1).toBe(k2);
    expect(k1.startsWith('to=c|ticket=')).toBe(true);
    // 键里没有发送方、也没有 taskId。
    expect(k1).not.toMatch(/from|sender|taskId/i);
    expect(dispatchDedupKey('other', ticket)).not.toBe(k1);
  });
});

// ---------------------------------------------------------------------------
// 2) 规模压-B3：派发去重键不含发送方
// ---------------------------------------------------------------------------

describe('规模压-B3：重复派发去重键（不含发送方）', () => {
  let workDir: string;
  let stateRoot: string;
  let core: ToolCore;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'xc-v071-b3-'));
    stateRoot = join(workDir, '.crosschat');
    core = createToolCore({ stateRoot, workspace: workDir, env: {} });
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function hookRegister(conn: string, name: string, sid: string): Promise<void> {
    await writeSession(stateRoot, { sessionId: sid, cwd: workDir, startedAt: Date.now(), lastSeen: Date.now() });
    const res = await core.xc_register({ name, sessionId: sid }, conn);
    expect(res.isError).toBeUndefined();
  }

  const args = { to: 'c', title: 'race-same', prompt: 'identical body', acceptance: 'x' } as const;

  it('两个不同发送方派同一张票给同一目标 → 只建一单（旧实现各建一单）', async () => {
    await hookRegister('conn-a', 'a', 'sess-a');
    await hookRegister('conn-b', 'b', 'sess-b');
    await hookRegister('conn-c', 'c', 'sess-c');

    const first = payloadOf(await core.xc_dispatch({ ...args }, 'conn-a')) as { taskId: string; delivered: string };
    expect(first.delivered).toBe('mailbox');

    // 第二个发送方：同一张票、同一收方 → duplicate，不再建单。
    const second = payloadOf(await core.xc_dispatch({ ...args }, 'conn-b')) as {
      taskId: string; delivered: string; duplicateKey: string; originalCreatedBy: string;
    };
    expect(second.delivered).toBe('duplicate');
    expect(second.taskId).toBe(first.taskId);
    // 回执披露去重键与首派方——命中键不含发送方，调用方必须能看出「这单是别人派的」。
    expect(second.duplicateKey).toMatch(/^to=c\|ticket=[0-9a-f]{16}$/);
    expect(second.originalCreatedBy).toBe('a');

    // 键与邮箱里那张票一一对应（同一张票 → 同一个键）。
    const { readMailbox } = await import('../core/mailbox.js');
    const box = await readMailbox(stateRoot, 'default', 'c');
    const ticket = box.find((m) => m.content.includes('"task-assignment"'))!.content;
    expect(second.duplicateKey).toBe(dispatchDedupKey('c', ticket));

    const { readTeam } = await import('../core/teamstate.js');
    const state = await readTeam(stateRoot, 'default');
    expect(state!.tasks).toHaveLength(1);
    expect(state!.tasks[0]!.createdBy).toBe('a');
  });

  it('同发送方重复派发仍 duplicate（v0.7.0 行为保留）；换 title 即建新单', async () => {
    await hookRegister('conn-a', 'a', 'sess-a');
    await hookRegister('conn-c', 'c', 'sess-c');

    const first = payloadOf(await core.xc_dispatch({ ...args }, 'conn-a')) as { taskId: string };
    const again = payloadOf(await core.xc_dispatch({ ...args }, 'conn-a')) as { taskId: string; delivered: string };
    expect(again.delivered).toBe('duplicate');
    expect(again.taskId).toBe(first.taskId);

    // 票面不同（title 变）→ 不是重复派发。
    const other = payloadOf(await core.xc_dispatch({ ...args, title: 'different' }, 'conn-a')) as { taskId: string; delivered: string };
    expect(other.delivered).toBe('mailbox');
    expect(other.taskId).not.toBe(first.taskId);
  });

  it('收方已读旧票后重派 → 建新单（未读才算在途重复，v0.7.0 语义保留）', async () => {
    await hookRegister('conn-a', 'a', 'sess-a');
    await hookRegister('conn-c', 'c', 'sess-c');
    const first = payloadOf(await core.xc_dispatch({ ...args }, 'conn-a')) as { taskId: string };
    await core.xc_check_inbox({}, 'conn-c'); // 读走 → readAt 落盘
    const second = payloadOf(await core.xc_dispatch({ ...args }, 'conn-a')) as { taskId: string; delivered: string };
    expect(second.delivered).toBe('mailbox');
    expect(second.taskId).not.toBe(first.taskId);
  });
});

// ---------------------------------------------------------------------------
// 3) 边界-9：peers 视图 [ref]
// ---------------------------------------------------------------------------

/** 行文本里最后一个方括号组 = `[ref]`（第一个方括号组是 `[kind]`）。 */
function lastBracket(line: string): string {
  const all = [...line.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
  return all[all.length - 1]!;
}

describe('边界-9：peers 视图 [ref] 只在跨会话可寻址行上渲染', () => {
  const SID_A = 'sess-v071-b9-a';
  const SID_B = 'sess-v071-b9-b';

  function record(sessionId: string, name: string): PeerRecord {
    return {
      pid: 4242,
      sessionId,
      messagingSocketPath: `\\\\.\\pipe\\xc-v071-b9-${sessionId}`,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: 'interactive' as const,
      name,
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    };
  }

  /** 队内成员行（peer-services.ts rowsOf('member') 的同一构造）。 */
  function memberRow(key: string): PeerRow {
    return {
      name: key,
      kind: 'member',
      ref: key.slice(0, 8),
      identity: `${key}@default`,
      status: 'ready',
    };
  }

  it('成员与 peer 同名：成员行不再渲染不可作地址的 [ref]；session 行照旧渲染且可寻址', () => {
    const rows: PeerRow[] = [
      ...peerRowsFromRecord(record(SID_A, 'iso-a'), 'self'),
      ...peerRowsFromRecord(record(SID_B, 'iso-b'), 'session'),
      memberRow('iso-a'),
      memberRow('iso-b'),
    ];
    const lines = formatPeerRows(rows, 1_000);
    const memberLine = lines.find((l) => l.startsWith('iso-b [member]'))!;
    const sessionLine = lines.find((l) => l.startsWith('iso-b [session]'))!;

    // 旧行为：`iso-b [member] [iso-b]`——照着抄去 xc_relay 必得 target_not_found。
    expect(memberLine).toBe('iso-b [member] status=ready seen=未知');
    // session 行：kind 之后仍带 [ref]，且它就是可寻址的那个 ref。
    const ref = lastBracket(sessionLine);
    expect(ref).toHaveLength(8);
    expect(sessionLine).toBe(`iso-b [session] [${ref}] seen=刚刚`);

    // 渲染出来的 [ref] 必须真的能当地址用（可寻址，二选一里的「可寻址」分支）。
    const resolved = resolvePeerTarget(`iso-b [${ref}]`, rows);
    expect(resolved.kind).toBe('found');
    if (resolved.kind === 'found') expect(resolved.row.sessionId).toBe(SID_B);
  });

  it('两个 peer 共享同名（别名场景）：两行都带 [ref] 且各自精确可寻址（v0.7.0 语义不回退）', () => {
    const rows: PeerRow[] = [
      ...peerRowsFromRecord(record(SID_A, 'iso-b'), 'session'),
      ...peerRowsFromRecord({ ...record(SID_B, 'iso-b2'), formerNames: [{ name: 'iso-b', releasedAt: 1 }] }, 'session'),
    ];
    const lines = formatPeerRows(rows, 1_000);
    const contested = lines.filter((l) => l.startsWith('iso-b ['));
    expect(contested).toHaveLength(2);
    for (const line of contested) {
      expect(line).toMatch(/^iso-b \[session(·former)?\] \[[0-9a-z-]{8}\]/);
      const ref = lastBracket(line);
      expect(resolvePeerTarget(`iso-b [${ref}]`, rows).kind).toBe('found');
    }
    // 裸名仍然不猜。
    expect(resolvePeerTarget('iso-b', rows).kind).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// 4) 规模压-B1：dropped 回执透出原因与恢复动作
// ---------------------------------------------------------------------------

describe('规模压-B1：peer 入队闸 dropped 回执带原因与恢复动作', () => {
  let workDir: string;
  let stateRoot: string;
  let peerRoot: string;
  let fakeServer: Server | undefined;
  let child: import('node:child_process').ChildProcess | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'xc-v071-b1-'));
    stateRoot = join(workDir, '.crosschat');
    peerRoot = mkdtempSync(join(tmpdir(), 'xc-v071-b1-peers-'));
    clearPeerSessionContext();
  });

  afterEach(async () => {
    clearPeerSessionContext();
    if (fakeServer !== undefined) await new Promise<void>((r) => fakeServer!.close(() => r()));
    fakeServer = undefined;
    if (child !== undefined) child.kill();
    child = undefined;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(peerRoot, { recursive: true, force: true });
  });

  async function seedTeam(): Promise<void> {
    const now = Date.now();
    const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
    team.members.push(
      { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
      { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
    );
    await writeTeam(stateRoot, team);
    identityStore.bind('conn-a', {
      sessionKey: 'xc:default:a',
      teamId: 'default',
      name: 'a',
      agentKey: 'a',
      sessionId: 'sess_a',
      role: 'peer',
      boundAt: now,
    });
  }

  /** 假接收端点：对 msg 帧回一句 dropped + detail（模拟入队闸命中 queue-full）。 */
  async function startDroppingEndpoint(): Promise<string> {
    const socketPath = `\\\\.\\pipe\\LOCAL\\xcc-msg-v071-b1-${Math.random().toString(16).slice(2)}`;
    const detail = 'queue-full: the receiver\'s pending peer queue is at its cap (10 messages) — '
      + 'this message was NOT delivered; ask the receiver to drain with xc_read({scope:"peer"}), or retry later';
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const frame = JSON.parse(line) as { type?: string; msgId?: string };
            if (frame.type === 'auth') socket.write(`${JSON.stringify({ type: 'auth', ok: true })}\n`);
            else if (frame.type === 'msg') {
              socket.write(`${JSON.stringify({ type: 'status', msgId: frame.msgId, state: 'dropped', detail })}\n`);
            }
          } catch {
            /* 非 JSON 行忽略 */
          }
          index = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    fakeServer = server;
    return socketPath;
  }

  it('xc_relay 的 payload 与摘要行都带上 detail（原因 + 恢复动作）', async () => {
    await seedTeam();
    setPeerSessionContext({ sessionId: 'sess_a', name: 'alice', pid: process.pid, root: peerRoot });
    const { spawn } = await import('node:child_process');
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const socketPath = await startDroppingEndpoint();
    await writePeerRecord(peerRoot, {
      pid,
      sessionId: 'sess_peer_target',
      messagingSocketPath: socketPath,
      pidDomain: localPidDomain(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: 'interactive' as const,
      name: 'bob',
      formerNames: [],
      startedAt: Date.now(),
      lastSeen: Date.now(),
    } satisfies PeerRecord);
    await writePeerKeyFile(peerRoot, pid, socketPath, { peerToken: 'c'.repeat(32), pidDomain: localPidDomain() });

    const result = await xcRelay(
      { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } },
      createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: peerRoot } }),
      { to: 'bob[peer]', msg: 'drop-me' } as RelayArgs,
      'conn-a',
      false,
    );
    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result) as { receipt: string; detail?: string; via: string };
    expect(payload.receipt).toBe('dropped');
    expect(payload.via).toBe('pipe');
    // 旧行为：payload 只有 {msgId,to,receipt,via,axis}——原因与恢复动作在工具面丢失。
    expect(payload.detail).toBeDefined();
    expect(payload.detail).toContain('queue-full');
    expect(payload.detail).toContain('NOT delivered');
    expect(payload.detail).toMatch(/drain|retry/);
    // 摘要行同样透出（模型第一眼看到的是文本面）。
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('receipt=dropped');
    expect(text).toContain('未投递原因与恢复动作');
    expect(text).toContain('queue-full');
  }, 20000);
});
