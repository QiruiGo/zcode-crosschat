import { describe, expect, it } from 'vitest';
import {
  PEER_FORMER_NAMES_LIMIT,
  PEER_NAME_RE,
  PEER_RESERVED_NAMES,
  addressableRows,
  ambiguousNames,
  encodeRouteId,
  formatPeerRow,
  formatPeerRows,
  parsePeerTarget,
  peerRef,
  peerRowsFromRecord,
  relativeAge,
  resolvePeerTarget,
  sanitizePeerName,
  type PeerRecordLike,
  type PeerRow,
} from './peeraddr.js';

const SESS_A = 'sessA1111aaaa';
const SESS_B = 'sessB2222bbbb';

function rec(sessionId: string, name: string, extra: Partial<PeerRecordLike> = {}): PeerRecordLike {
  return {
    sessionId,
    pidDomain: 'abcdef0123456789',
    name,
    cwd: `D:\\ws\\${name}`,
    status: 'idle',
    lastSeen: 1_000,
    formerNames: [],
    ...extra,
  };
}

function rowsOf(...records: PeerRecordLike[]): PeerRow[] {
  return records.flatMap((r) => peerRowsFromRecord(r, 'session'));
}

describe('peerRef (SPEC R-9)', () => {
  it('is the last 8 characters of the session id', () => {
    expect(peerRef(SESS_A)).toBe('1111aaaa');
    expect(peerRef(SESS_A)).toHaveLength(8);
  });

  it('returns short ids unchanged', () => {
    expect(peerRef('abc')).toBe('abc');
    expect(peerRef('')).toBe('');
  });
});

describe('sanitizePeerName (SPEC R-8 / R-11)', () => {
  it('accepts grammar-conforming names', () => {
    expect(sanitizePeerName('alice')).toEqual({ ok: true, name: 'alice' });
    expect(sanitizePeerName('a-b_C9')).toEqual({ ok: true, name: 'a-b_C9' });
    expect(sanitizePeerName('a'.repeat(64))).toEqual({ ok: true, name: 'a'.repeat(64) });
  });

  it('rejects names outside the grammar', () => {
    expect(sanitizePeerName('')).toMatchObject({ ok: false });
    expect(sanitizePeerName('-alice')).toMatchObject({ ok: false });
    expect(sanitizePeerName('alice bob')).toMatchObject({ ok: false });
    expect(sanitizePeerName('alice.bob')).toMatchObject({ ok: false });
    expect(sanitizePeerName('小明')).toMatchObject({ ok: false });
    expect(sanitizePeerName('a'.repeat(65))).toMatchObject({ ok: false, reason: expect.stringContaining('name-too-long') });
  });

  it('rejects reserved names', () => {
    for (const reserved of PEER_RESERVED_NAMES) {
      expect(sanitizePeerName(reserved)).toMatchObject({ ok: false, reason: expect.stringContaining('reserved-name') });
    }
  });

  it('strips control characters before validating (CC lX @3269979)', () => {
    expect(sanitizePeerName('ali\u0000ce')).toEqual({ ok: true, name: 'alice' });
    expect(sanitizePeerName('ali\u007fce')).toEqual({ ok: true, name: 'alice' });
    expect(sanitizePeerName('ali\u009fce')).toEqual({ ok: true, name: 'alice' });
    expect(sanitizePeerName('  alice  ')).toEqual({ ok: true, name: 'alice' });
  });

  it('exposes the grammar used by the checks', () => {
    expect(PEER_NAME_RE.test('alice')).toBe(true);
    expect(PEER_NAME_RE.test('a b')).toBe(false);
  });
});

describe('encodeRouteId (SPEC R-8, CC We() @2355944)', () => {
  it('keeps the safe set untouched', () => {
    expect(encodeRouteId('aZ0:_/.-')).toBe('aZ0:_/.-');
  });

  it('percent-encodes everything else with uppercase hex', () => {
    expect(encodeRouteId('a b')).toBe('a%20b');
    expect(encodeRouteId('a+b')).toBe('a%2Bb');
    expect(encodeRouteId('中文')).toBe('%E4%B8%AD%E6%96%87');
  });
});

describe('peerRowsFromRecord / formerNames (DESIGN-V0.3 §5.5)', () => {
  it('emits the current row plus one row per alias', () => {
    const rows = peerRowsFromRecord(
      rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }),
      'session',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'alice2', former: false });
    expect(rows[1]).toMatchObject({ name: 'alice', former: true, releasedAt: 100, currentName: 'alice2' });
  });

  it('caps aliases at the 32-entry FIFO (SPEC R-10)', () => {
    const formerNames = Array.from({ length: 40 }, (_, i) => ({ name: `old${i}`, releasedAt: i }));
    const rows = peerRowsFromRecord(rec(SESS_A, 'alice', { formerNames }), 'session');
    expect(rows).toHaveLength(1 + PEER_FORMER_NAMES_LIMIT);
    expect(rows[1]).toMatchObject({ name: 'old8' });
    expect(rows[rows.length - 1]).toMatchObject({ name: 'old39' });
  });

  it('does not duplicate a row when an alias equals the current name', () => {
    const rows = peerRowsFromRecord(rec(SESS_A, 'alice', { formerNames: [{ name: 'alice', releasedAt: 1 }] }), 'session');
    expect(rows).toHaveLength(1);
  });
});

