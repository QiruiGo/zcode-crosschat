import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PEER_FORMER_NAMES_MAX,
  PEER_RECORD_MAX_BYTES,
  findPeerByName,
  isPeerNameFree,
  peerIsAlive,
  peerRegistryLockName,
  pushFormerName,
  readPeerRecord,
  removePeerKeyFile,
  removePeerRecord,
  scanPeers,
  touchPeerRecord,
  tryWritePeerRecord,
  writePeerKeyFile,
  writePeerRecord,
} from './peerregistry.js';
import {
  localPidDomain,
  localPidDomains,
  peerBaseFile,
  peerHeldDir,
  peerInboxFile,
  peerKeyFile,
  peerQueueFile,
  peerRecordFile,
  peerRootFromEnv,
  peerSessionsDir,
  readPeerBaseRecord,
  refreshPeerBaseRecord,
  writePeerBaseRecord,
} from './peerdir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-peerreg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A record that is alive by construction (this very process). */
function liveRecord(overrides: Partial<Parameters<typeof writePeerRecord>[1]> = {}): Parameters<typeof writePeerRecord>[1] {
  return {
    pid: process.pid,
    sessionId: 'sess_a',
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa',
    pidDomain: localPidDomain(),
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'interactive',
    formerNames: [],
    startedAt: 1000,
    lastSeen: Date.now(),
    ...overrides,
  };
}

describe('peerRootFromEnv', () => {
  it('prefers XC_MESSAGING_DIR over everything else', () => {
    const root = peerRootFromEnv({
      XC_MESSAGING_DIR: join(dir, 'custom'),
      ZCODE_PLUGIN_DATA: join(dir, 'plugin-data'),
    } as NodeJS.ProcessEnv);
    expect(root).toBe(join(dir, 'custom'));
  });

  it('falls back to ZCODE_PLUGIN_DATA + /peers', () => {
    const root = peerRootFromEnv({ ZCODE_PLUGIN_DATA: join(dir, 'plugin-data') } as NodeJS.ProcessEnv);
    expect(root).toBe(join(dir, 'plugin-data', 'peers'));
  });

  it('ignores blank values and falls back to the plugin data home path', () => {
    const root = peerRootFromEnv({
      XC_MESSAGING_DIR: '   ',
      ZCODE_PLUGIN_DATA: '',
    } as NodeJS.ProcessEnv);
    expect(root).toContain(join('.zcode', 'cli', 'plugins', 'data'));
    expect(root.endsWith('peers')).toBe(true);
  });
});

describe('peer path builders', () => {
  it('lays out the DESIGN-V0.3 §3.1 tree', () => {
    expect(peerSessionsDir(dir)).toBe(join(dir, 'sessions'));
    expect(peerRecordFile(dir, 42)).toBe(join(dir, 'sessions', '42.json'));
    expect(peerBaseFile(dir, 'sess_x')).toBe(join(dir, 'base', 'sess_x.json'));
    expect(peerInboxFile(dir, 'sess_x')).toBe(join(dir, 'inbox', 'sess_x.jsonl'));
    expect(peerQueueFile(dir, 'sess_x')).toBe(join(dir, 'queue', 'sess_x.jsonl'));
    expect(peerHeldDir(dir, 'sess_x')).toBe(join(dir, 'held', 'sess_x'));
    expect(peerKeyFile(dir, 42, '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa'))
      .toMatch(/keys[/\\]42\.[0-9a-f]{64}\.key$/);
  });
});

describe('peer records', () => {
  it('round-trips a record', async () => {
    await writePeerRecord(dir, liveRecord({ name: 'alice' }));
    const read = await readPeerRecord(dir, process.pid);
    expect(read?.name).toBe('alice');
    expect(read?.pid).toBe(process.pid);
    expect(read?.peerFeatures).toEqual([]);
  });

  it('rejects a record whose pid does not match the file name', async () => {
    mkdirSync(peerSessionsDir(dir), { recursive: true });
    const record = { ...liveRecord(), pid: 999999 };
    writeFileSync(peerRecordFile(dir, process.pid), JSON.stringify(record), 'utf8');
    expect(await readPeerRecord(dir, process.pid)).toBeUndefined();
  });

  it('treats an oversized record as a bad record (cap 256 KiB, CC RUt)', async () => {
    mkdirSync(peerSessionsDir(dir), { recursive: true });
    const record = { ...liveRecord(), padding: 'x'.repeat(PEER_RECORD_MAX_BYTES + 10) };
    writeFileSync(peerRecordFile(dir, process.pid), JSON.stringify(record), 'utf8');
    expect(await readPeerRecord(dir, process.pid)).toBeUndefined();
  });

  it('reads a missing record as undefined', async () => {
    expect(await readPeerRecord(dir, 4242)).toBeUndefined();
  });

  it('tryWritePeerRecord swallows failures instead of crashing (heartbeat safety)', async () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf8');
    expect(await tryWritePeerRecord(blocked, liveRecord())).toBe(false);
  });

  it('touchPeerRecord merges the patch and stamps updatedAt', async () => {
    await writePeerRecord(dir, liveRecord({ name: 'alice' }));
    const ok = await touchPeerRecord(dir, process.pid, { lastSeen: 4242, status: 'busy' });
    expect(ok).toBe(true);
    const read = await readPeerRecord(dir, process.pid);
    expect(read?.status).toBe('busy');
    expect(read?.lastSeen).toBe(4242);
    expect(read?.name).toBe('alice');
    expect(typeof read?.updatedAt).toBe('number');
  });
});

