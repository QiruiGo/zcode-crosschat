/**
 * W2 member-engine 纯函数用例（DESIGN-V0.2.md V15：上限逻辑为纯插件侧，单元测试覆盖）。
 * 只覆盖 member-tools.ts 的纯判定函数；工具的锁内/锁外编排由 Phase A/B 场景验收
 * （DESIGN-V0.2.md §8.2/§8.3）。
 */
import { describe, expect, it } from 'vitest';
import {
  activeMembersAfterUpsert,
  countActiveMembers,
  leadKeyOf,
  maxMembersFromEnv,
  resolveReprovision,
} from './member-tools.js';
import type { TeamMember, TeamState } from '../core/types.js';

function teamWith(members: TeamMember[], leadKey?: string): TeamState {
  return {
    teamId: 'default',
    name: 'default',
    founderKey: 'a',
    phase: 'open',
    ...(leadKey === undefined ? {} : { leadKey }),
    members,
    tasks: [],
    seq: 0,
    createdAt: 1,
  };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    key: 'm1', sessionId: 'sess_m1', role: 'worker', joinedAt: 1, lastSeen: 1, ...overrides,
  };
}

describe('maxMembersFromEnv (V18 防御 + dsh index.js:100 默认 8)', () => {
  it('defaults to 8 on absent/blank env', () => {
    expect(maxMembersFromEnv({})).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '   ' })).toBe(8);
  });

  it('accepts finite positive integers', () => {
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '3' })).toBe(3);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '12' })).toBe(12);
  });

  it('falls back on any non-finite-positive-integer value (V18)', () => {
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '0' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '-1' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '2.5' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: 'abc' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: 'NaN' })).toBe(8);
    expect(maxMembersFromEnv({ XC_MAX_MEMBERS: '1e999' })).toBe(8); // Infinity
  });
});

describe('countActiveMembers (v0.5.3 A12 口径：lead/failed/removed 均不计)', () => {
  it('counts provisioning/ready only; excludes lead, failed and removed', () => {
    const team = teamWith(
      [
        member({ key: 'a', state: 'ready', identity: 'engine' }), // founder 记录（leadKey 未设 → a 是 lead）
        member({ key: 'b', state: 'provisioning' }),
        member({ key: 'c', state: 'failed' }),
        member({ key: 'd', state: 'removed' }),
        member({ key: 'e' }), // legacy record: memberState → ready
      ],
      'a',
    );
    // 红队 a12：旧实现计 lead(a)+failed(c)=5，max=2 时 0 个可用成员仍 team_at_member_cap。
    expect(countActiveMembers(team)).toBe(2); // b(provisioning) + e(legacy→ready)
  });

  it('explicit leadKey excludes the lead record even with role worker', () => {
    const team = teamWith(
      [
        member({ key: 'boss', state: 'ready', identity: 'self' }),
        member({ key: 'w1', state: 'ready', identity: 'engine' }),
        member({ key: 'w2', state: 'ready', identity: 'engine' }),
      ],
      'boss',
    );
    expect(countActiveMembers(team)).toBe(2);
  });

  it('no leadKey set → founder 视为 lead（leadKeyOf 同源），其记录不计', () => {
    const team = teamWith([
      member({ key: 'a', state: 'ready' }), // founder 记录
      member({ key: 'w', state: 'ready', identity: 'engine' }),
    ]);
    expect(countActiveMembers(team)).toBe(1);
  });

  it('all-failed roster counts 0（0 个可用成员不再占满名额）', () => {
    const team = teamWith(
      [member({ key: 'x', state: 'failed' }), member({ key: 'y', state: 'failed' })],
      'a',
    );
    expect(countActiveMembers(team)).toBe(0);
  });

  it('empty roster counts 0', () => {
    expect(countActiveMembers(teamWith([]))).toBe(0);
  });
});

describe('activeMembersAfterUpsert (v0.5.3 A12：写入后的名额数与净增量)', () => {
  const base = () =>
    teamWith(
      [
        member({ key: 'a', state: 'ready' }), // founder = lead，不计
        member({ key: 'w1', state: 'ready', identity: 'engine' }),
      ],
      'a',
    );

  it('新建（无记录）→ 净 +1', () => {
    expect(activeMembersAfterUpsert(base(), undefined)).toBe(2);
  });

  it('removed 重加 → 净 +1（removed 不计 → 重加后 provisioning 占位）', () => {
    expect(activeMembersAfterUpsert(base(), member({ key: 'w2', state: 'removed' }))).toBe(2);
  });

  it('failed 重供给 → 净 +1（failed 此前不计，重供给转 provisioning 占位）', () => {
    expect(activeMembersAfterUpsert(base(), member({ key: 'w2', state: 'failed' }))).toBe(2);
  });

  it('停滞 provisioning 接管 → 净 0（已在占位）', () => {
    expect(
      activeMembersAfterUpsert(base(), member({ key: 'w2', state: 'provisioning', provisionedAt: 1 })),
    ).toBe(1);
  });
});

describe('leadKeyOf (§6.1 step 1: leadKey 未设置时 founder 视为 lead)', () => {
  it('prefers the explicit leadKey', () => {
    expect(leadKeyOf(teamWith([member({ key: 'a' }), member({ key: 'b' })], 'b'))).toBe('b');
  });

  it('falls back to founderKey when leadKey is unset', () => {
    expect(leadKeyOf(teamWith([member({ key: 'a' })]))).toBe('a');
  });
});

describe('resolveReprovision (§6.4 幂等重供给分流)', () => {
  const BOOT = 300_000;

  it('fresh when no record exists', () => {
    expect(resolveReprovision(undefined, 1000, BOOT).kind).toBe('fresh');
  });

  it('rejects ready records (duplicate)', () => {
    expect(resolveReprovision(member({ state: 'ready' }), 1000, BOOT).kind).toBe('ready');
    expect(resolveReprovision(member({}), 1000, BOOT).kind).toBe('ready'); // legacy → ready
  });

  it('removed records re-add as a fresh lifecycle (§6.1)', () => {
    expect(resolveReprovision(member({ state: 'removed' }), 1000, BOOT).kind).toBe('fresh');
  });

  it('failed records reprovision via the §6.4 probe', () => {
    expect(resolveReprovision(member({ state: 'failed' }), 1000, BOOT).kind).toBe('auto');
  });

  it('fresh provisioning record is in-progress (防并发重复建)', () => {
    expect(
      resolveReprovision(member({ state: 'provisioning', provisionedAt: 900 }), 1000, BOOT).kind,
    ).toBe('in-progress');
  });

  it('stale provisioning record (past timeout + 60s margin) is takeover-eligible', () => {
    const startedAt = 1000;
    const now = startedAt + BOOT + 60_000 + 1;
    expect(resolveReprovision(member({ state: 'provisioning', provisionedAt: startedAt }), now, BOOT).kind)
      .toBe('auto');
  });

  it('falls back to joinedAt when provisionedAt is absent', () => {
    const joinedAt = 5000;
    expect(
      resolveReprovision(member({ state: 'provisioning', joinedAt }), joinedAt + 1000, BOOT).kind,
    ).toBe('in-progress');
    expect(
      resolveReprovision(member({ state: 'provisioning', joinedAt }), joinedAt + BOOT + 60_001, BOOT).kind,
    ).toBe('auto');
  });
});