describe('resolvePeerTarget (SPEC R-9 / DESIGN-V0.3 §5.3)', () => {
  it('delivers to the single matching identity', () => {
    const rows = rowsOf(rec(SESS_A, 'alice'), rec(SESS_B, 'bob'));
    const res = resolvePeerTarget('bob', rows);
    expect(res.kind).toBe('found');
    if (res.kind === 'found') expect(res.row.sessionId).toBe(SESS_B);
  });

  it('reports not-found with candidates described by where they run', () => {
    const rows = rowsOf(rec(SESS_A, 'alice'), rec(SESS_B, 'bob'));
    const res = resolvePeerTarget('carol', rows);
    expect(res.kind).toBe('not-found');
    if (res.kind === 'not-found') {
      expect(res.message).toContain('carol');
      expect(res.message).toContain('bob');
      expect(res.message).toContain('D:\\ws\\bob');
    }
  });

  it('rejects an empty target', () => {
    expect(resolvePeerTarget('', rowsOf(rec(SESS_A, 'alice'))).kind).toBe('not-found');
  });

  it('does not guess between a current holder and an alias holder', () => {
    const rows = rowsOf(
      rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }),
      rec(SESS_B, 'alice'),
    );
    expect(ambiguousNames(rows).has('alice')).toBe(true);
    const res = resolvePeerTarget('alice', rows);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates).toHaveLength(2);
      expect(res.candidates.map((c) => c.sessionId).sort()).toEqual([SESS_A, SESS_B]);
    }
  });

  it('resolves an exact [ref] hit even when the bare name is contested', () => {
    const rows = rowsOf(
      rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }),
      rec(SESS_B, 'alice'),
    );
    const refA = peerRef(SESS_A);
    const refB = peerRef(SESS_B);
    const hitA = resolvePeerTarget(`alice [${refA}]`, rows);
    expect(hitA.kind).toBe('found');
    if (hitA.kind === 'found') expect(hitA.row.sessionId).toBe(SESS_A);

    const hitB = resolvePeerTarget(`alice [${refB}]`, rows);
    expect(hitB.kind).toBe('found');
    if (hitB.kind === 'found') expect(hitB.row.sessionId).toBe(SESS_B);
  });

  it('treats a wrong ref as not-found and lists the real refs', () => {
    const rows = rowsOf(rec(SESS_A, 'alice'));
    const res = resolvePeerTarget('alice [deadbeef]', rows);
    expect(res.kind).toBe('not-found');
    if (res.kind === 'not-found') {
      expect(res.message).toContain(peerRef(SESS_A));
      expect(res.message).toContain('deadbeef');
    }
  });

  it('resolves an alias after the rename (the alias stays addressable)', () => {
    const rows = rowsOf(rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }));
    const res = resolvePeerTarget('alice', rows);
    expect(res.kind).toBe('found');
    if (res.kind === 'found') expect(res.row.former).toBe(true);
  });

  it('drops the alias once the record no longer carries it (alias expiry)', () => {
    const swept = rowsOf(rec(SESS_A, 'alice2', { formerNames: [] }));
    const res = resolvePeerTarget('alice', swept);
    expect(res.kind).toBe('not-found');
  });

  it('lets the newest releaser win when only aliases collide', () => {
    const rows = rowsOf(
      rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }),
      rec(SESS_B, 'bob2', { formerNames: [{ name: 'alice', releasedAt: 500 }] }),
    );
    const res = resolvePeerTarget('alice', rows);
    expect(res.kind).toBe('found');
    if (res.kind === 'found') expect(res.row.sessionId).toBe(SESS_B);
  });

  it('keeps the team namespace out of the cross-session address space', () => {
    const memberRow: PeerRow = {
      name: 'm1', kind: 'member', former: false, sessionId: 'sessM', ref: 'sessM',
      identity: 'm1@abcdef01', currentName: 'm1',
    };
    const rows = [memberRow, ...rowsOf(rec(SESS_A, 'alice'))];
    expect(addressableRows(rows).map((r) => r.name)).toEqual(['alice']);
    const res = resolvePeerTarget('m1', rows);
    expect(res.kind).toBe('not-found');
    if (res.kind === 'not-found') expect(res.message).toContain('队内成员');
  });

  it('does not make a name ambiguous because one session owns two rows', () => {
    const rows = rowsOf(rec(SESS_A, 'alice', { formerNames: [{ name: 'alice', releasedAt: 1 }] }));
    const res = resolvePeerTarget('alice', rows);
    expect(res.kind).toBe('found');
  });

  it('treats the reserved name "main" as not-found (SPEC R-11)', () => {
    const rows = rowsOf(rec(SESS_A, 'alice'));
    const res = resolvePeerTarget('main', rows);
    expect(res.kind).toBe('not-found');
  });

  it('resolves rows that carry no session id (tool-face row shape)', () => {
    const toolRow: PeerRow = {
      name: 'bob', kind: 'session', identity: 'bob@abcdef01', ref: 'b1c2d3d4',
    };
    const res = resolvePeerTarget('bob', [toolRow]);
    expect(res.kind).toBe('found');
    if (res.kind === 'found') expect(res.row.ref).toBe('b1c2d3d4');
  });

  it('keeps two identities apart when neither carries a session id', () => {
    const a: PeerRow = { name: 'alice', kind: 'session', identity: 'alice@aaaa', ref: 'aaaa1111' };
    const b: PeerRow = { name: 'alice', kind: 'session', identity: 'alice@bbbb', ref: 'bbbb2222' };
    const res = resolvePeerTarget('alice', [a, b]);
    expect(res.kind).toBe('ambiguous');
  });
});