describe('scanPeers', () => {
  it('only accepts /^\\d+\\.json$/ files', async () => {
    mkdirSync(peerSessionsDir(dir), { recursive: true });
    await writePeerRecord(dir, liveRecord());
    writeFileSync(join(peerSessionsDir(dir), 'notapid.json'), '{}', 'utf8');
    writeFileSync(join(peerSessionsDir(dir), '12.json'), '{}', 'utf8');
    const scan = await scanPeers(dir);
    expect(scan.active).toHaveLength(1);
    expect(scan.active[0]!.pid).toBe(process.pid);
  });

  it('classifies a dead pid as pid-dead and sweeps the file', async () => {
    const deadPid = 2147483000; // far above any live pid on this machine
    await writePeerRecord(dir, liveRecord({ pid: deadPid }));
    const scan = await scanPeers(dir);
    expect(scan.active).toHaveLength(0);
    expect(scan.dead).toHaveLength(1);
    expect(scan.dead[0]!.reason).toBe('pid-dead');
    expect(existsSync(peerRecordFile(dir, deadPid))).toBe(false);
  });

  it('classifies a stale lastSeen with a live pid as lastSeen-stale', async () => {
    await writePeerRecord(dir, liveRecord({ lastSeen: Date.now() - 10 * 60_000 }));
    const scan = await scanPeers(dir);
    expect(scan.dead).toHaveLength(1);
    expect(scan.dead[0]!.reason).toBe('lastSeen-stale');
  });

  it('keeps foreign-domain records out of the discovery set without deleting them', async () => {
    await writePeerRecord(dir, liveRecord({ pidDomain: 'ffffffffffffffff' }));
    const scan = await scanPeers(dir);
    expect(scan.active).toHaveLength(0);
    expect(scan.foreign).toHaveLength(1);
    expect(existsSync(peerRecordFile(dir, process.pid))).toBe(true);
  });

  it('accepts every known local domain口径 as local (writer/reader口径一致)', async () => {
    for (const domain of localPidDomains()) {
      await writePeerRecord(dir, liveRecord({ pidDomain: domain }));
      const scan = await scanPeers(dir);
      expect(scan.active).toHaveLength(1);
      expect(scan.foreign).toHaveLength(0);
    }
  });

  it('tolerates two scanners sweeping the same batch', async () => {
    const deadPid = 2147482999;
    await writePeerRecord(dir, liveRecord({ pid: deadPid }));
    const [a, b] = await Promise.all([scanPeers(dir), scanPeers(dir)]);
    // Both scanners may observe the record before either deletes it; the point
    // of the check is that the second delete hits ENOENT and is tolerated.
    expect(a.dead.length + b.dead.length).toBeGreaterThanOrEqual(1);
    expect([...a.dead, ...b.dead].every((row) => row.reason === 'pid-dead')).toBe(true);
    expect(existsSync(peerRecordFile(dir, deadPid))).toBe(false);
  });
});

describe('name occupancy', () => {
  it('a live peer keeps its name', async () => {
    await writePeerRecord(dir, liveRecord({ name: 'alice' }));
    expect(await isPeerNameFree(dir, 'alice')).toBe(false);
    expect((await findPeerByName(dir, 'alice'))?.name).toBe('alice');
  });

  it('a dead peer does NOT keep its name (regression of the T5 E7 failure)', async () => {
    const deadPid = 2147482998;
    await writePeerRecord(dir, liveRecord({ pid: deadPid, name: 'bob' }));
    expect(await isPeerNameFree(dir, 'bob')).toBe(true);
  });

  it('an empty name is never free', async () => {
    expect(await isPeerNameFree(dir, '  ')).toBe(false);
  });
});

describe('formerNames', () => {
  it('keeps the newest release and caps the list at 32 entries (FIFO)', () => {
    let list: { name: string; releasedAt: number }[] = [];
    for (let i = 0; i < PEER_FORMER_NAMES_MAX + 5; i += 1) {
      list = pushFormerName(list, `n${i}`, 1000 + i);
    }
    expect(list).toHaveLength(PEER_FORMER_NAMES_MAX);
    expect(list[0]!.name).toBe('n5');
    expect(list[list.length - 1]!.name).toBe(`n${PEER_FORMER_NAMES_MAX + 4}`);
  });

  it('replaces an existing entry with the same name', () => {
    let list = pushFormerName([], 'alice', 1);
    list = pushFormerName(list, 'alice', 2);
    expect(list).toHaveLength(1);
    expect(list[0]!.releasedAt).toBe(2);
  });
});