describe('parsePeerTarget', () => {
  it('splits name and ref', () => {
    expect(parsePeerTarget('alice')).toEqual({ name: 'alice' });
    expect(parsePeerTarget('alice [1111aaaa]')).toEqual({ name: 'alice', ref: '1111aaaa' });
    expect(parsePeerTarget('  alice   [ 1111aaaa ] ')).toEqual({ name: 'alice', ref: '1111aaaa' });
  });

  it('treats an empty bracket group as no ref', () => {
    expect(parsePeerTarget('alice []')).toEqual({ name: 'alice' });
  });
});

describe('row rendering (DESIGN-V0.3 §5.2)', () => {
  it('appends [ref] only when the bare name is not enough', () => {
    const single = rowsOf(rec(SESS_A, 'alice'));
    const contested = rowsOf(
      rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }),
      rec(SESS_B, 'alice'),
    );
    const singleLine = formatPeerRows(single, 1_000)[0]!;
    expect(singleLine).toContain('alice [session]');
    expect(singleLine).not.toContain('[1111aaaa]');

    const contestedLines = formatPeerRows(contested, 1_000);
    expect(contestedLines).toHaveLength(3);
    const aliceLines = contestedLines.filter((l) => l.startsWith('alice '));
    expect(aliceLines).toHaveLength(2);
    // both rows sharing the name carry their own [ref] (CC @8463662)
    expect(aliceLines[0]).toContain(`[${peerRef(SESS_A)}]`);
    expect(aliceLines[1]).toContain(`[${peerRef(SESS_B)}]`);
    // the third row (current name of the renamed session) is unambiguous by name
    expect(contestedLines.find((l) => l.startsWith('alice2'))).not.toContain(`[${peerRef(SESS_A)}]`);
  });

  it('marks alias rows and shows the current name', () => {
    const rows = rowsOf(rec(SESS_A, 'alice2', { formerNames: [{ name: 'alice', releasedAt: 100 }] }));
    const aliasLine = formatPeerRows(rows, 1_000).find((l) => l.startsWith('alice ['))!;
    expect(aliasLine).toContain('session·former');
    expect(aliasLine).toContain('现名 alice2');
  });

  it('carries cwd, status and the relative age', () => {
    const rows = rowsOf(rec(SESS_A, 'alice', { lastSeen: 1_000 }));
    const line = formatPeerRows(rows, 1_000)[0]!;
    expect(line).toContain('cwd=D:\\ws\\alice');
    expect(line).toContain('status=idle');
    expect(line).toContain('seen=刚刚');
  });

  it('formats a record directly (DESIGN-V0.3 §10.2 signature)', () => {
    const line = formatPeerRow(rec(SESS_A, 'alice'), 'self', false, 1_000);
    expect(line.startsWith('alice [self]')).toBe(true);
    expect(line).not.toContain('[1111aaaa]');
  });
});

describe('relativeAge', () => {
  it('renders coarse buckets', () => {
    expect(relativeAge(1_000, 1_000)).toBe('刚刚');
    expect(relativeAge(1_000, 10_000)).toBe('9 秒前');
    expect(relativeAge(1_000, 61_000)).toBe('1 分钟前');
    expect(relativeAge(1_000, 3_601_000)).toBe('1 小时前');
    expect(relativeAge(1_000, 90_000_000)).toBe('1 天前');
    expect(relativeAge(undefined, 1_000)).toBe('未知');
  });
});