describe('liveness helper', () => {
  it('a live pid with a fresh heartbeat is alive', () => {
    expect(peerIsAlive(liveRecord(), Date.now())).toBe(true);
  });
  it('a live pid with an old heartbeat is not alive', () => {
    expect(peerIsAlive(liveRecord({ lastSeen: 1 }), Date.now())).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes the record and the published key file', async () => {
    await writePeerRecord(dir, liveRecord());
    await writePeerKeyFile(dir, process.pid, '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa', { peerToken: 'abc' });
    expect(existsSync(peerKeyFile(dir, process.pid, '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa'))).toBe(true);
    await removePeerKeyFile(dir, process.pid, '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa');
    await removePeerRecord(dir, process.pid);
    expect(existsSync(peerRecordFile(dir, process.pid))).toBe(false);
    expect(existsSync(peerKeyFile(dir, process.pid, '\\\\.\\pipe\\LOCAL\\xcc-msg-aaaa'))).toBe(false);
  });
});

describe('base records (hook side)', () => {
  it('writes, reads and refreshes the permission class', async () => {
    await writePeerBaseRecord(dir, {
      sessionId: 'sess_a',
      cwd: 'D:\\ws',
      permissionMode: 'prompting',
      source: 'startup',
      startedAt: 10,
      lastSeen: 10,
    });
    const read = await readPeerBaseRecord(dir, 'sess_a');
    expect(read?.permissionMode).toBe('prompting');
    await refreshPeerBaseRecord(dir, 'sess_a', { permissionMode: 'bypass', lastSeen: 99 });
    const refreshed = await readPeerBaseRecord(dir, 'sess_a');
    expect(refreshed?.permissionMode).toBe('bypass');
    expect(refreshed?.lastSeen).toBe(99);
    expect(refreshed?.startedAt).toBe(10);
  });

  it('does not invent a base record on refresh (missing base = unknown class)', async () => {
    await refreshPeerBaseRecord(dir, 'sess_missing', { lastSeen: 5 });
    expect(await readPeerBaseRecord(dir, 'sess_missing')).toBeUndefined();
  });
});

describe('registry lock naming', () => {
  it('is stable per root and filesystem safe', () => {
    const name = peerRegistryLockName(dir);
    expect(name).toBe(peerRegistryLockName(dir));
    expect(name).toMatch(/^peer-registry-[0-9a-f]{8}$/);
  });
});

describe('session directory hygiene', () => {
  it('leaves only the pid files behind after a write', async () => {
    await writePeerRecord(dir, liveRecord());
    expect(readdirSync(peerSessionsDir(dir)).sort()).toEqual([`${process.pid}.json`]);
  });
});

// ---------------------------------------------------------------------------
// v0.5 M4：PeerRecord.contextChars（R-18 声明值；宽容读取——非法值丢字段不拒记录）
// ---------------------------------------------------------------------------

describe('contextChars (v0.5 R-18)', () => {
  it('合法正整数：落盘→读回保留（xc_peer_register contextChars 的存储通道）', async () => {
    await writePeerRecord(dir, liveRecord({ contextChars: 50_000 }));
    const record = await readPeerRecord(dir, process.pid);
    expect(record?.contextChars).toBe(50_000);
  });

  it('不写该字段：旧版本记录照读（回归——absent = env/200k 缺省）', async () => {
    await writePeerRecord(dir, liveRecord());
    const raw = JSON.parse(readFileSync(peerRecordFile(dir, process.pid), 'utf8')) as Record<string, unknown>;
    expect('contextChars' in raw).toBe(false);
    const record = await readPeerRecord(dir, process.pid);
    expect(record?.sessionId).toBe('sess_a');
    expect(record?.contextChars).toBeUndefined();
  });

  it('touchPeerRecord 的 patch 带上 contextChars 时能合并落盘', async () => {
    await writePeerRecord(dir, liveRecord());
    await touchPeerRecord(dir, process.pid, { contextChars: 1_000_000 });
    const record = await readPeerRecord(dir, process.pid);
    expect(record?.contextChars).toBe(1_000_000);
  });

  it('字段非法（字符串/负数/零）→ 字段被丢弃但整条记录可读（宽容读取，不拒文件）', async () => {
    mkdirSync(peerSessionsDir(dir), { recursive: true });
    for (const bad of ['"50000"', '-5', '0', '1.5']) {
      const raw = JSON.stringify({ ...liveRecord(), contextChars: JSON.parse(bad) });
      writeFileSync(peerRecordFile(dir, process.pid), raw, 'utf8');
      const record = await readPeerRecord(dir, process.pid);
      expect(record, `contextChars=${bad} should not reject the record`).not.toBeUndefined();
      expect(record?.contextChars, `contextChars=${bad} should be dropped`).toBeUndefined();
      expect(record?.sessionId).toBe('sess_a');
    }
  });
});
